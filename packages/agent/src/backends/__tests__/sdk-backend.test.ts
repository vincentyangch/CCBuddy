import { describe, it, expect, vi } from 'vitest';
import { SdkBackend } from '../sdk-backend.js';
import type { AgentRequest } from '@ccbuddy/core';

// Mock the Claude Agent SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
const mockQuery = vi.mocked(query);

/** Create an async generator that yields the given messages */
async function* makeAsyncGen(...messages: any[]) {
  for (const msg of messages) yield msg;
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

describe('SdkBackend', () => {
  it('passes prompt and options to Claude Agent SDK', async () => {
    mockQuery.mockReturnValueOnce(
      makeAsyncGen({ type: 'result', subtype: 'success', result: 'Hello back!' }) as any,
    );
    const backend = new SdkBackend({ skipPermissions: true });
    const events: any[] = [];
    for await (const event of backend.execute(makeRequest())) { events.push(event); }
    expect(mockQuery).toHaveBeenCalledOnce();
    const callArgs = mockQuery.mock.calls[0];
    expect(callArgs[0]).toMatchObject({ prompt: 'Hello' });
  });

  it('emits complete event with response', async () => {
    mockQuery.mockReturnValueOnce(
      makeAsyncGen({ type: 'result', subtype: 'success', result: 'The answer is 42' }) as any,
    );
    const backend = new SdkBackend({ skipPermissions: true });
    const events: any[] = [];
    for await (const event of backend.execute(makeRequest())) { events.push(event); }
    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    expect(complete.response).toContain('42');
  });

  it('emits error event on SDK failure', async () => {
    mockQuery.mockImplementationOnce(() => {
      throw new Error('SDK connection failed');
    });
    const backend = new SdkBackend({ skipPermissions: true });
    const events: any[] = [];
    for await (const event of backend.execute(makeRequest())) { events.push(event); }
    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect(error.error).toContain('SDK connection failed');
  });

  it('passes model option to Claude Agent SDK', async () => {
    mockQuery.mockReturnValueOnce(
      makeAsyncGen({ type: 'result', subtype: 'success', result: 'reply' }) as any,
    );
    const backend = new SdkBackend({ skipPermissions: true });
    const request = makeRequest({ model: 'claude-opus-4-5' });
    const events: any[] = [];
    for await (const event of backend.execute(request)) { events.push(event); }
    const lastCall = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    expect(lastCall[0].options).toMatchObject({ model: 'claude-opus-4-5' });
  });

  it('includes routing metadata in all events', async () => {
    mockQuery.mockReturnValueOnce(
      makeAsyncGen({ type: 'result', subtype: 'success', result: 'reply' }) as any,
    );
    const backend = new SdkBackend({ skipPermissions: true });
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

  describe('permission gates', () => {
    const gateRules = [
      { name: 'destructive-rm', pattern: 'rm\\s+-rf', tool: 'Bash', description: 'Destructive rm -rf command' },
    ];
    const gateConfig = { enabled: true, timeout_ms: 30000, rules: gateRules };

    /** Helper: execute backend to trigger canUseTool setup, then return captured canUseTool */
    async function getCanUseTool(backend: SdkBackend, request: AgentRequest): Promise<(toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal }) => Promise<any>> {
      let capturedCanUseTool: any;
      mockQuery.mockImplementationOnce((args: any) => {
        capturedCanUseTool = args.options?.canUseTool;
        return makeAsyncGen({ type: 'result', subtype: 'success', result: 'ok' }) as any;
      });
      const events: any[] = [];
      for await (const event of backend.execute(request)) { events.push(event); }
      return capturedCanUseTool;
    }

    const abortSignal = new AbortController().signal;

    it('gated tool triggers requestUserInput when gates active', async () => {
      const requestUserInput = vi.fn().mockResolvedValue({ '0': 'Allow' });
      const backend = new SdkBackend({ skipPermissions: false, permissionGates: gateConfig });
      const request = makeRequest({ requestUserInput, permissionLevel: 'admin' });
      const canUseTool = await getCanUseTool(backend, request);
      expect(canUseTool).toBeDefined();

      const result = await canUseTool('Bash', { command: 'rm -rf /tmp/stuff' }, { signal: abortSignal });
      expect(requestUserInput).toHaveBeenCalled();
      expect(result.behavior).toBe('allow');
    });

    it('auto-allows non-matching tools', async () => {
      const requestUserInput = vi.fn().mockResolvedValue({ '0': 'Allow' });
      const backend = new SdkBackend({ skipPermissions: false, permissionGates: gateConfig });
      const request = makeRequest({ requestUserInput, permissionLevel: 'admin' });
      const canUseTool = await getCanUseTool(backend, request);

      const result = await canUseTool('Bash', { command: 'ls -la' }, { signal: abortSignal });
      expect(requestUserInput).not.toHaveBeenCalled();
      expect(result.behavior).toBe('allow');
    });

    it('bypass mode (skipPermissions: true) uses bypassPermissions', async () => {
      mockQuery.mockReturnValueOnce(
        makeAsyncGen({ type: 'result', subtype: 'success', result: 'ok' }) as any,
      );
      const backend = new SdkBackend({ skipPermissions: true, permissionGates: gateConfig });
      const request = makeRequest({ permissionLevel: 'admin' });
      const events: any[] = [];
      for await (const event of backend.execute(request)) { events.push(event); }

      const lastCall = mockQuery.mock.calls[mockQuery.mock.calls.length - 1] as any;
      expect(lastCall[0].options.permissionMode).toBe('bypassPermissions');
    });

    it('returns deny with timeout message when user does not respond', async () => {
      const requestUserInput = vi.fn().mockResolvedValue(null);
      const backend = new SdkBackend({ skipPermissions: false, permissionGates: gateConfig });
      const request = makeRequest({ requestUserInput, permissionLevel: 'admin' });
      const canUseTool = await getCanUseTool(backend, request);

      const result = await canUseTool('Bash', { command: 'rm -rf /tmp/stuff' }, { signal: abortSignal });
      expect(result.behavior).toBe('deny');
      expect(result.message).toContain('timed out');
    });

    it('returns allow when user approves', async () => {
      const requestUserInput = vi.fn().mockResolvedValue({ '0': 'Allow' });
      const backend = new SdkBackend({ skipPermissions: false, permissionGates: gateConfig });
      const request = makeRequest({ requestUserInput, permissionLevel: 'admin' });
      const canUseTool = await getCanUseTool(backend, request);

      const result = await canUseTool('Bash', { command: 'rm -rf /tmp/stuff' }, { signal: abortSignal });
      expect(result.behavior).toBe('allow');
    });

    it('returns deny when user denies', async () => {
      const requestUserInput = vi.fn().mockResolvedValue({ '0': 'Deny' });
      const backend = new SdkBackend({ skipPermissions: false, permissionGates: gateConfig });
      const request = makeRequest({ requestUserInput, permissionLevel: 'admin' });
      const canUseTool = await getCanUseTool(backend, request);

      const result = await canUseTool('Bash', { command: 'rm -rf /tmp/stuff' }, { signal: abortSignal });
      expect(result.behavior).toBe('deny');
      expect(result.message).toContain('denied');
    });

    it('system jobs always use bypassPermissions', async () => {
      mockQuery.mockReturnValueOnce(
        makeAsyncGen({ type: 'result', subtype: 'success', result: 'ok' }) as any,
      );
      const backend = new SdkBackend({ skipPermissions: false, permissionGates: gateConfig });
      const request = makeRequest({ permissionLevel: 'system' });
      const events: any[] = [];
      for await (const event of backend.execute(request)) { events.push(event); }

      const lastCall = mockQuery.mock.calls[mockQuery.mock.calls.length - 1] as any;
      expect(lastCall[0].options.permissionMode).toBe('bypassPermissions');
    });

    it('AskUserQuestion still works when gates active', async () => {
      const requestUserInput = vi.fn().mockResolvedValue({ '0': 'Yes' });
      const backend = new SdkBackend({ skipPermissions: false, permissionGates: gateConfig });
      const request = makeRequest({ requestUserInput, permissionLevel: 'admin' });
      const canUseTool = await getCanUseTool(backend, request);

      const result = await canUseTool('AskUserQuestion', { questions: [{ question: 'Continue?' }] }, { signal: abortSignal });
      expect(result.behavior).toBe('allow');
      expect(result.updatedInput.answers).toEqual({ '0': 'Yes' });
    });

    it('gates disabled (enabled: false) does not prompt', async () => {
      const disabledConfig = { enabled: false, timeout_ms: 30000, rules: gateRules };
      const requestUserInput = vi.fn().mockResolvedValue({ '0': 'Allow' });
      const backend = new SdkBackend({ skipPermissions: false, permissionGates: disabledConfig });
      const request = makeRequest({ requestUserInput, permissionLevel: 'admin' });
      const canUseTool = await getCanUseTool(backend, request);

      const result = await canUseTool('Bash', { command: 'rm -rf /tmp/stuff' }, { signal: abortSignal });
      expect(requestUserInput).not.toHaveBeenCalled();
      expect(result.behavior).toBe('allow');
    });
  });
});
