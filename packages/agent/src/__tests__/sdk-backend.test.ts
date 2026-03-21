import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SdkBackend } from '../backends/sdk-backend.js';
import type { AgentRequest, Attachment } from '@ccbuddy/core';

// Mock @anthropic-ai/claude-agent-sdk
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: vi.fn(),
  };
});

import { query } from '@anthropic-ai/claude-agent-sdk';
const mockQuery = query as ReturnType<typeof vi.fn>;

function makeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    prompt: 'Hello',
    userId: 'user1',
    sessionId: 'sess-1',
    channelId: 'general',
    platform: 'discord',
    permissionLevel: 'admin',
    ...overrides,
  };
}

async function* successGenerator() {
  yield { type: 'result', subtype: 'success', result: 'Hello back!' };
}

describe('SdkBackend', () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockReturnValue(successGenerator());
  });

  it('passes through admin requests without chat restriction', async () => {
    const backend = new SdkBackend({ skipPermissions: false });
    const events = [];
    for await (const event of backend.execute(makeRequest({ permissionLevel: 'admin' }))) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('complete');

    const callArg = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> };
    const callOptions = callArg.options;
    // No chat restriction for admin
    expect(callOptions['systemPrompt'] ?? '').not.toContain('chat-only mode');
  });

  it('adds system prompt restriction for chat users', async () => {
    const backend = new SdkBackend();
    const events = [];
    for await (const event of backend.execute(makeRequest({ permissionLevel: 'chat' }))) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('complete');

    const callArg = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> };
    const callOptions = callArg.options;
    expect(callOptions['allowedTools']).toEqual([]);
    expect(callOptions['systemPrompt'] as string).toContain('chat-only mode');
    expect(callOptions['systemPrompt'] as string).toContain('Do NOT use any tools');
  });

  it('prepends existing system prompt with chat restriction for chat users', async () => {
    const backend = new SdkBackend();
    const events = [];
    for await (const event of backend.execute(
      makeRequest({ permissionLevel: 'chat', systemPrompt: 'You are a helpful assistant.' })
    )) {
      events.push(event);
    }

    const callArg = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> };
    const callOptions = callArg.options;
    const sp = callOptions['systemPrompt'] as string;
    expect(sp).toContain('You are a helpful assistant.');
    expect(sp).toContain('chat-only mode');
    // Original prompt should come first
    const idx1 = sp.indexOf('You are a helpful assistant.');
    const idx2 = sp.indexOf('chat-only mode');
    expect(idx1).toBeLessThan(idx2);
  });

  it('sets bypassPermissions for admin with skipPermissions=true', async () => {
    const backend = new SdkBackend({ skipPermissions: true });
    for await (const _event of backend.execute(makeRequest({ permissionLevel: 'admin' }))) {}

    const callArg = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> };
    const callOptions = callArg.options;
    expect(callOptions['permissionMode']).toBe('bypassPermissions');
    expect(callOptions['allowDangerouslySkipPermissions']).toBe(true);
  });

  it('passes image attachments as content blocks via AsyncIterable', async () => {
    const imageAttachment: Attachment = {
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from('fake-png-data'),
    };

    const backend = new SdkBackend();
    const events = [];
    for await (const event of backend.execute(makeRequest({ attachments: [imageAttachment] }))) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('complete');

    // query() should have been called with an async iterable (not a string) for the prompt
    const callArg = mockQuery.mock.calls[0][0] as { prompt: unknown; options: Record<string, unknown> };
    const passedPrompt = callArg.prompt;
    expect(typeof passedPrompt).not.toBe('string');
    expect(passedPrompt != null && typeof (passedPrompt as any)[Symbol.asyncIterator] === 'function').toBe(true);

    // Collect the yielded user message from the async iterable
    const messages = [];
    for await (const msg of passedPrompt as AsyncIterable<unknown>) {
      messages.push(msg);
    }
    expect(messages).toHaveLength(1);
    const userMsg = messages[0] as any;
    expect(userMsg.type).toBe('user');
    expect(userMsg.parent_tool_use_id).toBeNull();

    const content = userMsg.message.content as any[];
    // First block should be the image content block
    expect(content[0].type).toBe('image');
    expect(content[0].source.type).toBe('base64');
    expect(content[0].source.media_type).toBe('image/png');
    expect(content[0].source.data).toBe(Buffer.from('fake-png-data').toString('base64'));
    // Last block should be the text prompt
    const textBlock = content[content.length - 1];
    expect(textBlock.type).toBe('text');
    expect(textBlock.text).toBe('Hello');
  });

  it('uses plain string prompt when no attachments are present', async () => {
    const backend = new SdkBackend();
    for await (const _event of backend.execute(makeRequest())) {}

    const callArg = mockQuery.mock.calls[0][0] as { prompt: unknown; options: Record<string, unknown> };
    expect(typeof callArg.prompt).toBe('string');
    expect(callArg.prompt).toBe('Hello');
  });

  it('uses plain string prompt when attachments array is empty', async () => {
    const backend = new SdkBackend();
    for await (const _event of backend.execute(makeRequest({ attachments: [] }))) {}

    const callArg = mockQuery.mock.calls[0][0] as { prompt: unknown; options: Record<string, unknown> };
    expect(typeof callArg.prompt).toBe('string');
    expect(callArg.prompt).toBe('Hello');
  });

  it('skips non-image non-pdf attachments and falls back to plain string', async () => {
    const textAttachment: Attachment = {
      type: 'file',
      mimeType: 'text/plain',
      data: Buffer.from('some text'),
    };

    const backend = new SdkBackend();
    for await (const _event of backend.execute(makeRequest({ attachments: [textAttachment] }))) {}

    // text/plain produces no content blocks — should fall back to plain string
    const callArg = mockQuery.mock.calls[0][0] as { prompt: unknown; options: Record<string, unknown> };
    expect(typeof callArg.prompt).toBe('string');
    expect(callArg.prompt).toBe('Hello');
  });

  it('passes sessionId option for new sessions', async () => {
    const backend = new SdkBackend();
    const events = [];
    for await (const event of backend.execute(makeRequest({ sdkSessionId: 'test-uuid-123' }))) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('complete');
    if (events[0].type === 'complete') {
      expect(events[0].sdkSessionId).toBe('test-uuid-123');
    }

    const callArg = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> };
    expect(callArg.options['sessionId']).toBe('test-uuid-123');
    expect(callArg.options['resume']).toBeUndefined();
  });

  it('passes resume option for existing sessions', async () => {
    const backend = new SdkBackend();
    const events = [];
    for await (const event of backend.execute(makeRequest({ resumeSessionId: 'existing-uuid-456' }))) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('complete');
    if (events[0].type === 'complete') {
      expect(events[0].sdkSessionId).toBe('existing-uuid-456');
    }

    const callArg = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> };
    expect(callArg.options['resume']).toBe('existing-uuid-456');
    expect(callArg.options['sessionId']).toBeUndefined();
  });

  it('does not set sessionId or resume when neither is provided', async () => {
    const backend = new SdkBackend();
    for await (const _event of backend.execute(makeRequest())) {}

    const callArg = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> };
    expect(callArg.options['sessionId']).toBeUndefined();
    expect(callArg.options['resume']).toBeUndefined();
  });

  it('yields thinking events from assistant messages', async () => {
    async function* thinkingGenerator() {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Let me think about this...' },
            { type: 'text', text: 'Here is my answer.' },
          ],
        },
      };
      yield { type: 'result', subtype: 'success', result: 'Here is my answer.' };
    }
    mockQuery.mockReturnValue(thinkingGenerator());

    const backend = new SdkBackend();
    const events = [];
    for await (const event of backend.execute(makeRequest())) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThanOrEqual(3);
    const thinking = events.find(e => e.type === 'thinking');
    expect(thinking).toBeDefined();
    if (thinking && thinking.type === 'thinking') {
      expect(thinking.content).toBe('Let me think about this...');
    }
    const text = events.find(e => e.type === 'text');
    expect(text).toBeDefined();
    if (text && text.type === 'text') {
      expect(text.content).toBe('Here is my answer.');
    }
    const complete = events.find(e => e.type === 'complete');
    expect(complete).toBeDefined();
  });

  it('yields tool_use events from assistant messages', async () => {
    async function* toolGenerator() {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      };
      yield { type: 'result', subtype: 'success', result: 'Done!' };
    }
    mockQuery.mockReturnValue(toolGenerator());

    const backend = new SdkBackend();
    const events = [];
    for await (const event of backend.execute(makeRequest())) {
      events.push(event);
    }

    const toolUse = events.find(e => e.type === 'tool_use');
    expect(toolUse).toBeDefined();
    if (toolUse && toolUse.type === 'tool_use') {
      expect(toolUse.tool).toBe('Bash');
    }
  });

  it('does not yield thinking when assistant has no thinking blocks', async () => {
    async function* plainGenerator() {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Simple answer.' },
          ],
        },
      };
      yield { type: 'result', subtype: 'success', result: 'Simple answer.' };
    }
    mockQuery.mockReturnValue(plainGenerator());

    const backend = new SdkBackend();
    const events = [];
    for await (const event of backend.execute(makeRequest())) {
      events.push(event);
    }

    const thinking = events.find(e => e.type === 'thinking');
    expect(thinking).toBeUndefined();
    const complete = events.find(e => e.type === 'complete');
    expect(complete).toBeDefined();
  });

  it('passes canUseTool callback when requestUserInput is provided', async () => {
    const backend = new SdkBackend();
    const requestUserInput = vi.fn().mockResolvedValue({ 'Which option?': 'Option A' });
    for await (const _event of backend.execute(makeRequest({ requestUserInput }))) {}

    const callArg = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> };
    expect(callArg.options['canUseTool']).toBeDefined();
    expect(typeof callArg.options['canUseTool']).toBe('function');
  });

  it('does not set canUseTool when requestUserInput is absent', async () => {
    const backend = new SdkBackend();
    for await (const _event of backend.execute(makeRequest())) {}

    const callArg = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> };
    expect(callArg.options['canUseTool']).toBeUndefined();
  });

  it('canUseTool calls requestUserInput for AskUserQuestion and returns allow', async () => {
    const answers = { 'Pick a color': 'Blue' };
    const requestUserInput = vi.fn().mockResolvedValue(answers);
    const backend = new SdkBackend();
    for await (const _event of backend.execute(makeRequest({ requestUserInput }))) {}

    const callArg = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> };
    const canUseTool = callArg.options['canUseTool'] as Function;

    const questions = [{ question: 'Pick a color', header: 'Colors', options: [{ label: 'Blue', description: 'A blue color' }], multiSelect: false }];
    const result = await canUseTool('AskUserQuestion', { questions }, { signal: new AbortController().signal });

    expect(requestUserInput).toHaveBeenCalledWith(questions, expect.any(AbortSignal));
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { questions, answers },
    });
  });

  it('canUseTool returns deny with message when requestUserInput returns null', async () => {
    const requestUserInput = vi.fn().mockResolvedValue(null);
    const backend = new SdkBackend();
    for await (const _event of backend.execute(makeRequest({ requestUserInput }))) {}

    const callArg = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> };
    const canUseTool = callArg.options['canUseTool'] as Function;

    const result = await canUseTool('AskUserQuestion', { questions: [] }, { signal: new AbortController().signal });
    expect(result.behavior).toBe('deny');
    expect(result.message).toBeDefined();
    expect(typeof result.message).toBe('string');
  });

  it('canUseTool returns allow for non-AskUserQuestion tools', async () => {
    const requestUserInput = vi.fn();
    const backend = new SdkBackend();
    for await (const _event of backend.execute(makeRequest({ requestUserInput }))) {}

    const callArg = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> };
    const canUseTool = callArg.options['canUseTool'] as Function;

    const result = await canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal });
    expect(result).toEqual({ behavior: 'allow' });
    expect(requestUserInput).not.toHaveBeenCalled();
  });
});
