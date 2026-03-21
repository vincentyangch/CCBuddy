import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebChatAdapter } from '../webchat-adapter.js';

function mockWs() {
  return { send: vi.fn(), readyState: 1 };
}

describe('WebChatAdapter', () => {
  let adapter: WebChatAdapter;

  beforeEach(() => {
    adapter = new WebChatAdapter();
  });

  it('has platform "webchat"', () => {
    expect(adapter.platform).toBe('webchat');
  });

  it('start and stop are no-ops', async () => {
    await expect(adapter.start()).resolves.toBeUndefined();
    await expect(adapter.stop()).resolves.toBeUndefined();
  });

  it('onMessage stores handler and handleClientMessage invokes it', () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    const ws = mockWs();
    adapter.addClient('ch1', ws as any);
    adapter.handleClientMessage('ch1', { text: 'hello', attachments: [] });
    expect(handler).toHaveBeenCalledOnce();
    const msg = handler.mock.calls[0][0];
    expect(msg.platform).toBe('webchat');
    expect(msg.platformUserId).toBe('dashboard');
    expect(msg.channelId).toBe('ch1');
    expect(msg.channelType).toBe('dm');
    expect(msg.text).toBe('hello');
    expect(msg.isMention).toBe(true);
  });

  it('sendText sends via WS and returns messageId', async () => {
    const ws = mockWs();
    adapter.addClient('ch1', ws as any);
    const id = await adapter.sendText('ch1', 'hello back');
    expect(id).toBeDefined();
    expect(ws.send).toHaveBeenCalledOnce();
    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('chat.text');
    expect(sent.text).toBe('hello back');
    expect(sent.messageId).toBe(id);
  });

  it('editMessage sends edit event', async () => {
    const ws = mockWs();
    adapter.addClient('ch1', ws as any);
    await adapter.editMessage('ch1', 'msg1', 'updated text');
    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('chat.edit');
    expect(sent.messageId).toBe('msg1');
    expect(sent.text).toBe('updated text');
  });

  it('setTypingIndicator sends typing event', async () => {
    const ws = mockWs();
    adapter.addClient('ch1', ws as any);
    await adapter.setTypingIndicator('ch1', true);
    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('chat.typing');
    expect(sent.active).toBe(true);
  });

  it('sendImage sends base64 image', async () => {
    const ws = mockWs();
    adapter.addClient('ch1', ws as any);
    await adapter.sendImage('ch1', Buffer.from('fake-image'), 'test.png');
    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('chat.image');
    expect(sent.filename).toBe('test.png');
    expect(typeof sent.data).toBe('string');
  });

  it('sendFile sends base64 file', async () => {
    const ws = mockWs();
    adapter.addClient('ch1', ws as any);
    await adapter.sendFile('ch1', Buffer.from('file-data'), 'report.pdf');
    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('chat.file');
    expect(sent.filename).toBe('report.pdf');
  });

  it('sendButtons sends and resolves on handleButtonClick', async () => {
    const ws = mockWs();
    adapter.addClient('ch1', ws as any);
    const promise = adapter.sendButtons('ch1', 'Choose:', [
      { id: 'a', label: 'Allow' },
      { id: 'b', label: 'Deny' },
    ], { timeoutMs: 5000 });
    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('chat.buttons');
    adapter.handleButtonClick(sent.messageId, 'Allow');
    const result = await promise;
    expect(result).toBe('Allow');
  });

  it('sendButtons returns null on timeout', async () => {
    const ws = mockWs();
    adapter.addClient('ch1', ws as any);
    const result = await adapter.sendButtons('ch1', 'Choose:', [
      { id: 'a', label: 'Allow' },
    ], { timeoutMs: 50 });
    expect(result).toBeNull();
  });

  it('removeClient cleans up', async () => {
    const ws = mockWs();
    adapter.addClient('ch1', ws as any);
    adapter.removeClient('ch1');
    // sendText should silently no-op (no ws.send called)
    await adapter.sendText('ch1', 'hello');
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('handles attachments with base64 conversion', () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    const ws = mockWs();
    adapter.addClient('ch1', ws as any);
    adapter.handleClientMessage('ch1', {
      text: 'see this',
      attachments: [{
        data: Buffer.from('image-data').toString('base64'),
        mimeType: 'image/png',
        filename: 'screenshot.png',
      }],
    });
    const msg = handler.mock.calls[0][0];
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0].type).toBe('image');
    expect(msg.attachments[0].mimeType).toBe('image/png');
    expect(Buffer.isBuffer(msg.attachments[0].data)).toBe(true);
  });
});
