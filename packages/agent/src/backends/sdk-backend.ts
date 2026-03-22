import type { AgentBackend, AgentRequest, AgentEvent, AgentEventBase, PermissionGateConfig } from '@ccbuddy/core';
import { PermissionGateChecker } from '../permission-gate.js';
import { attachmentsToContentBlocks } from '@ccbuddy/core';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export interface SdkBackendOptions {
  skipPermissions?: boolean;
  permissionGates?: PermissionGateConfig;
  trustedAllowedTools?: string[];
  maxTurns?: number;
}

// Known limitation: The SDK `query()` function yields SDKMessage events as an
// AsyncGenerator. We collect the final 'result' message to emit a 'complete'
// event. When streaming intermediate text chunks is needed, iterate events
// where msg.type === 'assistant' and yield them as 'text' events.

export class SdkBackend implements AgentBackend {
  private options: SdkBackendOptions;
  private gateChecker: PermissionGateChecker | null;

  constructor(options: SdkBackendOptions = {}) {
    this.options = options;
    this.gateChecker = options.permissionGates?.rules
      ? new PermissionGateChecker(options.permissionGates.rules)
      : null;
  }

  async *execute(request: AgentRequest): AsyncGenerator<AgentEvent> {
    const base: AgentEventBase = {
      sessionId: request.sessionId,
      userId: request.userId,
      channelId: request.channelId,
      platform: request.platform,
    };

    try {
      const options: Record<string, any> = {
        allowedTools: request.allowedTools,
        cwd: request.workingDirectory,
        settingSources: ['user', 'project', 'local'],
      };

      if (this.options.maxTurns) {
        options.maxTurns = this.options.maxTurns;
      }

      if (request.model) {
        options.model = request.model;
      }

      if (request.systemPrompt) {
        options.systemPrompt = request.systemPrompt;
      }

      if (request.mcpServers && request.mcpServers.length > 0) {
        // Stdio MCP servers (subprocess) — fallback for CLI backend compatibility
        const stdioServers = Object.fromEntries(
          request.mcpServers.map(s => [s.name, { type: 'stdio' as const, command: s.command, args: s.args, env: s.env }])
        );
        options.mcpServers = { ...options.mcpServers, ...stdioServers };
      }

      if (request.permissionLevel === 'admin' && this.options.skipPermissions) {
        options.permissionMode = 'bypassPermissions';
        options.allowDangerouslySkipPermissions = true;
      } else if (request.permissionLevel === 'system') {
        // System-level requests (scheduler, heartbeat, webhooks) run unattended —
        // bypass permissions since no user is present to approve prompts
        options.permissionMode = 'bypassPermissions';
        options.allowDangerouslySkipPermissions = true;
      } else if (request.permissionLevel === 'trusted') {
        options.allowedTools = this.options.trustedAllowedTools ?? [];
        // Permission gates stay active — no bypass, no skip
      } else if (request.permissionLevel === 'chat') {
        options.allowedTools = [];
        // Restrict to text-only responses for chat users
        const chatRestriction = 'IMPORTANT: You are in chat-only mode. Do NOT use any tools (no Bash, no file operations, no web searches). Only respond with text.';
        options.systemPrompt = options.systemPrompt
          ? `${options.systemPrompt}\n\n${chatRestriction}`
          : chatRestriction;
      }

      // Session continuity — mutually exclusive: resume OR sessionId, never both
      let sdkSessionId: string | undefined;
      if (request.resumeSessionId) {
        options.resume = request.resumeSessionId;
        sdkSessionId = request.resumeSessionId;
      } else if (request.sdkSessionId) {
        options.sessionId = request.sdkSessionId;
        sdkSessionId = request.sdkSessionId;
      }

      // canUseTool — handles AskUserQuestion + permission gates
      if (request.requestUserInput) {
        const checker = this.gateChecker;
        const gatesEnabled = this.options.permissionGates?.enabled && !this.options.skipPermissions;

        options.canUseTool = async (toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal }) => {
          // AskUserQuestion — existing handler
          if (toolName === 'AskUserQuestion' && request.requestUserInput) {
            const answers = await request.requestUserInput(input.questions as any, opts.signal);
            if (!answers) {
              return { behavior: 'deny', message: 'User did not respond within the timeout period' };
            }
            return { behavior: 'allow', updatedInput: { ...input, answers } };
          }

          // Permission gates — check against rules
          if (gatesEnabled && checker) {
            const matched = checker.check(toolName, input);
            if (matched) {
              console.info(`[SdkBackend] Permission gate triggered: "${matched.name}" for tool ${toolName} — awaiting approval`);

              const preview = this.getCommandPreview(toolName, input);
              const answers = await request.requestUserInput!([{
                question: `Po wants to run:\n\`${preview}\``,
                header: `⚠️ ${matched.description}`,
                options: [
                  { label: 'Allow', description: 'Execute this command' },
                  { label: 'Deny', description: 'Block this command' },
                ],
                multiSelect: false,
              }], opts.signal);

              if (!answers) {
                console.info(`[SdkBackend] Permission gate timed out: "${matched.name}"`);
                return { behavior: 'deny', message: `Approval timed out for: ${matched.description}` };
              }

              const decision = Object.values(answers)[0];
              if (decision === 'Allow') {
                console.info(`[SdkBackend] Permission gate approved: "${matched.name}" by user`);
                return { behavior: 'allow', updatedInput: input };
              } else {
                console.info(`[SdkBackend] Permission gate denied: "${matched.name}" by user`);
                return { behavior: 'deny', message: `User denied: ${matched.description}` };
              }
            }
          }

          return { behavior: 'allow', updatedInput: input };
        };
      }

      let fullPrompt = request.prompt;
      if (request.memoryContext) {
        fullPrompt = `<memory_context>\n${request.memoryContext}\n</memory_context>\n\n${request.prompt}`;
      }

      // Build prompt: use content blocks when attachments are present, otherwise plain string
      const contentBlocks = request.attachments && request.attachments.length > 0
        ? attachmentsToContentBlocks(request.attachments)
        : [];

      let prompt: string | AsyncIterable<SDKUserMessage>;
      if (contentBlocks.length > 0) {
        const messageContent = [
          ...contentBlocks,
          { type: 'text' as const, text: fullPrompt },
        ];
        const userMessage: SDKUserMessage = {
          type: 'user',
          message: { role: 'user', content: messageContent as any },
          parent_tool_use_id: null,
          session_id: '',
        };
        prompt = (async function* () { yield userMessage; })();
      } else {
        prompt = fullPrompt;
      }

      const result = query({ prompt, options });

      let responseText = '';
      for await (const msg of result) {
        if (msg.type === 'assistant') {
          // Extract content blocks from assistant messages
          const content = (msg as any).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'thinking' && block.thinking) {
                yield { ...base, type: 'thinking' as const, content: block.thinking };
              } else if (block.type === 'text' && block.text) {
                yield { ...base, type: 'text' as const, content: block.text };
              } else if (block.type === 'tool_use') {
                yield { ...base, type: 'tool_use' as const, tool: block.name ?? block.id };
              }
            }
          }
        } else if (msg.type === 'result') {
          if ((msg as any).subtype === 'success') {
            responseText = (msg as any).result ?? '';
          } else {
            const errors: string[] = (msg as any).errors ?? [];
            throw new Error(errors.join('; ') || `Query ended with subtype: ${(msg as any).subtype}`);
          }
        }
      }

      yield { ...base, type: 'complete', response: responseText, sdkSessionId };
    } catch (err) {
      yield { ...base, type: 'error', error: (err as Error).message };
    }
  }

  private getCommandPreview(toolName: string, input: Record<string, unknown>): string {
    let preview: string;
    switch (toolName) {
      case 'Bash':
        preview = typeof input.command === 'string' ? input.command : JSON.stringify(input);
        break;
      case 'Write':
      case 'Edit':
        preview = typeof input.file_path === 'string' ? `${toolName} ${input.file_path}` : JSON.stringify(input);
        break;
      default:
        preview = `${toolName}: ${JSON.stringify(input)}`;
    }
    return preview.length > 200 ? preview.slice(0, 200) + '...' : preview;
  }

  async abort(_sessionId: string): Promise<void> {
    // SDK doesn't have a direct abort — future: track AbortControllers per session
  }
}
