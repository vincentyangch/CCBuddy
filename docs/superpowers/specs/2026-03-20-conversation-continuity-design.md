# Conversation Continuity Design

**Date:** 2026-03-20
**Status:** Approved

## Overview

Enable Po to maintain multi-turn conversations by resuming Claude Code SDK sessions. Within a channel, consecutive messages reuse the same SDK session so Po has full conversation history. After a configurable idle timeout (default: 1 hour), a fresh session starts.

Currently, every incoming message spawns a fresh `query()` call with no conversation history — only a prepended `<memory_context>` text block assembled from SQLite. With this change, Po will pass `resume: sdkSessionId` to `query()`, giving Claude the full prior conversation transcript.

## Session Lifecycle

1. **Message arrives** → gateway computes `sessionKey` via `buildSessionId()`
2. **Lookup** → check `SessionStore` for an active SDK session UUID mapped to this sessionKey
3. **No active session** → call `query({ prompt, options: { sessionId: newUUID } })`. Inject `<memory_context>` (profile + summaries). Store the `sessionKey → sdkSessionId` mapping.
4. **Active session found** → call `query({ prompt, options: { resume: storedUUID } })`. Skip memory context (the SDK session already has conversation history).
5. **Idle timeout (default 1 hour)** → `SessionStore.tick()` expires the mapping. Next message creates a fresh session.
6. **Resume failure** → if `resume` throws (e.g., SDK session expired server-side), catch the error and fall back to creating a new session with memory context.

## Session Key Strategy

Session keys determine which messages share a conversation:

- **DMs:** per-user — `userId-platform-dm`. Each user gets their own session.
- **Group channels:** shared — `channel-platform-channelId`. All users share one session, so Po can reference cross-talk.

This uses the existing `buildSessionId()` function. The hybrid DM-vs-group behavior is determined by the `isDirectMessage` flag already present on incoming messages.

## Components

### SessionStore (new — `packages/agent/src/session/session-store.ts`)

In-memory store mapping CCBuddy session keys to SDK session UUIDs.

```typescript
interface SessionEntry {
  sdkSessionId: string;   // UUID returned by/passed to the SDK
  lastActivity: number;   // Date.now() of last message
  isGroupChannel: boolean;
}

class SessionStore {
  private entries: Map<string, SessionEntry>;
  private timeoutMs: number;

  constructor(timeoutMs: number);

  /** Get existing session or create a new one. Returns { sdkSessionId, isNew }. */
  getOrCreate(sessionKey: string, isGroupChannel: boolean): { sdkSessionId: string; isNew: boolean };

  /** Update lastActivity timestamp. */
  touch(sessionKey: string): void;

  /** Remove a session (e.g., on resume failure). */
  remove(sessionKey: string): void;

  /** Expire sessions older than timeoutMs. Called periodically. */
  tick(): void;
}
```

**Design decisions:**
- **In-memory only.** If Po restarts, session mappings are lost. Next message creates a fresh session seeded with memory context — graceful degradation with no data loss.
- **No persistence needed.** SDK sessions are stored on disk by Claude Code itself. We only need to remember the UUID mapping while the process is alive.
- **`tick()` driven by the existing scheduler heartbeat** (runs every minute), keeping SessionStore passive.

### AgentRequest Changes (`packages/core/src/types/agent.ts`)

Add one optional field:

```typescript
interface AgentRequest {
  // ... existing fields ...
  resumeSessionId?: string;  // SDK session UUID to resume (omit for new sessions)
}
```

### AgentEvent Changes (`packages/core/src/types/agent.ts`)

Add SDK session UUID to the `complete` event so the gateway can store the mapping:

```typescript
interface AgentCompleteEvent extends AgentEventBase {
  type: 'complete';
  response: string;
  sdkSessionId?: string;  // The SDK session UUID used for this query
}
```

### SdkBackend Changes (`packages/agent/src/backends/sdk-backend.ts`)

```typescript
// In execute():
if (request.resumeSessionId) {
  // Resume existing session — skip memory context
  options.resume = request.resumeSessionId;
} else {
  // New session — generate UUID, inject memory context
  options.sessionId = crypto.randomUUID();
}

// ... existing query() call ...

// On complete event, include the sdkSessionId:
yield { ...base, type: 'complete', response: responseText, sdkSessionId: options.resume ?? options.sessionId };
```

### Gateway Changes (`packages/gateway/src/gateway.ts`)

In `executeAndRoute()`, before building the `AgentRequest`:

```typescript
const isGroupChannel = !msg.isDirectMessage;
const { sdkSessionId, isNew } = sessionStore.getOrCreate(sessionKey, isGroupChannel);

const request: AgentRequest = {
  // ... existing fields ...
  memoryContext: isNew ? assembledContext : undefined,  // Only on new sessions
  resumeSessionId: isNew ? undefined : sdkSessionId,   // Only on resume
};
```

After successful agent response:

```typescript
sessionStore.touch(sessionKey);
// If this was a new session, the sdkSessionId is already stored by getOrCreate()
```

On agent error during resume (session expired):

```typescript
sessionStore.remove(sessionKey);
// Retry as new session with memory context
```

### Config Addition (`packages/core/src/config/schema.ts` + `config/default.yaml`)

```yaml
agent:
  session_timeout_ms: 3600000  # 1 hour, configurable
```

Added to the config schema with a default of `3600000`.

### Bootstrap Wiring (`packages/main/src/bootstrap.ts`)

- Create `SessionStore` with `config.agent.session_timeout_ms`
- Pass it to the gateway
- Register `sessionStore.tick()` on the heartbeat interval (already runs every 60s)

## What Doesn't Change

- **Memory storage:** Messages are still saved to SQLite for long-term recall and consolidation.
- **CLI backend:** No session resumption — it remains the stateless fallback.
- **Scheduler/system requests:** Always one-shot with memory context. No continuity needed for briefings, heartbeats, etc.
- **Event bus architecture:** No new event types.
- **Activation mode logic:** Unchanged.
- **Memory consolidation:** Continues operating on SQLite message history as before.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Po restarts mid-session | Session store lost (in-memory). Next message creates fresh session with memory context. Graceful. |
| SDK session expired server-side | `resume` fails → catch error → `sessionStore.remove()` → retry as new session. |
| Very long sessions | SDK handles its own context window. 1-hour timeout naturally bounds most sessions. |
| User switches channels | Different sessionKey → different (or new) SDK session. Independent. |
| Multiple rapid messages | Same sessionKey → same sdkSessionId. `DirectoryLock` already serializes concurrent requests to the same working directory. |
| System/scheduler requests | No `resumeSessionId` set → always one-shot. SessionStore not consulted. |

## Testing Strategy

- **Unit tests:** SessionStore (getOrCreate, touch, tick expiration, remove)
- **Unit tests:** SdkBackend with `resumeSessionId` (mock `query()`)
- **Unit tests:** Gateway session lookup + memory context conditional logic
- **Integration test:** Two sequential messages in the same channel produce `resume` on the second call
- **Integration test:** Message after timeout creates a new session with memory context
- **Integration test:** Resume failure triggers fallback to new session
