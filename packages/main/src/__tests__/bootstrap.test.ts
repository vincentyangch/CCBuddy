import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentRequest } from '@ccbuddy/core';
import { bootstrap } from '../bootstrap.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockAcquirePidLock = vi.fn();
const mockLoadConfig = vi.fn();
const mockCreateEventBus = vi.fn();
const mockUserManager = vi.fn();
const mockIsValidModel = vi.fn((value: string) => typeof value === 'string' && value.length > 0);
const mockIsValidModelForBackend = vi.fn((value: string) => typeof value === 'string' && value.length > 0);
const mockGetModelOptionsForBackend = vi.fn((backend: string, configLists?: { claude_models?: string[]; codex_models?: string[] }) =>
  backend.startsWith('codex')
    ? (configLists?.codex_models ?? ['gpt-5.4'])
    : (configLists?.claude_models ?? ['sonnet'])
);

vi.mock('../pid-lock.js', () => ({
  acquirePidLock: (...args: unknown[]) => mockAcquirePidLock(...args),
}));

vi.mock('@ccbuddy/core', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  createEventBus: (...args: unknown[]) => mockCreateEventBus(...args),
  isValidModel: (...args: unknown[]) => mockIsValidModel(...args as [string]),
  isValidModelForBackend: (...args: unknown[]) => mockIsValidModelForBackend(...args as [string]),
  getModelOptionsForBackend: (...args: unknown[]) => mockGetModelOptionsForBackend(...args as [string, { claude_models?: string[]; codex_models?: string[] } | undefined]),
  UserManager: function (this: unknown, ...args: unknown[]) {
    return mockUserManager(...args);
  },
}));

const mockSdkBackend = vi.fn();
const mockCliBackend = vi.fn();
const mockCodexSdkBackend = vi.fn();
const mockCodexCliBackend = vi.fn();
const mockAgentService = vi.fn();
const mockSessionStore = vi.fn();

vi.mock('@ccbuddy/agent', () => ({
  SdkBackend: function (this: unknown, ...args: unknown[]) {
    return mockSdkBackend(...args);
  },
  CliBackend: function (this: unknown, ...args: unknown[]) {
    return mockCliBackend(...args);
  },
  CodexSdkBackend: function (this: unknown, ...args: unknown[]) {
    return mockCodexSdkBackend(...args);
  },
  CodexCliBackend: function (this: unknown, ...args: unknown[]) {
    return mockCodexCliBackend(...args);
  },
  AgentService: function (this: unknown, ...args: unknown[]) {
    return mockAgentService(...args);
  },
  SessionStore: function (this: unknown, ...args: unknown[]) {
    return mockSessionStore(...args);
  },
}));

const mockMemoryDatabase = vi.fn();
const mockMessageStore = vi.fn();
const mockAgentEventStore = vi.fn();
const mockSummaryStore = vi.fn();
const mockProfileStore = vi.fn();
const mockContextAssembler = vi.fn();
const mockRetrievalTools = vi.fn();
const mockConsolidationService = vi.fn();
const mockBackupService = vi.fn();
const mockSessionDatabase = vi.fn();
const mockWorkspaceStore = vi.fn().mockReturnValue({ get: vi.fn() });

vi.mock('@ccbuddy/memory', () => ({
  MemoryDatabase: function (this: unknown, ...args: unknown[]) {
    return mockMemoryDatabase(...args);
  },
  MessageStore: function (this: unknown, ...args: unknown[]) {
    return mockMessageStore(...args);
  },
  AgentEventStore: function (this: unknown, ...args: unknown[]) {
    return mockAgentEventStore(...args);
  },
  SummaryStore: function (this: unknown, ...args: unknown[]) {
    return mockSummaryStore(...args);
  },
  ProfileStore: function (this: unknown, ...args: unknown[]) {
    return mockProfileStore(...args);
  },
  ContextAssembler: function (this: unknown, ...args: unknown[]) {
    return mockContextAssembler(...args);
  },
  RetrievalTools: function (this: unknown, ...args: unknown[]) {
    return mockRetrievalTools(...args);
  },
  ConsolidationService: function (this: unknown, ...args: unknown[]) {
    return mockConsolidationService(...args);
  },
  BackupService: function (this: unknown, ...args: unknown[]) {
    return mockBackupService(...args);
  },
  SessionDatabase: function (this: unknown, ...args: unknown[]) {
    return mockSessionDatabase(...args);
  },
  WorkspaceStore: function (this: unknown, ...args: unknown[]) {
    return mockWorkspaceStore(...args);
  },
}));

const mockSkillRegistry = vi.fn();

vi.mock('@ccbuddy/skills', () => ({
  SkillRegistry: function (this: unknown, ...args: unknown[]) {
    return mockSkillRegistry(...args);
  },
  MCP_SERVER_PATH: '/mock/mcp-server.js',
}));

const mockGateway = vi.fn();

const mockDiscordAdapter = vi.fn();

vi.mock('@ccbuddy/platform-discord', () => ({
  DiscordAdapter: function (this: unknown, ...args: unknown[]) {
    return mockDiscordAdapter(...args);
  },
}));

const mockTelegramAdapter = vi.fn();

vi.mock('@ccbuddy/platform-telegram', () => ({
  TelegramAdapter: function (this: unknown, ...args: unknown[]) {
    return mockTelegramAdapter(...args);
  },
}));

const mockShutdownHandler = vi.fn();

vi.mock('@ccbuddy/orchestrator', () => ({
  ShutdownHandler: function (this: unknown, ...args: unknown[]) {
    return mockShutdownHandler(...args);
  },
}));

const mockSchedulerService = vi.fn();
const mockNotificationService = vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn(), tick: vi.fn() });
const mockResolvePreferences = vi.fn().mockReturnValue({
  enabled: true, types: {}, target: { platform: 'discord', channel: 'DM' }, quietHours: null, muteUntil: null,
});
const mockDashboardServer = vi.fn();
const mockWebChatAdapter = vi.fn();
const mockExecFile = vi.fn();

vi.mock('@ccbuddy/scheduler', () => ({
  SchedulerService: function (this: unknown, ...args: unknown[]) {
    return mockSchedulerService(...args);
  },
  NotificationService: function (this: unknown, ...args: unknown[]) {
    return mockNotificationService(...args);
  },
  resolvePreferences: (...args: unknown[]) => mockResolvePreferences(...args),
}));

vi.mock('@ccbuddy/dashboard', () => ({
  DashboardServer: function (this: unknown, ...args: unknown[]) {
    return mockDashboardServer(...args);
  },
  WebChatAdapter: function (this: unknown, ...args: unknown[]) {
    return mockWebChatAdapter(...args);
  },
}));

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

mockDashboardServer.mockImplementation(() => ({
    start: vi.fn().mockResolvedValue('http://127.0.0.1:18801'),
    stop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@ccbuddy/gateway', async (importOriginal) => {
  return {
    Gateway: function (this: unknown, ...args: unknown[]) {
      return mockGateway(...args);
    },
    chunkMessage: (text: string) => [text],
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    agent: {
      backend: 'sdk',
      model: 'sonnet',
      max_concurrent_sessions: 3,
      session_timeout_minutes: 30,
      queue_max_depth: 10,
      queue_timeout_seconds: 120,
      rate_limits: { admin: 30, trusted: 20, chat: 10, system: 20 },
      default_working_directory: '~',
      admin_skip_permissions: true,
      session_cleanup_hours: 24,
      pending_input_timeout_minutes: 10,
      graceful_shutdown_timeout_seconds: 30,
      session_timeout_ms: 3_600_000,
      user_input_timeout_ms: 300_000,
      max_pause_ms: 604_800_000,
      trusted_allowed_tools: ['Read', 'Glob', 'Grep'],
      max_turns: 80,
      compaction_threshold: 50,
      compaction_summary_tokens: 4000,
      permission_gates: {
        enabled: true,
        rules: [
          { name: 'destructive-rm', pattern: 'rm\\s+-rf', tool: 'Bash', description: 'Block rm -rf' },
        ],
      },
      codex: {
        api_key_env: 'OPENAI_API_KEY',
        network_access: true,
        default_sandbox: 'workspace-write',
      },
      claude_models: ['sonnet', 'opus'],
      codex_models: ['gpt-5.4', 'gpt-5.4-mini'],
    },
    memory: {
      db_path: './data/memory.sqlite',
      max_context_tokens: 100000,
      context_threshold: 0.75,
      fresh_tail_count: 32,
      leaf_chunk_tokens: 20000,
      leaf_target_tokens: 1200,
      condensed_target_tokens: 2000,
      max_expand_tokens: 4000,
      consolidation_cron: '0 3 * * *',
      backup_cron: '0 4 * * *',
      backup_dir: './data/backups',
      max_backups: 7,
      message_retention_days: 30,
    },
    gateway: {
      unknown_user_reply: true,
    },
    platforms: {
      discord: { enabled: true, token: 'discord-token-123' },
      telegram: { enabled: true, token: 'telegram-token-456' },
    },
    data_dir: './data',
    skills: {
      generated_dir: './skills/generated',
      require_admin_approval_for_elevated: true,
      auto_git_commit: true,
    },
    scheduler: {
      timezone: 'UTC',
    },
    heartbeat: {
      interval_seconds: 60,
      checks: { process: true, database: true, agent: true },
    },
    webhooks: {
      enabled: false,
      port: 18800,
    },
    dashboard: {
      enabled: false,
      port: 18801,
    },
    media: {
      max_file_size_mb: 10,
      allowed_mime_types: ['image/jpeg', 'image/png'],
    },
    apple: {
      enabled: false,
    },
    users: {
      alice: { name: 'alice', role: 'admin', discord_id: 'discord-alice' },
    },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('bootstrap', () => {
  let fakeConfig: ReturnType<typeof makeConfig>;
  let fakeEventBus: { publish: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
  let fakeUserManagerInstance: {
    findByPlatformId: ReturnType<typeof vi.fn>;
    buildSessionId: ReturnType<typeof vi.fn>;
    registerPlatformId: ReturnType<typeof vi.fn>;
    getAllUsers: ReturnType<typeof vi.fn>;
  };
  let fakeSdkBackendInstance: object;
  let fakeCodexSdkBackendInstance: object;
  let fakeCodexCliBackendInstance: object;
  let fakeAgentServiceInstance: {
    handleRequest: ReturnType<typeof vi.fn>;
    tick: ReturnType<typeof vi.fn>;
    setBackend: ReturnType<typeof vi.fn>;
  };
  let fakeDatabaseInstance: {
    init: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    raw: ReturnType<typeof vi.fn>;
  };
  let fakeSessionStoreInstance: {
    tick: ReturnType<typeof vi.fn>;
    hydrate: ReturnType<typeof vi.fn>;
    archiveAll: ReturnType<typeof vi.fn>;
  };
  let fakeMessageStoreInstance: { add: ReturnType<typeof vi.fn>; getById: ReturnType<typeof vi.fn> };
  let fakeSummaryStoreInstance: object;
  let fakeProfileStoreInstance: object;
  let fakeContextAssemblerInstance: {
    assemble: ReturnType<typeof vi.fn>;
    formatAsPrompt: ReturnType<typeof vi.fn>;
  };
  let fakeRetrievalToolsInstance: { getToolDefinitions: ReturnType<typeof vi.fn> };
  let fakeSkillRegistryInstance: {
    load: ReturnType<typeof vi.fn>;
    registerExternalTool: ReturnType<typeof vi.fn>;
  };
  let fakeGatewayInstance: {
    registerAdapter: ReturnType<typeof vi.fn>;
    getAdapter: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
  let fakeDiscordAdapterInstance: object;
  let fakeTelegramAdapterInstance: object;
  let fakeShutdownHandlerInstance: {
    register: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();

    fakeConfig = makeConfig();
    fakeEventBus = { publish: vi.fn(), subscribe: vi.fn() };
    fakeUserManagerInstance = {
      findByPlatformId: vi.fn(),
      buildSessionId: vi.fn().mockReturnValue('alice-discord-ch1'),
      registerPlatformId: vi.fn(),
      getAllUsers: vi.fn().mockReturnValue([]),
    };
    fakeSdkBackendInstance = {};
    fakeCodexSdkBackendInstance = {};
    fakeCodexCliBackendInstance = {};
    fakeAgentServiceInstance = {
      handleRequest: vi.fn().mockReturnValue((async function* () {})()),
      tick: vi.fn(),
      setBackend: vi.fn(),
    };
    fakeDatabaseInstance = {
      init: vi.fn(),
      close: vi.fn(),
      raw: vi.fn().mockReturnValue({}),
    };
    fakeSessionStoreInstance = {
      tick: vi.fn(),
      hydrate: vi.fn(),
      archiveAll: vi.fn().mockReturnValue(0),
    };
    fakeMessageStoreInstance = { add: vi.fn(), getById: vi.fn() };
    fakeSummaryStoreInstance = {};
    fakeProfileStoreInstance = {};
    fakeContextAssemblerInstance = {
      assemble: vi.fn().mockReturnValue({ profile: '', messages: [], summaries: [], totalTokens: 0, needsCompaction: false }),
      formatAsPrompt: vi.fn().mockReturnValue(''),
    };
    fakeRetrievalToolsInstance = {
      getToolDefinitions: vi.fn().mockReturnValue([
        { name: 'memory_grep', description: 'grep', inputSchema: { type: 'object', properties: {}, required: [] } },
        { name: 'memory_describe', description: 'describe', inputSchema: { type: 'object', properties: {}, required: [] } },
        { name: 'memory_expand', description: 'expand', inputSchema: { type: 'object', properties: {}, required: [] } },
      ]),
    };
    fakeSkillRegistryInstance = {
      load: vi.fn().mockResolvedValue(undefined),
      registerExternalTool: vi.fn(),
    };
    fakeGatewayInstance = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    fakeDiscordAdapterInstance = {};
    fakeTelegramAdapterInstance = {};
    fakeShutdownHandlerInstance = {
      register: vi.fn(),
      execute: vi.fn().mockResolvedValue(undefined),
    };

    mockLoadConfig.mockReturnValue(fakeConfig);
    mockCreateEventBus.mockReturnValue(fakeEventBus);
    mockAcquirePidLock.mockReturnValue(vi.fn());
    mockUserManager.mockReturnValue(fakeUserManagerInstance);
    mockSdkBackend.mockReturnValue(fakeSdkBackendInstance);
    mockCliBackend.mockReturnValue({});
    mockCodexSdkBackend.mockReturnValue(fakeCodexSdkBackendInstance);
    mockCodexCliBackend.mockReturnValue(fakeCodexCliBackendInstance);
    mockAgentService.mockReturnValue(fakeAgentServiceInstance);
    mockSessionStore.mockReturnValue(fakeSessionStoreInstance);
    mockMemoryDatabase.mockReturnValue(fakeDatabaseInstance);
    mockMessageStore.mockReturnValue(fakeMessageStoreInstance);
    mockAgentEventStore.mockReturnValue({ add: vi.fn() });
    mockSummaryStore.mockReturnValue(fakeSummaryStoreInstance);
    mockProfileStore.mockReturnValue(fakeProfileStoreInstance);
    mockContextAssembler.mockReturnValue(fakeContextAssemblerInstance);
    mockRetrievalTools.mockReturnValue(fakeRetrievalToolsInstance);
    mockConsolidationService.mockReturnValue({
      consolidate: vi.fn(),
      runFullConsolidation: vi.fn().mockResolvedValue(new Map()),
    });
    mockBackupService.mockReturnValue({
      backup: vi.fn().mockResolvedValue(undefined),
      rotateBackups: vi.fn().mockResolvedValue(undefined),
    });
    mockSkillRegistry.mockReturnValue(fakeSkillRegistryInstance);
    mockGateway.mockReturnValue(fakeGatewayInstance);
    mockDiscordAdapter.mockReturnValue(fakeDiscordAdapterInstance);
    mockTelegramAdapter.mockReturnValue(fakeTelegramAdapterInstance);
    mockShutdownHandler.mockReturnValue(fakeShutdownHandlerInstance);
    mockSchedulerService.mockReturnValue({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    });
    mockDashboardServer.mockReturnValue({
      start: vi.fn().mockResolvedValue('http://127.0.0.1:18801'),
      stop: vi.fn().mockResolvedValue(undefined),
      setWebChatAdapter: vi.fn(),
    });
    mockWebChatAdapter.mockReturnValue({});
    mockExecFile.mockImplementation((_command: string, _args: string[], _opts: { timeout: number }, callback: (err: Error | null) => void) => {
      callback(null);
      return {} as any;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    delete process.env.CUSTOM_OPENAI_API_KEY;
  });

  it('calls loadConfig with the provided configDir', async () => {
    await bootstrap('/etc/ccbuddy');
    expect(mockLoadConfig).toHaveBeenCalledWith('/etc/ccbuddy');
  });

  it('creates SdkBackend with skipPermissions from config', async () => {
    await bootstrap('/config');
    expect(mockSdkBackend).toHaveBeenCalledWith(expect.objectContaining({ skipPermissions: true }));
  });

  it('creates CliBackend when backend is cli', async () => {
    const cliConfig = makeConfig({ agent: { ...makeConfig().agent, backend: 'cli' } });
    mockLoadConfig.mockReturnValue(cliConfig);
    await bootstrap('/config');
    expect(mockCliBackend).toHaveBeenCalled();
    expect(mockSdkBackend).not.toHaveBeenCalled();
  });

  it('creates CodexSdkBackend with configured auth and sandbox options', async () => {
    process.env.CUSTOM_OPENAI_API_KEY = 'sk-codex-sdk';
    const codexConfig = makeConfig({
      agent: {
        ...makeConfig().agent,
        backend: 'codex-sdk',
        codex: {
          api_key_env: 'CUSTOM_OPENAI_API_KEY',
          network_access: false,
          default_sandbox: 'read-only',
        },
      },
    });
    mockLoadConfig.mockReturnValue(codexConfig);

    await bootstrap('/config');

    expect(mockCodexSdkBackend).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'sk-codex-sdk',
      networkAccess: false,
      defaultSandbox: 'read-only',
      permissionGateRules: codexConfig.agent.permission_gates.rules,
    }));
  });

  it('creates CodexCliBackend with the same configured auth and sandbox options', async () => {
    process.env.CUSTOM_OPENAI_API_KEY = 'sk-codex-cli';
    const codexConfig = makeConfig({
      agent: {
        ...makeConfig().agent,
        backend: 'codex-cli',
        codex: {
          api_key_env: 'CUSTOM_OPENAI_API_KEY',
          codex_path: '/custom/codex',
          network_access: false,
          default_sandbox: 'danger-full-access',
        },
      },
    });
    mockLoadConfig.mockReturnValue(codexConfig);

    await bootstrap('/config');

    expect(mockCodexCliBackend).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'sk-codex-cli',
      codexPath: '/custom/codex',
      networkAccess: false,
      defaultSandbox: 'danger-full-access',
      permissionGateRules: codexConfig.agent.permission_gates.rules,
    }));
  });

  it('calls MemoryDatabase.init()', async () => {
    await bootstrap('/config');
    expect(fakeDatabaseInstance.init).toHaveBeenCalled();
  });

  it('loads the SkillRegistry', async () => {
    await bootstrap('/config');
    expect(fakeSkillRegistryInstance.load).toHaveBeenCalled();
  });

  it('registers retrieval tools with SkillRegistry', async () => {
    await bootstrap('/config');
    expect(fakeSkillRegistryInstance.registerExternalTool).toHaveBeenCalledTimes(3);
    const toolNames = (fakeSkillRegistryInstance.registerExternalTool as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { name: string }).name,
    );
    expect(toolNames).toContain('memory_grep');
    expect(toolNames).toContain('memory_describe');
    expect(toolNames).toContain('memory_expand');
  });

  it('passes trusted rate limits into AgentService', async () => {
    await bootstrap('/config');

    expect(mockAgentService).toHaveBeenCalledWith(expect.objectContaining({
      rateLimits: {
        admin: 30,
        trusted: 20,
        chat: 10,
        system: 20,
      },
    }));
  });

  it('passes CCBUDDY_OUTBOUND_DIR into the skills MCP server env per request', async () => {
    await bootstrap('/config');

    const gatewayDeps = (mockGateway as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      executeAgentRequest: (request: AgentRequest) => AsyncGenerator<unknown>;
    };

    const request: AgentRequest = {
      prompt: 'hello',
      userId: 'alice',
      sessionId: 'alice-discord-ch1',
      channelId: 'ch1',
      platform: 'discord',
      permissionLevel: 'admin',
      outboundMediaDir: '/tmp/ccbuddy-outbound/request-1',
    };

    for await (const _event of gatewayDeps.executeAgentRequest(request)) {}

    expect(fakeAgentServiceInstance.handleRequest).toHaveBeenCalledWith(expect.objectContaining({
      mcpServers: [
        expect.objectContaining({
          name: 'ccbuddy-skills',
          env: expect.objectContaining({
            CCBUDDY_OUTBOUND_DIR: '/tmp/ccbuddy-outbound/request-1',
          }),
        }),
        expect.any(Object),
      ],
    }));
  });

  it('creates DiscordAdapter with the discord token', async () => {
    await bootstrap('/config');
    expect(mockDiscordAdapter).toHaveBeenCalledWith(expect.objectContaining({ token: 'discord-token-123' }));
  });

  it('creates TelegramAdapter with the telegram token', async () => {
    await bootstrap('/config');
    expect(mockTelegramAdapter).toHaveBeenCalledWith(expect.objectContaining({ token: 'telegram-token-456' }));
  });

  it('calls Gateway.registerAdapter twice (discord + telegram)', async () => {
    await bootstrap('/config');
    expect(fakeGatewayInstance.registerAdapter).toHaveBeenCalledTimes(2);
    expect(fakeGatewayInstance.registerAdapter).toHaveBeenCalledWith(fakeDiscordAdapterInstance);
    expect(fakeGatewayInstance.registerAdapter).toHaveBeenCalledWith(fakeTelegramAdapterInstance);
  });

  it('calls Gateway.start()', async () => {
    await bootstrap('/config');
    expect(fakeGatewayInstance.start).toHaveBeenCalled();
  });

  it('runtime backend switching does not archive sessions if the new backend fails to initialize', async () => {
    const cfg = makeConfig({
      dashboard: { enabled: true, port: 18801 },
    });
    mockLoadConfig.mockReturnValue(cfg);
    mockCodexCliBackend.mockImplementation(() => {
      throw new Error('codex init failed');
    });

    await bootstrap('/config');

    const dashboardDeps = mockDashboardServer.mock.calls[0][0] as {
      switchBackend: (backend: string) => Promise<string>;
    };

    await expect(dashboardDeps.switchBackend('codex-cli')).rejects.toThrow('codex init failed');
    expect(fakeSessionStoreInstance.archiveAll).not.toHaveBeenCalled();
  });

  it('runtime backend switching archives sessions only after the new backend is created', async () => {
    const cfg = makeConfig({
      dashboard: { enabled: true, port: 18801 },
    });
    mockLoadConfig.mockReturnValue(cfg);
    fakeSessionStoreInstance.archiveAll.mockReturnValue(2);

    await bootstrap('/config');

    const dashboardDeps = mockDashboardServer.mock.calls[0][0] as {
      switchBackend: (backend: string) => Promise<string>;
    };

    await expect(dashboardDeps.switchBackend('codex-cli')).resolves.toBe('codex-cli');
    expect(mockCodexCliBackend).toHaveBeenCalled();
    expect(fakeAgentServiceInstance.setBackend).toHaveBeenCalledWith(fakeCodexCliBackendInstance);
    expect(fakeSessionStoreInstance.archiveAll).toHaveBeenCalledTimes(1);
  });

  it('waits for SDK backend readiness before dispatching gateway requests', async () => {
    let requestFinished: Promise<void> | undefined;

    fakeGatewayInstance.start.mockImplementation(async () => {
      const gatewayDeps = (mockGateway as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        executeAgentRequest: (request: AgentRequest) => AsyncGenerator<unknown>;
      };

      const request: AgentRequest = {
        prompt: 'hello before sdk ready',
        userId: 'alice',
        sessionId: 'alice-discord-ch1',
        channelId: 'ch1',
        platform: 'discord',
        permissionLevel: 'admin',
      };

      requestFinished = (async () => {
        for await (const _event of gatewayDeps.executeAgentRequest(request)) {
          // Drain the request.
        }
      })();

      await Promise.resolve();

      expect(fakeAgentServiceInstance.setBackend).not.toHaveBeenCalled();
      expect(fakeAgentServiceInstance.handleRequest).not.toHaveBeenCalled();
    });

    await bootstrap('/config');

    expect(fakeAgentServiceInstance.setBackend).toHaveBeenCalledWith(fakeSdkBackendInstance);
    await requestFinished;
    expect(fakeAgentServiceInstance.handleRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'hello before sdk ready',
        userId: 'alice',
        sessionId: 'alice-discord-ch1',
      }),
    );
  });

  it('uses the active backend command for scheduler health checks', async () => {
    const cfg = makeConfig({
      agent: {
        ...makeConfig().agent,
        backend: 'codex-cli',
        codex: {
          api_key_env: 'OPENAI_API_KEY',
          codex_path: '/custom/codex',
          network_access: true,
          default_sandbox: 'workspace-write',
        },
      },
    });
    mockLoadConfig.mockReturnValue(cfg);

    await bootstrap('/config');

    const schedulerArgs = mockSchedulerService.mock.calls[0][0] as {
      checkAgent: () => Promise<{ reachable: boolean; durationMs: number }>;
    };

    await schedulerArgs.checkAgent();
    expect(mockExecFile).toHaveBeenCalledWith('/custom/codex', ['--version'], { timeout: 10_000 }, expect.any(Function));
  });

  it('does not create Discord adapter when disabled', async () => {
    const cfg = makeConfig();
    cfg.platforms.discord = { enabled: false, token: 'discord-token-123' };
    mockLoadConfig.mockReturnValue(cfg);
    await bootstrap('/config');
    expect(mockDiscordAdapter).not.toHaveBeenCalled();
  });

  it('does not create Telegram adapter when token is missing', async () => {
    const cfg = makeConfig();
    (cfg.platforms as Record<string, unknown>).telegram = { enabled: true };
    mockLoadConfig.mockReturnValue(cfg);
    await bootstrap('/config');
    expect(mockTelegramAdapter).not.toHaveBeenCalled();
  });

  it('fires agentService.tick() on the 60s interval', async () => {
    await bootstrap('/config');
    expect(fakeAgentServiceInstance.tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(fakeAgentServiceInstance.tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(fakeAgentServiceInstance.tick).toHaveBeenCalledTimes(2);
  });

  it('stop() clears the tick interval and executes shutdown handler', async () => {
    const { stop } = await bootstrap('/config');
    vi.advanceTimersByTime(60_000);
    expect(fakeAgentServiceInstance.tick).toHaveBeenCalledTimes(1);

    await stop();

    // Interval should be cleared — no more ticks
    vi.advanceTimersByTime(60_000);
    expect(fakeAgentServiceInstance.tick).toHaveBeenCalledTimes(1);

    expect(fakeShutdownHandlerInstance.execute).toHaveBeenCalled();
  });

  it('stop() releases the pid lock after shutdown', async () => {
    const callOrder: string[] = [];
    const releasePidLock = vi.fn(() => {
      callOrder.push('release');
    });
    mockAcquirePidLock.mockReturnValue(releasePidLock);
    fakeShutdownHandlerInstance.execute.mockImplementation(async () => {
      callOrder.push('shutdown');
    });

    const { stop } = await bootstrap('/config');
    await stop();

    expect(callOrder).toEqual(['shutdown', 'release']);
  });

  it('releases the pid lock when bootstrap fails after acquisition', async () => {
    const callOrder: string[] = [];
    const releasePidLock = vi.fn(() => {
      callOrder.push('release');
    });
    mockAcquirePidLock.mockReturnValue(releasePidLock);
    fakeShutdownHandlerInstance.execute.mockImplementation(async () => {
      callOrder.push('shutdown');
    });

    const schedulerService = {
      start: vi.fn().mockRejectedValue(new Error('scheduler boom')),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    mockSchedulerService.mockReturnValue(schedulerService);

    await expect(bootstrap('/config')).rejects.toThrow('scheduler boom');
    expect(callOrder).toEqual(['shutdown', 'release']);
  });

  it('runs shutdown cleanup before releasing the pid lock when skill registry loading fails', async () => {
    const callOrder: string[] = [];
    const releasePidLock = vi.fn(() => {
      callOrder.push('release');
    });
    mockAcquirePidLock.mockReturnValue(releasePidLock);
    fakeShutdownHandlerInstance.execute.mockImplementation(async () => {
      callOrder.push('shutdown');
    });
    mockSkillRegistry.mockReturnValue({
      load: vi.fn().mockRejectedValue(new Error('registry boom')),
      registerExternalTool: vi.fn(),
    });

    await expect(bootstrap('/config')).rejects.toThrow('registry boom');
    expect(callOrder).toEqual(['shutdown', 'release']);
  });

  it('registers shutdown handlers for gateway and database', async () => {
    await bootstrap('/config');
    const registerCalls = (fakeShutdownHandlerInstance.register as ReturnType<typeof vi.fn>).mock.calls;
    const names = registerCalls.map((c) => c[0] as string);
    expect(names).toContain('gateway');
    expect(names).toContain('database');
  });

  it('shutdown handler for database calls database.close()', async () => {
    await bootstrap('/config');
    const registerCalls = (fakeShutdownHandlerInstance.register as ReturnType<typeof vi.fn>).mock.calls;
    const dbEntry = registerCalls.find((c) => c[0] === 'database');
    expect(dbEntry).toBeDefined();
    const callback = dbEntry![1] as () => Promise<void>;
    await callback();
    expect(fakeDatabaseInstance.close).toHaveBeenCalled();
  });

  it('shutdown handler for gateway calls gateway.stop()', async () => {
    await bootstrap('/config');
    const registerCalls = (fakeShutdownHandlerInstance.register as ReturnType<typeof vi.fn>).mock.calls;
    const gwEntry = registerCalls.find((c) => c[0] === 'gateway');
    expect(gwEntry).toBeDefined();
    const callback = gwEntry![1] as () => Promise<void>;
    await callback();
    expect(fakeGatewayInstance.stop).toHaveBeenCalled();
  });

  it('defaults configDir to process.cwd() when not provided', async () => {
    await bootstrap();
    expect(mockLoadConfig).toHaveBeenCalledWith(process.cwd() + '/config');
  });

  it('builds registryPath from dirname of generated_dir', async () => {
    await bootstrap('/config');
    // skills.generated_dir = './skills/generated'
    // dirname('./skills/generated') = 'skills' (node:path strips leading ./)
    // registryPath = 'skills/registry.yaml'
    expect(mockSkillRegistry).toHaveBeenCalledWith('skills/registry.yaml');
  });
});
