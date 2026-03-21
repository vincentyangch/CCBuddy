import type { PlatformAdapter, IncomingMessage, Attachment } from '@ccbuddy/core';
import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

interface ChatMessageData {
  text: string;
  attachments?: Array<{ data: string; mimeType: string; filename?: string }>;
}

interface PendingButtons {
  resolve: (label: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WebChatAdapter implements PlatformAdapter {
  readonly platform = 'webchat';
  private clients = new Map<string, WebSocket>();
  private messageHandler: ((msg: IncomingMessage) => void) | null = null;
  private pendingButtons = new Map<string, PendingButtons>();

  async start(): Promise<void> { /* no-op */ }
  async stop(): Promise<void> { /* no-op */ }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  addClient(channelId: string, ws: WebSocket): void {
    this.clients.set(channelId, ws);
  }

  removeClient(channelId: string): void {
    this.clients.delete(channelId);
  }

  handleClientMessage(channelId: string, data: ChatMessageData): void {
    if (!this.messageHandler) return;

    const attachments: Attachment[] = (data.attachments ?? []).map(a => ({
      type: a.mimeType.startsWith('image/') ? 'image' as const
        : a.mimeType.startsWith('audio/') ? 'voice' as const
        : 'file' as const,
      mimeType: a.mimeType,
      data: Buffer.from(a.data, 'base64'),
      filename: a.filename,
    }));

    const msg: IncomingMessage = {
      platform: 'webchat',
      platformUserId: 'dashboard',
      channelId,
      channelType: 'dm',
      text: data.text,
      attachments,
      isMention: true,
      raw: data,
    };

    this.messageHandler(msg);
  }

  handleButtonClick(messageId: string, buttonLabel: string): void {
    const pending = this.pendingButtons.get(messageId);
    if (!pending) return;
    this.pendingButtons.delete(messageId);
    clearTimeout(pending.timer);
    pending.resolve(buttonLabel);
  }

  async sendText(channelId: string, text: string): Promise<string> {
    const messageId = randomUUID();
    this.send(channelId, { type: 'chat.text', messageId, text });
    return messageId;
  }

  async sendImage(channelId: string, image: Buffer, caption?: string): Promise<void> {
    this.send(channelId, { type: 'chat.image', data: image.toString('base64'), filename: caption });
  }

  async sendFile(channelId: string, file: Buffer, filename: string): Promise<void> {
    this.send(channelId, { type: 'chat.file', data: file.toString('base64'), filename });
  }

  async sendVoice(channelId: string, audio: Buffer): Promise<void> {
    this.send(channelId, { type: 'chat.voice', data: audio.toString('base64') });
  }

  async setTypingIndicator(channelId: string, active: boolean): Promise<void> {
    this.send(channelId, { type: 'chat.typing', active });
  }

  async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
    this.send(channelId, { type: 'chat.edit', messageId, text });
  }

  async sendButtons(
    channelId: string,
    text: string,
    buttons: Array<{ id: string; label: string }>,
    options: { timeoutMs: number; userId?: string; signal?: AbortSignal },
  ): Promise<string | null> {
    const messageId = randomUUID();
    this.send(channelId, { type: 'chat.buttons', messageId, text, buttons });

    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingButtons.delete(messageId);
        resolve(null);
      }, options.timeoutMs);

      this.pendingButtons.set(messageId, { resolve, timer });

      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          this.pendingButtons.delete(messageId);
          clearTimeout(timer);
          resolve(null);
        }, { once: true });
      }
    });
  }

  private send(channelId: string, data: Record<string, unknown>): void {
    const ws = this.clients.get(channelId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  }
}
