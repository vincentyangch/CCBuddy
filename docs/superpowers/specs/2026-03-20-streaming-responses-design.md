# Streaming Responses Design

**Date:** 2026-03-20
**Status:** Implemented

## Overview

Instead of waiting for the entire agent response to complete before sending a Discord message, Po sends a message immediately on the first text chunk, then edits it every ~1 second as more text arrives. The user sees Po's response building progressively, making Po feel much faster on long responses.

## How It Works

The SdkBackend already yields `text` events from the SDK stream. Currently, the gateway ignores these during `executeAndRoute()` and waits for the `complete` event. The change is entirely in the gateway's response handling:

1. **First `text` event** → send a new Discord message with the text, save the message ID
2. **Subsequent `text` events** → accumulate in a buffer
3. **Every ~1 second** → if buffer has new text since last edit, edit the message with accumulated content
4. **`complete` event** → stop the timer, do one final edit with the full response, store in SQLite as before, deliver outbound media

The 1-second interval is hardcoded — not worth making configurable for a cosmetic feature.

## Components

### PlatformAdapter Changes (`packages/core/src/types/platform.ts`)

Add optional method:

```typescript
interface PlatformAdapter {
  // ... existing methods ...
  /** Edit a previously sent message. Returns the message ID. */
  editMessage?(channelId: string, messageId: string, text: string): Promise<void>;
}
```

### DiscordAdapter Changes (`packages/platforms/discord/src/discord-adapter.ts`)

Implement `editMessage`:

```typescript
async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
  const channel = await this.fetchTextChannel(channelId);
  if (!channel) return;
  const message = await channel.messages.fetch(messageId);
  await message.edit(text);
}
```

Also update `sendText` to return the message ID so the gateway can track it:

```typescript
async sendText(channelId: string, text: string): Promise<string | undefined> {
  const channel = await this.fetchTextChannel(channelId);
  if (!channel) return undefined;
  const msg = await channel.send(text);
  return msg.id;
}
```

Update `PlatformAdapter.sendText` signature to return `Promise<string | void>` (backwards compatible — existing adapters return void).

### Gateway Changes (`packages/gateway/src/gateway.ts`)

In `executeAndRoute()`, add streaming state management. The current flow:

```
for await (event of agent) {
  switch(event.type) {
    case 'complete': // send full response
    case 'media': // send media
    case 'error': // send error
  }
}
```

Becomes:

```
let streamBuffer = '';
let streamMessageId: string | undefined;
let lastEditTime = 0;
let streamInterval: ReturnType<typeof setInterval> | undefined;
const STREAM_INTERVAL_MS = 1000;
const CHAR_LIMIT = PLATFORM_CHAR_LIMITS[msg.platform] ?? DEFAULT_CHAR_LIMIT;

// Helper to edit or send the streaming message
const flushStream = async () => {
  if (!streamBuffer || !adapter.editMessage) return;
  if (streamMessageId) {
    if (streamBuffer.length <= CHAR_LIMIT - 100) {
      await adapter.editMessage(msg.channelId, streamMessageId, streamBuffer);
    }
    // If approaching limit, stop editing — overflow handled on complete
  } else {
    // First chunk — send initial message
    streamMessageId = await adapter.sendText(msg.channelId, streamBuffer) as string;
  }
  lastEditTime = Date.now();
};

for await (event of agent) {
  switch(event.type) {
    case 'text':
      streamBuffer += event.content;
      if (!streamInterval && adapter.editMessage) {
        streamInterval = setInterval(flushStream, STREAM_INTERVAL_MS);
        await flushStream(); // Send first chunk immediately
      }
      break;
    case 'complete':
      clearInterval(streamInterval);
      // Final response — use this as the authoritative text
      // (may differ from accumulated stream buffer)
      // ... existing complete handling, but skip sendText if already streaming
      break;
    // ... existing media, error handling
  }
}
```

Key behaviors:
- **Streaming only activates when adapter supports `editMessage`** — otherwise falls back to current behavior (wait for complete)
- **Voice mirror mode bypasses streaming** — needs full text for TTS, so streaming is disabled when `voiceInput` is true
- **The `complete` event's response is authoritative** — the final edit uses `event.response`, not the accumulated buffer, to ensure consistency
- **If the streaming message exceeds the char limit** — stop editing it, and on `complete`, send overflow as additional messages using the existing chunking logic
- **Error mid-stream** — clear interval, send error message as usual

### What Doesn't Change

- **SdkBackend** — already yields `text` events
- **AgentService** — already forwards `text` to event bus
- **Memory storage** — still stores the `complete` event's response, not stream fragments
- **Agent event storage** — `text` events already stored by the event bus subscription
- **Conversation continuity, session management** — unaffected
- **Telegram adapter** — `editMessage` not implemented initially; falls back to wait-for-complete

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Short response (<100 chars) | First `text` event sends message, `complete` does final edit. Minimal streaming visible. |
| Response exceeds 2000 chars | Stop editing at ~1900 chars. On `complete`, send overflow as additional chunked messages. |
| Agent errors mid-stream | Clear interval, send error message. Partial streaming message remains visible. |
| Adapter doesn't support editMessage | Falls back to current behavior — wait for `complete`, send full response. |
| Voice mirror mode | Streaming disabled — wait for full text to synthesize speech. |
| Multiple `text` events within 1 second | Accumulated in buffer, sent as single edit on next interval tick. |
| No `text` events before `complete` | No streaming — `complete` sends the response as before. |

## Testing Strategy

- **Unit test:** DiscordAdapter `editMessage` — verify message.edit called
- **Unit test:** Gateway streaming — mock adapter with `editMessage`, verify:
  - First `text` event triggers `sendText`
  - Subsequent edits happen via `editMessage`
  - `complete` event does final edit and stores message
  - Error clears interval
  - No streaming when `editMessage` not available
