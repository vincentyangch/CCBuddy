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
import { buildSettingsSourceMap } from './settings-meta.js';
import { loadConfig } from '@ccbuddy/core';
import type { EventBus, CCBuddyConfig } from '@ccbuddy/core';
import { isValidModel } from '@ccbuddy/core';
import type { SessionInfo } from '@ccbuddy/agent';
import type { MessageQueryParams, MessageQueryResult, StoredAgentEvent } from '@ccbuddy/memory';

export interface DashboardDeps {
  eventBus: EventBus;
  agentService: {
    getSessionInfo(): SessionInfo[];
    readonly queueSize: number;
  };
  messageStore: {
    query(params: MessageQueryParams): MessageQueryResult;
    deleteBySessionId(sessionId: string): number;
  };
  agentEventStore: {
    getBySession(sessionId: string, pagination?: { limit: number; offset: number }): StoredAgentEvent[];
  };
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
      status: string;
      created_at: number;
      last_activity: number;
    }>;
    deleteSession(sessionKey: string): void;
  };
}

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
        wildcard: false,
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
      const localConfig = loadLocalSettingsConfig(localPath);
      const runtimePath = join(this.deps.config.data_dir, 'runtime-config.json');
      let runtimeModel: string | null = null;
      try {
        const data = JSON.parse(readFileSync(runtimePath, 'utf8'));
        runtimeModel = typeof data?.model === 'string' ? data.model : null;
      } catch { /* no runtime override */ }

      return buildSettingsSourceMap(
        localConfig,
        this.deps.config as unknown as Record<string, unknown>,
        runtimeModel,
      );
    });

    // GET /api/config/model — current default model
    this.app.get('/api/config/model', async () => {
      const runtimePath = join(this.deps.config.data_dir, 'runtime-config.json');
      let runtimeModel: string | null = null;
      try {
        const data = JSON.parse(readFileSync(runtimePath, 'utf8'));
        runtimeModel = data.model ?? null;
      } catch { /* no runtime override */ }

      return {
        model: runtimeModel ?? this.deps.config.agent.model,
        source: runtimeModel ? 'runtime_override' : 'config',
      };
    });

    // PUT /api/config/model — set runtime model override
    this.app.put('/api/config/model', async (request, reply) => {
      const body = request.body as { model: string } | null;
      if (!body?.model) {
        return reply.status(400).send({ error: 'Missing model in request body' });
      }

      if (!isValidModel(body.model)) {
        return reply.status(400).send({ error: `Invalid model: "${body.model}"` });
      }

      const runtimePath = join(this.deps.config.data_dir, 'runtime-config.json');
      let runtimeConfig: Record<string, unknown> = {};
      try {
        runtimeConfig = JSON.parse(readFileSync(runtimePath, 'utf8'));
      } catch { /* no existing file */ }

      runtimeConfig.model = body.model;
      mkdirSync(dirname(runtimePath), { recursive: true });
      writeFileSync(runtimePath, JSON.stringify(runtimeConfig, null, 2), 'utf8');

      // Live-update config so gateway picks up the change immediately
      this.deps.config.agent.model = body.model;

      return { ok: true, model: body.model };
    });
  }
}
