import { readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import yaml from 'js-yaml';
import type { EventBus, CCBuddyConfig } from '@ccbuddy/core';
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
  };
  agentEventStore: {
    getBySession(sessionId: string, pagination?: { limit: number; offset: number }): StoredAgentEvent[];
  };
  config: CCBuddyConfig;
  configDir: string;
  logFiles: { stdout: string; stderr: string; app: string };
}

export class DashboardServer {
  private app: FastifyInstance;
  private deps: DashboardDeps;
  private token: string | undefined;

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

    this.setupRoutes();

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
      if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== this.token) {
        reply.status(401).send({ error: 'Unauthorized' });
      }
    });

    // POST /api/auth — validate token (no auth middleware needed)
    this.app.post('/api/auth', async (request, reply) => {
      const body = request.body as { token?: string } | null;
      if (body?.token === this.token) {
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
    this.app.get('/api/sessions', async () => {
      return { sessions: this.deps.agentService.getSessionInfo() };
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

    // GET /api/logs — recent log lines
    this.app.get('/api/logs', async (request) => {
      const q = request.query as Record<string, string>;
      const file = (q.file ?? 'stdout') as 'stdout' | 'stderr' | 'app';
      const lines = parseInt(q.lines ?? '500', 10);
      const logPath = this.deps.logFiles[file];
      if (!logPath) return { lines: [], file };

      try {
        const content = readFileSync(logPath, 'utf8');
        const allLines = content.split('\n').filter(Boolean);
        return { lines: allLines.slice(-lines), file };
      } catch {
        return { lines: [], file };
      }
    });

    // GET /api/config — current config with secrets redacted
    this.app.get('/api/config', async () => {
      const config = JSON.parse(JSON.stringify(this.deps.config));
      if (config.platforms?.discord?.token) config.platforms.discord.token = '••••••';
      if (config.platforms?.telegram?.token) config.platforms.telegram.token = '••••••';
      return { config };
    });

    // PUT /api/config — update config/local.yaml
    this.app.put('/api/config', async (request, reply) => {
      const body = request.body as { config: Record<string, unknown> } | null;
      if (!body?.config) {
        return reply.status(400).send({ error: 'Missing config in request body' });
      }

      const localPath = join(this.deps.configDir, 'local.yaml');
      const backupPath = localPath + '.bak';

      try {
        try { copyFileSync(localPath, backupPath); } catch { /* no existing file */ }
        const yamlContent = yaml.dump({ ccbuddy: body.config }, { lineWidth: 120 });
        writeFileSync(localPath, yamlContent, 'utf8');
        return { ok: true, backup: backupPath };
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    });
  }
}
