import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
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

  it('PUT /api/sessions/:key/settings updates direct session overrides', async () => {
    const deps = createMockDeps();
    const setModel = vi.fn();
    const setReasoningEffort = vi.fn();
    const setServiceTier = vi.fn();
    const setVerbosity = vi.fn();
    (deps.config as any).agent = {
      backend: 'codex-sdk',
      claude_models: ['sonnet'],
      codex_models: ['gpt-5.4', 'gpt-5.4-mini'],
    };
    (deps as any).sessionStore = {
      getHistory: vi.fn().mockReturnValue([{
        session_key: 'dad-discord-ch1',
        sdk_session_id: 'uuid-1',
        user_id: 'dad',
        platform: 'discord',
        channel_id: 'ch1',
        is_group_channel: false,
        model: 'gpt-5.4',
        reasoning_effort: null,
        service_tier: null,
        verbosity: null,
        status: 'active',
        created_at: 1000,
        last_activity: 2000,
      }]),
      setModel,
      setReasoningEffort,
      setServiceTier,
      setVerbosity,
      deleteSession: vi.fn(),
    };

    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/api/sessions/dad-discord-ch1/settings`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        reasoning_effort: 'high',
        service_tier: 'fast',
        verbosity: 'low',
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.model).toBe('gpt-5.4-mini');
    expect(data.reasoning_effort).toBe('high');
    expect(data.service_tier).toBe('fast');
    expect(data.verbosity).toBe('low');
    expect(setModel).toHaveBeenCalledWith('dad-discord-ch1', 'gpt-5.4-mini');
    expect(setReasoningEffort).toHaveBeenCalledWith('dad-discord-ch1', 'high');
    expect(setServiceTier).toHaveBeenCalledWith('dad-discord-ch1', 'fast');
    expect(setVerbosity).toHaveBeenCalledWith('dad-discord-ch1', 'low');
  });

  it('PUT /api/sessions/:key/settings rejects invalid backend-incompatible models', async () => {
    const deps = createMockDeps();
    (deps.config as any).agent = {
      backend: 'codex-sdk',
      claude_models: ['sonnet'],
      codex_models: ['gpt-5.4'],
    };
    (deps as any).sessionStore = {
      getHistory: vi.fn().mockReturnValue([{
        session_key: 'dad-discord-ch1',
        sdk_session_id: 'uuid-1',
        user_id: 'dad',
        platform: 'discord',
        channel_id: 'ch1',
        is_group_channel: false,
        model: null,
        reasoning_effort: null,
        verbosity: null,
        status: 'active',
        created_at: 1000,
        last_activity: 2000,
      }]),
      setModel: vi.fn(),
      setReasoningEffort: vi.fn(),
      setVerbosity: vi.fn(),
      deleteSession: vi.fn(),
    };

    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/api/sessions/dad-discord-ch1/settings`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonnet',
      }),
    });

    expect(res.status).toBe(400);
  });

  it('GET /api/conversations passes query params to messageStore', async () => {
    const deps = createMockDeps();
    server = new DashboardServer(deps as any);
    const address = await server.start();

    await fetch(`${address}/api/conversations?user=dad&platform=discord&sessionId=dad-discord-ch1&page=2&pageSize=10`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(deps.messageStore.query).toHaveBeenCalledWith({
      user: 'dad',
      platform: 'discord',
      sessionId: 'dad-discord-ch1',
      page: 2,
      pageSize: 10,
      search: undefined,
      dateFrom: undefined,
      dateTo: undefined,
    });
  });

  it('serves built asset files instead of falling back to index.html', async () => {
    const deps = createMockDeps();
    const clientDir = join(process.cwd(), 'dist-client');
    const assetsDir = join(clientDir, 'assets');
    const assetPath = join(assetsDir, '__dashboard-server-test.txt');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(assetPath, 'dashboard-asset-ok', 'utf8');

    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/assets/__dashboard-server-test.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('dashboard-asset-ok');
  });

  it('serves asset files added after startup', async () => {
    const deps = createMockDeps();
    const clientDir = join(process.cwd(), 'dist-client');
    const assetsDir = join(clientDir, 'assets');
    mkdirSync(assetsDir, { recursive: true });

    server = new DashboardServer(deps as any);
    const address = await server.start();

    const assetPath = join(assetsDir, '__dashboard-server-late-asset.txt');
    writeFileSync(assetPath, 'late-asset-ok', 'utf8');

    const res = await fetch(`${address}/assets/__dashboard-server-late-asset.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('late-asset-ok');
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

  it('PUT /api/config/models trims, dedupes, and resets an invalid active model', async () => {
    const deps = createMockDeps();
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-model-lists-'));
    tempDirs.push(dir);
    deps.configDir = dir;
    (deps.config as any).data_dir = dir;
    (deps.config as any).agent = {
      backend: 'codex-sdk',
      model: 'legacy-codex',
      claude_models: ['sonnet'],
      codex_models: ['gpt-5.4-pro'],
    };

    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/api/config/models`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        codex_models: [' gpt-5.4 ', 'gpt-5.4', 'gpt-5.4-mini'],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.codex_models).toEqual(['gpt-5.4', 'gpt-5.4-mini']);
    expect((deps.config as any).agent.model).toBe('gpt-5.4');

    const runtimeConfig = JSON.parse(readFileSync(join(dir, 'runtime-config.json'), 'utf8'));
    expect(runtimeConfig.codex_models).toEqual(['gpt-5.4', 'gpt-5.4-mini']);
    expect(runtimeConfig.model).toBe('gpt-5.4');
  });

  it('GET /api/config/model includes codex reasoning effort, service tier, and verbosity state', async () => {
    const deps = createMockDeps();
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-config-model-'));
    tempDirs.push(dir);
    (deps.config as any).data_dir = dir;
    (deps.config as any).agent = {
      backend: 'codex-sdk',
      model: 'gpt-5.4',
      claude_models: ['sonnet'],
      codex_models: ['gpt-5.4', 'gpt-5.4-mini'],
      codex: {
        default_reasoning_effort: 'minimal',
        default_service_tier: 'flex',
        default_verbosity: 'high',
      },
    };
    writeFileSync(join(dir, 'runtime-config.json'), JSON.stringify({
      model: 'gpt-5.4-mini',
      reasoning_effort: 'high',
      service_tier: 'fast',
      verbosity: 'low',
    }), 'utf8');

    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/api/config/model`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.model).toBe('gpt-5.4-mini');
    expect(data.reasoning_effort).toBe('high');
    expect(data.service_tier).toBe('fast');
    expect(data.verbosity).toBe('low');
    expect(data.reasoning_effort_source).toBe('runtime_override');
    expect(data.service_tier_source).toBe('runtime_override');
    expect(data.verbosity_source).toBe('runtime_override');
    expect(data.reasoning_effort_options).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(data.service_tier_options).toEqual(['flex', 'fast']);
    expect(data.verbosity_options).toEqual(['low', 'medium', 'high']);
  });

  it('PUT /api/config/model updates codex reasoning effort, service tier, and verbosity runtime overrides', async () => {
    const deps = createMockDeps();
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-config-model-'));
    tempDirs.push(dir);
    (deps.config as any).data_dir = dir;
    (deps.config as any).agent = {
      backend: 'codex-sdk',
      model: 'gpt-5.4',
      claude_models: ['sonnet'],
      codex_models: ['gpt-5.4', 'gpt-5.4-mini'],
      codex: {},
    };

    server = new DashboardServer(deps as any);
    const address = await server.start();

    const res = await fetch(`${address}/api/config/model`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        reasoning_effort: 'high',
        service_tier: 'fast',
        verbosity: 'low',
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.model).toBe('gpt-5.4-mini');
    expect(data.reasoning_effort).toBe('high');
    expect(data.service_tier).toBe('fast');
    expect(data.verbosity).toBe('low');
    expect((deps.config as any).agent.model).toBe('gpt-5.4-mini');
    expect((deps.config as any).agent.codex.default_reasoning_effort).toBe('high');
    expect((deps.config as any).agent.codex.default_service_tier).toBe('fast');
    expect((deps.config as any).agent.codex.default_verbosity).toBe('low');

    const runtimeConfig = JSON.parse(readFileSync(join(dir, 'runtime-config.json'), 'utf8'));
    expect(runtimeConfig.model).toBe('gpt-5.4-mini');
    expect(runtimeConfig.reasoning_effort).toBe('high');
    expect(runtimeConfig.service_tier).toBe('fast');
    expect(runtimeConfig.verbosity).toBe('low');
  });
});
