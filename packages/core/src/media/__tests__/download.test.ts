// packages/core/src/media/__tests__/download.test.ts
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fetchAttachment } from '../download.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/image.png') {
      const data = Buffer.from('fake-image-data');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(data.byteLength) });
      res.end(data);
    } else if (req.url === '/large') {
      const data = Buffer.alloc(2 * 1024 * 1024, 'x');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(data);
    } else if (req.url === '/slow') {
      // Never respond — tests timeout
    } else if (req.url === '/error') {
      res.writeHead(500);
      res.end('Internal Server Error');
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' ? addr!.port : 0}`;
      resolve();
    });
  });
});

afterAll(() => { server?.close(); });

describe('fetchAttachment', () => {
  it('downloads binary data from a URL', async () => {
    const buf = await fetchAttachment(`${baseUrl}/image.png`);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.toString()).toBe('fake-image-data');
  });

  it('throws on HTTP error', async () => {
    await expect(fetchAttachment(`${baseUrl}/error`)).rejects.toThrow();
  });

  it('throws on 404', async () => {
    await expect(fetchAttachment(`${baseUrl}/missing`)).rejects.toThrow();
  });

  it('enforces maxBytes limit', async () => {
    await expect(
      fetchAttachment(`${baseUrl}/large`, { maxBytes: 1024 })
    ).rejects.toThrow(/exceeded/i);
  });

  it('enforces timeout', async () => {
    await expect(
      fetchAttachment(`${baseUrl}/slow`, { timeoutMs: 500 })
    ).rejects.toThrow();
  }, 5000);
});
