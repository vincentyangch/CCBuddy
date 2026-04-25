import { readFileSync, copyFileSync, writeFileSync, existsSync, openSync, readSync, closeSync, statSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { setupWebSocket } from './websocket.js';
import { WebChatAdapter } from './webchat-adapter.js';
import { loadLocalSettingsConfig, saveLocalSettingsConfig } from './settings-store.js';
import { buildSettingsSourceMap, validateLocalSettingsConfig } from './settings-meta.js';
import { loadConfig } from '@ccbuddy/core';
import type { EventBus, CCBuddyConfig } from '@ccbuddy/core';
import { isValidModel, isValidModelForBackend, getModelOptionsForBackend } from '@ccbuddy/core';
import type { BackendType } from '@ccbuddy/core';
import type { SessionInfo } from '@ccbuddy/agent';
import type { MessageQueryParams, MessageQueryResult, StoredAgentEvent, SchedulerJobState } from '@ccbuddy/memory';

export interface DashboardDeps {
  eventBus: EventBus;
  agentService: {
    getSessionInfo(): SessionInfo[];
    readonly queueSize: number;
  };
  /** Callback to switch the active agent backend at runtime. Returns the new backend name on success. */
  switchBackend?: (backend: string) => Promise<string>;
  messageStore: {
    query(params: MessageQueryParams): MessageQueryResult;
    deleteBySessionId(sessionId: string): number;
  };
  agentEventStore: {
    getBySession(sessionId: string, pagination?: { limit: number; offset: number }): StoredAgentEvent[];
  };
  schedulerJobStore?: {
    list(): SchedulerJobState[];
  };
  runSchedulerJob?: (jobName: string) => Promise<{ jobName: string; accepted: boolean }>;
  config: CCBuddyConfig;
  configDir: string;
  logFiles: { stdout: string; stderr: string; app: string };
  sessionStore?: {
    getHistory(filters?: { status?: string; platform?: string }): Array<{
      session_key: string;
      sdk_session_id: string;
      user_id: string | null;
      platform: string;
      channel_id: string;
      is_group_channel: boolean;
      model: string | null;
      reasoning_effort: string | null;
      service_tier: string | null;
      verbosity: string | null;
      status: string;
      created_at: number;
      last_activity: number;
    }>;
    setModel?(sessionKey: string, model: string | null): void;
    setReasoningEffort?(sessionKey: string, reasoningEffort: string | null): void;
    setServiceTier?(sessionKey: string, serviceTier: string | null): void;
    setVerbosity?(sessionKey: string, verbosity: string | null): void;
    deleteSession(sessionKey: string): void;
  };
}

const CODEx_REASONING_EFFORT_OPTIONS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const CODEx_SERVICE_TIER_OPTIONS = ['flex', 'fast'] as const;
const CODEx_VERBOSITY_OPTIONS = ['low', 'medium', 'high'] as const;

/** Constant-time string comparison to prevent timing attacks on token checks. */
function safeTokenEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactConfigTokens(config: CCBuddyConfig): CCBuddyConfig {
  const redacted = JSON.parse(JSON.stringify(config)) as CCBuddyConfig;
  if (redacted.platforms) {
    for (const key of Object.keys(redacted.platforms)) {
      if (redacted.platforms[key]?.token) redacted.platforms[key]!.token = '••••••';
    }
  }
  return redacted;
}

export class DashboardServer {
  private app: FastifyInstance;
  private deps: DashboardDeps;
  private token: string | undefined;
  private webchatAdapter?: WebChatAdapter;

  setWebChatAdapter(adapter: WebChatAdapter): void {
    this.webchatAdapter = adapter;
  }

  constructor(deps: DashboardDeps) {
    this.deps = deps;
    this.app = Fastify({ logger: false });
  }

  async start(): Promise<string> {
    const config = this.deps.config.dashboard;
    this.token = process.env[config.auth_token_env];
    if (!this.token) {
      throw new Error(`Dashboard auth token not set: env var '${config.auth_token_env}' is empty`);
    }

    await this.app.register(websocket);
    setupWebSocket(this.app, this.deps.eventBus, this.token, this.webchatAdapter);

    this.setupRoutes();

    // Serve built React client as static files
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const clientDir = join(__dirname, '..', '..', 'dist-client');
    if (existsSync(clientDir)) {
      await this.app.register(fastifyStatic, {
        root: clientDir,
      });
      // SPA fallback — serve index.html for all non-API, non-WS routes
      this.app.setNotFoundHandler(async (request, reply) => {
        if (request.url.startsWith('/api/') || request.url.startsWith('/ws')) {
          reply.status(404).send({ error: 'Not found' });
          return;
        }
        return reply.sendFile('index.html');
      });
    } else {
      console.warn('[Dashboard] Client build not found at', clientDir, '— API-only mode');
    }

    await this.app.listen({ port: config.port, host: config.host });
    const addr = this.app.server.address();
    if (typeof addr === 'object' && addr) {
      return `http://${config.host}:${addr.port}`;
    }
    return `http://${config.host}:${config.port}`;
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  private setupRoutes(): void {
    // Auth middleware — skip for POST /api/auth and non-API routes
    this.app.addHook('onRequest', async (request, reply) => {
      if (request.url === '/api/auth' && request.method === 'POST') return;
      if (!request.url.startsWith('/api/')) return;

      const auth = request.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ') || !this.token || !safeTokenEqual(auth.slice(7), this.token)) {
        reply.status(401).send({ error: 'Unauthorized' });
        return;
      }
    });

    // POST /api/auth — validate token (no auth middleware needed)
    this.app.post('/api/auth', async (request, reply) => {
      const body = request.body as { token?: string } | null;
      if (body?.token && this.token && safeTokenEqual(body.token, this.token)) {
        return { ok: true };
      }
      reply.status(401).send({ error: 'Invalid token' });
    });

    // GET /api/status
    this.app.get('/api/status', async () => {
      let heartbeat: Record<string, unknown> = {};
      try {
        const path = join(this.deps.config.data_dir, 'heartbeat-status.json');
        heartbeat = JSON.parse(readFileSync(path, 'utf8'));
      } catch { /* no heartbeat file yet */ }

      return {
        heartbeat,
        sessions: this.deps.agentService.getSessionInfo(),
        queueSize: this.deps.agentService.queueSize,
        uptime: process.uptime(),
      };
    });

    // GET /api/scheduler/jobs — persisted scheduler job health and timing
    this.app.get('/api/scheduler/jobs', async () => {
      return { jobs: this.deps.schedulerJobStore?.list() ?? [] };
    });

    // POST /api/scheduler/jobs/:name/run — trigger a registered job immediately
    this.app.post<{ Params: { name: string } }>('/api/scheduler/jobs/:name/run', async (request, reply) => {
      if (!this.deps.runSchedulerJob) {
        return reply.status(501).send({ error: 'Scheduler controls not available' });
      }

      try {
        const result = await this.deps.runSchedulerJob(request.params.name);
        return { ok: true, result };
      } catch (err) {
        const message = (err as Error).message;
        const status = message.includes('not found') ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    });

    // GET /api/sessions
    this.app.get('/api/sessions', async (request) => {
      const q = request.query as Record<string, string>;
      const status = q.status as string | undefined;
      const platform = q.platform as string | undefined;

      if (this.deps.sessionStore) {
        const filters: Record<string, string> = {};
        if (status) filters.status = status;
        if (platform) filters.platform = platform;
        const sessions = this.deps.sessionStore.getHistory(
          Object.keys(filters).length > 0 ? filters : undefined,
        );
        return { sessions };
      }
      // Fallback: active-only from AgentService
      return { sessions: this.deps.agentService.getSessionInfo() };
    });

    // DELETE /api/sessions/:key
    this.app.delete<{ Params: { key: string } }>('/api/sessions/:key', async (request) => {
      const { key } = request.params;
      if (this.deps.sessionStore) {
        this.deps.sessionStore.deleteSession(key);
      }
      return { success: true };
    });

    // PUT /api/sessions/:key/settings — update per-session runtime overrides
    this.app.put<{ Params: { key: string } }>('/api/sessions/:key/settings', async (request, reply) => {
      const { key } = request.params;
      const body = request.body as {
        model?: string | null;
        reasoning_effort?: string | null;
        service_tier?: string | null;
        verbosity?: string | null;
      } | null;

      if (!this.deps.sessionStore) {
        return reply.status(501).send({ error: 'Session runtime editing not available' });
      }
      if (!body || (body.model === undefined && body.reasoning_effort === undefined && body.service_tier === undefined && body.verbosity === undefined)) {
        return reply.status(400).send({ error: 'Provide model, reasoning_effort, service_tier, and/or verbosity in request body' });
      }

      const session = this.deps.sessionStore.getHistory().find((row) => row.session_key === key);
      if (!session) {
        return reply.status(404).send({ error: `Session not found: ${key}` });
      }

      const backend = this.deps.config.agent.backend as BackendType;
      const configLists = {
        claude_models: this.deps.config.agent.claude_models,
        codex_models: this.deps.config.agent.codex_models,
      };

      if (body.model !== undefined && body.model !== null && !isValidModelForBackend(body.model, backend, configLists)) {
        const available = getModelOptionsForBackend(backend, configLists).join(', ');
        return reply.status(400).send({ error: `Invalid model "${body.model}" for ${backend} backend. Available: ${available}` });
      }
      if ((body.reasoning_effort !== undefined || body.service_tier !== undefined || body.verbosity !== undefined) && !backend.startsWith('codex')) {
        return reply.status(400).send({ error: `reasoning_effort, service_tier, and verbosity are only supported for Codex backends. Current backend: ${backend}` });
      }
      if (
        body.reasoning_effort !== undefined &&
        body.reasoning_effort !== null &&
        !(CODEx_REASONING_EFFORT_OPTIONS as readonly string[]).includes(body.reasoning_effort)
      ) {
        return reply.status(400).send({ error: `Invalid reasoning_effort "${body.reasoning_effort}". Valid: ${CODEx_REASONING_EFFORT_OPTIONS.join(', ')}` });
      }
      if (
        body.service_tier !== undefined &&
        body.service_tier !== null &&
        !(CODEx_SERVICE_TIER_OPTIONS as readonly string[]).includes(body.service_tier)
      ) {
        return reply.status(400).send({ error: `Invalid service_tier "${body.service_tier}". Valid: ${CODEx_SERVICE_TIER_OPTIONS.join(', ')}` });
      }
      if (
        body.verbosity !== undefined &&
        body.verbosity !== null &&
        !(CODEx_VERBOSITY_OPTIONS as readonly string[]).includes(body.verbosity)
      ) {
        return reply.status(400).send({ error: `Invalid verbosity "${body.verbosity}". Valid: ${CODEx_VERBOSITY_OPTIONS.join(', ')}` });
      }

      this.deps.sessionStore.setModel?.(key, body.model ?? null);
      if (body.reasoning_effort !== undefined) {
        this.deps.sessionStore.setReasoningEffort?.(key, body.reasoning_effort);
      }
      if (body.service_tier !== undefined) {
        this.deps.sessionStore.setServiceTier?.(key, body.service_tier);
      }
      if (body.verbosity !== undefined) {
        this.deps.sessionStore.setVerbosity?.(key, body.verbosity);
      }

      return {
        ok: true,
        session_key: key,
        model: body.model ?? null,
        reasoning_effort: body.reasoning_effort ?? null,
        service_tier: body.service_tier ?? null,
        verbosity: body.verbosity ?? null,
      };
    });

    // GET /api/sessions/:key/events — agent events for session replay
    this.app.get<{ Params: { key: string } }>('/api/sessions/:key/events', async (request) => {
      const { key } = request.params;
      const events = this.deps.agentEventStore.getBySession(key);
      return { sessionKey: key, events };
    });

    // GET /api/conversations — paginated message search
    this.app.get('/api/conversations', async (request) => {
      const q = request.query as Record<string, string>;
      const params: MessageQueryParams = {
        page: parseInt(q.page ?? '1', 10),
        pageSize: parseInt(q.pageSize ?? '50', 10),
        user: q.user || undefined,
        platform: q.platform || undefined,
        sessionId: q.sessionId || undefined,
        search: q.search || undefined,
        dateFrom: q.dateFrom ? parseInt(q.dateFrom, 10) : undefined,
        dateTo: q.dateTo ? parseInt(q.dateTo, 10) : undefined,
      };
      return this.deps.messageStore.query(params);
    });

    // DELETE /api/conversations/:sessionId — delete all messages for a session
    this.app.delete('/api/conversations/:sessionId', async (request) => {
      const { sessionId } = request.params as { sessionId: string };
      const deleted = this.deps.messageStore.deleteBySessionId(sessionId);
      return { ok: true, deleted };
    });

    // GET /api/logs — recent log lines (tail-read to avoid loading entire file)
    this.app.get('/api/logs', async (request) => {
      const q = request.query as Record<string, string>;
      const file = (q.file ?? 'stdout') as 'stdout' | 'stderr' | 'app';
      const lineCount = parseInt(q.lines ?? '500', 10);
      const logPath = this.deps.logFiles[file];
      if (!logPath) return { lines: [], file };

      try {
        const stat = statSync(logPath);
        // Read last ~64KB (enough for ~500 lines) instead of entire file
        const readBytes = Math.min(stat.size, lineCount * 150);
        const buffer = Buffer.alloc(readBytes);
        const fd = openSync(logPath, 'r');
        readSync(fd, buffer, 0, readBytes, Math.max(0, stat.size - readBytes));
        closeSync(fd);
        const content = buffer.toString('utf8');
        const allLines = content.split('\n').filter(Boolean);
        return { lines: allLines.slice(-lineCount), file };
      } catch {
        return { lines: [], file };
      }
    });

    // GET /api/config — temporary compatibility alias for the effective config
    this.app.get('/api/config', async () => {
      return { config: redactConfigTokens(this.deps.config) };
    });

    // GET /api/settings/local — persisted editable config
    this.app.get('/api/settings/local', async () => {
      const localPath = join(this.deps.configDir, 'local.yaml');
      return { config: loadLocalSettingsConfig(localPath) };
    });

    // PUT /api/settings/local — update config/local.yaml directly
    this.app.put('/api/settings/local', async (request, reply) => {
      if (!isPlainObject(request.body)) {
        return reply.status(400).send({ error: 'Request body must be an object' });
      }

      const body = request.body as { config?: unknown };
      if (!isPlainObject(body.config)) {
        return reply.status(400).send({ error: 'Missing config in request body' });
      }

      const config = body.config as Record<string, unknown>;
      const localPath = join(this.deps.configDir, 'local.yaml');
      const existingConfig = loadLocalSettingsConfig(localPath);
      const shapeError = validateLocalSettingsConfig(config, existingConfig);
      if (shapeError) {
        return reply.status(400).send({ error: `Invalid config structure: ${shapeError}` });
      }
      const backupPath = localPath + '.bak';

      const tempDir = mkdtempSync(join(tmpdir(), 'ccbuddy-dashboard-config-'));
      try {
        const tempLocalPath = join(tempDir, 'local.yaml');
        saveLocalSettingsConfig(tempLocalPath, config);
        loadConfig(tempDir);
      } catch (err) {
        return reply.status(400).send({ error: `Invalid config: ${(err as Error).message}` });
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }

      try {
        try { copyFileSync(localPath, backupPath); } catch { /* no existing file */ }
        saveLocalSettingsConfig(localPath, config);
        return { ok: true, backup: backupPath };
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    });

    // GET /api/settings/effective — current runtime config, redacted
    this.app.get('/api/settings/effective', async () => {
      return { config: redactConfigTokens(this.deps.config) };
    });

    // GET /api/settings/meta — source map for effective vs local values
    this.app.get('/api/settings/meta', async () => {
      const localPath = join(this.deps.configDir, 'local.yaml');
      const defaultPath = join(this.deps.configDir, 'default.yaml');
      const localConfig = loadLocalSettingsConfig(localPath);
      const defaultConfig = loadLocalSettingsConfig(defaultPath);
      const runtimePath = join(this.deps.config.data_dir, 'runtime-config.json');
      let runtimeModel: string | null = null;
      try {
        const data = JSON.parse(readFileSync(runtimePath, 'utf8'));
        runtimeModel = typeof data?.model === 'string' ? data.model : null;
      } catch { /* no runtime override */ }

      return buildSettingsSourceMap(
        localConfig,
        this.deps.config as unknown as Record<string, unknown>,
        defaultConfig,
        runtimeModel,
      );
    });

    // GET /api/config/backend — current backend type and available models
    this.app.get('/api/config/backend', async () => {
      const backend = this.deps.config.agent.backend as BackendType;
      const configLists = {
        claude_models: this.deps.config.agent.claude_models,
        codex_models: this.deps.config.agent.codex_models,
      };
      return {
        backend,
        models: getModelOptionsForBackend(backend, configLists),
        claude_models: this.deps.config.agent.claude_models,
        codex_models: this.deps.config.agent.codex_models,
      };
    });

    // PUT /api/config/backend — switch agent backend at runtime
    const VALID_BACKENDS = ['sdk', 'cli', 'codex-sdk', 'codex-cli'];
    this.app.put('/api/config/backend', async (request, reply) => {
      const body = request.body as { backend: string } | null;
      if (!body?.backend) {
        return reply.status(400).send({ error: 'Missing backend in request body' });
      }
      if (!VALID_BACKENDS.includes(body.backend)) {
        return reply.status(400).send({ error: `Invalid backend: "${body.backend}". Valid: ${VALID_BACKENDS.join(', ')}` });
      }
      if (!this.deps.switchBackend) {
        return reply.status(501).send({ error: 'Runtime backend switching not available' });
      }

      try {
        const newBackend = await this.deps.switchBackend(body.backend);

        // Persist to runtime-config.json
        const runtimePath = join(this.deps.config.data_dir, 'runtime-config.json');
        let runtimeConfig: Record<string, unknown> = {};
        try {
          runtimeConfig = JSON.parse(readFileSync(runtimePath, 'utf8'));
        } catch { /* no existing file */ }
        runtimeConfig.backend = body.backend;

        // Auto-reset model to first valid option for the new backend
        const configLists = {
          claude_models: this.deps.config.agent.claude_models,
          codex_models: this.deps.config.agent.codex_models,
        };
        const newModels = getModelOptionsForBackend(body.backend as BackendType, configLists);
        if (newModels.length > 0) {
          runtimeConfig.model = newModels[0];
          this.deps.config.agent.model = newModels[0];
        }

        this.deps.config.agent.backend = body.backend as BackendType;
        mkdirSync(dirname(runtimePath), { recursive: true });
        writeFileSync(runtimePath, JSON.stringify(runtimeConfig, null, 2), 'utf8');

        return {
          ok: true,
          backend: newBackend,
          model: this.deps.config.agent.model,
          models: newModels,
        };
      } catch (err) {
        return reply.status(500).send({ error: `Backend switch failed: ${(err as Error).message}` });
      }
    });

    // PUT /api/config/models — update model lists at runtime
    this.app.put('/api/config/models', async (request, reply) => {
      const body = request.body as { claude_models?: unknown; codex_models?: unknown } | null;
      if (!body || (!body.claude_models && !body.codex_models)) {
        return reply.status(400).send({ error: 'Provide claude_models and/or codex_models arrays' });
      }

      // Validate: must be arrays of non-empty strings
      const validateModelList = (val: unknown, name: string): string[] | null => {
        if (val === undefined) return null;
        if (!Array.isArray(val)) {
          throw new Error(`${name} must be an array`);
        }
        const normalized: string[] = [];
        for (const item of val) {
          if (typeof item !== 'string' || item.trim() === '') {
            throw new Error(`${name} must contain only non-empty strings`);
          }
          const trimmed = item.trim();
          if (!normalized.includes(trimmed)) normalized.push(trimmed);
        }
        return normalized;
      };

      let claudeModels: string[] | null;
      let codexModels: string[] | null;
      try {
        claudeModels = validateModelList(body.claude_models, 'claude_models');
        codexModels = validateModelList(body.codex_models, 'codex_models');
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }

      const runtimePath = join(this.deps.config.data_dir, 'runtime-config.json');
      let runtimeConfig: Record<string, unknown> = {};
      try {
        runtimeConfig = JSON.parse(readFileSync(runtimePath, 'utf8'));
      } catch { /* no existing file */ }

      if (claudeModels) {
        runtimeConfig.claude_models = claudeModels;
        this.deps.config.agent.claude_models = claudeModels;
      }
      if (codexModels) {
        runtimeConfig.codex_models = codexModels;
        this.deps.config.agent.codex_models = codexModels;
      }

      const backend = this.deps.config.agent.backend as BackendType;
      const configLists = {
        claude_models: this.deps.config.agent.claude_models,
        codex_models: this.deps.config.agent.codex_models,
      };
      if (!isValidModelForBackend(this.deps.config.agent.model, backend, configLists)) {
        const fallbackModels = getModelOptionsForBackend(backend, configLists);
        if (fallbackModels.length > 0) {
          runtimeConfig.model = fallbackModels[0];
          this.deps.config.agent.model = fallbackModels[0];
        }
      }

      mkdirSync(dirname(runtimePath), { recursive: true });
      writeFileSync(runtimePath, JSON.stringify(runtimeConfig, null, 2), 'utf8');

      return { ok: true, claude_models: this.deps.config.agent.claude_models, codex_models: this.deps.config.agent.codex_models };
    });

    // GET /api/config/model — current default model
    this.app.get('/api/config/model', async () => {
      const runtimePath = join(this.deps.config.data_dir, 'runtime-config.json');
      let runtimeModel: string | null = null;
      let runtimeReasoningEffort: string | null = null;
      let runtimeServiceTier: string | null = null;
      let runtimeVerbosity: string | null = null;
      try {
        const data = JSON.parse(readFileSync(runtimePath, 'utf8'));
        runtimeModel = data.model ?? null;
        runtimeReasoningEffort = data.reasoning_effort ?? null;
        runtimeServiceTier = data.service_tier ?? null;
        runtimeVerbosity = data.verbosity ?? null;
      } catch { /* no runtime override */ }

      const configReasoningEffort = this.deps.config.agent.codex.default_reasoning_effort ?? null;
      const configServiceTier = this.deps.config.agent.codex.default_service_tier ?? null;
      const configVerbosity = this.deps.config.agent.codex.default_verbosity ?? null;
      return {
        model: runtimeModel ?? this.deps.config.agent.model,
        source: runtimeModel ? 'runtime_override' : 'config',
        backend: this.deps.config.agent.backend,
        reasoning_effort: runtimeReasoningEffort ?? configReasoningEffort,
        reasoning_effort_source: runtimeReasoningEffort ? 'runtime_override' : configReasoningEffort ? 'config' : 'effective_only',
        service_tier: runtimeServiceTier ?? configServiceTier,
        service_tier_source: runtimeServiceTier ? 'runtime_override' : configServiceTier ? 'config' : 'effective_only',
        verbosity: runtimeVerbosity ?? configVerbosity,
        verbosity_source: runtimeVerbosity ? 'runtime_override' : configVerbosity ? 'config' : 'effective_only',
        reasoning_effort_options: [...CODEx_REASONING_EFFORT_OPTIONS],
        service_tier_options: [...CODEx_SERVICE_TIER_OPTIONS],
        verbosity_options: [...CODEx_VERBOSITY_OPTIONS],
      };
    });

    // PUT /api/config/model — set runtime model override
    this.app.put('/api/config/model', async (request, reply) => {
      const body = request.body as {
        model?: string | null;
        reasoning_effort?: string | null;
        service_tier?: string | null;
        verbosity?: string | null;
      } | null;
      if (!body || (body.model === undefined && body.reasoning_effort === undefined && body.service_tier === undefined && body.verbosity === undefined)) {
        return reply.status(400).send({ error: 'Provide model, reasoning_effort, service_tier, and/or verbosity in request body' });
      }

      const backend = this.deps.config.agent.backend as BackendType;
      const configLists = {
        claude_models: this.deps.config.agent.claude_models,
        codex_models: this.deps.config.agent.codex_models,
      };
      if (body.model !== undefined && body.model !== null && !isValidModelForBackend(body.model, backend, configLists)) {
        const available = getModelOptionsForBackend(backend, configLists).join(', ');
        return reply.status(400).send({ error: `Invalid model "${body.model}" for ${backend} backend. Available: ${available}` });
      }
      if ((body.reasoning_effort !== undefined || body.service_tier !== undefined || body.verbosity !== undefined) && !backend.startsWith('codex')) {
        return reply.status(400).send({ error: `reasoning_effort, service_tier, and verbosity are only supported for Codex backends. Current backend: ${backend}` });
      }
      if (
        body.reasoning_effort !== undefined &&
        body.reasoning_effort !== null &&
        !(CODEx_REASONING_EFFORT_OPTIONS as readonly string[]).includes(body.reasoning_effort)
      ) {
        return reply.status(400).send({ error: `Invalid reasoning_effort "${body.reasoning_effort}". Valid: ${CODEx_REASONING_EFFORT_OPTIONS.join(', ')}` });
      }
      if (
        body.service_tier !== undefined &&
        body.service_tier !== null &&
        !(CODEx_SERVICE_TIER_OPTIONS as readonly string[]).includes(body.service_tier)
      ) {
        return reply.status(400).send({ error: `Invalid service_tier "${body.service_tier}". Valid: ${CODEx_SERVICE_TIER_OPTIONS.join(', ')}` });
      }
      if (
        body.verbosity !== undefined &&
        body.verbosity !== null &&
        !(CODEx_VERBOSITY_OPTIONS as readonly string[]).includes(body.verbosity)
      ) {
        return reply.status(400).send({ error: `Invalid verbosity "${body.verbosity}". Valid: ${CODEx_VERBOSITY_OPTIONS.join(', ')}` });
      }

      const runtimePath = join(this.deps.config.data_dir, 'runtime-config.json');
      let runtimeConfig: Record<string, unknown> = {};
      try {
        runtimeConfig = JSON.parse(readFileSync(runtimePath, 'utf8'));
      } catch { /* no existing file */ }

      if (body.model !== undefined && body.model !== null) {
        runtimeConfig.model = body.model;
        this.deps.config.agent.model = body.model;
      }
      if (body.reasoning_effort !== undefined) {
        if (body.reasoning_effort === null) {
          delete runtimeConfig.reasoning_effort;
          delete this.deps.config.agent.codex.default_reasoning_effort;
        } else {
          runtimeConfig.reasoning_effort = body.reasoning_effort;
          this.deps.config.agent.codex.default_reasoning_effort = body.reasoning_effort as typeof this.deps.config.agent.codex.default_reasoning_effort;
        }
      }
      if (body.service_tier !== undefined) {
        if (body.service_tier === null) {
          delete runtimeConfig.service_tier;
          delete this.deps.config.agent.codex.default_service_tier;
        } else {
          runtimeConfig.service_tier = body.service_tier;
          this.deps.config.agent.codex.default_service_tier = body.service_tier as typeof this.deps.config.agent.codex.default_service_tier;
        }
      }
      if (body.verbosity !== undefined) {
        if (body.verbosity === null) {
          delete runtimeConfig.verbosity;
          delete this.deps.config.agent.codex.default_verbosity;
        } else {
          runtimeConfig.verbosity = body.verbosity;
          this.deps.config.agent.codex.default_verbosity = body.verbosity as typeof this.deps.config.agent.codex.default_verbosity;
        }
      }
      mkdirSync(dirname(runtimePath), { recursive: true });
      writeFileSync(runtimePath, JSON.stringify(runtimeConfig, null, 2), 'utf8');

      return {
        ok: true,
        model: this.deps.config.agent.model,
        reasoning_effort: this.deps.config.agent.codex.default_reasoning_effort ?? null,
        service_tier: this.deps.config.agent.codex.default_service_tier ?? null,
        verbosity: this.deps.config.agent.codex.default_verbosity ?? null,
      };
    });
  }
}
