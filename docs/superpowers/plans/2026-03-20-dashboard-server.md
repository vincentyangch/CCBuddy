# Dashboard Server Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Fastify-based dashboard server with REST API, WebSocket, and token auth — producing a working API layer testable with curl.

**Architecture:** A `DashboardServer` class wraps Fastify, serving REST endpoints for status/sessions/conversations/logs/config and a WebSocket that forwards event bus events and streams log files. Runs in-process alongside Po on a configurable port (default 18801). Token auth via `Authorization: Bearer` header.

**Tech Stack:** TypeScript, Fastify, @fastify/websocket, @fastify/static, @fastify/cors, chokidar, js-yaml, vitest

---

## Chunk 1: Config + Package + Server Core

### Task 1: Add DashboardConfig to core config schema

**Files:**
- Modify: `packages/core/src/config/schema.ts`
- Modify: `config/default.yaml`

- [ ] **Step 1: Add DashboardConfig interface**

In `packages/core/src/config/schema.ts`, add before `CCBuddyConfig`:

```typescript
export interface DashboardConfig {
  enabled: boolean;
  port: number;
  host: string;
  auth_token_env: string;
}
```

- [ ] **Step 2: Add to CCBuddyConfig**

Add `dashboard: DashboardConfig;` to the `CCBuddyConfig` interface.

- [ ] **Step 3: Add defaults**

In `DEFAULT_CONFIG`, add:

```typescript
  dashboard: {
    enabled: false,
    port: 18801,
    host: '127.0.0.1',
    auth_token_env: 'CCBUDDY_DASHBOARD_TOKEN',
  },
```

- [ ] **Step 4: Add to default.yaml**

Add to `config/default.yaml`:

```yaml
  dashboard:
    enabled: false
    port: 18801
    host: "127.0.0.1"
    auth_token_env: "CCBUDDY_DASHBOARD_TOKEN"
```

- [ ] **Step 5: Run config tests, commit**

Run: `npx vitest run packages/core`

```bash
git add packages/core/src/config/schema.ts config/default.yaml
git commit -m "feat(config): add DashboardConfig for GUI dashboard"
```

---

### Task 2: Create packages/dashboard scaffold

**Files:**
- Create: `packages/dashboard/package.json`
- Create: `packages/dashboard/tsconfig.json`
- Create: `packages/dashboard/src/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@ccbuddy/dashboard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@ccbuddy/core": "*",
    "@ccbuddy/agent": "*",
    "@ccbuddy/memory": "*",
    "fastify": "^5",
    "@fastify/websocket": "^11",
    "@fastify/static": "^8",
    "@fastify/cors": "^10",
    "chokidar": "^4",
    "js-yaml": "^4"
  },
  "devDependencies": {
    "@types/node": "^22",
    "@types/js-yaml": "^4",
    "vitest": "^3"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*"],
  "references": [
    { "path": "../core" },
    { "path": "../agent" },
    { "path": "../memory" }
  ]
}
```

- [ ] **Step 3: Create stub index.ts**

Create `packages/dashboard/src/index.ts`:

```typescript
export { DashboardServer } from './server/index.js';
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/
git commit -m "feat(dashboard): scaffold dashboard package"
```

---

### Task 3: DashboardServer class with auth (TDD)

**Files:**
- Create: `packages/dashboard/src/server/index.ts`
- Create: `packages/dashboard/src/server/__tests__/server.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/dashboard/src/server/__tests__/server.test.ts`:

```typescript
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
      getByUser: vi.fn().mockReturnValue([]),
    },
    agentEventStore: {
      getBySession: vi.fn().mockReturnValue([]),
    },
    config: {
      dashboard: { enabled: true, port: 0, host: '127.0.0.1', auth_token_env: 'TEST_TOKEN' },
      data_dir: '/tmp/test',
    },
    configDir: '/tmp',
    logFiles: { stdout: '/tmp/stdout.log', stderr: '/tmp/stderr.log', app: '/tmp/app.log' },
  };
}

describe('DashboardServer', () => {
  let server: DashboardServer;
  const originalEnv = process.env.TEST_TOKEN;

  beforeEach(() => {
    process.env.TEST_TOKEN = 'secret123';
  });

  afterEach(async () => {
    if (server) await server.stop();
    if (originalEnv === undefined) delete process.env.TEST_TOKEN;
    else process.env.TEST_TOKEN = originalEnv;
  });

  it('starts and stops', async () => {
    server = new DashboardServer(createMockDeps() as any);
    const address = await server.start();
    expect(address).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
    await server.stop();
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
      headers: { Authorization: 'Bearer secret123' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects requests with wrong auth token', async () => {
    server = new DashboardServer(createMockDeps() as any);
    const address = await server.start();
    const res = await fetch(`${address}/api/status`, {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/auth validates token', async () => {
    server = new DashboardServer(createMockDeps() as any);
    const address = await server.start();

    const good = await fetch(`${address}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'secret123' }),
    });
    expect(good.status).toBe(200);

    const bad = await fetch(`${address}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    });
    expect(bad.status).toBe(401);
  });

  it('refuses to start without auth token env var', async () => {
    delete process.env.TEST_TOKEN;
    server = new DashboardServer(createMockDeps() as any);
    await expect(server.start()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Implement DashboardServer**

Create `packages/dashboard/src/server/index.ts`:

```typescript
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { EventBus, CCBuddyConfig } from '@ccbuddy/core';
import type { SessionInfo } from '@ccbuddy/agent';
import type { MessageQueryParams, MessageQueryResult, StoredAgentEvent } from '@ccbuddy/memory';

export interface DashboardDeps {
  eventBus: EventBus;
  agentService: {
    getSessionInfo(): SessionInfo[];
    queueSize: number;
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
    this.setupRoutes();
  }

  async start(): Promise<string> {
    const config = this.deps.config.dashboard;
    this.token = process.env[config.auth_token_env];
    if (!this.token) {
      throw new Error(`Dashboard auth token not set: env var ${config.auth_token_env} is empty`);
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
    // Auth middleware — skip for /api/auth
    this.app.addHook('onRequest', async (request, reply) => {
      if (request.url === '/api/auth' && request.method === 'POST') return;
      if (!request.url.startsWith('/api/')) return;

      const auth = request.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== this.token) {
        reply.status(401).send({ error: 'Unauthorized' });
      }
    });

    // POST /api/auth
    this.app.post('/api/auth', async (request, reply) => {
      const body = request.body as { token?: string } | null;
      if (body?.token === this.token) {
        return { ok: true };
      }
      reply.status(401).send({ error: 'Invalid token' });
    });

    // GET /api/status
    this.app.get('/api/status', async () => {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
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

    // GET /api/sessions/:key/messages
    this.app.get('/api/sessions/:key/messages', async (request) => {
      const { key } = request.params as { key: string };
      const events = this.deps.agentEventStore.getBySession(key);
      const messages = this.deps.messageStore.query({
        page: 1,
        pageSize: 1000,
        // sessionId filtering would need to go through the store directly
        // For now, use the agentEventStore for session-level data
      });
      return { sessionKey: key, events, messages: messages.messages };
    });

    // GET /api/conversations
    this.app.get('/api/conversations', async (request) => {
      const q = request.query as Record<string, string>;
      const params: MessageQueryParams = {
        page: parseInt(q.page ?? '1', 10),
        pageSize: parseInt(q.pageSize ?? '50', 10),
        user: q.user,
        platform: q.platform,
        search: q.search,
        dateFrom: q.dateFrom ? parseInt(q.dateFrom, 10) : undefined,
        dateTo: q.dateTo ? parseInt(q.dateTo, 10) : undefined,
      };
      return this.deps.messageStore.query(params);
    });

    // GET /api/logs
    this.app.get('/api/logs', async (request) => {
      const { readFileSync } = await import('node:fs');
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

    // GET /api/config
    this.app.get('/api/config', async () => {
      // Return config with secrets redacted
      const config = JSON.parse(JSON.stringify(this.deps.config));
      // Redact platform tokens
      if (config.platforms?.discord?.token) config.platforms.discord.token = '••••••';
      if (config.platforms?.telegram?.token) config.platforms.telegram.token = '••••••';
      return { config };
    });

    // PUT /api/config
    this.app.put('/api/config', async (request, reply) => {
      const { readFileSync, writeFileSync, copyFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const yaml = await import('js-yaml');

      const body = request.body as { config: Record<string, unknown> };
      if (!body?.config) {
        reply.status(400).send({ error: 'Missing config in request body' });
        return;
      }

      const localPath = join(this.deps.configDir, 'local.yaml');
      const backupPath = localPath + '.bak';

      try {
        // Backup existing
        try { copyFileSync(localPath, backupPath); } catch { /* no existing file */ }

        // Write new config wrapped in ccbuddy key
        const yamlContent = yaml.dump({ ccbuddy: body.config }, { lineWidth: 120 });
        writeFileSync(localPath, yamlContent, 'utf8');

        return { ok: true, backup: backupPath };
      } catch (err) {
        reply.status(500).send({ error: (err as Error).message });
      }
    });
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run packages/dashboard`
Expected: PASS (all 6 tests)

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src/
git commit -m "feat(dashboard): DashboardServer with Fastify, auth, and REST routes"
```

---

## Chunk 2: WebSocket + Bootstrap

### Task 4: WebSocket handler (TDD)

**Files:**
- Create: `packages/dashboard/src/server/websocket.ts`
- Create: `packages/dashboard/src/server/__tests__/websocket.test.ts`
- Modify: `packages/dashboard/src/server/index.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/dashboard/src/server/__tests__/websocket.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DashboardServer } from '../index.js';
import WebSocket from 'ws';

function createMockDeps() {
  const subscribers = new Map<string, Function>();
  return {
    eventBus: {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockImplementation((event: string, handler: Function) => {
        subscribers.set(event, handler);
        return { dispose: vi.fn() };
      }),
    },
    agentService: { getSessionInfo: vi.fn().mockReturnValue([]), queueSize: 0 },
    messageStore: { query: vi.fn().mockReturnValue({ messages: [], total: 0, page: 1, pageSize: 50 }) },
    agentEventStore: { getBySession: vi.fn().mockReturnValue([]) },
    config: {
      dashboard: { enabled: true, port: 0, host: '127.0.0.1', auth_token_env: 'TEST_TOKEN' },
      data_dir: '/tmp/test',
    },
    configDir: '/tmp',
    logFiles: { stdout: '/tmp/stdout.log', stderr: '/tmp/stderr.log', app: '/tmp/app.log' },
    _subscribers: subscribers,
  };
}

describe('Dashboard WebSocket', () => {
  let server: DashboardServer;
  const originalEnv = process.env.TEST_TOKEN;

  beforeEach(() => {
    process.env.TEST_TOKEN = 'secret123';
  });

  afterEach(async () => {
    if (server) await server.stop();
    if (originalEnv === undefined) delete process.env.TEST_TOKEN;
    else process.env.TEST_TOKEN = originalEnv;
  });

  it('rejects unauthenticated WebSocket connections', async () => {
    const deps = createMockDeps();
    server = new DashboardServer(deps as any);
    const address = await server.start();
    const wsUrl = address.replace('http', 'ws') + '/ws';

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => {
      ws.on('close', (code) => {
        expect(code).toBe(4001);
        resolve();
      });
      ws.on('open', () => {
        // Send invalid auth
        ws.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
      });
    });
  });

  it('accepts authenticated WebSocket and receives events', async () => {
    const deps = createMockDeps();
    server = new DashboardServer(deps as any);
    const address = await server.start();
    const wsUrl = address.replace('http', 'ws') + '/ws';

    const ws = new WebSocket(wsUrl);
    const messages: any[] = [];

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: 'secret123' }));
      });
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        if (msg.type === 'auth.ok') {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    expect(messages[0]).toEqual({ type: 'auth.ok' });
    ws.close();
  });
});
```

- [ ] **Step 2: Add ws dependency**

Run: `cd packages/dashboard && npm install ws && npm install -D @types/ws`

(ws is needed for the test client. @fastify/websocket uses ws internally.)

- [ ] **Step 3: Implement WebSocket support**

Create `packages/dashboard/src/server/websocket.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { EventBus, Disposable } from '@ccbuddy/core';

export function setupWebSocket(
  app: FastifyInstance,
  eventBus: EventBus,
  token: string,
): void {
  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    let authenticated = false;
    const disposables: Disposable[] = [];
    let authTimeout: ReturnType<typeof setTimeout>;

    // Require auth within 5 seconds
    authTimeout = setTimeout(() => {
      if (!authenticated) {
        socket.close(4001, 'Auth timeout');
      }
    }, 5000);

    socket.on('message', (data) => {
      let msg: { type: string; token?: string; file?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === 'auth') {
        if (msg.token === token) {
          authenticated = true;
          clearTimeout(authTimeout);
          socket.send(JSON.stringify({ type: 'auth.ok' }));

          // Subscribe to event bus events
          const eventTypes = [
            'heartbeat.status',
            'message.incoming',
            'message.outgoing',
            'agent.progress',
            'alert.health',
            'session.conflict',
            'scheduler.job.complete',
          ] as const;

          for (const eventType of eventTypes) {
            const d = eventBus.subscribe(eventType, (payload) => {
              if (socket.readyState === socket.OPEN) {
                socket.send(JSON.stringify({ type: eventType, data: payload }));
              }
            });
            disposables.push(d);
          }
        } else {
          socket.close(4001, 'Invalid token');
        }
        return;
      }

      if (!authenticated) {
        socket.close(4001, 'Not authenticated');
        return;
      }

      // Handle other message types for authenticated clients
      // (log streaming can be added later)
    });

    socket.on('close', () => {
      clearTimeout(authTimeout);
      for (const d of disposables) d.dispose();
    });
  });
}
```

- [ ] **Step 4: Register WebSocket in DashboardServer**

In `packages/dashboard/src/server/index.ts`, add the websocket plugin registration. At the top, add:

```typescript
import websocket from '@fastify/websocket';
import { setupWebSocket } from './websocket.js';
```

In the constructor, before `this.setupRoutes()`, add:

```typescript
    this.app.register(websocket);
```

In `start()`, after setting `this.token`, add:

```typescript
    setupWebSocket(this.app, this.deps.eventBus, this.token);
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/dashboard`
Expected: PASS (all 8 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/
git commit -m "feat(dashboard): WebSocket with auth and event bus forwarding"
```

---

### Task 5: Bootstrap wiring

**Files:**
- Modify: `packages/main/src/bootstrap.ts`
- Modify: `packages/main/package.json`

- [ ] **Step 1: Add @ccbuddy/dashboard dependency**

In `packages/main/package.json`, add to dependencies:

```json
"@ccbuddy/dashboard": "*"
```

Run: `npm install`

- [ ] **Step 2: Wire DashboardServer in bootstrap**

Read `packages/main/src/bootstrap.ts`. Add import at the top:

```typescript
import { DashboardServer } from '@ccbuddy/dashboard';
```

After gateway starts (after `await gateway.start()`), add the dashboard server startup:

```typescript
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
```

Register shutdown:

```typescript
  if (dashboardServer) {
    shutdownHandler.register('dashboard', async () => {
      await dashboardServer!.stop();
    });
  }
```

- [ ] **Step 3: Build all packages**

Run: `npm run build`
Expected: All packages compile

- [ ] **Step 4: Run full test suite**

Run: `npm run test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/main/src/bootstrap.ts packages/main/package.json package-lock.json
git commit -m "feat(main): wire DashboardServer into bootstrap"
```

---

### Task 6: Verify end-to-end with curl

- [ ] **Step 1: Enable dashboard in local config**

Add to `config/local.yaml`:

```yaml
  dashboard:
    enabled: true
    host: "0.0.0.0"
```

Set the env var: `export CCBUDDY_DASHBOARD_TOKEN=test123`

- [ ] **Step 2: Build and restart**

```bash
npm run build
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
```

- [ ] **Step 3: Test with curl**

```bash
# Auth
curl -s -X POST http://localhost:18801/api/auth -H 'Content-Type: application/json' -d '{"token":"test123"}'

# Status
curl -s http://localhost:18801/api/status -H 'Authorization: Bearer test123'

# Sessions
curl -s http://localhost:18801/api/sessions -H 'Authorization: Bearer test123'

# Conversations
curl -s 'http://localhost:18801/api/conversations?page=1&pageSize=5' -H 'Authorization: Bearer test123'

# Logs
curl -s 'http://localhost:18801/api/logs?file=stdout&lines=10' -H 'Authorization: Bearer test123'

# Config
curl -s http://localhost:18801/api/config -H 'Authorization: Bearer test123'
```

Verify each returns valid JSON with correct data.
