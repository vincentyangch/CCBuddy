import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentBackend, AgentRequest, AgentEvent, AgentEventBase } from '@ccbuddy/core';

export class CodexCliBackend implements AgentBackend {
  private processes: Map<string, ChildProcess> = new Map();

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

    if (request.workingDirectory) args.push('--cd', request.workingDirectory);
    if (request.model) args.push('--model', request.model);

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
        break;
      case 'trusted':
        args.push('--sandbox', 'workspace-write');
        break;
      case 'chat':
        args.push('--sandbox', 'read-only');
        break;
    }

    // Session resumption
    if (request.resumeSessionId) {
      args.push('resume', request.resumeSessionId);
    }

    // MCP config via temp TOML file
    let mcpConfigPath: string | undefined;
    if (request.mcpServers && request.mcpServers.length > 0) {
      mcpConfigPath = this.writeTempMcpConfig(request.mcpServers);
      args.push('--config', `config_file=${mcpConfigPath}`);
    }

    try {
      const result = await this.runCodex(args, attachmentNote + fullPrompt, request.sessionId, request.env);
      yield { ...base, type: 'complete', response: result };
    } catch (err) {
      yield { ...base, type: 'error', error: (err as Error).message };
    } finally {
      if (mcpConfigPath) {
        try { unlinkSync(mcpConfigPath); } catch { /* ignore */ }
      }
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

  private writeTempMcpConfig(mcpServers: AgentRequest['mcpServers']): string {
    let toml = '';
    for (const s of mcpServers ?? []) {
      toml += `[mcp_servers.${s.name}]\n`;
      toml += `type = "stdio"\n`;
      toml += `command = "${s.command}"\n`;
      toml += `args = [${s.args.map(a => `"${a}"`).join(', ')}]\n\n`;
    }
    const configPath = join(tmpdir(), `ccbuddy-codex-mcp-${randomUUID()}.toml`);
    writeFileSync(configPath, toml);
    return configPath;
  }

  private runCodex(
    args: string[],
    prompt: string,
    sessionId: string,
    extraEnv?: Record<string, string>,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...extraEnv } as Record<string, string>;
      const proc = spawn('codex', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
      this.processes.set(sessionId, proc);

      // Send prompt via stdin
      proc.stdin.write(prompt);
      proc.stdin.end();

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code: number | null) => {
        this.processes.delete(sessionId);
        if (code !== 0) {
          reject(new Error(`codex CLI exited with code ${code}: ${stderr}`));
          return;
        }
        try {
          // Parse NDJSON — extract final response
          const lines = stdout.trim().split('\n').filter(Boolean);
          let responseText = '';
          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
                responseText = obj.item.text ?? '';
              } else if (obj.type === 'turn.failed') {
                reject(new Error(obj.error?.message ?? 'Codex turn failed'));
                return;
              }
            } catch { /* skip unparseable lines */ }
          }
          resolve(responseText || stdout);
        } catch {
          resolve(stdout);
        }
      });
    });
  }
}
