import http from 'node:http';
import crypto from 'node:crypto';
import type {
  EventBus,
  AgentRequest,
  AgentEvent,
  MessageTarget,
} from '@ccbuddy/core';

export interface WebhookEndpoint {
  path: string;
  secret_env?: string;
  signature_header?: string;
  signature_algorithm?: string;
  prompt_template: string;
  max_payload_chars?: number;
  user: string;
  target: MessageTarget;
}

export interface WebhookServerOptions {
  port: number;
  endpoints: Record<string, WebhookEndpoint>;
  eventBus: EventBus;
  executeAgentRequest: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
  sendProactiveMessage: (target: MessageTarget, text: string) => Promise<void>;
}

const MAX_BODY_BYTES = 1_048_576; // 1 MB
const DEFAULT_MAX_PAYLOAD_CHARS = 50_000;

export class WebhookServer {
  private readonly opts: WebhookServerOptions;
  private readonly pathMap: Map<string, { name: string; endpoint: WebhookEndpoint }>;
  private httpServer: http.Server | null = null;

  constructor(opts: WebhookServerOptions) {
    this.opts = opts;

    // Build a path -> endpoint lookup map
    this.pathMap = new Map();
    for (const [name, endpoint] of Object.entries(opts.endpoints)) {
      this.pathMap.set(endpoint.path, { name, endpoint });
    }
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      this.httpServer.on('error', reject);

      this.httpServer.listen(this.opts.port, '127.0.0.1', () => {
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = req.url ?? '/';
    const entry = this.pathMap.get(url);

    // 1. Path match
    if (!entry) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // 2. Method check
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const { name, endpoint } = entry;

    // 3. Read body (reject > 1 MB)
    let rawBody: string;
    try {
      rawBody = await this.readBody(req);
    } catch {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
      return;
    }

    // 4. Verify signature if configured
    if (endpoint.secret_env && endpoint.signature_header && endpoint.signature_algorithm) {
      const secret = process.env[endpoint.secret_env];
      if (!secret) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Webhook secret not configured' }));
        return;
      }

      const receivedSig = req.headers[endpoint.signature_header.toLowerCase()] as string | undefined;
      if (!receivedSig) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing signature' }));
        return;
      }

      const expectedHex = crypto
        .createHmac(endpoint.signature_algorithm, secret)
        .update(rawBody)
        .digest('hex');

      // Strip optional algorithm prefix (e.g. "sha256=...")
      const sigParts = receivedSig.split('=');
      const receivedHex = sigParts.length > 1 ? sigParts.slice(1).join('=') : receivedSig;

      if (!this.safeCompare(expectedHex, receivedHex)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        return;
      }
    }

    // 5. Parse JSON
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    // 6. Return 200 immediately
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

    // 7. Async dispatch
    void this.dispatch(name, endpoint, rawBody, payload, req);
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy();
          reject(new Error('Payload too large'));
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  private safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
    } catch {
      return false;
    }
  }

  private async dispatch(
    name: string,
    endpoint: WebhookEndpoint,
    rawBody: string,
    payload: unknown,
    req: http.IncomingMessage,
  ): Promise<void> {
    // Determine event type from headers
    const eventType =
      (req.headers['x-github-event'] as string | undefined) ??
      (req.headers['x-event-type'] as string | undefined) ??
      'unknown';

    // Truncate payload for prompt
    const maxChars = endpoint.max_payload_chars ?? DEFAULT_MAX_PAYLOAD_CHARS;
    const payloadStr = rawBody.length > maxChars ? rawBody.slice(0, maxChars) : rawBody;

    // Render template
    const prompt = endpoint.prompt_template
      .replace(/\{\{endpoint\}\}/g, name)
      .replace(/\{\{payload\}\}/g, payloadStr)
      .replace(/\{\{event_type\}\}/g, eventType);

    // Publish webhook.received event
    await this.opts.eventBus.publish('webhook.received', {
      handler: name,
      userId: endpoint.user,
      payload,
      promptTemplate: endpoint.prompt_template,
      timestamp: Date.now(),
    });

    // Build AgentRequest
    const request: AgentRequest = {
      prompt,
      userId: endpoint.user,
      sessionId: `scheduler:webhook:${name}:${crypto.randomUUID().slice(0, 8)}`,
      channelId: endpoint.target.channel,
      platform: endpoint.target.platform,
      permissionLevel: 'system',
    };

    // Execute
    try {
      const generator = this.opts.executeAgentRequest(request);
      for await (const event of generator) {
        if (event.type === 'error') {
          await this.opts.sendProactiveMessage(
            endpoint.target,
            `Webhook "${name}" failed: ${event.error}`,
          );
          await this.publishComplete(name, false, endpoint.target);
          return;
        }
        if (event.type === 'complete') {
          await this.opts.sendProactiveMessage(endpoint.target, event.response);
          await this.publishComplete(name, true, endpoint.target);
          return;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.opts.sendProactiveMessage(
        endpoint.target,
        `Webhook "${name}" failed: ${message}`,
      );
      await this.publishComplete(name, false, endpoint.target);
    }
  }

  private async publishComplete(
    jobName: string,
    success: boolean,
    target: MessageTarget,
  ): Promise<void> {
    await this.opts.eventBus.publish('scheduler.job.complete', {
      jobName,
      source: 'webhook',
      success,
      target,
      timestamp: Date.now(),
    });
  }
}
