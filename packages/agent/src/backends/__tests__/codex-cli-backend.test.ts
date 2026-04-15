import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentRequest } from '@ccbuddy/core';
import { EventEmitter } from 'events';

// Mock child_process.spawn before importing the module under test
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
const mockSpawn = vi.mocked(spawn);

import { CodexCliBackend } from '../codex-cli-backend.js';

// Helper: create a fake child process with controllable stdin/stdout/stderr/close
function makeMockProcess() {
  const stdout = new EventEmitter() as NodeJS.EventEmitter & { pipe?: any };
  const stderr = new EventEmitter() as NodeJS.EventEmitter & { pipe?: any };
  const stdin = { write: vi.fn(), end: vi.fn() };
  const proc = new EventEmitter() as any;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = stdin;
  proc.kill = vi.fn();
  return proc;
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

describe('CodexCliBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns codex exec with correct flags', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const backend = new CodexCliBackend();
    const request = makeRequest();

    const gen = backend.execute(request);
    const nextPromise = gen.next();

    process.nextTick(() => {
      proc.stdout.emit('data', Buffer.from('{"type":"item.completed","item":{"id":"msg1","type":"agent_message","text":"Hi there"}}\n'));
      proc.emit('close', 0);
    });

    await nextPromise;

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('codex');
    expect(args).toContain('exec');
    expect(args).toContain('--experimental-json');
    expect(args).toContain('--sandbox');
    expect(args).toContain('danger-full-access');
  });

  it('emits complete event with response from NDJSON', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const backend = new CodexCliBackend();
    const events: any[] = [];
    const gen = backend.execute(makeRequest());
    const nextPromise = gen.next();

    process.nextTick(() => {
      proc.stdout.emit('data', Buffer.from('{"type":"item.completed","item":{"id":"msg1","type":"agent_message","text":"Hi there"}}\n'));
      proc.emit('close', 0);
    });

    const result = await nextPromise;
    if (!result.done) events.push(result.value);

    const complete = events.find(e => e.type === 'complete');
    expect(complete).toBeDefined();
    expect(complete.response).toBe('Hi there');
  });

  it('sends prompt via stdin', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const backend = new CodexCliBackend();
    const gen = backend.execute(makeRequest({ prompt: 'Test prompt' }));
    const nextPromise = gen.next();

    process.nextTick(() => {
      proc.stdout.emit('data', Buffer.from('{"type":"item.completed","item":{"id":"msg1","type":"agent_message","text":"ok"}}\n'));
      proc.emit('close', 0);
    });

    await nextPromise;

    expect(proc.stdin.write).toHaveBeenCalledWith(expect.stringContaining('Test prompt'));
    expect(proc.stdin.end).toHaveBeenCalled();
  });

  it('includes routing metadata in all events', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const backend = new CodexCliBackend();
    const request = makeRequest({
      userId: 'dad',
      sessionId: 's42',
      channelId: 'general',
      platform: 'telegram',
    });

    const events: any[] = [];
    const gen = backend.execute(request);
    const nextPromise = gen.next();

    process.nextTick(() => {
      proc.stdout.emit('data', Buffer.from('{"type":"item.completed","item":{"id":"msg1","type":"agent_message","text":"reply"}}\n'));
      proc.emit('close', 0);
    });

    const result = await nextPromise;
    if (!result.done) events.push(result.value);

    for (const event of events) {
      expect(event.sessionId).toBe('s42');
      expect(event.userId).toBe('dad');
      expect(event.channelId).toBe('general');
      expect(event.platform).toBe('telegram');
    }
  });

  it('emits error event on non-zero exit code', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const backend = new CodexCliBackend();
    const events: any[] = [];
    const gen = backend.execute(makeRequest());
    const nextPromise = gen.next();

    process.nextTick(() => {
      proc.stderr.emit('data', Buffer.from('something went wrong'));
      proc.emit('close', 1);
    });

    const result = await nextPromise;
    if (!result.done) events.push(result.value);

    const error = events.find(e => e.type === 'error');
    expect(error).toBeDefined();
    expect(error.error).toContain('1');
  });

  it('passes --model flag when model is set', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const backend = new CodexCliBackend();
    const gen = backend.execute(makeRequest({ model: 'gpt-5' }));
    const nextPromise = gen.next();

    process.nextTick(() => {
      proc.stdout.emit('data', Buffer.from('{"type":"item.completed","item":{"id":"msg1","type":"agent_message","text":"ok"}}\n'));
      proc.emit('close', 0);
    });

    await nextPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5');
  });

  it('uses read-only sandbox for chat permission level', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const backend = new CodexCliBackend();
    const gen = backend.execute(makeRequest({ permissionLevel: 'chat' }));
    const nextPromise = gen.next();

    process.nextTick(() => {
      proc.stdout.emit('data', Buffer.from('{"type":"item.completed","item":{"id":"msg1","type":"agent_message","text":"ok"}}\n'));
      proc.emit('close', 0);
    });

    await nextPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
  });

  it('passes resume flag when resumeSessionId is provided', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const backend = new CodexCliBackend();
    const gen = backend.execute(makeRequest({ resumeSessionId: 'thread-abc' }));
    const nextPromise = gen.next();

    process.nextTick(() => {
      proc.stdout.emit('data', Buffer.from('{"type":"item.completed","item":{"id":"msg1","type":"agent_message","text":"resumed"}}\n'));
      proc.emit('close', 0);
    });

    await nextPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('resume');
    expect(args).toContain('thread-abc');
  });

  it('aborts the running process on abort()', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const backend = new CodexCliBackend();
    const request = makeRequest({ sessionId: 'abort-session' });

    const gen = backend.execute(request);
    const nextPromise = gen.next();

    await new Promise(r => process.nextTick(r));

    await backend.abort('abort-session');
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    proc.emit('close', 0);
    await nextPromise;
  });
});
