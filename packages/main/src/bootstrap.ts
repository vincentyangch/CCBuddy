import { join, dirname } from 'node:path';
import { writeFileSync, renameSync, readFileSync } from 'node:fs';
import { loadConfig, createEventBus, UserManager, TranscriptionService, SpeechService, isValidModel, isValidModelForBackend, getModelOptionsForBackend, type BackendType } from '@ccbuddy/core';
import { AgentService, CliBackend, SessionStore } from '@ccbuddy/agent';
import {
  MemoryDatabase,
  MessageStore,
  SummaryStore,
  ProfileStore,
  ContextAssembler,
  RetrievalTools,
  ConsolidationService,
  BackupService,
  AgentEventStore,
  SessionDatabase,
  WorkspaceStore,
} from '@ccbuddy/memory';
import { SkillRegistry, MCP_SERVER_PATH } from '@ccbuddy/skills';
import { Gateway } from '@ccbuddy/gateway';
import { DiscordAdapter } from '@ccbuddy/platform-discord';
import { TelegramAdapter } from '@ccbuddy/platform-telegram';
import { ShutdownHandler } from '@ccbuddy/orchestrator';
import { SchedulerService, NotificationService, resolvePreferences } from '@ccbuddy/scheduler';
import { chunkMessage } from '@ccbuddy/gateway';
import { DashboardServer } from '@ccbuddy/dashboard';
import { acquirePidLock } from './pid-lock.js';

export interface BootstrapResult {
  stop: () => Promise<void>;
}

export async function bootstrap(configDir?: string): Promise<BootstrapResult> {
  let releasePidLock: (() => void) | undefined;
  let tickInterval: ReturnType<typeof setInterval> | undefined;
  let shutdownHandler: ShutdownHandler | undefined;
  let resolveAgentBackendReady: (() => void) | undefined;
  let agentBackendReady: Promise<void> = Promise.resolve();
  let agentBackendReadyError: unknown;

  try {
    // 1. Load config
    const resolvedConfigDir = configDir ?? join(process.cwd(), 'config');
    const config = loadConfig(resolvedConfigDir);

  // 1a. Apply runtime overrides (from dashboard)
  const runtimeConfigPath = join(config.data_dir, 'runtime-config.json');
  try {
    const runtimeConfig = JSON.parse(readFileSync(runtimeConfigPath, 'utf8'));

    // Restore backend first — model validation depends on it
    const validBackends: BackendType[] = ['sdk', 'cli', 'codex-sdk', 'codex-cli'];
    if (runtimeConfig.backend && validBackends.includes(runtimeConfig.backend)) {
      config.agent.backend = runtimeConfig.backend;
      console.log(`[Bootstrap] Runtime backend override applied: ${runtimeConfig.backend}`);
    }

    // Restore custom model lists
    if (Array.isArray(runtimeConfig.claude_models) && runtimeConfig.claude_models.every((m: unknown) => typeof m === 'string')) {
      config.agent.claude_models = runtimeConfig.claude_models;
      console.log(`[Bootstrap] Runtime claude_models override applied (${runtimeConfig.claude_models.length} models)`);
    }
    if (Array.isArray(runtimeConfig.codex_models) && runtimeConfig.codex_models.every((m: unknown) => typeof m === 'string')) {
      config.agent.codex_models = runtimeConfig.codex_models;
      console.log(`[Bootstrap] Runtime codex_models override applied (${runtimeConfig.codex_models.length} models)`);
    }

    // Restore model, validating against the (possibly overridden) backend
    if (runtimeConfig.model && isValidModel(runtimeConfig.model)) {
      if (isValidModelForBackend(runtimeConfig.model, config.agent.backend as BackendType)) {
        config.agent.model = runtimeConfig.model;
        console.log(`[Bootstrap] Runtime model override applied: ${runtimeConfig.model}`);
      } else {
        // Model incompatible with backend — reset to first valid model
        const validModels = getModelOptionsForBackend(config.agent.backend as BackendType);
        if (validModels.length > 0) {
          config.agent.model = validModels[0];
          console.log(`[Bootstrap] Model '${runtimeConfig.model}' incompatible with backend '${config.agent.backend}', reset to '${validModels[0]}'`);
        }
      }
    }
  } catch { /* no runtime config */ }

  // 1b. Acquire PID lock — kills any existing CCBuddy process
  releasePidLock = acquirePidLock(config.data_dir);

  // 1c. Create shutdown handler early so startup failures can reuse cleanup logic
  shutdownHandler = new ShutdownHandler(
    config.agent.graceful_shutdown_timeout_seconds * 1000,
  );

  // 2. Create event bus
  const eventBus = createEventBus();

  // 3. Create UserManager from config users
  const userManager = new UserManager(Object.values(config.users));

  // 4. Create agent backend with CLI (SDK loaded lazily after Discord connects)
  const backend = new CliBackend();

  // 5. Create memory database first (SessionDatabase depends on it)
  const projectRoot = dirname(resolvedConfigDir);
  const resolve = (p: string) => join(projectRoot, p);
  const database = new MemoryDatabase(config.memory.db_path);
  database.init();
  shutdownHandler.register('database', async () => {
    database.close();
  });

  const sessionDb = new SessionDatabase(database.raw());
  const sessionStore = new SessionStore(config.agent.session_timeout_ms, {
    persistence: sessionDb,
    maxPauseMs: config.agent.max_pause_ms,
  });
  sessionStore.hydrate();

  const agentService = new AgentService({
    backend,
    eventBus,
    maxConcurrent: config.agent.max_concurrent_sessions,
    rateLimits: {
      admin: config.agent.rate_limits.admin,
      trusted: config.agent.rate_limits.trusted,
      chat: config.agent.rate_limits.chat,
      system: config.agent.rate_limits.system,
    },
    queueMaxDepth: config.agent.queue_max_depth,
    queueTimeoutSeconds: config.agent.queue_timeout_seconds,
    sessionTimeoutMinutes: config.agent.session_timeout_minutes,
    sessionCleanupHours: config.agent.session_cleanup_hours,
    sessionStore,
  });

  // SDK mode starts adapters before importing the SDK; gateway work must wait
  // until the final backend is installed instead of using the transitional CLI.
  if (config.agent.backend === 'sdk' || config.agent.backend === 'codex-sdk' || config.agent.backend === 'codex-cli') {
    agentBackendReady = new Promise<void>((resolve) => {
      resolveAgentBackendReady = resolve;
    });
  }

  // 6. Create memory stores

  const messageStore = new MessageStore(database);
  const agentEventStore = new AgentEventStore(database);
  const summaryStore = new SummaryStore(database);
  const profileStore = new ProfileStore(database);
  const workspaceStore = new WorkspaceStore(database.raw());

  const contextAssembler = new ContextAssembler(messageStore, summaryStore, profileStore, {
    maxContextTokens: config.memory.max_context_tokens,
    freshTailCount: config.memory.fresh_tail_count,
    contextThreshold: config.memory.context_threshold,
  });

  const retrievalTools = new RetrievalTools(messageStore, summaryStore);

  // 6b. Create consolidation and backup services
  const summarize = async (text: string): Promise<string> => {
    const sessionId = `consolidation:${Date.now()}`;
    const request: import('@ccbuddy/core').AgentRequest = {
      prompt: text,
      userId: 'system',
      sessionId,
      channelId: 'internal',
      platform: 'system',
      permissionLevel: 'system',
      systemPrompt: 'You are a summarization engine. Summarize the following conversation preserving key facts, decisions, user preferences, and important context. Be concise but thorough. Output only the summary, no preamble.',
    };

    const generator = agentService.handleRequest(request);
    let result = '';
    for await (const event of generator) {
      if (event.type === 'complete') {
        result = event.response;
        break;
      }
      if (event.type === 'error') {
        throw new Error(`Summarization failed: ${event.error}`);
      }
    }
    return result;
  };

  const consolidationService = new ConsolidationService({
    messageStore,
    summaryStore,
    database,
    config: config.memory,
    summarize,
  });

  const backupService = new BackupService({
    database,
    config: config.memory,
    eventBus,
  });

  // 7. Create SkillRegistry and register retrieval tools
  const registryPath = join(dirname(config.skills.generated_dir), 'registry.yaml');
  const skillRegistry = new SkillRegistry(registryPath);
  await skillRegistry.load();

  for (const tool of retrievalTools.getToolDefinitions()) {
    skillRegistry.registerExternalTool(tool);
  }

  // Build skill MCP server spec
  // All paths must be absolute — the SDK spawns a CLI subprocess that may use a different CWD
  const skillMcpServerPath = config.skills.mcp_server_path ?? MCP_SERVER_PATH;
  const registryDir = dirname(config.skills.generated_dir); // parent dir (e.g., './skills')
  // Forward env vars from this process to the MCP server subprocess.
  // The Claude Code SDK session does not inherit the LaunchAgent environment,
  // so env vars (e.g. third-party service keys) must be passed explicitly.
  const forwardedEnvKeys = Object.keys(process.env).filter(k =>
    k.startsWith('HOMEASSISTANT_') ||
    k.startsWith('CCBUDDY_') ||
    k.startsWith('OPENAI_') ||
    k === 'PATH' || k === 'HOME' || k === 'USER' || k === 'TMPDIR'
  );
  const forwardedEnv: Record<string, string> = {};
  for (const k of forwardedEnvKeys) {
    if (process.env[k] !== undefined) forwardedEnv[k] = process.env[k] as string;
  }

  // Determine owner user ID: the first admin user in config, used as default for memory tool calls
  const adminUser = Object.values(config.users).find(u => u.role === 'admin');
  const ownerUserId = adminUser?.name ?? '';

  const skillMcpServer = {
    name: 'ccbuddy-skills',
    command: process.execPath, // Use the exact same Node.js binary as the parent process
    args: [
      skillMcpServerPath, // already absolute (from import.meta.url)
      '--registry', resolve(registryPath),
      '--skills-dir', resolve(registryDir),
      ...(config.skills.require_admin_approval_for_elevated ? [] : ['--no-approval']),
      ...(config.skills.auto_git_commit ? [] : ['--no-git-commit']),
      '--memory-db', resolve(config.memory.db_path),
      '--heartbeat-status-file', resolve(join(config.data_dir, 'heartbeat-status.json')),
      '--data-dir', resolve(config.data_dir),
      ...(ownerUserId ? ['--owner-user-id', ownerUserId] : []),
    ],
    env: forwardedEnv,
    get backend() { return config.agent.backend; },
  };

  // Home Assistant MCP server (ha-mcp via uvx)
  // Uses forwardedEnv so the subprocess inherits PATH (needed to find uvx) plus HOMEASSISTANT_* vars
  const haMcpServer = {
    name: 'home-assistant',
    command: 'uvx',
    args: ['ha-mcp@latest'],
    env: {
      ...forwardedEnv,
      HOMEASSISTANT_URL: process.env.HOMEASSISTANT_URL ?? 'http://localhost:8123',
      HOMEASSISTANT_TOKEN: process.env.HOMEASSISTANT_TOKEN ?? '',
    },
  };

  // 7b. Wire Apple helper path into MCP server args if enabled
  if (config.apple.enabled) {
    const helperPath = config.apple.helper_path
      ?? join(projectRoot, 'swift-helper', '.build', 'release', 'ccbuddy-helper');
    skillMcpServer.args.push('--apple-helper', helperPath);
  }

  const identityPrompt = `You are CCBuddy — a personal AI assistant belonging to flyingchickens. You run 24/7 on a Mac Mini and are reachable via Discord. Your name is CCBuddy (or just "Buddy"). When asked who you are, introduce yourself as CCBuddy. You are powered by Claude under the hood, but your identity, personality, and purpose are CCBuddy's. You are helpful, concise, and proactive. You know your own codebase (this project) and can improve yourself when asked.

**IMPORTANT — Identity clarification:** You are NOT a Claude Code CLI session. You ARE CCBuddy, a persistent agent running via macOS launchd (com.ccbuddy.agent.plist). The CLAUDE.md file in this project describes YOUR own codebase in third person — it is documentation about you, not instructions for a separate developer. This project IS you. When you see references to "CCBuddy" in project files, that is you.

You have profile tools (profile_get, profile_set, profile_delete) to remember things about users across conversations. When you learn something about a user — their preferences, interests, timezone, communication style, or anything worth remembering — save it with profile_set. This data automatically appears in your context for every future conversation. Proactively use these tools; don't wait to be asked.

**Memory tools:** When using memory_grep, memory_get_briefs, memory_describe, or memory_expand, the userId is "${ownerUserId || 'flyingchickens'}". You may omit userId entirely — the tools will default to the owner user. Use memory_get_briefs to retrieve morning/evening briefings (jobName examples: "evening_briefing", "morning_briefing_weekday", "morning_briefing_weekend").`;

  const skillNudge = 'You have access to reusable skills (prefixed skill_) and can create new ones with create_skill. When you solve a novel problem that could be reusable, consider creating a skill for it.\n\nFor image generation requests, use the skill_generate_image tool directly with a descriptive prompt. Do not deliberate — just call the tool.';

  // 7c. Voice services (optional)
  let transcriptionService: TranscriptionService | undefined;
  let speechService: SpeechService | undefined;
  if (config.media.voice_enabled) {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      console.warn('[Bootstrap] voice_enabled is true but OPENAI_API_KEY is not set — voice disabled');
    } else {
      transcriptionService = new TranscriptionService(openaiKey);
      speechService = new SpeechService(openaiKey);
    }
  }

  // 8. Create Gateway with injected dependencies
  const gateway = new Gateway({
    eventBus,
    findUser: (platform, platformId) => userManager.findByPlatformId(platform, platformId),
    buildSessionId: (userName, platform, channelId) =>
      userManager.buildSessionId(userName, platform, channelId),
    executeAgentRequest: async function* (request) {
      await agentBackendReady;
      if (agentBackendReadyError !== undefined) {
        throw agentBackendReadyError;
      }

      const mcpServer = {
        ...skillMcpServer,
        args: [
          ...skillMcpServer.args,
          '--backend', skillMcpServer.backend,
          '--session-key', request.sessionId,
          '--channel-key', `${request.platform}-${request.channelId}`,
        ],
        env: {
          ...skillMcpServer.env,
          ...(request.outboundMediaDir ? { CCBUDDY_OUTBOUND_DIR: request.outboundMediaDir } : {}),
        },
      };
      yield* agentService.handleRequest({
        ...request,
        workingDirectory: request.workingDirectory,
        mcpServers: [mcpServer, haMcpServer],
        env: forwardedEnv,
        systemPrompt: [identityPrompt, request.systemPrompt, skillNudge].filter(Boolean).join('\n\n'),
      });
    },
    assembleContext: (userId, sessionId) => {
      const context = contextAssembler.assemble(userId, sessionId);
      return contextAssembler.formatAsPrompt(context);
    },
    storeMessage: (params) => {
      messageStore.add({
        userId: params.userId,
        sessionId: params.sessionId,
        platform: params.platform,
        content: params.content,
        role: params.role,
        attachments: params.attachments,
      });
    },
    gatewayConfig: config.gateway,
    platformsConfig: config.platforms,
    outboundMediaDir: join(config.data_dir, 'outbound'),
    transcriptionService,
    speechService,
    voiceConfig: { enabled: config.media.voice_enabled, ttsMaxChars: config.media.tts_max_chars },
    sessionStore,
    get defaultModel() { return config.agent.model; },
    userInputTimeoutMs: config.agent.user_input_timeout_ms,
    storeAgentEvent: (params) => {
      agentEventStore.add({ ...params, timestamp: Date.now() });
    },
    getWorkspace: (channelKey) => workspaceStore.get(channelKey),
    defaultWorkingDirectory: config.agent.default_working_directory,
    compactSession: async ({ sessionKey, userId, sessionId, platform, channelId }) => {
      // Fetch recent messages for this session
      const messages = messageStore.getFreshTail(userId, sessionId, 500);
      if (messages.length === 0) {
        throw new Error('No messages to compact');
      }
      const conversationText = messages
        .map(m => `[${m.role}] ${m.content}`)
        .join('\n\n');

      // Summarize using existing summarize function
      const summary = await summarize(
        `Summarize this conversation, preserving key decisions, code changes, current task state, and any important context the assistant needs to continue helping:\n\n${conversationText}`
      );

      // Archive old session, create new one
      sessionStore.archive(sessionKey);
      const newSession = sessionStore.getOrCreate(
        sessionKey, false, platform, channelId, userId,
      );

      console.log(`[Compaction] Session ${sessionKey} compacted: ${messages.length} messages → ${summary.length} char summary`);
      return { newSdkSessionId: newSession.sdkSessionId, summary };
    },
    compactionThreshold: config.agent.compaction_threshold,
  });

  // 9. Create and register platform adapters based on config
  if (config.platforms.discord?.enabled && config.platforms.discord.token) {
    const discordAdapter = new DiscordAdapter({ token: config.platforms.discord.token, mediaConfig: config.media });
    gateway.registerAdapter(discordAdapter);
  }

  if (config.platforms.telegram?.enabled && config.platforms.telegram.token) {
    const telegramAdapter = new TelegramAdapter({ token: config.platforms.telegram.token, mediaConfig: config.media });
    gateway.registerAdapter(telegramAdapter);
  }

  // 9b. Create webchat adapter (if dashboard enabled) — must register before gateway.start()
  let webchatAdapter: any;
  if (config.dashboard.enabled) {
    const { WebChatAdapter } = await import('@ccbuddy/dashboard');
    webchatAdapter = new WebChatAdapter();
    gateway.registerAdapter(webchatAdapter);

    // Auto-register admin user's webchat identity
    const adminUser = Object.values(config.users).find(u => u.role === 'admin');
    if (adminUser) {
      userManager.registerPlatformId('webchat', 'dashboard', adminUser.name);
    }
  }

  // 10. Set up SessionManager.tick() interval (every 60 seconds)
  let notificationService: NotificationService | undefined;
    tickInterval = setInterval(() => {
    agentService.tick();
    sessionStore.tick();
    notificationService?.tick();
  }, 60_000);

  shutdownHandler.register('gateway', async () => {
    await gateway.stop();
  });

  // 12. Start gateway (connects Discord/Telegram)
  await gateway.start();

  // 12b. Start dashboard if enabled
  let dashboardServer: DashboardServer | undefined;
  if (config.dashboard.enabled) {
    dashboardServer = new DashboardServer({
      eventBus,
      agentService,
      messageStore,
      agentEventStore,
      config,
      configDir: resolvedConfigDir,
      logFiles: {
        stdout: join(config.data_dir, 'ccbuddy.stdout.log'),
        stderr: join(config.data_dir, 'ccbuddy.stderr.log'),
        app: join(config.data_dir, 'ccbuddy.log'),
      },
      sessionStore,
      switchBackend: async (backendName: string) => {
        // Archive all active sessions — their IDs are invalid for the new backend
        const archived = sessionStore.archiveAll();
        if (archived > 0) {
          console.log(`[Dashboard] Archived ${archived} session(s) for backend switch`);
        }

        if (backendName === 'sdk') {
          const { SdkBackend } = await import('@ccbuddy/agent');
          agentService.setBackend(new SdkBackend({
            skipPermissions: config.agent.admin_skip_permissions,
            permissionGates: config.agent.permission_gates,
            trustedAllowedTools: config.agent.trusted_allowed_tools,
            maxTurns: config.agent.max_turns,
          }));
        } else if (backendName === 'cli') {
          const { CliBackend } = await import('@ccbuddy/agent');
          agentService.setBackend(new CliBackend());
        } else if (backendName === 'codex-sdk') {
          const { CodexSdkBackend } = await import('@ccbuddy/agent');
          const codexApiKey = config.agent.codex.api_key_env
            ? process.env[config.agent.codex.api_key_env]
            : undefined;
          agentService.setBackend(new CodexSdkBackend({
            apiKey: codexApiKey,
            codexPath: config.agent.codex.codex_path,
            networkAccess: config.agent.codex.network_access,
            defaultSandbox: config.agent.codex.default_sandbox,
            permissionGateRules: config.agent.permission_gates.enabled
              ? config.agent.permission_gates.rules
              : undefined,
          }));
        } else if (backendName === 'codex-cli') {
          const { CodexCliBackend } = await import('@ccbuddy/agent');
          agentService.setBackend(new CodexCliBackend());
        } else {
          throw new Error(`Unknown backend: ${backendName}`);
        }
        console.log(`[Dashboard] Backend switched to ${backendName}`);
        return backendName;
      },
    });
    if (webchatAdapter) {
      dashboardServer.setWebChatAdapter(webchatAdapter);
    }
    try {
      const addr = await dashboardServer.start();
      console.log(`[Dashboard] Started at ${addr}`);
    } catch (err) {
      console.error('[Dashboard] Failed to start:', (err as Error).message);
      dashboardServer = undefined;
    }
  }

  if (dashboardServer) {
    shutdownHandler.register('dashboard', async () => {
      await dashboardServer!.stop();
    });
  }

  // 13. Swap in SDK backend if configured (must happen AFTER discord.js connects —
  //     the SDK module has side effects that suppress discord.js WebSocket events
  //     if imported before the connection is established)
  if (config.agent.backend === 'sdk') {
    const { SdkBackend } = await import('@ccbuddy/agent');
    agentService.setBackend(new SdkBackend({
      skipPermissions: config.agent.admin_skip_permissions,
      permissionGates: config.agent.permission_gates,
      trustedAllowedTools: config.agent.trusted_allowed_tools,
      maxTurns: config.agent.max_turns,
    }));
    resolveAgentBackendReady?.();
  } else if (config.agent.backend === 'codex-sdk') {
    const { CodexSdkBackend } = await import('@ccbuddy/agent');
    const codexApiKey = config.agent.codex.api_key_env
      ? process.env[config.agent.codex.api_key_env]
      : undefined;
    agentService.setBackend(new CodexSdkBackend({
      apiKey: codexApiKey,
      codexPath: config.agent.codex.codex_path,
      networkAccess: config.agent.codex.network_access,
      defaultSandbox: config.agent.codex.default_sandbox,
      permissionGateRules: config.agent.permission_gates.enabled
        ? config.agent.permission_gates.rules
        : undefined,
    }));
    resolveAgentBackendReady?.();
  } else if (config.agent.backend === 'codex-cli') {
    const { CodexCliBackend } = await import('@ccbuddy/agent');
    agentService.setBackend(new CodexCliBackend());
    resolveAgentBackendReady?.();
  }

  // 14. Create proactive sender closure
  const sendProactiveMessage = async (target: { platform: string; channel: string }, text: string) => {
    const adapter = gateway.getAdapter(target.platform);
    if (!adapter) {
      throw new Error(`[Scheduler] No adapter for platform '${target.platform}'`);
    }
    const limit = target.platform === 'telegram' ? 4096 : 2000;
    const chunks = chunkMessage(text, limit);
    for (const chunk of chunks) {
      await adapter.sendText(target.channel, chunk);
    }
    await eventBus.publish('message.outgoing', {
      userId: 'system',
      sessionId: 'scheduler',
      channelId: target.channel,
      platform: target.platform,
      text,
    });
  };

  // 15. Create and start scheduler
  const internalJobs = new Map<string, () => Promise<void>>([
    ['memory_consolidation', async () => {
      const results = await consolidationService.runFullConsolidation();
      for (const [userId, stats] of results) {
        await eventBus.publish('consolidation.complete', stats);
      }
    }],
    ['memory_backup', () => backupService.backup()],
  ]);

  const schedulerService = new SchedulerService({
    config,
    eventBus,
    get defaultModel() { return config.agent.model; },
    executeAgentRequest: (request) => agentService.handleRequest({
      ...request,
      workingDirectory: request.workingDirectory,
      mcpServers: [{
        ...skillMcpServer,
        args: [...skillMcpServer.args, '--backend', skillMcpServer.backend],
      }, haMcpServer],
      env: forwardedEnv,
      systemPrompt: [identityPrompt, request.systemPrompt, skillNudge].filter(Boolean).join('\n\n'),
    }),
    sendProactiveMessage,
    runSkill: undefined, // skill-type jobs use the agent prompt path; direct skill execution deferred
    assembleContext: (userId, sessionId) => {
      const context = contextAssembler.assemble(userId, sessionId);
      return contextAssembler.formatAsPrompt(context);
    },
    checkDatabase: async () => {
      // Lightweight DB health check — try to read a non-existent row
      messageStore.getById(0);
      return true;
    },
    checkAgent: async () => {
      const start = Date.now();
      const { execFile } = await import('node:child_process');
      return new Promise<{ reachable: boolean; durationMs: number }>((resolve) => {
        execFile('claude', ['--version'], { timeout: 10_000 }, (err) => {
          resolve({ reachable: !err, durationMs: Date.now() - start });
        });
      });
    },
    internalJobs,
    storeMessage: (params) => {
      messageStore.add({
        userId: params.userId,
        sessionId: params.sessionId,
        platform: params.platform,
        content: params.content,
        role: params.role,
      });
    },
  });

  shutdownHandler.register('scheduler', async () => {
    await schedulerService.stop();
  });

  shutdownHandler.register('notifications', async () => {
    notificationService?.stop();
  });

  // Heartbeat status file — atomic write for MCP server reads
  const heartbeatStatusPath = join(config.data_dir, 'heartbeat-status.json');
  eventBus.subscribe('heartbeat.status', (data: unknown) => {
    const tmpPath = heartbeatStatusPath + '.tmp';
    try {
      writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
      renameSync(tmpPath, heartbeatStatusPath);
    } catch {
      // Non-fatal — MCP server will report "no data"
    }
  });

  await schedulerService.start();

  // 16. Create and start notification service
  notificationService = new NotificationService({
    eventBus,
    sendProactiveMessage,
    getPreferences: (userId) => resolvePreferences(config.notifications, profileStore, userId),
    getUsers: () => userManager.getAllUsers(),
    resolveDMChannel: async (platform, platformUserId) => {
      const adapter = gateway.getAdapter(platform);
      return adapter?.resolveDMChannel?.(platformUserId) ?? null;
    },
  });
  notificationService.start();

  return {
    stop: async () => {
      if (tickInterval) clearInterval(tickInterval);
      await shutdownHandler!.execute();
      releasePidLock?.();
      releasePidLock = undefined;
    },
  };

  } catch (err) {
    agentBackendReadyError = err;
    resolveAgentBackendReady?.();
    // Clean up interval and PID lock if bootstrap fails after acquisition
    if (tickInterval) clearInterval(tickInterval);
    if (shutdownHandler) {
      try {
        await shutdownHandler.execute();
      } catch {
        // Best-effort cleanup; preserve the original bootstrap failure.
      }
    }
    releasePidLock?.();
    releasePidLock = undefined;
    throw err;
  }
}
