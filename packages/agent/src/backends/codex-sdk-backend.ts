import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentBackend, AgentRequest, AgentEvent, AgentEventBase } from '@ccbuddy/core';
import { Codex, type ThreadOptions, type ThreadEvent, type Input, type UserInput } from '@openai/codex-sdk';

export interface CodexSdkBackendOptions {
  codexPath?: string;
  apiKey?: string;
  networkAccess?: boolean;
  defaultSandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}

export class CodexSdkBackend implements AgentBackend {
  private readonly options: CodexSdkBackendOptions;
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(options: CodexSdkBackendOptions = {}) {
    this.options = options;
  }

  async *execute(request: AgentRequest): AsyncGenerator<AgentEvent> {
    const base: AgentEventBase = {
      sessionId: request.sessionId,
      userId: request.userId,
      channelId: request.channelId,
      platform: request.platform,
    };

    const tempFiles: string[] = [];

    try {
      // Build Codex instance with env and optional overrides
      const codexEnv: Record<string, string> = { ...process.env as Record<string, string> };
      if (request.env) Object.assign(codexEnv, request.env);
      if (this.options.apiKey) codexEnv.OPENAI_API_KEY = this.options.apiKey;

      const codexConfig: Record<string, string | string[] | Record<string, string>> = {};

      // MCP servers — pass via config overrides
      if (request.mcpServers && request.mcpServers.length > 0) {
        for (const s of request.mcpServers) {
          codexConfig[`mcp_servers.${s.name}.type`] = 'stdio';
          codexConfig[`mcp_servers.${s.name}.command`] = s.command;
          codexConfig[`mcp_servers.${s.name}.args`] = s.args;
          if (s.env) codexConfig[`mcp_servers.${s.name}.env`] = s.env;
        }
      }

      const codex = new Codex({
        codexPathOverride: this.options.codexPath,
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

      const streamed = await thread.runStreamed(input, { signal: ac.signal });
      let threadId: string | undefined = request.sdkSessionId;
      let responseText = '';

      for await (const event of streamed.events) {
        const mapped = this.mapEvent(event, base);
        if (mapped) {
          for (const ev of mapped) yield ev;
        }

        // Capture thread ID from thread.started
        if (event.type === 'thread.started') {
          threadId = event.thread_id;
        }

        // Accumulate final response from agent_message items
        if (event.type === 'item.completed' && event.item.type === 'agent_message') {
          responseText = event.item.text;
        }

        // Handle turn completion
        if (event.type === 'turn.completed') {
          yield { ...base, type: 'complete', response: responseText, sdkSessionId: threadId };
        }

        // Handle turn failure
        if (event.type === 'turn.failed') {
          yield { ...base, type: 'error', error: event.error.message };
        }
      }
    } catch (err) {
      yield { ...base, type: 'error', error: (err as Error).message };
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
      case 'error':
        return [{ ...base, type: 'error', error: event.message }];
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
