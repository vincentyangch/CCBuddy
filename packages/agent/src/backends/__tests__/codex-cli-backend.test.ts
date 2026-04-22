import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentRequest } from '@ccbuddy/core';
import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('uses configured codex path and CODEX_API_KEY', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const backend = new CodexCliBackend({ codexPath: '/custom/codex', apiKey: 'sk-test-123' });
    const gen = backend.execute(makeRequest());
    const nextPromise = gen.next();

    process.nextTick(() => {
      proc.stdout.emit('data', Buffer.from('{"type":"item.completed","item":{"id":"msg1","type":"agent_message","text":"ok"}}\n'));
      proc.emit('close', 0);
    });

    await nextPromise;

    const [cmd, , options] = mockSpawn.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(cmd).toBe('/custom/codex');
    expect(options.env.CODEX_API_KEY).toBe('sk-test-123');
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

  it('returns thread ID from NDJSON thread.started event as sdkSessionId', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const backend = new CodexCliBackend();
    const events: any[] = [];
    const gen = backend.execute(makeRequest());
    const nextPromise = gen.next();

    process.nextTick(() => {
      proc.stdout.emit('data', Buffer.from(
        '{"type":"thread.started","thread_id":"thread-xyz-123"}\n' +
        '{"type":"item.completed","item":{"id":"msg1","type":"agent_message","text":"Hello"}}\n'
      ));
      proc.emit('close', 0);
    });

    const result = await nextPromise;
    if (!result.done) events.push(result.value);

    const complete = events.find(e => e.type === 'complete');
    expect(complete).toBeDefined();
    expect(complete.sdkSessionId).toBe('thread-xyz-123');
    expect(complete.response).toBe('Hello');
  });

  it('falls back to request sdkSessionId when no thread.started in NDJSON', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const backend = new CodexCliBackend();
    const events: any[] = [];
    const gen = backend.execute(makeRequest({ sdkSessionId: 'existing-id' }));
    const nextPromise = gen.next();

    process.nextTick(() => {
      proc.stdout.emit('data', Buffer.from(
        '{"type":"item.completed","item":{"id":"msg1","type":"agent_message","text":"ok"}}\n'
      ));
      proc.emit('close', 0);
    });

    const result = await nextPromise;
    if (!result.done) events.push(result.value);

    const complete = events.find(e => e.type === 'complete');
    expect(complete).toBeDefined();
    expect(complete.sdkSessionId).toBe('existing-id');
  });

  it('passes config overrides for approval policy, MCP env, network access, and rules file', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const backend = new CodexCliBackend({
      networkAccess: false,
      permissionGateRules: [
        { name: 'destructive-rm', pattern: 'rm\\s+-rf', tool: 'Bash', description: 'Block rm -rf' },
      ],
    });
    const request = makeRequest({
      mcpServers: [{
        name: 'test',
        command: '/path/with "quotes"',
        args: ['--flag', 'val\\ue'],
        env: { TOKEN: 'abc123' },
      }],
    });

    const gen = backend.execute(request);
    const nextPromise = gen.next();

    process.nextTick(() => {
      proc.stdout.emit('data', Buffer.from('{"type":"item.completed","item":{"id":"msg1","type":"agent_message","text":"ok"}}\n'));
      proc.emit('close', 0);
    });

    await nextPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('approval_policy="never"');
    expect(args).toContain('sandbox_workspace_write.network_access=false');
    expect(args).toContain('mcp_servers.test.command="/path/with \\"quotes\\""');
    expect(args).toContain('mcp_servers.test.args=["--flag", "val\\\\ue"]');
    expect(args).toContain('mcp_servers.test.env.TOKEN="abc123"');
    const rulesOverride = (args as string[]).find((arg) => arg.startsWith('exec_policy.rules_file='));
    expect(rulesOverride).toContain('ccbuddy.rules');
  });

  it('passes reasoning effort, service tier, and verbosity config overrides', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const backend = new CodexCliBackend();
    const gen = backend.execute(makeRequest({ reasoningEffort: 'medium', serviceTier: 'fast', verbosity: 'high' }));
    const nextPromise = gen.next();

    process.nextTick(() => {
      proc.stdout.emit('data', Buffer.from('{"type":"item.completed","item":{"id":"msg1","type":"agent_message","text":"ok"}}\n'));
      proc.emit('close', 0);
    });

    await nextPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('model_reasoning_effort="medium"');
    expect(args).toContain('service_tier="fast"');
    expect(args).toContain('model_verbosity="high"');
  });

  it('restores protected files modified by Codex and returns an error event', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const workingDirectory = mkdtempSync(join(tmpdir(), 'codex-cli-backend-'));
    mkdirSync(join(workingDirectory, 'config'), { recursive: true });
    writeFileSync(join(workingDirectory, 'config', 'local.yaml'), 'secret: original\n', 'utf8');

    const backend = new CodexCliBackend({
      permissionGateRules: [
        { name: 'local-config', pattern: 'config/local\\.yaml', tool: '*', description: 'Modify local config (contains secrets)' },
      ],
    });

    try {
      const events: any[] = [];
      const gen = backend.execute(makeRequest({ workingDirectory }));
      const nextPromise = gen.next();

      process.nextTick(() => {
        writeFileSync(join(workingDirectory, 'config', 'local.yaml'), 'secret: changed\n', 'utf8');
        proc.stdout.emit('data', Buffer.from(
          '{"type":"item.completed","item":{"id":"fc1","type":"file_change","changes":[{"kind":"update","path":"config/local.yaml"}],"status":"completed"}}\n' +
          '{"type":"item.completed","item":{"id":"msg1","type":"agent_message","text":"done"}}\n' +
          '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\n'
        ));
        proc.emit('close', 0);
      });

      const result = await nextPromise;
      if (!result.done) events.push(result.value);

      expect(events[0].type).toBe('error');
      expect(events[0].error).toContain('config/local.yaml');
      expect(readFileSync(join(workingDirectory, 'config', 'local.yaml'), 'utf8')).toBe('secret: original\n');
    } finally {
      backend.destroy();
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  it('restores protected files even when Codex exits non-zero after modifying them', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const workingDirectory = mkdtempSync(join(tmpdir(), 'codex-cli-backend-fail-'));
    mkdirSync(join(workingDirectory, 'config'), { recursive: true });
    writeFileSync(join(workingDirectory, 'config', 'local.yaml'), 'secret: original\n', 'utf8');

    const backend = new CodexCliBackend({
      permissionGateRules: [
        { name: 'local-config', pattern: 'config/local\\.yaml', tool: '*', description: 'Modify local config (contains secrets)' },
      ],
    });

    try {
      const events: any[] = [];
      const gen = backend.execute(makeRequest({ workingDirectory }));
      const nextPromise = gen.next();

      process.nextTick(() => {
        writeFileSync(join(workingDirectory, 'config', 'local.yaml'), 'secret: changed\n', 'utf8');
        proc.stdout.emit('data', Buffer.from('{"type":"turn.failed","error":{"message":"turn failed"}}\n'));
        proc.stderr.emit('data', Buffer.from('process failed'));
        proc.emit('close', 1);
      });

      const result = await nextPromise;
      if (!result.done) events.push(result.value);

      expect(events[0].type).toBe('error');
      expect(events[0].error).toContain('config/local.yaml');
      expect(readFileSync(join(workingDirectory, 'config', 'local.yaml'), 'utf8')).toBe('secret: original\n');
    } finally {
      backend.destroy();
      rmSync(workingDirectory, { recursive: true, force: true });
    }
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
