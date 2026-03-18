import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AgentEvent, AgentRequest, EventBus, MessageTarget } from '@ccbuddy/core';
import type { WebhookServerOptions, WebhookEndpoint } from '../webhook-server.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeRequest(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {},
  method = 'POST',
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'content-type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ statusCode: res.statusCode!, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function createMockDeps(
  endpointOverrides: Partial<WebhookEndpoint> = {},
  extraEndpoints: Record<string, WebhookEndpoint> = {},
): WebhookServerOptions {
  const completeEvent: AgentEvent = {
    type: 'complete',
    response: 'Webhook handled.',
    sessionId: 'test-session',
    userId: 'webhook-user',
    channelId: 'alerts',
    platform: 'discord',
  };

  const executeAgentRequest = vi.fn(async function* (_req: AgentRequest): AsyncGenerator<AgentEvent> {
    yield completeEvent;
  });

  const sendProactiveMessage = vi.fn(async () => {});

  const eventBus: EventBus = {
    publish: vi.fn(async () => {}),
    subscribe: vi.fn(() => ({ dispose: vi.fn() })),
  };

  const defaultEndpoint: WebhookEndpoint = {
    path: '/webhook/github',
    prompt_template: 'Handle {{endpoint}} event: {{payload}}',
    user: 'webhook-user',
    target: { platform: 'discord', channel: 'alerts' },
    ...endpointOverrides,
  };

  const port = 19900 + Math.floor(Math.random() * 100);

  return {
    port,
    endpoints: {
      github: defaultEndpoint,
      ...extraEndpoints,
    },
    eventBus,
    executeAgentRequest,
    sendProactiveMessage,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

// Dynamic import so we test the real module
import { WebhookServer } from '../webhook-server.js';

describe('WebhookServer', () => {
  let server: WebhookServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    // Clean up env vars used by signature tests
    delete process.env['TEST_WEBHOOK_SECRET'];
  });

  /* 1 */
  it('returns 404 for unknown paths', async () => {
    const opts = createMockDeps();
    server = new WebhookServer(opts);
    await server.start();

    const res = await makeRequest(opts.port, '/unknown', '{}');
    expect(res.statusCode).toBe(404);
  });

  /* 2 */
  it('returns 405 for non-POST methods', async () => {
    const opts = createMockDeps();
    server = new WebhookServer(opts);
    await server.start();

    const res = await makeRequest(opts.port, '/webhook/github', '{}', {}, 'GET');
    expect(res.statusCode).toBe(405);
  });

  /* 3 */
  it('returns 200 for valid POST to matching endpoint', async () => {
    const opts = createMockDeps();
    server = new WebhookServer(opts);
    await server.start();

    const res = await makeRequest(opts.port, '/webhook/github', '{"action":"opened"}');
    expect(res.statusCode).toBe(200);
  });

  /* 4 */
  it('returns 401 for invalid signature', async () => {
    process.env['TEST_WEBHOOK_SECRET'] = 'my-secret-key';

    const opts = createMockDeps({
      secret_env: 'TEST_WEBHOOK_SECRET',
      signature_header: 'x-hub-signature-256',
      signature_algorithm: 'sha256',
    });
    server = new WebhookServer(opts);
    await server.start();

    const res = await makeRequest(
      opts.port,
      '/webhook/github',
      '{"action":"opened"}',
      { 'x-hub-signature-256': 'sha256=invalidsignature' },
    );
    expect(res.statusCode).toBe(401);
  });

  /* 5 */
  it('returns 200 for valid signature', async () => {
    process.env['TEST_WEBHOOK_SECRET'] = 'my-secret-key';

    const opts = createMockDeps({
      secret_env: 'TEST_WEBHOOK_SECRET',
      signature_header: 'x-hub-signature-256',
      signature_algorithm: 'sha256',
    });
    server = new WebhookServer(opts);
    await server.start();

    const body = '{"action":"opened"}';
    const hmac = crypto.createHmac('sha256', 'my-secret-key').update(body).digest('hex');

    const res = await makeRequest(
      opts.port,
      '/webhook/github',
      body,
      { 'x-hub-signature-256': `sha256=${hmac}` },
    );
    expect(res.statusCode).toBe(200);
  });

  /* 6 */
  it('renders template with {{endpoint}} and {{payload}} replaced', async () => {
    const opts = createMockDeps({
      prompt_template: 'Endpoint={{endpoint}} Payload={{payload}} Event={{event_type}}',
    });
    server = new WebhookServer(opts);
    await server.start();

    const body = '{"action":"opened"}';
    await makeRequest(
      opts.port,
      '/webhook/github',
      body,
      { 'x-github-event': 'push' },
    );

    // Wait for async dispatch
    await new Promise((r) => setTimeout(r, 100));

    expect(opts.executeAgentRequest).toHaveBeenCalledTimes(1);
    const request: AgentRequest = (opts.executeAgentRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.prompt).toContain('Endpoint=github');
    expect(request.prompt).toContain('Payload={"action":"opened"}');
    expect(request.prompt).toContain('Event=push');
  });

  /* 7 */
  it('truncates payload to max_payload_chars', async () => {
    const opts = createMockDeps({
      prompt_template: 'Payload={{payload}}',
      max_payload_chars: 50,
    });
    server = new WebhookServer(opts);
    await server.start();

    const largePayload = JSON.stringify({ data: 'x'.repeat(200) });
    await makeRequest(opts.port, '/webhook/github', largePayload);

    // Wait for async dispatch
    await new Promise((r) => setTimeout(r, 100));

    expect(opts.executeAgentRequest).toHaveBeenCalledTimes(1);
    const request: AgentRequest = (opts.executeAgentRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // The payload portion in the prompt should be truncated
    const payloadInPrompt = request.prompt.replace('Payload=', '');
    expect(payloadInPrompt.length).toBeLessThanOrEqual(50);
  });

  /* 8 */
  it('returns 400 for invalid JSON', async () => {
    const opts = createMockDeps();
    server = new WebhookServer(opts);
    await server.start();

    const res = await makeRequest(opts.port, '/webhook/github', 'not-json{{{');
    expect(res.statusCode).toBe(400);
  });
});
