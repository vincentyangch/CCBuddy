import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DashboardServer } from '../index.js';

function createMockDeps() {
  return {
    eventBus: {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    },
    agentService: {
      getSessionInfo: vi.fn().mockReturnValue([]),
      queueSize: 0,
    },
    messageStore: {
      query: vi.fn().mockReturnValue({ messages: [], total: 0, page: 1, pageSize: 50 }),
    },
    agentEventStore: {
      getBySession: vi.fn().mockReturnValue([]),
    },
    config: {
      dashboard: { enabled: true, port: 0, host: '127.0.0.1', auth_token_env: 'TEST_DASHBOARD_TOKEN' },
      data_dir: '/tmp/test-ccbuddy',
    },
    configDir: '/tmp',
    logFiles: { stdout: '/tmp/stdout.log', stderr: '/tmp/stderr.log', app: '/tmp/app.log' },
  };
}

describe('DashboardServer', () => {
  let server: DashboardServer;
  const TOKEN = 'test-secret-123';

  beforeEach(() => {
    process.env.TEST_DASHBOARD_TOKEN = TOKEN;
  });

  afterEach(async () => {
    if (server) await server.stop();
    delete process.env.TEST_DASHBOARD_TOKEN;
  });

  it('starts and stops cleanly', async () => {
    server = new DashboardServer(createMockDeps() as any);
    const address = await server.start();
    expect(address).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
  });

  it('rejects requests without auth token', async () => {
    server = new DashboardServer(createMockDeps() as any);
    const address = await server.start();
    const res = await fetch(`${address}/api/status`);
    expect(res.status).toBe(401);
  });

  it('accepts requests with valid auth token', async () => {
    server = new DashboardServer(createMockDeps() as any);
    const address = await server.start();
    const res = await fetch(`${address}/api/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects requests with wrong auth token', async () => {
    server = new DashboardServer(createMockDeps() as any);
    const address = await server.start();
    const res = await fetch(`${address}/api/status`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/auth validates token', async () => {
    server = new DashboardServer(createMockDeps() as any);
    const address = await server.start();

    const good = await fetch(`${address}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ ok: true });

    const bad = await fetch(`${address}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    });
    expect(bad.status).toBe(401);
  });

  it('refuses to start without auth token env var', async () => {
    delete process.env.TEST_DASHBOARD_TOKEN;
    server = new DashboardServer(createMockDeps() as any);
    await expect(server.start()).rejects.toThrow(/auth token not set/);
  });

  it('GET /api/sessions returns session list', async () => {
    const deps = createMockDeps();
    deps.agentService.getSessionInfo.mockReturnValue([
      { sessionKey: 'dad-discord-ch1', sdkSessionId: 'uuid-1', lastActivity: 1000, isGroupChannel: false },
    ]);
    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/api/sessions`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].sessionKey).toBe('dad-discord-ch1');
  });

  it('GET /api/conversations passes query params to messageStore', async () => {
    const deps = createMockDeps();
    server = new DashboardServer(deps as any);
    const address = await server.start();

    await fetch(`${address}/api/conversations?user=dad&platform=discord&page=2&pageSize=10`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(deps.messageStore.query).toHaveBeenCalledWith({
      user: 'dad',
      platform: 'discord',
      page: 2,
      pageSize: 10,
      search: undefined,
      dateFrom: undefined,
      dateTo: undefined,
    });
  });

  it('GET /api/config redacts platform tokens', async () => {
    const deps = createMockDeps();
    (deps.config as any).platforms = {
      discord: { enabled: true, token: 'secret-discord-token' },
      telegram: { enabled: true, token: 'secret-telegram-token' },
    };
    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/api/config`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const data = await res.json();
    expect(data.config.platforms.discord.token).toBe('••••••');
    expect(data.config.platforms.telegram.token).toBe('••••••');
  });
});
