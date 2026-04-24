import { writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentBackend, AgentRequest, AgentEvent, AgentEventBase, PermissionGateRule, ServiceTier } from '@ccbuddy/core';
import { Codex, type ThreadOptions, type ThreadEvent, type Input, type UserInput } from '@openai/codex-sdk';
import { generateCodexRules } from './codex-rules.js';
import { prepareCodexMcpServers, restoreModifiedProtectedFiles, restoreProtectedFiles, snapshotProtectedFiles } from './codex-runtime-helpers.js';
import { isProvisionalRemoteSdkSessionId } from '../session/session-store.js';

export interface CodexSdkBackendOptions {
  codexPath?: string;
  apiKey?: string;
  networkAccess?: boolean;
  defaultSandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  defaultServiceTier?: ServiceTier;
  /** Permission gate rules to convert to static Codex deny rules */
  permissionGateRules?: PermissionGateRule[];
  startupTimeoutMs?: number;
}

function awaitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* ignore timeout cleanup errors */ }
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export class CodexSdkBackend implements AgentBackend {
  private readonly options: CodexSdkBackendOptions;
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly rulesFilePath: string | null;

  constructor(options: CodexSdkBackendOptions = {}) {
    this.options = options;

    // Generate static deny rules from permission gate config
    if (options.permissionGateRules && options.permissionGateRules.length > 0) {
      const rulesDir = join(tmpdir(), `ccbuddy-codex-rules-${randomUUID()}`);
      mkdirSync(rulesDir, { recursive: true });
      this.rulesFilePath = join(rulesDir, 'ccbuddy.rules');
      const content = generateCodexRules(options.permissionGateRules);
      writeFileSync(this.rulesFilePath, content, 'utf8');
      console.info(`[CodexSdkBackend] Generated Codex deny rules at ${this.rulesFilePath}`);
    } else {
      this.rulesFilePath = null;
    }
  }

  destroy(): void {
    if (this.rulesFilePath) {
      try { rmSync(dirname(this.rulesFilePath), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  async *execute(request: AgentRequest): AsyncGenerator<AgentEvent> {
    const base: AgentEventBase = {
      sessionId: request.sessionId,
      userId: request.userId,
      channelId: request.channelId,
      platform: request.platform,
    };

    const tempFiles: string[] = [];
    const protectedFiles = snapshotProtectedFiles(request.workingDirectory, this.options.permissionGateRules);
    const blockedProtectedPaths = new Set<string>();

    try {
      // Build Codex instance with env and optional overrides
      const codexEnv: Record<string, string> = { ...process.env as Record<string, string> };
      if (request.env) Object.assign(codexEnv, request.env);

      const codexConfig: Record<string, string | string[] | Record<string, string>> = {};

      // MCP servers — pass via config overrides
      if (request.mcpServers && request.mcpServers.length > 0) {
        const prepared = prepareCodexMcpServers(request.mcpServers);
        Object.assign(codexEnv, prepared.inheritedEnv);
        for (const [name, server] of Object.entries(prepared.config)) {
          codexConfig[`mcp_servers.${name}.type`] = server.type;
          codexConfig[`mcp_servers.${name}.command`] = server.command;
          codexConfig[`mcp_servers.${name}.args`] = server.args;
          if (server.env) codexConfig[`mcp_servers.${name}.env`] = server.env;
        }
      }

      // Wire in deny rules file if generated
      if (this.rulesFilePath) {
        codexConfig['exec_policy.rules_file'] = this.rulesFilePath;
      }
      if (request.serviceTier ?? this.options.defaultServiceTier) {
        codexConfig.service_tier = request.serviceTier ?? this.options.defaultServiceTier!;
      }
      if (request.verbosity) {
        codexConfig.model_verbosity = request.verbosity;
      }

      const codex = new Codex({
        codexPathOverride: this.options.codexPath,
        apiKey: this.options.apiKey,
        env: codexEnv,
        config: codexConfig,
      });

      // Build thread options
      const threadOpts: ThreadOptions = {
        workingDirectory: request.workingDirectory,
        networkAccessEnabled: this.options.networkAccess ?? true,
        skipGitRepoCheck: true,
      };

      if (request.model) threadOpts.model = request.model;
      if (request.reasoningEffort) threadOpts.modelReasoningEffort = request.reasoningEffort;

      // Map permission levels to Codex approval/sandbox modes
      switch (request.permissionLevel) {
        case 'admin':
        case 'system':
          threadOpts.approvalPolicy = 'never';
          threadOpts.sandboxMode = 'danger-full-access';
          break;
        case 'trusted':
          threadOpts.approvalPolicy = 'never';
          threadOpts.sandboxMode = this.options.defaultSandbox ?? 'workspace-write';
          break;
        case 'chat':
          threadOpts.approvalPolicy = 'never';
          threadOpts.sandboxMode = 'read-only';
          break;
      }

      // Create or resume thread
      const thread = request.resumeSessionId
        ? codex.resumeThread(request.resumeSessionId, threadOpts)
        : codex.startThread(threadOpts);

      // Build prompt with memory context and system prompt prepended
      let fullPrompt = request.prompt;
      if (request.memoryContext) {
        fullPrompt = `<memory_context>\n${request.memoryContext}\n</memory_context>\n\n${fullPrompt}`;
      }
      if (request.systemPrompt) {
        fullPrompt = `<system_instructions>\n${request.systemPrompt}\n</system_instructions>\n\n${fullPrompt}`;
      }
      if (request.permissionLevel === 'chat') {
        fullPrompt = `IMPORTANT: You are in chat-only mode. Do NOT use any tools (no shell commands, no file operations, no web searches). Only respond with text.\n\n${fullPrompt}`;
      }

      // Build input — handle image attachments via temp files
      let input: Input;
      const imageInputs: UserInput[] = [];

      if (request.attachments && request.attachments.length > 0) {
        for (const att of request.attachments) {
          if (att.type === 'image') {
            const ext = att.mimeType.split('/')[1] || 'png';
            const tempPath = join(tmpdir(), `ccbuddy-img-${randomUUID()}.${ext}`);
            writeFileSync(tempPath, att.data);
            tempFiles.push(tempPath);
            imageInputs.push({ type: 'local_image', path: tempPath });
          } else {
            // Non-image attachments: metadata-only note prepended to prompt
            const sizeKB = Math.round(att.data.byteLength / 1024);
            fullPrompt = `[Attached: ${att.mimeType} "${att.filename ?? 'unnamed'}" (${sizeKB}KB)]\n${fullPrompt}`;
          }
        }
      }

      if (imageInputs.length > 0) {
        input = [...imageInputs, { type: 'text', text: fullPrompt }];
      } else {
        input = fullPrompt;
      }

      // Run with streaming
      const ac = new AbortController();
      this.abortControllers.set(request.sessionId, ac);

      const startupTimeoutMs = this.options.startupTimeoutMs ?? 30_000;
      const timeoutMessage = 'Codex did not start responding in time.';
      const streamed = await awaitWithTimeout(
        thread.runStreamed(input, { signal: ac.signal }),
        startupTimeoutMs,
        timeoutMessage,
        () => ac.abort(),
      );
      let threadId: string | undefined = isProvisionalRemoteSdkSessionId(request.sdkSessionId)
        ? undefined
        : request.sdkSessionId;
      let responseText = '';
      let terminalError: string | undefined;
      let sawTurnCompleted = false;

      const applyEvent = (event: ThreadEvent): AgentEvent[] | null => {
        // Capture thread ID from thread.started
        if (event.type === 'thread.started') {
          threadId = event.thread_id;
        }

        // Accumulate final response from agent_message items
        if (event.type === 'item.completed' && event.item.type === 'agent_message') {
          responseText = event.item.text;
        }

        if (event.type === 'item.completed' && event.item.type === 'file_change') {
          const restored = restoreProtectedFiles(
            request.workingDirectory,
            protectedFiles,
            event.item.changes.map((change) => change.path),
          );
          for (const filePath of restored) blockedProtectedPaths.add(filePath);
        }

        // Handle turn completion
        if (event.type === 'turn.completed') {
          sawTurnCompleted = true;
        }

        // Handle turn failure
        if (event.type === 'turn.failed') {
          terminalError = event.error.message;
        }

        if (event.type === 'error') {
          terminalError = event.message;
        }

        return this.mapEvent(event, base);
      };

      const iterator = streamed.events[Symbol.asyncIterator]();
      const firstEvent = await awaitWithTimeout(
        iterator.next(),
        startupTimeoutMs,
        timeoutMessage,
        () => ac.abort(),
      );

      if (firstEvent.done) {
        throw new Error('Codex stream ended before producing any events.');
      }

      const firstMapped = applyEvent(firstEvent.value);
      if (firstMapped) {
        for (const ev of firstMapped) yield ev;
      }

      const remainingEvents: AsyncIterable<ThreadEvent> = {
        [Symbol.asyncIterator]() {
          return iterator;
        },
      };

      for await (const event of remainingEvents) {
        const mapped = applyEvent(event);
        if (mapped) {
          for (const ev of mapped) yield ev;
        }
      }

      const restored = restoreModifiedProtectedFiles(protectedFiles);
      for (const filePath of restored) blockedProtectedPaths.add(filePath);
      if (blockedProtectedPaths.size > 0) {
        const files = [...blockedProtectedPaths].join(', ');
        const suffix = terminalError ? ` Underlying error: ${terminalError}` : '';
        yield { ...base, type: 'error', error: `Blocked protected file modification and restored: ${files}.${suffix}` };
      } else if (terminalError) {
        yield { ...base, type: 'error', error: terminalError };
      } else if (sawTurnCompleted) {
        yield { ...base, type: 'complete', response: responseText, sdkSessionId: threadId };
      }
    } catch (err) {
      const restored = restoreModifiedProtectedFiles(protectedFiles);
      const suffix = restored.length > 0 ? ` Protected files restored: ${restored.join(', ')}` : '';
      yield { ...base, type: 'error', error: `${(err as Error).message}${suffix}` };
    } finally {
      this.abortControllers.delete(request.sessionId);
      for (const f of tempFiles) {
        try { unlinkSync(f); } catch { /* ignore cleanup errors */ }
      }
    }
  }

  async abort(sessionId: string): Promise<void> {
    const ac = this.abortControllers.get(sessionId);
    if (ac) {
      ac.abort();
      this.abortControllers.delete(sessionId);
    }
  }

  private mapEvent(event: ThreadEvent, base: AgentEventBase): AgentEvent[] | null {
    switch (event.type) {
      case 'item.started':
        return this.mapItemStarted(event.item, base);
      case 'item.updated':
        return this.mapItemUpdated(event.item, base);
      case 'item.completed':
        return this.mapItemCompleted(event.item, base);
      default:
        return null;
    }
  }

  private mapItemStarted(item: { type: string; [key: string]: unknown }, base: AgentEventBase): AgentEvent[] | null {
    switch (item.type) {
      case 'command_execution':
        return [{ ...base, type: 'tool_use', tool: `Bash: ${(item as any).command ?? ''}` }];
      case 'file_change':
        return [{ ...base, type: 'tool_use', tool: 'FileChange' }];
      case 'mcp_tool_call':
        return [{ ...base, type: 'tool_use', tool: `${(item as any).server}/${(item as any).tool}` }];
      case 'web_search':
        return [{ ...base, type: 'tool_use', tool: `WebSearch: ${(item as any).query ?? ''}` }];
      default:
        return null;
    }
  }

  private mapItemUpdated(item: { type: string; [key: string]: unknown }, base: AgentEventBase): AgentEvent[] | null {
    switch (item.type) {
      case 'agent_message':
        if ((item as any).text) {
          return [{ ...base, type: 'text', content: (item as any).text }];
        }
        return null;
      case 'reasoning':
        if ((item as any).text) {
          return [{ ...base, type: 'thinking', content: (item as any).text }];
        }
        return null;
      default:
        return null;
    }
  }

  private mapItemCompleted(item: { type: string; [key: string]: unknown }, base: AgentEventBase): AgentEvent[] | null {
    switch (item.type) {
      case 'command_execution': {
        const cmd = item as any;
        return [{
          ...base,
          type: 'tool_result',
          tool: 'Bash',
          toolInput: { command: cmd.command },
          toolOutput: cmd.aggregated_output ?? '',
        }];
      }
      case 'file_change': {
        const fc = item as any;
        const summary = (fc.changes ?? [])
          .map((c: any) => `${c.kind}: ${c.path}`)
          .join(', ');
        return [{
          ...base,
          type: 'tool_result',
          tool: 'FileChange',
          toolInput: { changes: fc.changes },
          toolOutput: summary,
        }];
      }
      case 'mcp_tool_call': {
        const mcp = item as any;
        const output = mcp.error?.message ?? JSON.stringify(mcp.result ?? '');
        return [{
          ...base,
          type: 'tool_result',
          tool: `${mcp.server}/${mcp.tool}`,
          toolInput: mcp.arguments ?? {},
          toolOutput: output,
        }];
      }
      default:
        return null;
    }
  }
}
