# Dashboard Web Chat Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a web-based chat interface to the CCBuddy dashboard so the admin can talk to Po from any browser, with full media support and agent progress visibility.

**Architecture:** A `WebChatAdapter` implements `PlatformAdapter` and registers with the gateway like Discord/Telegram. The dashboard's WebSocket bridges browser messages to the adapter. The React client adds a `/chat` route with sidebar + inline chat layout, reusing existing components.

**Tech Stack:** TypeScript, vitest, Fastify, React, WebSocket, react-markdown

**Spec:** `docs/superpowers/specs/2026-03-21-dashboard-webchat-design.md`

---

## Chunk 1: Core Infrastructure

### Task 1: UserManager.registerPlatformId

**Files:**
- Modify: `packages/core/src/users/user-manager.ts:12-70`
- Create: `packages/core/src/users/__tests__/user-manager-register.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/users/__tests__/user-manager-register.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { UserManager } from '../user-manager.js';

describe('UserManager.registerPlatformId', () => {
  it('registers a platform ID at runtime and enables lookup', () => {
    const manager = new UserManager([{ name: 'alice', role: 'admin' }]);
    expect(manager.findByPlatformId('webchat', 'dashboard')).toBeUndefined();

    manager.registerPlatformId('webchat', 'dashboard', 'alice');
    const user = manager.findByPlatformId('webchat', 'dashboard');
    expect(user).toBeDefined();
    expect(user!.name).toBe('alice');
  });

  it('does nothing if user name not found', () => {
    const manager = new UserManager([{ name: 'alice', role: 'admin' }]);
    manager.registerPlatformId('webchat', 'dashboard', 'nonexistent');
    expect(manager.findByPlatformId('webchat', 'dashboard')).toBeUndefined();
  });

  it('overwrites existing platform ID for same platform', () => {
    const manager = new UserManager([
      { name: 'alice', role: 'admin' },
      { name: 'bob', role: 'chat' },
    ]);
    manager.registerPlatformId('webchat', 'dashboard', 'alice');
    manager.registerPlatformId('webchat', 'dashboard', 'bob');
    expect(manager.findByPlatformId('webchat', 'dashboard')!.name).toBe('bob');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/core -- --run src/users/__tests__/user-manager-register.test.ts`
Expected: FAIL — `registerPlatformId` does not exist

- [ ] **Step 3: Implement**

In `packages/core/src/users/user-manager.ts`, add method to the class:

```typescript
/** Register a platform ID for an existing user at runtime (ephemeral, not persisted). */
registerPlatformId(platform: string, platformId: string, userName: string): void {
  const user = this.nameIndex.get(userName.toLowerCase());
  if (!user) return;
  const key = `${platform}:${platformId}`;
  user.platformIds[platform] = platformId;
  this.index.set(key, user);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/core -- --run src/users/__tests__/user-manager-register.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/users/user-manager.ts packages/core/src/users/__tests__/user-manager-register.test.ts
git commit -m "feat(core): add UserManager.registerPlatformId for runtime identity mapping"
```

### Task 2: Add webchat to gateway PLATFORM_CHAR_LIMITS

**Files:**
- Modify: `packages/gateway/src/gateway.ts:54-59`

- [ ] **Step 1: Add webchat char limit**

In `packages/gateway/src/gateway.ts`, add to `PLATFORM_CHAR_LIMITS`:

```typescript
const PLATFORM_CHAR_LIMITS: Record<string, number> = {
  discord: 2000,
  telegram: 4096,
  webchat: 100000,
};
```

- [ ] **Step 2: Build**

Run: `npm run build -w packages/gateway`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): add webchat char limit (100k — no chunking)"
```

---

## Chunk 2: WebChatAdapter

### Task 3: Create WebChatAdapter

**Files:**
- Create: `packages/dashboard/src/server/webchat-adapter.ts`
- Create: `packages/dashboard/src/server/__tests__/webchat-adapter.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/dashboard/src/server/__tests__/webchat-adapter.test.ts`:

```typescript
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
    expect(typeof sent.data).toBe('string'); // base64
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

    // Simulate button click
    adapter.handleButtonClick(sent.messageId, 'a');

    const result = await promise;
    expect(result).toBe('Allow');
  });

  it('sendButtons returns null on timeout', async () => {
    const ws = mockWs();
    adapter.addClient('ch1', ws as any);

    const result = await adapter.sendButtons('ch1', 'Choose:', [
      { id: 'a', label: 'Allow' },
    ], { timeoutMs: 50 }); // very short timeout

    expect(result).toBeNull();
  });

  it('removeClient cleans up', () => {
    const ws = mockWs();
    adapter.addClient('ch1', ws as any);
    adapter.removeClient('ch1');

    // sendText should silently no-op
    expect(adapter.sendText('ch1', 'hello')).resolves.toBeUndefined();
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/dashboard -- --run src/server/__tests__/webchat-adapter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement WebChatAdapter**

Create `packages/dashboard/src/server/webchat-adapter.ts`:

```typescript
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
  private messageHandler: ((msg: IncomingMessage) => void | Promise<void>) | null = null;
  private pendingButtons = new Map<string, PendingButtons>();

  async start(): Promise<void> { /* no-op — WS transport owned by dashboard server */ }
  async stop(): Promise<void> { /* no-op */ }

  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void {
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

  handleButtonClick(messageId: string, buttonId: string): void {
    const pending = this.pendingButtons.get(messageId);
    if (!pending) return;
    this.pendingButtons.delete(messageId);
    clearTimeout(pending.timer);
    // Find the label for this button ID from the original buttons
    // Since we store the buttons in the WS message, the client sends back the label directly
    pending.resolve(buttonId);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/dashboard -- --run src/server/__tests__/webchat-adapter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/server/webchat-adapter.ts packages/dashboard/src/server/__tests__/webchat-adapter.test.ts
git commit -m "feat(dashboard): add WebChatAdapter implementing PlatformAdapter"
```

---

## Chunk 3: Server Wiring

### Task 4: WebSocket chat message routing

**Files:**
- Modify: `packages/dashboard/src/server/websocket.ts`
- Modify: `packages/dashboard/src/server/index.ts`

- [ ] **Step 1: Add WebChatAdapter reference to setupWebSocket**

Modify `packages/dashboard/src/server/websocket.ts` signature to accept an optional adapter:

```typescript
import type { WebChatAdapter } from './webchat-adapter.js';

export function setupWebSocket(
  app: FastifyInstance,
  eventBus: EventBusLike,
  token: string,
  webchatAdapter?: WebChatAdapter,
): void {
```

- [ ] **Step 2: Add chat message routing after auth**

In the `socket.on('message')` handler, after the auth check and `if (!authenticated)` guard, add:

```typescript
// Chat message routing
if (msg.type === 'chat.message' && webchatAdapter) {
  const channelId = (socket as any).__channelId;
  if (channelId) {
    webchatAdapter.handleClientMessage(channelId, msg as any);
  }
  return;
}

if (msg.type === 'chat.button_click' && webchatAdapter) {
  webchatAdapter.handleButtonClick((msg as any).messageId, (msg as any).buttonLabel);
  return;
}
```

- [ ] **Step 3: Register client with adapter on auth success**

After the `authenticated = true` block, add client registration:

```typescript
if (msg.token === token) {
  authenticated = true;
  clearTimeout(authTimeout);

  // Register with webchat adapter if available
  if (webchatAdapter) {
    const channelId = (msg as any).channelId || 'webchat-main';
    (socket as any).__channelId = channelId;
    webchatAdapter.addClient(channelId, socket);
  }

  socket.send(JSON.stringify({ type: 'auth.ok' }));
  // ... existing event subscription code
}
```

- [ ] **Step 4: Clean up on disconnect**

In the `socket.on('close')` handler, add:

```typescript
if (webchatAdapter && (socket as any).__channelId) {
  webchatAdapter.removeClient((socket as any).__channelId);
}
```

- [ ] **Step 5: Add setWebChatAdapter to DashboardServer**

In `packages/dashboard/src/server/index.ts`, add:

```typescript
import { WebChatAdapter } from './webchat-adapter.js';

// Add to DashboardServer class:
private webchatAdapter?: WebChatAdapter;

setWebChatAdapter(adapter: WebChatAdapter): void {
  this.webchatAdapter = adapter;
}
```

Update the `setupWebSocket` call in `start()` to pass the adapter:

```typescript
setupWebSocket(this.app, this.deps.eventBus, this.token, this.webchatAdapter);
```

- [ ] **Step 6: Export WebChatAdapter from dashboard package**

In `packages/dashboard/src/server/index.ts` or the package's index, add:

```typescript
export { WebChatAdapter } from './webchat-adapter.js';
```

- [ ] **Step 7: Build**

Run: `npm run build -w packages/dashboard`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/dashboard/src/server/websocket.ts packages/dashboard/src/server/index.ts
git commit -m "feat(dashboard): wire WebChatAdapter into WebSocket handler"
```

### Task 5: Bootstrap wiring

**Files:**
- Modify: `packages/main/src/bootstrap.ts:289-298` (adapter registration) and `322-345` (dashboard setup)

- [ ] **Step 1: Create and register WebChatAdapter before gateway.start()**

In `packages/main/src/bootstrap.ts`, after the platform adapter registrations (around line 298) but before `gateway.start()` (line 320), add:

```typescript
// 9b. Create webchat adapter (if dashboard enabled) — must register before gateway.start()
let webchatAdapter: import('@ccbuddy/dashboard').WebChatAdapter | undefined;
if (config.dashboard.enabled) {
  const { WebChatAdapter } = await import('@ccbuddy/dashboard');
  webchatAdapter = new WebChatAdapter();
  gateway.registerAdapter(webchatAdapter);

  // Auto-register admin user's webchat identity
  const adminUser = Object.values(config.users).find(u => u.role === 'admin');
  if (adminUser) {
    userManager.registerPlatformId('webchat', 'dashboard', adminUser.name);
  }
}
```

- [ ] **Step 2: Pass adapter to dashboard server after creation**

In the dashboard setup block (around line 324), after `dashboardServer = new DashboardServer(...)`, add:

```typescript
if (webchatAdapter) {
  dashboardServer.setWebChatAdapter(webchatAdapter);
}
```

- [ ] **Step 3: Build**

Run: `npm run build -w packages/main`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/main/src/bootstrap.ts
git commit -m "feat(main): wire WebChatAdapter into bootstrap — register before gateway.start()"
```

---

## Chunk 4: Client — useWebSocket + ChatInput

### Task 6: Extend useWebSocket with send method

**Files:**
- Modify: `packages/dashboard/client/src/hooks/useWebSocket.ts`

- [ ] **Step 1: Add send function and channelId to the hook**

Modify the hook to expose a `send` method and accept a `channelId`:

```typescript
import { useEffect, useRef, useCallback, useState } from 'react';

type EventHandler = (type: string, data: any) => void;

interface UseWebSocketOptions {
  onEvent: EventHandler;
  channelId?: string;  // for webchat — sent with auth message
}

export function useWebSocket(onEventOrOptions: EventHandler | UseWebSocketOptions) {
  const opts = typeof onEventOrOptions === 'function'
    ? { onEvent: onEventOrOptions }
    : onEventOrOptions;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const delayRef = useRef(3000);
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(opts.onEvent);
  onEventRef.current = opts.onEvent;

  const send = useCallback((data: Record<string, unknown>) => {
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const connect = useCallback(() => {
    const token = localStorage.getItem('dashboard_token');
    if (!token) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token, channelId: opts.channelId }));
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'auth.ok') {
        setConnected(true);
        delayRef.current = 3000;
        return;
      }
      onEventRef.current(msg.type, msg.data ?? msg);
    };

    ws.onclose = () => {
      setConnected(false);
      reconnectTimerRef.current = setTimeout(connect, delayRef.current);
      delayRef.current = Math.min(delayRef.current * 2, 30000);
    };
  }, [opts.channelId]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { connected, send };
}
```

Note: The signature change is backwards-compatible — existing callers pass a function, which is handled by the type check.

- [ ] **Step 2: Build to verify**

Run: `npm run build -w packages/dashboard`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/client/src/hooks/useWebSocket.ts
git commit -m "feat(dashboard): extend useWebSocket with send method and channelId"
```

### Task 7: Create ChatInput component

**Files:**
- Create: `packages/dashboard/client/src/components/ChatInput.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useState, useRef } from 'react';

interface ChatInputProps {
  onSend: (text: string, attachments: Array<{ data: string; mimeType: string; filename: string }>) => void;
  disabled?: boolean;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Array<{ data: string; mimeType: string; filename: string }>>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const [recording, setRecording] = useState(false);

  const handleSend = () => {
    if (!text.trim() && attachments.length === 0) return;
    onSend(text, attachments);
    setText('');
    setAttachments([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      const data = await fileToBase64(file);
      setAttachments(prev => [...prev, { data, mimeType: file.type, filename: file.name }]);
    }
    e.target.value = '';
  };

  const toggleRecording = async () => {
    if (recording && mediaRef.current) {
      mediaRef.current.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunks, { type: mimeType });
        const data = await blobToBase64(blob);
        setAttachments(prev => [...prev, { data, mimeType, filename: `voice.${mimeType.split('/')[1]}` }]);
      };
      recorder.start();
      mediaRef.current = recorder;
      setRecording(true);
    } catch {
      // Microphone access denied or unavailable
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="border-t border-gray-800 p-3">
      {attachments.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {attachments.map((a, i) => (
            <div key={i} className="flex items-center gap-1 bg-gray-800 rounded px-2 py-1 text-xs text-gray-400">
              <span>{a.filename}</span>
              <button onClick={() => removeAttachment(i)} className="text-gray-600 hover:text-red-400">×</button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          disabled={disabled}
          rows={1}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 resize-none disabled:opacity-50 focus:outline-none focus:border-blue-600"
        />
        <input ref={fileRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
        <button onClick={() => fileRef.current?.click()} className="w-8 h-8 flex items-center justify-center bg-gray-800 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700" title="Attach file">
          📎
        </button>
        <button onClick={toggleRecording} className={`w-8 h-8 flex items-center justify-center rounded-lg ${recording ? 'bg-red-600 text-white animate-pulse' : 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700'}`} title="Record voice">
          🎤
        </button>
        <button onClick={handleSend} disabled={disabled || (!text.trim() && attachments.length === 0)} className="w-8 h-8 flex items-center justify-center bg-blue-600 rounded-lg text-white disabled:opacity-50 hover:bg-blue-500">
          →
        </button>
      </div>
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]); // strip data:...;base64, prefix
    };
    reader.readAsDataURL(file);
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return fileToBase64(blob as any);
}
```

- [ ] **Step 2: Build**

Run: `npm run build -w packages/dashboard`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/client/src/components/ChatInput.tsx
git commit -m "feat(dashboard): add ChatInput component with text, file upload, and voice recording"
```

---

## Chunk 5: Client — ChatPage + Route

### Task 8: Create ChatSidebar component

**Files:**
- Create: `packages/dashboard/client/src/components/ChatSidebar.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Session {
  sessionId: string;
  lastMessage: string;
  timestamp: number;
}

interface ChatSidebarProps {
  activeSession: string;
  onSelectSession: (sessionId: string) => void;
  onNewChat: () => void;
}

export function ChatSidebar({ activeSession, onSelectSession, onNewChat }: ChatSidebarProps) {
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    api.conversations({ platform: 'webchat', pageSize: '50' }).then(data => {
      // Group messages by sessionId and get latest
      const grouped = new Map<string, Session>();
      for (const msg of (data.messages ?? [])) {
        if (!grouped.has(msg.sessionId) || msg.timestamp > grouped.get(msg.sessionId)!.timestamp) {
          grouped.set(msg.sessionId, {
            sessionId: msg.sessionId,
            lastMessage: msg.content?.slice(0, 50) ?? '',
            timestamp: msg.timestamp,
          });
        }
      }
      setSessions(Array.from(grouped.values()).sort((a, b) => b.timestamp - a.timestamp));
    });
  }, []);

  return (
    <div className="w-56 bg-gray-900 border-r border-gray-800 p-3 flex flex-col">
      <button onClick={onNewChat} className="mb-3 px-3 py-2 bg-blue-600 rounded-lg text-sm text-white hover:bg-blue-500 w-full">
        + New Chat
      </button>
      <div className="text-xs text-gray-500 uppercase mb-2 px-1">Sessions</div>
      <div className="flex-1 overflow-auto space-y-1">
        {sessions.map(s => (
          <button
            key={s.sessionId}
            onClick={() => onSelectSession(s.sessionId)}
            className={`w-full text-left px-3 py-2 rounded-lg text-xs truncate ${
              s.sessionId === activeSession
                ? 'bg-blue-900/30 border border-blue-800 text-white'
                : 'text-gray-400 hover:bg-gray-800 hover:text-white'
            }`}
          >
            <div className="truncate">{s.lastMessage || 'New conversation'}</div>
            <div className="text-gray-600 text-[10px] mt-0.5">{new Date(s.timestamp).toLocaleDateString()}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/dashboard/client/src/components/ChatSidebar.tsx
git commit -m "feat(dashboard): add ChatSidebar component"
```

### Task 9: Create ChatPage and add route

**Files:**
- Create: `packages/dashboard/client/src/pages/ChatPage.tsx`
- Modify: `packages/dashboard/client/src/App.tsx`

- [ ] **Step 1: Install react-markdown**

Run: `npm install react-markdown -w packages/dashboard`

- [ ] **Step 2: Create ChatPage**

Create `packages/dashboard/client/src/pages/ChatPage.tsx`:

```tsx
import { useState, useRef, useEffect, useCallback } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { ChatInput } from '../components/ChatInput';
import { ChatSidebar } from '../components/ChatSidebar';
import ReactMarkdown from 'react-markdown';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: Array<{ type: string; data: string; filename?: string }>;
}

interface AgentProgress {
  id: string;
  type: 'thinking' | 'tool_use';
  content: string;
}

export function ChatPage() {
  const [channelId, setChannelId] = useState('webchat-main');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [progress, setProgress] = useState<AgentProgress[]>([]);
  const [typing, setTyping] = useState(false);
  const [buttons, setButtons] = useState<{ messageId: string; text: string; buttons: Array<{ id: string; label: string }> } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);

  const handleEvent = useCallback((type: string, data: any) => {
    switch (type) {
      case 'chat.text':
        setMessages(prev => [...prev, { id: data.messageId, role: 'assistant', content: data.text }]);
        setProgress([]);
        setTyping(false);
        break;
      case 'chat.edit':
        setMessages(prev => prev.map(m => m.id === data.messageId ? { ...m, content: data.text } : m));
        break;
      case 'chat.typing':
        setTyping(data.active);
        break;
      case 'chat.image':
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: '',
          attachments: [{ type: 'image', data: data.data, filename: data.filename }],
        }]);
        break;
      case 'chat.file':
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `📎 ${data.filename}`,
          attachments: [{ type: 'file', data: data.data, filename: data.filename }],
        }]);
        break;
      case 'chat.voice':
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: '',
          attachments: [{ type: 'voice', data: data.data }],
        }]);
        break;
      case 'chat.buttons':
        setButtons(data);
        break;
      case 'agent.progress':
        // Filter to current session
        if (data.platform === 'webchat') {
          if (data.type === 'thinking') {
            setProgress(prev => [...prev, { id: crypto.randomUUID(), type: 'thinking', content: data.content }]);
          } else if (data.type === 'tool_use') {
            setProgress(prev => [...prev, { id: crypto.randomUUID(), type: 'tool_use', content: data.content }]);
          }
        }
        break;
    }
  }, []);

  const { connected, send } = useWebSocket({ onEvent: handleEvent, channelId });

  const handleSend = useCallback((text: string, attachments: Array<{ data: string; mimeType: string; filename: string }>) => {
    // Add user message locally
    setMessages(prev => [...prev, {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      attachments: attachments.length > 0
        ? attachments.map(a => ({ type: a.mimeType.startsWith('image/') ? 'image' : 'file', data: a.data, filename: a.filename }))
        : undefined,
    }]);

    send({ type: 'chat.message', text, attachments: attachments.length > 0 ? attachments : undefined });
  }, [send]);

  const handleButtonClick = useCallback((messageId: string, buttonLabel: string) => {
    send({ type: 'chat.button_click', messageId, buttonLabel });
    setButtons(null);
  }, [send]);

  const handleNewChat = useCallback(() => {
    const newId = `webchat-${Date.now()}`;
    setChannelId(newId);
    setMessages([]);
    setProgress([]);
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, progress]);

  return (
    <div className="flex h-[calc(100vh-theme(spacing.12))] -m-6">
      <ChatSidebar activeSession={channelId} onSelectSession={setChannelId} onNewChat={handleNewChat} />
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-800 flex justify-between items-center">
          <span className="text-sm font-medium">Chat with Po</span>
          <span className={`text-xs px-2 py-0.5 rounded ${connected ? 'bg-green-900 text-green-400' : 'bg-red-900 text-red-400'}`}>
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-3">
          {messages.map(msg => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                msg.role === 'user' ? 'bg-blue-900/30 border border-blue-800/50' : 'bg-gray-800 border border-gray-700'
              }`}>
                {msg.attachments?.map((a, i) => (
                  <div key={i} className="mb-2">
                    {a.type === 'image' && <img src={`data:image/png;base64,${a.data}`} className="max-w-full rounded" />}
                    {a.type === 'voice' && <audio controls src={`data:audio/webm;base64,${a.data}`} className="max-w-full" />}
                    {a.type === 'file' && <div className="text-blue-400 text-xs">📎 {a.filename}</div>}
                  </div>
                ))}
                {msg.content && (
                  <div className="prose prose-invert prose-sm max-w-none">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Agent progress (thinking/tool_use) */}
          {progress.map(p => (
            <div key={p.id} className="flex justify-start">
              <div className="max-w-[75%] rounded-lg px-3 py-2 text-xs bg-gray-900 border border-gray-800">
                {p.type === 'thinking' && <span className="text-purple-400">💭 {p.content.slice(0, 200)}{p.content.length > 200 ? '...' : ''}</span>}
                {p.type === 'tool_use' && <span className="text-yellow-400">🔧 Using {p.content}...</span>}
              </div>
            </div>
          ))}

          {/* Typing indicator */}
          {typing && (
            <div className="flex justify-start">
              <div className="rounded-lg px-3 py-2 text-sm bg-gray-800 border border-gray-700 text-gray-500">
                Po is typing...
              </div>
            </div>
          )}

          {/* Interactive buttons */}
          {buttons && (
            <div className="flex justify-start">
              <div className="max-w-[75%] rounded-lg px-3 py-2 bg-gray-800 border border-gray-700">
                <div className="text-sm mb-2 whitespace-pre-wrap">{buttons.text}</div>
                <div className="flex gap-2 flex-wrap">
                  {buttons.buttons.map(b => (
                    <button
                      key={b.id}
                      onClick={() => handleButtonClick(buttons.messageId, b.label)}
                      className="px-3 py-1 bg-blue-600 rounded text-xs text-white hover:bg-blue-500"
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <ChatInput onSend={handleSend} disabled={!connected} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add route and nav item to App.tsx**

In `packages/dashboard/client/src/App.tsx`:

Add import:
```typescript
import { ChatPage } from './pages/ChatPage';
```

Add to `navItems` array:
```typescript
{ to: '/chat', label: 'Chat' },
```

Add route inside `<Routes>`:
```typescript
<Route path="/chat" element={<ChatPage />} />
```

- [ ] **Step 4: Build**

Run: `npm run build -w packages/dashboard`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/client/src/pages/ChatPage.tsx packages/dashboard/client/src/App.tsx packages/dashboard/package.json
git commit -m "feat(dashboard): add ChatPage with inline streaming, agent progress, and media support"
```

---

## Chunk 6: Final Integration & Verification

### Task 10: Full build and test suite

- [ ] **Step 1: Build all packages**

Run: `npm run build`
Expected: PASS

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: PASS — all existing + new tests pass

- [ ] **Step 3: Manual smoke test**

1. Restart CCBuddy
2. Open dashboard at `http://localhost:18801`
3. Navigate to `/chat`
4. Type a message and send — Po should respond with streaming
5. Verify thinking/tool_use blocks appear inline
6. Upload an image — verify Po sees it
7. Record voice — verify transcription works
8. Trigger a permission gate (e.g., "run `git reset --hard`") — verify buttons appear
9. Click "New Chat" — verify new session starts
10. Check sidebar shows past sessions

- [ ] **Step 4: Commit if any fixes needed**

```bash
git add -A
git commit -m "chore: integration fixes for dashboard web chat"
```
