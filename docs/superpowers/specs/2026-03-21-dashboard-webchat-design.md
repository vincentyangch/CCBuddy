# Dashboard Web Chat

**Date:** 2026-03-21
**Status:** Draft

## Overview

Add a web-based chat interface to the CCBuddy dashboard, allowing the admin user to talk to Po from any browser. The webchat is a full PlatformAdapter registered with the gateway, getting all features (memory, sessions, streaming, permission gates, model selection) for free. Supports text, images, files, and voice — full parity with Discord.

## Requirements

1. **Real chat interface** — sidebar with session list, inline message stream with thinking/tool events
2. **Full media support** — text, image upload, file upload, voice recording
3. **Developer visibility** — thinking blocks, tool use events shown inline with messages
4. **Separate platform** — `platform: 'webchat'`, independent sessions, shared memory context
5. **No extra config** — automatically available when `dashboard.enabled: true`
6. **Streaming** — progressive message updates via `editMessage`

## Design Decisions

### Why a real PlatformAdapter

The WebChatAdapter implements the same `PlatformAdapter` interface as Discord and Telegram. This means the entire gateway pipeline (user lookup, activation, session management, memory context, agent execution, streaming, media delivery) works automatically. The alternative — a REST endpoint — would require reimplementing all that logic.

### Why in the dashboard package

The adapter is tightly coupled to the dashboard's WebSocket connection. It doesn't need its own package — it lives alongside the dashboard server and shares the WS transport.

### Auto-derived user identity

The dashboard is single-user (auth-gated by token). The WebChatAdapter uses a fixed `platformUserId: 'dashboard'`. Bootstrap auto-registers this as the admin user's webchat ID. No config changes needed.

## Architecture

### WebChatAdapter

**File:** `packages/dashboard/src/server/webchat-adapter.ts`

Implements `PlatformAdapter` with `platform: 'webchat'`:

```typescript
class WebChatAdapter implements PlatformAdapter {
  readonly platform = 'webchat';
  private clients: Map<string, WebSocket>;     // channelId → WebSocket
  private messageHandler: ((msg: IncomingMessage) => void) | null;
  private pendingButtons: Map<string, { resolve: (label: string | null) => void }>;

  // PlatformAdapter required methods
  start(): Promise<void>;     // no-op — WS transport owned by dashboard server
  stop(): Promise<void>;      // no-op
  onMessage(handler: (msg: IncomingMessage) => void): void;  // stores handler for gateway

  // Called by dashboard WS handler when client sends chat.message
  handleClientMessage(channelId: string, data: ChatMessageData): void;

  // PlatformAdapter methods — send via WS to matching client
  sendText(channelId, text): Promise<string>;       // returns messageId
  sendImage(channelId, image, caption): Promise<void>;
  sendFile(channelId, file, filename): Promise<void>;
  sendVoice(channelId, audio): Promise<void>;
  editMessage(channelId, messageId, text): Promise<void>;  // streaming
  sendButtons(channelId, text, buttons, opts): Promise<string | null>;  // pending-promises pattern
  setTypingIndicator(channelId, active): Promise<void>;

  // Client lifecycle
  addClient(channelId: string, ws: WebSocket): void;
  removeClient(channelId: string): void;

  // Called by WS handler when client clicks a button
  handleButtonClick(messageId: string, buttonId: string): void;
}
```

**`sendButtons` resolution:** Uses a pending-promises map keyed on `messageId`. When `sendButtons` is called, it stores a `{ resolve }` entry and sends the buttons to the client. When `handleButtonClick` arrives via WS, it resolves the matching promise with the button label. Timeout handled via `AbortSignal` from the SDK.

**Identity mapping:**
- `channelId` = stable ID per chat session, default `'webchat-main'`. User can start a "new conversation" from the sidebar, which generates a new channelId (e.g., `'webchat-<timestamp>'`). This prevents session proliferation from tab refreshes — reconnecting to the same channelId resumes the same gateway session.
- `platformUserId` = `'dashboard'` (fixed — auto-mapped to admin user)
- `channelType` = `'dm'` always
- `isMention` = `true` always

### WebSocket Protocol

**Client → Server:**
```typescript
{ type: 'chat.message', text: string, attachments?: Array<{ data: string, mimeType: string, filename: string }> }
{ type: 'chat.button_click', messageId: string, buttonId: string }
```

**Server → Client:**
```typescript
{ type: 'chat.text', messageId: string, text: string }
{ type: 'chat.edit', messageId: string, text: string }
{ type: 'chat.image', data: string, filename?: string }       // base64
{ type: 'chat.file', data: string, filename: string }          // base64
{ type: 'chat.voice', data: string }                           // base64
{ type: 'chat.typing', active: boolean }
{ type: 'chat.buttons', messageId: string, text: string, buttons: Array<{ id: string, label: string }> }
```

Attachments use base64 encoding over WS. The adapter converts base64 → Buffer for the gateway's `Attachment` type, and Buffer → base64 for outbound media.

### Dashboard Server Integration

The existing WebSocket handler (`websocket.ts`) gains chat message routing:

1. Authenticated WS client sends `{ type: 'chat.message', ... }`
2. WS handler forwards to `webchatAdapter.handleClientMessage(wsId, data)`
3. Adapter constructs `IncomingMessage` and calls the gateway's message handler
4. Gateway pipeline executes (memory, agent, streaming)
5. Adapter's `sendText`/`editMessage`/etc. send responses back via the same WS connection

The existing event forwarding (`agent.progress`, `message.incoming`, `message.outgoing`) continues to work. The client filters `agent.progress` events by matching `sessionId` to the current chat session, so progress from Discord sessions doesn't appear in the webchat.

### Gateway Char Limit

Add `webchat: 100000` to `PLATFORM_CHAR_LIMITS` in `gateway.ts`. Webchat has no inherent character limit — responses should not be chunked.

### Bootstrap Wiring

**Ordering is important.** The WebChatAdapter must be registered with the gateway *before* `gateway.start()`, but the dashboard server is created after. The adapter is created early and passed to the dashboard server later:

```typescript
// 1. Create adapter early (before gateway.start)
let webchatAdapter: WebChatAdapter | undefined;
if (config.dashboard.enabled) {
  webchatAdapter = new WebChatAdapter();
  gateway.registerAdapter(webchatAdapter);

  // Auto-register admin user's webchat identity
  const adminUser = Object.values(config.users).find(u => u.role === 'admin');
  if (adminUser) {
    userManager.registerPlatformId('webchat', 'dashboard', adminUser.name);
  }
}

// 2. gateway.start() — calls adapter.start() on all registered adapters
await gateway.start();

// 3. Dashboard server created and started later
if (config.dashboard.enabled) {
  dashboardServer = new DashboardServer({ ... });
  if (webchatAdapter) {
    dashboardServer.setWebChatAdapter(webchatAdapter);
  }
  await dashboardServer.start();
}
```

The adapter's `start()`/`stop()` are no-ops since it doesn't own the WS transport.

The `UserManager` needs a new method `registerPlatformId(platform, id, userName)` to dynamically add platform IDs at runtime. This is an ephemeral, in-memory registration — re-registered on every startup from bootstrap code. No persistence needed.

### Client UI

**New route:** `/chat` added to the dashboard React app.

**Layout: Sidebar + Chat (Option A from mockups)**

```
┌──────────────┬────────────────────────────────────┐
│  Sessions    │  Chat with Po              sonnet  │
│              │                                    │
│ ● Current    │  [You] Can you check coverage?     │
│   Yesterday  │                                    │
│   Mar 19     │  [Po] 💭 Thinking...               │
│              │  [Po] 🔧 Using Bash...             │
│              │  [Po] Coverage is at 87%...         │
│              │                                    │
│              │  ┌──────────────────┐ 📎 🎤 [→]    │
│              │  │ Type a message   │              │
│              │  └──────────────────┘              │
└──────────────┴────────────────────────────────────┘
```

**Components:**
- `ChatPage` — main page layout with sidebar + chat area
- `ChatSidebar` — lists past webchat sessions from `GET /api/conversations?platform=webchat`
- `ChatInput` — text input + file upload (drag-and-drop + button) + voice recording (MediaRecorder API) + send button
- Message rendering reuses existing `ThinkingBlock`, `ToolUseBlock` components. The existing `ChatMessage` component is too basic (no markdown, no media) — it will be enhanced or replaced with a richer component that renders markdown (via `react-markdown`) and inline media.

**Real-time rendering:**
- User message appears immediately on send
- `chat.typing` shows typing indicator
- `chat.text` renders assistant message (with markdown)
- `chat.edit` updates the existing message (streaming)
- `agent.progress` events filtered by `sessionId` to match current chat session — only shows progress for this conversation, not Discord sessions
- `chat.buttons` renders interactive buttons for permission gates / AskUserQuestion
- `chat.image`/`chat.file`/`chat.voice` render media inline

**Session history:**
- Past messages loaded via `GET /api/conversations?platform=webchat&user=<adminUser>`
- Grouped by sessionId for sidebar display
- New messages rendered in real-time via WS

**File uploads:**
- Drag-and-drop or click file input
- Images/files converted to base64 on client
- Sent as `chat.message.attachments` array
- Voice: MediaRecorder API → check `MediaRecorder.isTypeSupported('audio/webm')`, fall back to `audio/mp4` for Safari. Sent as base64 attachment.
- Base64 encoding doubles payload size. Acceptable for typical attachments (<10MB per `media.max_file_size_mb` config). Not a concern for v1.

## Files to Create or Modify

### Dashboard (`packages/dashboard`)
- `src/server/webchat-adapter.ts` — WebChatAdapter class implementing PlatformAdapter
- `src/server/websocket.ts` — add chat message routing + button click handling to WS handler
- `src/server/index.ts` — add `setWebChatAdapter()` method to DashboardServer
- `client/src/pages/ChatPage.tsx` — main chat page with sidebar + chat area
- `client/src/components/ChatSidebar.tsx` — session list sidebar
- `client/src/components/ChatInput.tsx` — message input with file upload, voice recording, send button
- `client/src/components/ChatMessage.tsx` — enhance with markdown rendering and inline media
- `client/src/hooks/useWebSocket.ts` — expose `send()` method for sending chat messages
- `client/src/App.tsx` — add `/chat` route
- `package.json` — add `react-markdown` dependency

### Gateway (`packages/gateway`)
- `src/gateway.ts` — add `webchat: 100000` to `PLATFORM_CHAR_LIMITS`

### Core (`packages/core`)
- `src/users/user-manager.ts` — add `registerPlatformId()` method

### Main (`packages/main`)
- `src/bootstrap.ts` — create WebChatAdapter, register with gateway before start, pass to dashboard server, auto-map admin user

## Testing

- Unit tests for WebChatAdapter:
  - `start()` and `stop()` are no-ops (no errors)
  - `onMessage` stores handler, `handleClientMessage` invokes it with correct IncomingMessage
  - `sendText` sends via WS with messageId
  - `editMessage` sends edit event via WS
  - `sendButtons` sends buttons, resolves on `handleButtonClick`, returns null on timeout
  - `setTypingIndicator` sends typing event
  - Base64 ↔ Buffer conversion for attachments
  - Client add/remove lifecycle
- Unit tests for UserManager.registerPlatformId:
  - Adds platform ID at runtime
  - findByPlatformId works for dynamically registered IDs
- Unit tests for WS chat message routing:
  - Authenticated client can send chat.message
  - Unauthenticated client cannot
  - Chat messages forwarded to adapter
  - Button clicks forwarded to adapter
- Integration: full message flow from WS → adapter → gateway → WS response
- Client: ChatInput handles text, file upload, voice recording
- Client: agent.progress events filtered by sessionId
