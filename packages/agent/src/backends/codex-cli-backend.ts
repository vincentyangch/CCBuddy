import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentBackend, AgentRequest, AgentEvent, AgentEventBase, PermissionGateRule } from '@ccbuddy/core';
import { generateCodexRules } from './codex-rules.js';
import { restoreModifiedProtectedFiles, serializeCodexConfigOverrides, snapshotProtectedFiles, type CodexConfigOverrideObject } from './codex-runtime-helpers.js';
import { isProvisionalRemoteSdkSessionId } from '../session/session-store.js';

export interface CodexCliBackendOptions {
  codexPath?: string;
  apiKey?: string;
  networkAccess?: boolean;
  defaultSandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  permissionGateRules?: PermissionGateRule[];
}

export class CodexCliBackend implements AgentBackend {
  private readonly options: CodexCliBackendOptions;
  private processes: Map<string, ChildProcess> = new Map();
  private readonly rulesFilePath: string | null;

  constructor(options: CodexCliBackendOptions = {}) {
    this.options = options;

    if (options.permissionGateRules && options.permissionGateRules.length > 0) {
      const rulesDir = join(tmpdir(), `ccbuddy-codex-rules-${randomUUID()}`);
      mkdirSync(rulesDir, { recursive: true });
      this.rulesFilePath = join(rulesDir, 'ccbuddy.rules');
      writeFileSync(this.rulesFilePath, generateCodexRules(options.permissionGateRules), 'utf8');
    } else {
      this.rulesFilePath = null;
    }
  }

  async *execute(request: AgentRequest): AsyncGenerator<AgentEvent> {
    const base: AgentEventBase = {
      sessionId: request.sessionId,
      userId: request.userId,
      channelId: request.channelId,
      platform: request.platform,
    };

    let attachmentNote = '';
    if (request.attachments && request.attachments.length > 0) {
      console.warn('[CodexCliBackend] File/voice attachments not supported — including metadata only');
      attachmentNote = request.attachments
        .filter(a => a.type !== 'image')
        .map(a => {
          const sizeKB = Math.round(a.data.byteLength / 1024);
          return `[Attached: ${a.mimeType} "${a.filename ?? 'unnamed'}" (${sizeKB}KB)]`;
        }).join('\n');
      if (attachmentNote) attachmentNote += '\n\n';
    }

    // Build full prompt with memory context and system prompt
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

    const args: string[] = ['exec', '--experimental-json'];
    const configOverrides: CodexConfigOverrideObject = {};
    const protectedFiles = snapshotProtectedFiles(request.workingDirectory, this.options.permissionGateRules);

    if (request.workingDirectory) args.push('--cd', request.workingDirectory);
    if (request.model) args.push('--model', request.model);
    if (request.reasoningEffort) {
      configOverrides.model_reasoning_effort = request.reasoningEffort;
    }
    if (request.verbosity) {
      configOverrides.model_verbosity = request.verbosity;
    }

    if (this.options.networkAccess !== undefined) {
      configOverrides.sandbox_workspace_write = { network_access: this.options.networkAccess };
    }
    if (this.rulesFilePath) {
      configOverrides.exec_policy = { rules_file: this.rulesFilePath };
    }

    // Image attachments via --image flags
    const tempImages: string[] = [];
    if (request.attachments) {
      for (const att of request.attachments) {
        if (att.type === 'image') {
          const ext = att.mimeType.split('/')[1] || 'png';
          const tempPath = join(tmpdir(), `ccbuddy-img-${randomUUID()}.${ext}`);
          writeFileSync(tempPath, att.data);
          tempImages.push(tempPath);
          args.push('--image', tempPath);
        }
      }
    }

    // Sandbox mode based on permission level
    switch (request.permissionLevel) {
      case 'admin':
      case 'system':
        args.push('--sandbox', 'danger-full-access');
        configOverrides.approval_policy = 'never';
        break;
      case 'trusted':
        args.push('--sandbox', this.options.defaultSandbox ?? 'workspace-write');
        configOverrides.approval_policy = 'never';
        break;
      case 'chat':
        args.push('--sandbox', 'read-only');
        configOverrides.approval_policy = 'never';
        break;
    }

    if (request.mcpServers && request.mcpServers.length > 0) {
      configOverrides.mcp_servers = Object.fromEntries(request.mcpServers.map((server) => [
        server.name,
        {
          type: 'stdio',
          command: server.command,
          args: server.args,
          ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
        },
      ]));
    }

    for (const override of serializeCodexConfigOverrides(configOverrides)) {
      args.push('--config', override);
    }

    // Session resumption
    if (request.resumeSessionId) {
      args.push('resume', request.resumeSessionId);
    }

    try {
      const result = await this.runCodex(args, attachmentNote + fullPrompt, request.sessionId, request.env);
      const restored = restoreModifiedProtectedFiles(protectedFiles);
      if (restored.length > 0) {
        const suffix = result.error ? ` Underlying error: ${result.error}` : '';
        yield { ...base, type: 'error', error: `Blocked protected file modification and restored: ${restored.join(', ')}.${suffix}` };
      } else if (result.error) {
        yield { ...base, type: 'error', error: result.error };
      } else {
        const fallbackThreadId = isProvisionalRemoteSdkSessionId(request.sdkSessionId)
          ? undefined
          : request.sdkSessionId;
        yield { ...base, type: 'complete', response: result.text, sdkSessionId: result.threadId ?? fallbackThreadId };
      }
    } catch (err) {
      const restored = restoreModifiedProtectedFiles(protectedFiles);
      const suffix = restored.length > 0 ? ` Protected files restored: ${restored.join(', ')}` : '';
      yield { ...base, type: 'error', error: `${(err as Error).message}${suffix}` };
    } finally {
      for (const f of tempImages) {
        try { unlinkSync(f); } catch { /* ignore */ }
      }
    }
  }

  async abort(sessionId: string): Promise<void> {
    const proc = this.processes.get(sessionId);
    if (proc) {
      proc.kill('SIGTERM');
      this.processes.delete(sessionId);
    }
  }

  destroy(): void {
    if (this.rulesFilePath) {
      try { rmSync(dirname(this.rulesFilePath), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  private runCodex(
    args: string[],
    prompt: string,
    sessionId: string,
    extraEnv?: Record<string, string>,
  ): Promise<{ text: string; threadId?: string; error?: string }> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...extraEnv } as Record<string, string>;
      if (this.options.apiKey) {
        env.CODEX_API_KEY = this.options.apiKey;
      }

      const proc = spawn(this.options.codexPath ?? 'codex', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
      this.processes.set(sessionId, proc);

      // Send prompt via stdin
      proc.stdin.write(prompt);
      proc.stdin.end();

      let stdout = '';
      let stderr = '';
      let spawnError: Error | null = null;

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      proc.once('error', (err) => {
        spawnError = err;
      });

      proc.on('close', (code: number | null) => {
        this.processes.delete(sessionId);
        try {
          // Parse NDJSON — extract final response and thread ID
          const lines = stdout.trim().split('\n').filter(Boolean);
          let responseText = '';
          let threadId: string | undefined;
          let turnError: string | undefined;
          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              if (obj.type === 'thread.started' && obj.thread_id) {
                threadId = obj.thread_id;
              } else if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
                responseText = obj.item.text ?? '';
              } else if (obj.type === 'turn.failed') {
                turnError = obj.error?.message ?? 'Codex turn failed';
              }
            } catch { /* skip unparseable lines */ }
          }
          const exitError = code !== 0
            ? `codex CLI exited with code ${code}: ${stderr || spawnError?.message || 'unknown error'}`
            : undefined;
          resolve({ text: responseText || stdout, threadId, error: turnError ?? exitError });
        } catch {
          if (code !== 0) {
            reject(new Error(`codex CLI exited with code ${code}: ${stderr || spawnError?.message || 'unknown error'}`));
          } else {
            resolve({ text: stdout });
          }
        }
      });
    });
  }
}
