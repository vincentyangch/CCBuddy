import { join, dirname } from 'node:path';
import { writeFileSync, renameSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadConfig, createEventBus, UserManager, TranscriptionService, SpeechService, readModelFile, isValidModel } from '@ccbuddy/core';
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
} from '@ccbuddy/memory';
import { SkillRegistry, MCP_SERVER_PATH } from '@ccbuddy/skills';
import { Gateway } from '@ccbuddy/gateway';
import { DiscordAdapter } from '@ccbuddy/platform-discord';
import { TelegramAdapter } from '@ccbuddy/platform-telegram';
import { ShutdownHandler } from '@ccbuddy/orchestrator';
import { SchedulerService } from '@ccbuddy/scheduler';
import { chunkMessage } from '@ccbuddy/gateway';
import { DashboardServer } from '@ccbuddy/dashboard';

export interface BootstrapResult {
  stop: () => Promise<void>;
}

/**
 * Acquire a PID lockfile, killing any stale CCBuddy process first.
 * Returns a cleanup function that removes the lockfile on shutdown.
 */
function acquirePidLock(dataDir: string): () => void {
  const lockPath = join(dataDir, 'ccbuddy.pid');

  if (existsSync(lockPath)) {
    const oldPid = parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      // Check if the old process is still alive
      try {
        process.kill(oldPid, 0); // signal 0 = existence check
        console.log(`[PID Lock] Killing stale CCBuddy process (PID ${oldPid})`);
        process.kill(oldPid, 'SIGTERM');
        // Give it a moment to shut down gracefully, then force kill
        try {
          execSync(`sleep 2 && kill -0 ${oldPid} 2>/dev/null && kill -9 ${oldPid}`, {
            stdio: 'ignore',
            timeout: 5000,
          });
        } catch {
          // Process already exited — good
        }
      } catch {
        // Old process no longer exists — stale lockfile
      }
    }
  }

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(lockPath, String(process.pid), 'utf8');

  return () => {
    try {
      // Only remove if it's still our PID (avoid race with a new instance)
      if (existsSync(lockPath) && readFileSync(lockPath, 'utf8').trim() === String(process.pid)) {
        unlinkSync(lockPath);
      }
    } catch {
      // Non-fatal
    }
  };
}

export async function bootstrap(configDir?: string): Promise<BootstrapResult> {
  // 1. Load config
  const resolvedConfigDir = configDir ?? join(process.cwd(), 'config');
  const config = loadConfig(resolvedConfigDir);

  // 1a. Apply runtime model override (from dashboard)
  const runtimeConfigPath = join(config.data_dir, 'runtime-config.json');
  try {
    const runtimeConfig = JSON.parse(readFileSync(runtimeConfigPath, 'utf8'));
    if (runtimeConfig.model && isValidModel(runtimeConfig.model)) {
      config.agent.model = runtimeConfig.model;
      console.log(`[Bootstrap] Runtime model override applied: ${runtimeConfig.model}`);
    }
  } catch { /* no runtime config */ }

  // 1b. Acquire PID lock — kills any existing CCBuddy process
  const releasePidLock = acquirePidLock(config.data_dir);

  // 2. Create event bus
  const eventBus = createEventBus();

  // 3. Create UserManager from config users
  const userManager = new UserManager(Object.values(config.users));

  // 4. Create agent backend with CLI (SDK loaded lazily after Discord connects)
  const backend = new CliBackend();

  // 5. Create AgentService
  const projectRoot = dirname(resolvedConfigDir);
  const resolve = (p: string) => join(projectRoot, p);
  const sessionStore = new SessionStore(config.agent.session_timeout_ms, {
    onExpiry: (sessionKey) => {
      const modelFile = join(resolve(config.data_dir), 'sessions', `${sessionKey}.model`);
      try { unlinkSync(modelFile); } catch { /* file may not exist */ }
    },
  });

  const agentService = new AgentService({
    backend,
    eventBus,
    maxConcurrent: config.agent.max_concurrent_sessions,
    rateLimits: {
      admin: config.agent.rate_limits.admin,
      chat: config.agent.rate_limits.chat,
      system: config.agent.rate_limits.system,
    },
    queueMaxDepth: config.agent.queue_max_depth,
    queueTimeoutSeconds: config.agent.queue_timeout_seconds,
    sessionTimeoutMinutes: config.agent.session_timeout_minutes,
    sessionCleanupHours: config.agent.session_cleanup_hours,
    sessionStore,
  });

  // 6. Create memory stores
  const database = new MemoryDatabase(config.memory.db_path);
  database.init();

  const messageStore = new MessageStore(database);
  const agentEventStore = new AgentEventStore(database);
  const summaryStore = new SummaryStore(database);
  const profileStore = new ProfileStore(database);

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
    ],
  };

  // 7b. Wire Apple helper path into MCP server args if enabled
  if (config.apple.enabled) {
    const helperPath = config.apple.helper_path
      ?? join(projectRoot, 'swift-helper', '.build', 'release', 'ccbuddy-helper');
    skillMcpServer.args.push('--apple-helper', helperPath);
  }

  const identityPrompt = `You are CCBuddy — a personal AI assistant belonging to flyingchickens. You run 24/7 on a Mac Mini and are reachable via Discord. Your name is CCBuddy (or just "Buddy"). When asked who you are, introduce yourself as CCBuddy. You are powered by Claude under the hood, but your identity, personality, and purpose are CCBuddy's. You are helpful, concise, and proactive. You know your own codebase (this project) and can improve yourself when asked.

You have profile tools (profile_get, profile_set, profile_delete) to remember things about users across conversations. When you learn something about a user — their preferences, interests, timezone, communication style, or anything worth remembering — save it with profile_set. This data automatically appears in your context for every future conversation. Proactively use these tools; don't wait to be asked.`;

  const skillNudge = 'You have access to reusable skills (prefixed skill_) and can create new ones with create_skill. When you solve a novel problem that could be reusable, consider creating a skill for it.\n\nFor image generation requests, use the skill_generate_image tool directly with a descriptive prompt. Do not deliberate — just call the tool.';

  // 7c. Voice services (optional)
  let transcriptionService: TranscriptionService | undefined;
  let speechService: SpeechService | undefined;
  if (config.media.voice_enabled) {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      throw new Error('voice_enabled is true but OPENAI_API_KEY is not set');
    }
    transcriptionService = new TranscriptionService(openaiKey);
    speechService = new SpeechService(openaiKey);
  }

  // 8. Create Gateway with injected dependencies
  const gateway = new Gateway({
    eventBus,
    findUser: (platform, platformId) => userManager.findByPlatformId(platform, platformId),
    buildSessionId: (userName, platform, channelId) =>
      userManager.buildSessionId(userName, platform, channelId),
    executeAgentRequest: (request) => {
      const mcpServer = {
        ...skillMcpServer,
        args: [...skillMcpServer.args, '--session-key', request.sessionId],
      };
      return agentService.handleRequest({
        ...request,
        workingDirectory: request.workingDirectory,
        mcpServers: [mcpServer],
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
    readModelFile: (sessionKey: string) => {
      const filePath = join(resolve(config.data_dir), 'sessions', `${sessionKey}.model`);
      return readModelFile(filePath);
    },
    userInputTimeoutMs: config.agent.user_input_timeout_ms,
    storeAgentEvent: (params) => {
      agentEventStore.add({ ...params, timestamp: Date.now() });
    },
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

  // 10. Set up SessionManager.tick() interval (every 60 seconds)
  const tickInterval = setInterval(() => {
    agentService.tick();
    sessionStore.tick();
  }, 60_000);

  // 11. Create shutdown handler
  const shutdownHandler = new ShutdownHandler(
    config.agent.graceful_shutdown_timeout_seconds * 1000,
  );

  shutdownHandler.register('gateway', async () => {
    await gateway.stop();
  });

  shutdownHandler.register('database', async () => {
    database.close();
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
    });
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
    agentService.setBackend(new SdkBackend({ skipPermissions: config.agent.admin_skip_permissions }));
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
    defaultModel: config.agent.model,
    executeAgentRequest: (request) => agentService.handleRequest({
      ...request,
      workingDirectory: request.workingDirectory,
      mcpServers: [skillMcpServer],

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
  });

  shutdownHandler.register('scheduler', async () => {
    await schedulerService.stop();
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

  return {
    stop: async () => {
      clearInterval(tickInterval);
      await shutdownHandler.execute();
      releasePidLock();
    },
  };
}
