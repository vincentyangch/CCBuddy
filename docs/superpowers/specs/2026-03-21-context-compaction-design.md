# Context Compaction

**Date:** 2026-03-21
**Status:** Approved

## Problem

The Claude SDK accumulates all conversation turns internally when resuming sessions. There's no built-in compaction — when context exceeds the model's limit, the SDK throws an error and the conversation dies with no recovery. Long coding sessions (50+ turns of back-and-forth debugging, refactoring, etc.) reliably hit this limit.

## Goals

1. Proactive compaction — detect when a session is getting long and compact before hitting the limit
2. Reactive fallback — catch context overflow errors, compact, and retry transparently
3. Brief user notification when compaction occurs
4. Seamless conversation continuity — the user doesn't need to do anything

## Non-Goals

- Token-level estimation of SDK internal context (we can't see it)
- Compacting within the SDK session (impossible — SDK manages its own context)
- User-triggered compaction commands (may add later)
- Changing the nightly ConsolidationService (separate concern)

## How Compaction Works

Compaction replaces a long SDK session with a fresh one. The old conversation is summarized, and the summary becomes the memory context for the new session.

```
Session A (50 turns, approaching limit)
  ↓ compact
Summarize turns 1-50 → summary text
Archive session A
Create session B (fresh)
  ↓ next message
Session B starts with summary as <memory_context>
User sees: "(conversation compacted — continuing)"
```

## Triggers

### Proactive (after each successful response)

A per-session **turn counter** tracks completed agent responses. When it crosses `compaction_threshold` (configurable, default 50 turns), compaction triggers before the next user message.

Why turn count, not tokens? The SDK manages its own internal context — we can't see its token count. Turn count is a reliable proxy we control. 50 turns is conservative; most context overflows happen around 80-120 turns depending on turn length.

### Reactive (on SDK error)

When `executeAndRoute` catches an error from the SDK, check if the error message indicates a context overflow (e.g., contains "context length", "too many tokens", "prompt is too long", or similar). If so:

1. Compact the session (summarize + create new)
2. Retry the user's prompt with the fresh session
3. Notify user

If the retry also fails, fall back to the normal error message.

## Component Changes

### SessionStore — turn counter

**File:** `packages/agent/src/session/session-store.ts`

Add `turns: number` to `SessionEntry`. New methods:

```typescript
incrementTurns(sessionKey: string): number  // returns new count
getTurns(sessionKey: string): number
```

The turn counter persists to the `sessions` DB table (add `turns INTEGER NOT NULL DEFAULT 0` column). On compaction (session archived + new created), the new session starts at 0.

### Gateway — compaction orchestration

**File:** `packages/gateway/src/gateway.ts`

Add a `compactSession` dependency to `GatewayDeps`:

```typescript
compactSession?: (params: {
  sessionKey: string;
  userId: string;
  sessionId: string;   // memory session ID (for message lookup)
  platform: string;
  channelId: string;
}) => Promise<{ newSdkSessionId: string; summary: string }>;
```

**Proactive trigger** — in `executeAndRoute`, after the `complete` event is processed and `sessionStore.touch()` is called:

```typescript
if (sessionKey && this.deps.sessionStore && this.deps.compactSession) {
  const turns = this.deps.sessionStore.incrementTurns(sessionKey);
  if (turns >= this.deps.compactionThreshold) {
    const result = await this.deps.compactSession({ ... });
    await adapter.sendText(msg.channelId, '*(conversation compacted — continuing)*');
  }
}
```

**Reactive trigger** — in the catch block of `executeAndRoute`, before the existing resume-retry logic:

```typescript
if (isContextOverflowError(err) && sessionKey && this.deps.compactSession) {
  const result = await this.deps.compactSession({ ... });
  // Retry with fresh session
  const retryRequest = { ...request, resumeSessionId: undefined, sdkSessionId: result.newSdkSessionId, memoryContext: result.summary };
  await this.executeAndRoute(retryRequest, msg, voiceInput, sessionKey);
  await adapter.sendText(msg.channelId, '*(conversation compacted — continuing)*');
  return;
}
```

**Error detection helper:**

```typescript
function isContextOverflowError(err: unknown): boolean {
  const msg = (err as Error)?.message?.toLowerCase() ?? '';
  return msg.includes('context length') || msg.includes('too many tokens') || msg.includes('prompt is too long') || msg.includes('maximum context');
}
```

### Bootstrap — compactSession closure

**File:** `packages/main/src/bootstrap.ts`

Wire the `compactSession` closure using existing infrastructure:

```typescript
compactSession: async ({ sessionKey, userId, sessionId, platform, channelId }) => {
  // 1. Fetch recent messages for this session
  const messages = messageStore.getBySessionId(sessionId);
  const conversationText = messages
    .map(m => `[${m.role}] ${m.content}`)
    .join('\n\n');

  // 2. Summarize using existing summarize function
  const summary = await summarize(
    `Summarize this conversation, preserving key decisions, code changes, current task state, and any important context:\n\n${conversationText}`
  );

  // 3. Archive old session, create new one
  sessionStore.archive(sessionKey);
  const newSession = sessionStore.getOrCreate(
    sessionKey, false, platform, channelId, userId,
  );

  return { newSdkSessionId: newSession.sdkSessionId, summary };
},
compactionThreshold: config.agent.compaction_threshold,
```

The `summarize` function already exists in bootstrap (used by ConsolidationService) — it sends a summarization prompt through the agent and returns the result.

### Config

**File:** `packages/core/src/config/schema.ts`

Add to `AgentConfig`:

```typescript
  compaction_threshold: number;       // turns before proactive compaction
  compaction_summary_tokens: number;  // target summary length hint
```

Defaults:

```typescript
  compaction_threshold: 50,
  compaction_summary_tokens: 4000,
```

### Database migration

Add `turns` column to the `sessions` table. In `MemoryDatabase.init()`, add a migration:

```typescript
const sessionCols = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
if (!sessionCols.some(c => c.name === 'turns')) {
  this.db.exec('ALTER TABLE sessions ADD COLUMN turns INTEGER NOT NULL DEFAULT 0');
}
```

Update `SessionDatabase` to handle the `turns` field in upsert/getByKey.

## What Stays the Same

- ConsolidationService — nightly batch job, separate concern
- ContextAssembler — assembles context for new sessions (compaction creates new sessions, so assembler works naturally)
- SDK backend — unchanged, just gets new session UUIDs transparently
- Session pause/resume — unaffected (turn counter resets on compaction, not on pause)
- Message storage — messages continue to be stored per session ID (memory session ID doesn't change)

## User Experience

1. User is having a long conversation with Po (50+ turns)
2. After Po's 50th response, compaction triggers automatically
3. Po sends: "*(conversation compacted — continuing)*"
4. User sends next message — Po responds normally, with context from the summary
5. If compaction somehow fails, the conversation continues as-is until the SDK hits its limit
6. If the SDK hits its limit, reactive compaction catches the error and retries

## Testing

- **SessionStore:** incrementTurns/getTurns, counter persists to DB, resets on new session
- **Gateway proactive:** turn counter triggers compaction at threshold, notification sent
- **Gateway reactive:** context overflow error caught, compaction + retry, notification sent
- **isContextOverflowError:** matches known error patterns, doesn't false-positive
- **compactSession closure:** messages fetched, summarized, old session archived, new created
- **Integration:** 50-turn conversation triggers compaction seamlessly
