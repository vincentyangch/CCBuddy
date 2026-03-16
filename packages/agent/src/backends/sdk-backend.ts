import type { AgentBackend, AgentRequest, AgentEvent, AgentEventBase } from '@ccbuddy/core';
import { query } from '@anthropic-ai/claude-code';

export interface SdkBackendOptions {
  skipPermissions?: boolean;
}

// Known limitation: The SDK `query()` function returns the full result, so
// streaming intermediate events (text chunks, tool_use) is not yet supported.
// When the SDK adds a streaming/callback API, update this backend to yield
// intermediate events. For now, only 'complete' or 'error' events are emitted.

export class SdkBackend implements AgentBackend {
  private options: SdkBackendOptions;

  constructor(options: SdkBackendOptions = {}) {
    this.options = options;
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
        sessionId: request.sessionId,
      };

      if (request.systemPrompt) {
        options.systemPrompt = request.systemPrompt;
      }

      if (request.permissionLevel === 'admin' && this.options.skipPermissions) {
        options.permissions = { allow: ['*'], deny: [] };
      } else if (request.permissionLevel === 'chat') {
        options.allowedTools = [];
      }

      let fullPrompt = request.prompt;
      if (request.memoryContext) {
        fullPrompt = `<memory_context>\n${request.memoryContext}\n</memory_context>\n\n${request.prompt}`;
      }

      const result = await query(fullPrompt, options);

      const responseText = Array.isArray(result)
        ? result
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text)
            .join('\n')
        : String(result);

      yield { ...base, type: 'complete', response: responseText };
    } catch (err) {
      yield { ...base, type: 'error', error: (err as Error).message };
    }
  }

  async abort(_sessionId: string): Promise<void> {
    // SDK doesn't have a direct abort — future: track AbortControllers per session
  }
}
