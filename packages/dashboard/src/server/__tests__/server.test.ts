import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const tempDirs: string[] = [];

  beforeEach(() => {
    process.env.TEST_DASHBOARD_TOKEN = TOKEN;
  });

  afterEach(async () => {
    if (server) await server.stop();
    delete process.env.TEST_DASHBOARD_TOKEN;
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('GET /api/settings/local returns persisted local config instead of effective config', async () => {
    const deps = createMockDeps();
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-api-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'local.yaml'), [
      'ccbuddy:',
      '  platforms:',
      '    discord:',
      '      token: ${DISCORD_TOKEN}',
      '',
    ].join('\n'), 'utf8');
    deps.configDir = dir;
    (deps.config as any).platforms = {
      discord: { enabled: true, token: 'resolved-token' },
    };

    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/api/settings/local`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.config.platforms.discord.token).toBe('${DISCORD_TOKEN}');
  });

  it('PUT /api/settings/local preserves placeholders while updating editable values', async () => {
    const deps = createMockDeps();
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-api-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'local.yaml'), [
      'ccbuddy:',
      '  platforms:',
      '    discord:',
      '      token: ${DISCORD_TOKEN}',
      '',
    ].join('\n'), 'utf8');
    deps.configDir = dir;

    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/api/settings/local`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        config: {
          platforms: {
            discord: {
              token: '${DISCORD_TOKEN}',
              enabled: true,
            },
          },
          agent: {
            admin_skip_permissions: false,
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    const raw = readFileSync(join(dir, 'local.yaml'), 'utf8');
    expect(raw).toContain('${DISCORD_TOKEN}');
    expect(raw).toContain('admin_skip_permissions: false');
  });

  it('PUT /api/settings/local rejects non-object payloads', async () => {
    const deps = createMockDeps();
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-api-'));
    tempDirs.push(dir);
    deps.configDir = dir;

    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/api/settings/local`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(null),
    });

    expect(res.status).toBe(400);
  });

  it('PUT /api/settings/local rejects unknown top-level keys', async () => {
    const deps = createMockDeps();
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-api-'));
    tempDirs.push(dir);
    deps.configDir = dir;

    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/api/settings/local`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        config: {
          unexpected_top_level_key: true,
        },
      }),
    });

    expect(res.status).toBe(400);
  });

  it('PUT /api/settings/local rejects type mismatches', async () => {
    const deps = createMockDeps();
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-api-'));
    tempDirs.push(dir);
    deps.configDir = dir;

    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/api/settings/local`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        config: {
          agent: {
            admin_skip_permissions: 'false',
          },
        },
      }),
    });

    expect(res.status).toBe(400);
  });

  it('PUT /api/settings/local rejects malformed array entries', async () => {
    const deps = createMockDeps();
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-api-'));
    tempDirs.push(dir);
    deps.configDir = dir;

    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/api/settings/local`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        config: {
          media: {
            allowed_mime_types: [false],
          },
        },
      }),
    });

    expect(res.status).toBe(400);
  });

  it('PUT /api/settings/local rejects semantically invalid config values', async () => {
    const deps = createMockDeps();
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-api-'));
    tempDirs.push(dir);
    deps.configDir = dir;

    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/api/settings/local`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        config: {
          agent: {
            model: '',
          },
        },
      }),
    });

    expect(res.status).toBe(400);
  });

  it('PUT /api/settings/local leaves local.yaml unchanged when validation fails', async () => {
    const deps = createMockDeps();
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-api-'));
    tempDirs.push(dir);
    deps.configDir = dir;
    const localPath = join(dir, 'local.yaml');
    const original = [
      'ccbuddy:',
      '  agent:',
      '    model: opus',
      '',
    ].join('\n');
    writeFileSync(localPath, original, 'utf8');

    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/api/settings/local`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        config: {
          agent: {
            admin_skip_permissions: 'false',
          },
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(readFileSync(localPath, 'utf8')).toBe(original);
  });

  it('PUT /api/settings/local preserves unchanged legacy keys already in local.yaml', async () => {
    const deps = createMockDeps();
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-api-'));
    tempDirs.push(dir);
    deps.configDir = dir;
    const localPath = join(dir, 'local.yaml');
    writeFileSync(localPath, [
      'ccbuddy:',
      '  permission_gates:',
      '    enabled: true',
      '    timeout_ms: 300000',
      '    rules: []',
      '  agent:',
      '    admin_skip_permissions: true',
      '',
    ].join('\n'), 'utf8');

    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/api/settings/local`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        config: {
          permission_gates: {
            enabled: true,
            timeout_ms: 300000,
            rules: [],
          },
          agent: {
            admin_skip_permissions: false,
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    const raw = readFileSync(localPath, 'utf8');
    expect(raw).toContain('permission_gates:');
    expect(raw).toContain('admin_skip_permissions: false');
  });

  it('GET /api/settings/effective returns the resolved runtime config read-only', async () => {
    const deps = createMockDeps();
    (deps.config as any).platforms = {
      discord: { enabled: true, token: 'resolved-token' },
    };
    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/api/settings/effective`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.config.platforms.discord.token).toBe('••••••');
  });

  it('GET /api/settings/meta reports env-backed placeholders as env', async () => {
    const deps = createMockDeps();
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-api-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'local.yaml'), [
      'ccbuddy:',
      '  platforms:',
      '    discord:',
      '      token: ${DISCORD_TOKEN}',
      '',
    ].join('\n'), 'utf8');
    deps.configDir = dir;
    (deps.config as any).platforms = {
      discord: { enabled: true, token: 'resolved-token' },
    };

    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/api/settings/meta`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sources['platforms.discord.token']).toBe('env');
  });

  it('GET /api/settings/meta reports runtime, default, and effective-only sources', async () => {
    const deps = createMockDeps();
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-api-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'default.yaml'), [
      'ccbuddy:',
      '  gateway:',
      '    unknown_user_reply: false',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(dir, 'local.yaml'), [
      'ccbuddy:',
      '  agent:',
      '    admin_skip_permissions: false',
      '',
    ].join('\n'), 'utf8');
    deps.configDir = dir;
    (deps.config as any).data_dir = dir;
    (deps.config as any).agent = {
      model: 'sonnet',
      admin_skip_permissions: false,
    };
    (deps.config as any).gateway = {
      unknown_user_reply: false,
    };
    (deps.config as any).platforms = {
      discord: { enabled: true, token: 'resolved-token' },
    };
    writeFileSync(join(dir, 'runtime-config.json'), JSON.stringify({ model: 'sonnet' }), 'utf8');

    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/api/settings/meta`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sources['agent.model']).toBe('runtime_override');
    expect(data.sources['gateway.unknown_user_reply']).toBe('default');
    expect(data.sources['platforms.discord.token']).toBe('effective_only');
  });
});
