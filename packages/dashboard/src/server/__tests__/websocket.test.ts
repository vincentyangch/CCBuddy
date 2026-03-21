import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DashboardServer } from '../index.js';
import WebSocket from 'ws';

function createMockDeps() {
  const handlers = new Map<string, Function>();
  return {
    eventBus: {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockImplementation((event: string, handler: Function) => {
        handlers.set(event, handler);
        return { dispose: vi.fn() };
      }),
    },
    agentService: { getSessionInfo: vi.fn().mockReturnValue([]), queueSize: 0 },
    messageStore: { query: vi.fn().mockReturnValue({ messages: [], total: 0, page: 1, pageSize: 50 }) },
    agentEventStore: { getBySession: vi.fn().mockReturnValue([]) },
    config: {
      dashboard: { enabled: true, port: 0, host: '127.0.0.1', auth_token_env: 'TEST_WS_TOKEN' },
      data_dir: '/tmp/test-ccbuddy',
    },
    configDir: '/tmp',
    logFiles: { stdout: '/tmp/stdout.log', stderr: '/tmp/stderr.log', app: '/tmp/app.log' },
    _handlers: handlers,
  };
}

const TOKEN = 'ws-test-secret';

describe('Dashboard WebSocket', () => {
  let server: DashboardServer;

  beforeEach(() => {
    process.env.TEST_WS_TOKEN = TOKEN;
  });

  afterEach(async () => {
    if (server) await server.stop();
    delete process.env.TEST_WS_TOKEN;
  });

  it('rejects unauthenticated connections', async () => {
    server = new DashboardServer(createMockDeps() as any);
    const address = await server.start();
    const wsUrl = address.replace('http', 'ws') + '/ws';

    const ws = new WebSocket(wsUrl);
    const closeCode = await new Promise<number>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
      });
      ws.on('close', (code) => resolve(code));
    });
    expect(closeCode).toBe(4001);
  });

  it('accepts auth and sends auth.ok', async () => {
    server = new DashboardServer(createMockDeps() as any);
    const address = await server.start();
    const wsUrl = address.replace('http', 'ws') + '/ws';

    const ws = new WebSocket(wsUrl);
    const msg = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
      });
      ws.on('message', (data) => {
        clearTimeout(timeout);
        resolve(JSON.parse(data.toString()));
      });
    });
    expect(msg).toEqual({ type: 'auth.ok' });
    ws.close();
  });

  it('forwards event bus events after auth', async () => {
    const deps = createMockDeps();
    server = new DashboardServer(deps as any);
    const address = await server.start();
    const wsUrl = address.replace('http', 'ws') + '/ws';

    const ws = new WebSocket(wsUrl);
    const messages: any[] = [];

    // Auth first
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
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

    // Simulate event bus publishing a heartbeat
    const heartbeatHandler = deps._handlers.get('heartbeat.status');
    expect(heartbeatHandler).toBeDefined();

    const receivedEvent = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
      ws.on('message', (data) => {
        clearTimeout(timeout);
        resolve(JSON.parse(data.toString()));
      });
    });

    heartbeatHandler!({ modules: { process: 'healthy' }, system: { cpuPercent: 5 }, timestamp: Date.now() });

    const event = await receivedEvent;
    expect(event.type).toBe('heartbeat.status');
    expect(event.data.modules.process).toBe('healthy');

    ws.close();
  });
});
