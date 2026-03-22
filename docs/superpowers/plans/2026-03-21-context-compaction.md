# Context Compaction Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically compact long SDK sessions by summarizing the conversation and starting a fresh session, preventing context overflow errors.

**Architecture:** Add a turn counter to SessionStore. Gateway checks the counter after each response — when it exceeds a threshold, it calls a `compactSession` closure (wired in bootstrap) that summarizes messages, archives the old session, and creates a fresh one. A reactive fallback catches context overflow errors and does the same thing.

**Tech Stack:** TypeScript, better-sqlite3, Vitest

**Spec:** `docs/superpowers/specs/2026-03-21-context-compaction-design.md`

---

## Chunk 1: Config + SessionStore Turn Counter

### Task 1: Add compaction config

**Files:**
- Modify: `packages/core/src/config/schema.ts`

- [ ] **Step 1: Add compaction fields to AgentConfig**

In `packages/core/src/config/schema.ts`, add to the `AgentConfig` interface (after `trusted_allowed_tools`):

```typescript
  compaction_threshold: number;
  compaction_summary_tokens: number;
```

Add defaults in `DEFAULT_CONFIG.agent` (after `trusted_allowed_tools`):

```typescript
    compaction_threshold: 50,
    compaction_summary_tokens: 4000,
```

- [ ] **Step 2: Build and verify**

Run: `npm run build -w packages/core`

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/config/schema.ts
git commit -m "feat(core): add compaction_threshold and compaction_summary_tokens config"
```

---

### Task 2: Add turns column + turn counter to SessionStore

**Files:**
- Modify: `packages/memory/src/database.ts` (migration)
- Modify: `packages/memory/src/session-database.ts` (upsert, getByKey handle turns)
- Modify: `packages/agent/src/session/session-store.ts` (turn counter methods)
- Modify: `packages/agent/src/session/__tests__/session-store.test.ts`

- [ ] **Step 1: Add turns column migration**

In `packages/memory/src/database.ts`, add a migration after the existing ones (after the `condensed_at` migration block):

```typescript
    const sessionCols = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
    if (sessionCols.length > 0 && !sessionCols.some(c => c.name === 'turns')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN turns INTEGER NOT NULL DEFAULT 0');
    }
```

- [ ] **Step 2: Update SessionDatabase to handle turns**

In `packages/memory/src/session-database.ts`:

Update the upsert statement to include `turns`:
```sql
INSERT INTO sessions (session_key, sdk_session_id, user_id, platform, channel_id, is_group_channel, model, status, created_at, last_activity, turns)
VALUES (@session_key, @sdk_session_id, @user_id, @platform, @channel_id, @is_group_channel, @model, @status, @created_at, @last_activity, @turns)
ON CONFLICT(session_key) DO UPDATE SET
  sdk_session_id = @sdk_session_id,
  user_id = @user_id,
  model = @model,
  status = @status,
  last_activity = @last_activity,
  turns = @turns
```

Add a prepared statement for updating turns:
```typescript
updateTurns: this.db.prepare('UPDATE sessions SET turns = ? WHERE session_key = ?'),
```

Add method:
```typescript
updateTurns(sessionKey: string, turns: number): void {
  this.stmts.updateTurns.run(turns, sessionKey);
}
```

Update `upsert()` to include `turns`:
```typescript
turns: row.turns ?? 0,
```

Update `toSessionRow()` to include `turns`:
```typescript
turns: row.turns ?? 0,
```

Also update `SessionPersistence` interface in `packages/core/src/types/session.ts` to add:
```typescript
updateTurns(sessionKey: string, turns: number): void;
```

And add `turns: number` to `SessionRow`.

- [ ] **Step 3: Add turns to SessionEntry and SessionStore**

In `packages/agent/src/session/session-store.ts`:

Add `turns: number` to `SessionEntry` interface.
Add `turns: number` to `SessionInfo` interface.

Add methods:

```typescript
  incrementTurns(sessionKey: string): number {
    const entry = this.entries.get(sessionKey);
    if (!entry) return 0;
    entry.turns++;
    this.persistence?.updateTurns(sessionKey, entry.turns);
    return entry.turns;
  }

  getTurns(sessionKey: string): number {
    return this.entries.get(sessionKey)?.turns ?? 0;
  }
```

Update `getOrCreate` to initialize `turns: 0` for new entries.

Update `hydrate` to load `turns` from DB rows.

Update `getAll` to include `turns`.

- [ ] **Step 4: Write tests**

Add to `packages/agent/src/session/__tests__/session-store.test.ts`:

```typescript
  it('incrementTurns increments and returns new count', () => {
    const store = new SessionStore(60_000);
    store.getOrCreate('k1', false);
    expect(store.incrementTurns('k1')).toBe(1);
    expect(store.incrementTurns('k1')).toBe(2);
    expect(store.getTurns('k1')).toBe(2);
  });

  it('incrementTurns returns 0 for unknown session', () => {
    const store = new SessionStore(60_000);
    expect(store.incrementTurns('unknown')).toBe(0);
  });

  it('getTurns returns 0 for new session', () => {
    const store = new SessionStore(60_000);
    store.getOrCreate('k1', false);
    expect(store.getTurns('k1')).toBe(0);
  });

  it('incrementTurns persists to DB', () => {
    const db = new MockPersistence();
    const store = new SessionStore(60_000, { persistence: db });
    store.getOrCreate('k1', false, 'discord', 'ch1', 'dad');
    store.incrementTurns('k1');
    store.incrementTurns('k1');
    // MockPersistence doesn't have updateTurns — add it
  });
```

Note: `MockPersistence` in the test file needs an `updateTurns` method added.

- [ ] **Step 5: Build and test**

Run: `npm run build -w packages/core -w packages/memory -w packages/agent && npm test -w packages/agent -- --run`

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types/session.ts packages/core/src/config/schema.ts packages/memory/src/database.ts packages/memory/src/session-database.ts packages/agent/src/session/session-store.ts packages/agent/src/session/__tests__/session-store.test.ts
git commit -m "feat(agent): add turn counter to SessionStore for context compaction"
```

---

## Chunk 2: Gateway Compaction Logic

### Task 3: Add compaction to gateway

**Files:**
- Modify: `packages/gateway/src/gateway.ts`

- [ ] **Step 1: Add compaction deps to GatewayDeps**

In `packages/gateway/src/gateway.ts`, add to `GatewayDeps` (after `defaultWorkingDirectory`):

```typescript
  compactSession?: (params: {
    sessionKey: string;
    userId: string;
    sessionId: string;
    platform: string;
    channelId: string;
  }) => Promise<{ newSdkSessionId: string; summary: string }>;
  compactionThreshold?: number;
```

- [ ] **Step 2: Add isContextOverflowError helper**

Add as a module-level function (before the `Gateway` class):

```typescript
function isContextOverflowError(err: unknown): boolean {
  const msg = (err as Error)?.message?.toLowerCase() ?? '';
  return msg.includes('context length') ||
    msg.includes('too many tokens') ||
    msg.includes('prompt is too long') ||
    msg.includes('maximum context') ||
    msg.includes('context window');
}
```

- [ ] **Step 3: Add proactive compaction after successful response**

In `executeAndRoute`, after `sessionStore.touch(sessionKey)` (around line 527), add:

```typescript
      // Proactive compaction — check if session is getting long
      if (sessionKey && this.deps.sessionStore && this.deps.compactSession && this.deps.compactionThreshold) {
        const turns = this.deps.sessionStore.incrementTurns(sessionKey);
        if (turns >= this.deps.compactionThreshold) {
          try {
            console.log(`[Gateway] Proactive compaction triggered for ${sessionKey} at ${turns} turns`);
            await this.deps.compactSession({
              sessionKey,
              userId: request.userId,
              sessionId: request.sessionId,
              platform: msg.platform,
              channelId: msg.channelId,
            });
            await adapter.sendText(msg.channelId, '*(conversation compacted — continuing)*');
          } catch (compactErr) {
            console.error('[Gateway] Proactive compaction failed:', compactErr);
            // Non-fatal — conversation continues, will try again next turn or hit reactive
          }
        }
      }
```

- [ ] **Step 4: Add reactive compaction in the catch block**

In the catch block of `executeAndRoute` (around line 529), add BEFORE the existing resume-retry logic:

```typescript
      // Reactive compaction — catch context overflow errors
      if (isContextOverflowError(err) && sessionKey && this.deps.compactSession && this.deps.sessionStore) {
        console.warn(`[Gateway] Context overflow detected for ${sessionKey}, compacting`);
        try {
          const result = await this.deps.compactSession({
            sessionKey,
            userId: request.userId,
            sessionId: request.sessionId,
            platform: msg.platform,
            channelId: msg.channelId,
          });
          const retryRequest: AgentRequest = {
            ...request,
            resumeSessionId: undefined,
            sdkSessionId: result.newSdkSessionId,
            memoryContext: result.summary,
          };
          await this.executeAndRoute(retryRequest, msg, voiceInput, sessionKey);
          await adapter.sendText(msg.channelId, '*(conversation compacted — continuing)*');
          return;
        } catch (compactErr) {
          console.error('[Gateway] Reactive compaction failed:', compactErr);
          // Fall through to normal error handling
        }
      }
```

- [ ] **Step 5: Build and test**

Run: `npm run build -w packages/gateway && npm test -w packages/gateway -- --run`

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): add proactive and reactive context compaction"
```

---

## Chunk 3: Bootstrap Wiring

### Task 4: Wire compactSession in bootstrap

**Files:**
- Modify: `packages/main/src/bootstrap.ts`

- [ ] **Step 1: Add compactSession closure to gateway deps**

In the `new Gateway({...})` constructor call, add:

```typescript
    compactSession: async ({ sessionKey, userId, sessionId, platform, channelId }) => {
      // Fetch recent messages for this session
      const messages = messageStore.getFreshTail(userId, sessionId, 500);
      if (messages.length === 0) {
        throw new Error('No messages to compact');
      }
      const conversationText = messages
        .map(m => `[${m.role}] ${m.content}`)
        .join('\n\n');

      // Summarize using existing summarize function
      const summary = await summarize(
        `Summarize this conversation, preserving key decisions, code changes, current task state, and any important context the assistant needs to continue helping:\n\n${conversationText}`
      );

      // Archive old session, create new one
      sessionStore.archive(sessionKey);
      const newSession = sessionStore.getOrCreate(
        sessionKey, false, platform, channelId, userId,
      );

      console.log(`[Compaction] Session ${sessionKey} compacted: ${messages.length} messages → ${summary.length} char summary`);
      return { newSdkSessionId: newSession.sdkSessionId, summary };
    },
    compactionThreshold: config.agent.compaction_threshold,
```

Note: The `summarize` function is defined earlier in bootstrap (around line 150) and is already in scope. `messageStore.getFreshTail(userId, sessionId, 500)` fetches the last 500 messages for the session.

- [ ] **Step 2: Build and verify**

Run: `npm run build -w packages/main`

- [ ] **Step 3: Commit**

```bash
git add packages/main/src/bootstrap.ts
git commit -m "feat(main): wire compactSession closure into gateway for context compaction"
```

---

## Chunk 4: Integration

### Task 5: Run full test suite and fix issues

- [ ] **Step 1: Build all packages**

Run: `npm run build`

- [ ] **Step 2: Run full test suite**

Run: `npm test`

- [ ] **Step 3: Fix any failures**

Common issues:
- Scheduler test config mock may need `compaction_threshold` and `compaction_summary_tokens`
- Bootstrap test mock may need updates
- SessionDatabase tests may need `turns` field in test rows
- `SessionRow` type changes may ripple to test mocks

- [ ] **Step 4: Commit fixes**

```bash
git add -A
git commit -m "fix: resolve test failures from context compaction integration"
```

---

### Task 6: Verify end-to-end

- [ ] **Step 1: Restart CCBuddy**

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
```

- [ ] **Step 2: Verify turns column exists**

```bash
sqlite3 data/memory.sqlite "PRAGMA table_info(sessions)" | grep turns
```

- [ ] **Step 3: Test proactive compaction**

To test without sending 50 messages, temporarily set `compaction_threshold: 3` in `config/local.yaml`, restart, send 3 messages, and verify:
1. After the 3rd response, Po sends "*(conversation compacted — continuing)*"
2. The next message works normally (new SDK session with summary context)
3. Reset threshold to 50 when done

- [ ] **Step 4: Test reactive compaction**

Harder to trigger naturally. You could temporarily lower the model's context limit or send very long messages. The reactive path is a safety net — proactive should catch most cases.
