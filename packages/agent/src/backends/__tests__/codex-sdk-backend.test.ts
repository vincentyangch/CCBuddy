import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRequest, PermissionGateRule } from '@ccbuddy/core';

// Mock the Codex SDK
const mockRunStreamed = vi.fn();
const mockStartThread = vi.fn();
const mockResumeThread = vi.fn();

vi.mock('@openai/codex-sdk', () => {
  return {
    Codex: vi.fn().mockImplementation(() => ({
      startThread: mockStartThread,
      resumeThread: mockResumeThread,
    })),
  };
});

import { CodexSdkBackend } from '../codex-sdk-backend.js';
import { Codex } from '@openai/codex-sdk';
const MockCodex = vi.mocked(Codex);

/** Create an async generator that yields the given events */
async function* makeEventStream(...events: any[]) {
  for (const ev of events) yield ev;
}

function makeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    prompt: 'Hello',
    userId: 'dad',
    sessionId: 'dad-discord-dev',
    channelId: 'dev',
    platform: 'discord',
    permissionLevel: 'admin',
    ...overrides,
  };
}

describe('CodexSdkBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const thread = { id: 'thread-123', runStreamed: mockRunStreamed };
    mockStartThread.mockReturnValue(thread);
    mockResumeThread.mockReturnValue(thread);
  });

  it('emits complete event with response from agent_message', async () => {
    mockRunStreamed.mockResolvedValue({
      events: makeEventStream(
        { type: 'thread.started', thread_id: 'thread-123' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'Hello back!' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ),
    });

    const backend = new CodexSdkBackend();
    const events: any[] = [];
    for await (const event of backend.execute(makeRequest())) { events.push(event); }

    const complete = events.find(e => e.type === 'complete');
    expect(complete).toBeDefined();
    expect(complete.response).toBe('Hello back!');
    expect(complete.sdkSessionId).toBe('thread-123');
  });

  it('emits tool_use events for command execution', async () => {
    mockRunStreamed.mockResolvedValue({
      events: makeEventStream(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.started', item: { id: 'cmd1', type: 'command_execution', command: 'ls -la', aggregated_output: '', status: 'in_progress' } },
        { type: 'item.completed', item: { id: 'cmd1', type: 'command_execution', command: 'ls -la', aggregated_output: 'file.txt', exit_code: 0, status: 'completed' } },
        { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'Done' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ),
    });

    const backend = new CodexSdkBackend();
    const events: any[] = [];
    for await (const event of backend.execute(makeRequest())) { events.push(event); }

    const toolUse = events.find(e => e.type === 'tool_use');
    expect(toolUse).toBeDefined();
    expect(toolUse.tool).toContain('ls -la');

    const toolResult = events.find(e => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    expect(toolResult.tool).toBe('Bash');
    expect(toolResult.toolOutput).toBe('file.txt');
  });

  it('emits thinking events from reasoning items', async () => {
    mockRunStreamed.mockResolvedValue({
      events: makeEventStream(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.updated', item: { id: 'r1', type: 'reasoning', text: 'Let me think...' } },
        { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'Answer' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ),
    });

    const backend = new CodexSdkBackend();
    const events: any[] = [];
    for await (const event of backend.execute(makeRequest())) { events.push(event); }

    const thinking = events.find(e => e.type === 'thinking');
    expect(thinking).toBeDefined();
    expect(thinking.content).toBe('Let me think...');
  });

  it('emits error on turn failure', async () => {
    mockRunStreamed.mockResolvedValue({
      events: makeEventStream(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.failed', error: { message: 'Rate limited' } },
      ),
    });

    const backend = new CodexSdkBackend();
    const events: any[] = [];
    for await (const event of backend.execute(makeRequest())) { events.push(event); }

    const error = events.find(e => e.type === 'error');
    expect(error).toBeDefined();
    expect(error.error).toBe('Rate limited');
  });

  it('emits error on stream error event', async () => {
    mockRunStreamed.mockResolvedValue({
      events: makeEventStream(
        { type: 'error', message: 'Connection lost' },
      ),
    });

    const backend = new CodexSdkBackend();
    const events: any[] = [];
    for await (const event of backend.execute(makeRequest())) { events.push(event); }

    const error = events.find(e => e.type === 'error');
    expect(error).toBeDefined();
    expect(error.error).toBe('Connection lost');
  });

  it('resumes thread when resumeSessionId is provided', async () => {
    mockRunStreamed.mockResolvedValue({
      events: makeEventStream(
        { type: 'thread.started', thread_id: 'existing-thread' },
        { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'Resumed' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ),
    });

    const backend = new CodexSdkBackend();
    const request = makeRequest({ resumeSessionId: 'existing-thread' });
    const events: any[] = [];
    for await (const event of backend.execute(request)) { events.push(event); }

    expect(mockResumeThread).toHaveBeenCalledWith('existing-thread', expect.any(Object));
    expect(mockStartThread).not.toHaveBeenCalled();
  });

  it('starts new thread when no resumeSessionId', async () => {
    mockRunStreamed.mockResolvedValue({
      events: makeEventStream(
        { type: 'thread.started', thread_id: 'new-thread' },
        { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'New' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ),
    });

    const backend = new CodexSdkBackend();
    const events: any[] = [];
    for await (const event of backend.execute(makeRequest())) { events.push(event); }

    expect(mockStartThread).toHaveBeenCalled();
    expect(mockResumeThread).not.toHaveBeenCalled();
  });

  it('includes routing metadata in all events', async () => {
    mockRunStreamed.mockResolvedValue({
      events: makeEventStream(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'reply' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ),
    });

    const backend = new CodexSdkBackend();
    const request = makeRequest({ userId: 'dad', sessionId: 's1', channelId: 'c1', platform: 'discord' });
    const events: any[] = [];
    for await (const event of backend.execute(request)) { events.push(event); }

    for (const event of events) {
      expect(event.sessionId).toBe('s1');
      expect(event.userId).toBe('dad');
      expect(event.channelId).toBe('c1');
      expect(event.platform).toBe('discord');
    }
  });

  it('maps permission levels to sandbox modes', async () => {
    // Test that chat gets read-only
    mockRunStreamed.mockResolvedValue({
      events: makeEventStream(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'ok' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ),
    });

    const backend = new CodexSdkBackend();
    const request = makeRequest({ permissionLevel: 'chat' });
    const events: any[] = [];
    for await (const event of backend.execute(request)) { events.push(event); }

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxMode: 'read-only' }),
    );
  });

  it('passes reasoning effort and verbosity to Codex', async () => {
    mockRunStreamed.mockResolvedValue({
      events: makeEventStream(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'ok' } },
        { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
      ),
    });

    const backend = new CodexSdkBackend();
    for await (const _ of backend.execute(makeRequest({ reasoningEffort: 'high', verbosity: 'low' }))) { /* consume */ }

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ modelReasoningEffort: 'high' }),
    );
    const codexOpts = MockCodex.mock.calls[0][0] as any;
    expect(codexOpts.config.model_verbosity).toBe('low');
  });

  it('prepends memory context and system prompt to prompt', async () => {
    let capturedInput: any;
    mockRunStreamed.mockImplementation((input: any) => {
      capturedInput = input;
      return Promise.resolve({
        events: makeEventStream(
          { type: 'thread.started', thread_id: 'thread-1' },
          { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'ok' } },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ),
      });
    });

    const backend = new CodexSdkBackend();
    const request = makeRequest({
      memoryContext: 'User likes cats',
      systemPrompt: 'Be helpful',
    });
    const events: any[] = [];
    for await (const event of backend.execute(request)) { events.push(event); }

    expect(capturedInput).toContain('<memory_context>');
    expect(capturedInput).toContain('User likes cats');
    expect(capturedInput).toContain('<system_instructions>');
    expect(capturedInput).toContain('Be helpful');
  });

  it('emits error on thrown exception', async () => {
    mockRunStreamed.mockRejectedValue(new Error('Connection failed'));

    const backend = new CodexSdkBackend();
    const events: any[] = [];
    for await (const event of backend.execute(makeRequest())) { events.push(event); }

    const error = events.find(e => e.type === 'error');
    expect(error).toBeDefined();
    expect(error.error).toContain('Connection failed');
  });

  it('aborts via AbortController', async () => {
    const ac = new AbortController();
    mockRunStreamed.mockResolvedValue({
      events: makeEventStream(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'ok' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ),
    });

    const backend = new CodexSdkBackend();
    const request = makeRequest({ sessionId: 'abort-test' });

    // Execute and collect events
    for await (const event of backend.execute(request)) { /* consume */ }

    // After execute, abort should be a no-op (controller already cleaned up)
    await backend.abort('abort-test');
    // No error thrown = success
  });

  it('maps MCP tool calls to tool_use and tool_result events', async () => {
    mockRunStreamed.mockResolvedValue({
      events: makeEventStream(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.started', item: { id: 'mcp1', type: 'mcp_tool_call', server: 'skills', tool: 'create_skill', arguments: { name: 'test' }, status: 'in_progress' } },
        { type: 'item.completed', item: { id: 'mcp1', type: 'mcp_tool_call', server: 'skills', tool: 'create_skill', arguments: { name: 'test' }, result: { content: [], structured_content: 'ok' }, status: 'completed' } },
        { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'Done' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ),
    });

    const backend = new CodexSdkBackend();
    const events: any[] = [];
    for await (const event of backend.execute(makeRequest())) { events.push(event); }

    const toolUse = events.find(e => e.type === 'tool_use');
    expect(toolUse).toBeDefined();
    expect(toolUse.tool).toBe('skills/create_skill');

    const toolResult = events.find(e => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    expect(toolResult.tool).toBe('skills/create_skill');
  });

  it('passes rules file path to Codex config when permission gate rules provided', async () => {
    const rules: PermissionGateRule[] = [
      { name: 'destructive-rm', pattern: 'rm\\s+-rf', tool: 'Bash', description: 'Block rm -rf' },
    ];

    mockRunStreamed.mockResolvedValue({
      events: makeEventStream(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'ok' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ),
    });

    const backend = new CodexSdkBackend({ permissionGateRules: rules });
    for await (const _ of backend.execute(makeRequest())) { /* consume */ }

    const codexOpts = MockCodex.mock.calls[0][0] as any;
    expect(codexOpts.config['exec_policy.rules_file']).toBeDefined();
    expect(codexOpts.config['exec_policy.rules_file']).toContain('ccbuddy.rules');

    backend.destroy(); // clean up temp files
  });

  it('does not set exec_policy.rules_file when no permission gate rules', async () => {
    mockRunStreamed.mockResolvedValue({
      events: makeEventStream(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'ok' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ),
    });

    const backend = new CodexSdkBackend();
    for await (const _ of backend.execute(makeRequest())) { /* consume */ }

    const codexOpts = MockCodex.mock.calls[0][0] as any;
    expect(codexOpts.config['exec_policy.rules_file']).toBeUndefined();
  });

  it('passes apiKey through the Codex constructor', async () => {
    mockRunStreamed.mockResolvedValue({
      events: makeEventStream(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'ok' } },
        { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
      ),
    });

    const backend = new CodexSdkBackend({ apiKey: 'sk-sdk-test' });
    for await (const _ of backend.execute(makeRequest())) { /* consume */ }

    const codexOpts = MockCodex.mock.calls[0][0] as any;
    expect(codexOpts.apiKey).toBe('sk-sdk-test');
  });

  it('maps file_change items to tool_use and tool_result events', async () => {
    mockRunStreamed.mockResolvedValue({
      events: makeEventStream(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.started', item: { id: 'fc1', type: 'file_change', status: 'in_progress' } },
        { type: 'item.completed', item: { id: 'fc1', type: 'file_change', changes: [{ kind: 'edit', path: 'src/index.ts' }, { kind: 'create', path: 'src/new.ts' }], status: 'completed' } },
        { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'Done' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ),
    });

    const backend = new CodexSdkBackend();
    const events: any[] = [];
    for await (const event of backend.execute(makeRequest())) { events.push(event); }

    const toolUse = events.find(e => e.type === 'tool_use' && e.tool === 'FileChange');
    expect(toolUse).toBeDefined();

    const toolResult = events.find(e => e.type === 'tool_result' && e.tool === 'FileChange');
    expect(toolResult).toBeDefined();
    expect(toolResult.toolOutput).toContain('edit: src/index.ts');
    expect(toolResult.toolOutput).toContain('create: src/new.ts');
  });

  it('restores protected files modified by Codex and emits an error instead of complete', async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), 'codex-sdk-backend-'));
    mkdirSync(join(workingDirectory, 'config'), { recursive: true });
    writeFileSync(join(workingDirectory, 'config', 'local.yaml'), 'secret: original\n', 'utf8');

    mockRunStreamed.mockImplementation(() => {
      writeFileSync(join(workingDirectory, 'config', 'local.yaml'), 'secret: changed\n', 'utf8');
      return Promise.resolve({
        events: makeEventStream(
          { type: 'thread.started', thread_id: 'thread-1' },
          { type: 'item.completed', item: { id: 'fc1', type: 'file_change', changes: [{ kind: 'update', path: 'config/local.yaml' }], status: 'completed' } },
          { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'Done' } },
          { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
        ),
      });
    });

    const backend = new CodexSdkBackend({
      permissionGateRules: [
        { name: 'local-config', pattern: 'config/local\\.yaml', tool: '*', description: 'Modify local config (contains secrets)' },
      ],
    });

    try {
      const events: any[] = [];
      for await (const event of backend.execute(makeRequest({ workingDirectory }))) { events.push(event); }

      const error = events.find((event) => event.type === 'error');
      const complete = events.find((event) => event.type === 'complete');
      expect(error).toBeDefined();
      expect(error.error).toContain('config/local.yaml');
      expect(complete).toBeUndefined();
      expect(readFileSync(join(workingDirectory, 'config', 'local.yaml'), 'utf8')).toBe('secret: original\n');
    } finally {
      backend.destroy();
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  it('restores protected files changed outside file_change events before completing', async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), 'codex-sdk-backend-shell-'));
    mkdirSync(join(workingDirectory, 'config'), { recursive: true });
    writeFileSync(join(workingDirectory, 'config', 'local.yaml'), 'secret: original\n', 'utf8');

    mockRunStreamed.mockImplementation(() => {
      writeFileSync(join(workingDirectory, 'config', 'local.yaml'), 'secret: shell-write\n', 'utf8');
      return Promise.resolve({
        events: makeEventStream(
          { type: 'thread.started', thread_id: 'thread-1' },
          { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'Done' } },
          { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
        ),
      });
    });

    const backend = new CodexSdkBackend({
      permissionGateRules: [
        { name: 'local-config', pattern: 'config/local\\.yaml', tool: '*', description: 'Modify local config (contains secrets)' },
      ],
    });

    try {
      const events: any[] = [];
      for await (const event of backend.execute(makeRequest({ workingDirectory }))) { events.push(event); }

      const error = events.find((event) => event.type === 'error');
      const complete = events.find((event) => event.type === 'complete');
      expect(error).toBeDefined();
      expect(error.error).toContain('config/local.yaml');
      expect(complete).toBeUndefined();
      expect(readFileSync(join(workingDirectory, 'config', 'local.yaml'), 'utf8')).toBe('secret: original\n');
    } finally {
      backend.destroy();
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  it('abort cancels active stream via AbortController signal', async () => {
    let capturedSignal: AbortSignal | undefined;

    // Simulate a long-running stream that respects the abort signal
    mockRunStreamed.mockImplementation((_input: any, opts: any) => {
      capturedSignal = opts?.signal;
      return Promise.resolve({
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'thread-1' };
          // Wait long enough for abort to happen
          await new Promise(r => setTimeout(r, 100));
          if (capturedSignal?.aborted) return;
          yield { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'should not reach' } };
          yield { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } };
        })(),
      });
    });

    const backend = new CodexSdkBackend();
    const request = makeRequest({ sessionId: 'abort-active' });
    const events: any[] = [];

    const collectPromise = (async () => {
      for await (const event of backend.execute(request)) { events.push(event); }
    })();

    // Let the stream start, then abort
    await new Promise(r => setTimeout(r, 20));
    await backend.abort('abort-active');
    await collectPromise;

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('destroy() removes temp rules directory', async () => {
    const rules: PermissionGateRule[] = [
      { name: 'launchctl', pattern: 'launchctl', tool: 'Bash', description: 'Block launchctl' },
    ];

    const backend = new CodexSdkBackend({ permissionGateRules: rules });

    // Verify the rules file was created
    mockRunStreamed.mockResolvedValue({
      events: makeEventStream(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'ok' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ),
    });
    for await (const _ of backend.execute(makeRequest())) { /* consume */ }

    const codexOpts = MockCodex.mock.calls[0][0] as any;
    const rulesPath = codexOpts.config['exec_policy.rules_file'];
    expect(existsSync(rulesPath)).toBe(true);

    // Destroy should remove it
    backend.destroy();
    expect(existsSync(rulesPath)).toBe(false);
  });

  it('sets approvalPolicy to never for chat permission level', async () => {
    mockRunStreamed.mockResolvedValue({
      events: makeEventStream(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'ok' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ),
    });

    const backend = new CodexSdkBackend();
    for await (const _ of backend.execute(makeRequest({ permissionLevel: 'chat' }))) { /* consume */ }

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxMode: 'read-only', approvalPolicy: 'never' }),
    );
  });
});
