# Session History Persistence

**Date:** 2026-03-21
**Status:** Approved

## Problem

SessionStore is purely in-memory. When the process restarts or sessions expire, all session key → SDK UUID mappings are lost. The dashboard can only show currently active sessions, and there's no way to browse or understand past conversations at the session level.

## Goals

1. Sessions survive process restarts — active/paused sessions resume seamlessly
2. Archived sessions visible in the dashboard for historical browsing
3. Users can explicitly pause sessions for later resumption (hours/days)
4. Model selection persists in DB instead of filesystem `.model` files

## Non-Goals

- Auto-resume archived sessions (expired = done, new messages start fresh)
- Retention policies (keep sessions indefinitely, manual delete from dashboard)
- Schema changes to existing `messages` or `agent_events` tables

## Session Status Lifecycle

```
active ──(idle timeout)──► archived
active ──(user says "pause")──► paused ──(user returns)──► active ──► archived
active ──(manual delete)──► deleted
paused ──(manual delete)──► deleted
archived ──(manual delete)──► deleted
```

- **active**: In-memory + DB. Normal expiry tick applies.
- **paused**: In-memory + DB. Exempt from normal expiry tick. User explicitly told Po to hold the session. Safety net: paused sessions auto-archive after 7 days (`max_pause_ms`, configurable).
- **archived**: DB only, removed from memory. Read-only in dashboard.

## Data Model

New table in `MemoryDatabase`:

```sql
CREATE TABLE sessions (
  session_key TEXT PRIMARY KEY,
  sdk_session_id TEXT NOT NULL,
  user_id TEXT,
  platform TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  is_group_channel BOOLEAN NOT NULL DEFAULT 0,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'archived')),
  created_at INTEGER NOT NULL,
  last_activity INTEGER NOT NULL
);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_last_activity ON sessions(last_activity);
CREATE INDEX idx_sessions_user ON sessions(user_id);
```

`user_id` is nullable — set for DM sessions (known user), null for group channel sessions.

## Component Changes

### 0. SessionPersistence interface (new — `@ccbuddy/core`)

**File:** `packages/core/src/types/session.ts`

To avoid `@ccbuddy/agent` depending on `@ccbuddy/memory`, define a persistence interface in `@ccbuddy/core`. Bootstrap injects the concrete `SessionDatabase` at wiring time — same pattern as `storeMessage`/`assembleContext` closures in gateway.

```typescript
interface SessionPersistence {
  upsert(row: SessionRow): void;
  getByKey(sessionKey: string): SessionRow | null;
  getAll(filters?: SessionQueryFilters): SessionRow[];
  updateStatus(sessionKey: string, status: string): void;
  updateLastActivity(sessionKey: string, timestamp: number): void;
  updateModel(sessionKey: string, model: string | null): void;
  delete(sessionKey: string): void;
}
```

### 1. SessionDatabase (new — `@ccbuddy/memory`)

**File:** `packages/memory/src/session-database.ts`

Implements `SessionPersistence` — thin SQLite CRUD layer over the `sessions` table:

```typescript
interface SessionRow {
  session_key: string;
  sdk_session_id: string;
  user_id: string | null;
  platform: string;
  channel_id: string;
  is_group_channel: boolean;
  model: string | null;
  status: 'active' | 'paused' | 'archived';
  created_at: number;
  last_activity: number;
}

interface SessionQueryFilters {
  status?: 'active' | 'paused' | 'archived';
  platform?: string;
}

class SessionDatabase {
  constructor(db: BetterSqlite3.Database)

  upsert(row: SessionRow): void
  getByKey(sessionKey: string): SessionRow | null
  getAll(filters?: SessionQueryFilters): SessionRow[]
  updateStatus(sessionKey: string, status: string): void
  updateLastActivity(sessionKey: string, timestamp: number): void
  updateModel(sessionKey: string, model: string | null): void
  delete(sessionKey: string): void
}
```

Table creation registered in `MemoryDatabase.initialize()`.

### 2. SessionStore changes (`@ccbuddy/agent`)

**File:** `packages/agent/src/session/session-store.ts`

Constructor gains optional `SessionPersistence` dependency (backward compatible for tests):

```typescript
constructor(timeoutMs: number, onExpiry?: (key: string) => void, persistence?: SessionPersistence)
```

**Method changes:**

- `getOrCreate(sessionKey, isGroupChannel, platform?, channelId?, userId?)`:
  - Check memory map → check DB (restore to memory if found and active/paused) → create new
  - On create: upsert to DB with status `active`
  - On restore from DB: add to memory map, return `isNew: false`. If restoring a paused session, set status back to `active`.
  - New params `platform`, `channelId`, `userId` needed for DB row (gateway already has these)

- `touch(sessionKey)`: Update memory map + `sessionDb.updateLastActivity()`

- `tick()`: For each expired entry in memory:
  - If status is `paused`, skip (exempt from expiry)
  - Otherwise, call `onExpiry` callback, set status `archived` in DB, remove from memory

- `setModel(sessionKey, model)`: Update memory + `sessionDb.updateModel()`

- `archive(sessionKey)`: Set status `archived` in DB, remove from memory. Replaces the old `remove()` method — callers updated (e.g., gateway retry-on-resume-failure).

- **New methods:**
  - `pause(sessionKey)`: Set status to `paused` in memory + DB
  - `unpause(sessionKey)`: Set status back to `active` in memory + DB, touch
  - `getHistory(filters?)`: Delegates to `persistence.getAll(filters)` — returns all sessions including archived. Dashboard API uses this as the single source for all session queries.
  - `deleteSession(sessionKey)`: Hard-delete from DB + remove from memory

- **Startup hydration:** New `hydrate()` method loads all `active` and `paused` rows from DB into the memory map. Called once during bootstrap.

### 3. `pause_session` MCP tool (`@ccbuddy/skills`)

Added to the skill MCP server alongside existing tools:

```typescript
{
  name: 'pause_session',
  description: 'Pause the current session so it can be resumed later, even after hours or days. Use when the user says they are stepping away and want to continue later.',
  inputSchema: {
    type: 'object',
    properties: {},  // no input needed — session key comes from --session-key arg
  }
}
```

**Process boundary:** The MCP server runs as a subprocess and cannot call `sessionStore.pause()` directly. Instead, `pause_session` writes the status change directly to the `sessions` SQLite table (the MCP server already opens a writable DB connection for `profileStore`). The in-process `SessionStore` picks up the change on the next `tick()` cycle or `getOrCreate()` call — both read from DB when the in-memory entry doesn't match expectations.

**Unpausing:** When the user returns and sends a message, `getOrCreate()` finds the paused session in DB, restores it to memory as active, and resumes the SDK session. No explicit unpause tool needed — sending a message is the unpause action.

### 4. Model file migration

Remove the `data/sessions/*.model` file-based model persistence:

- **Delete:** `packages/core/src/config/model-file.ts` (readModelFile, writeModelFile, deleteModelFile)
- **Gateway:** Read model from `sessionStore.getModel(sessionKey)` instead of `readModelFile()`
- **MCP `switch_model` tool:** Write model directly to the `sessions` table via SQLite (same DB connection as profile/pause tools). The in-process `SessionStore` picks up the change on next `getModel()` call by checking DB.
- **MCP `get_current_model` tool:** Read from `sessions` table instead of `.model` file.
- **Bootstrap:** Remove model file cleanup from `onExpiry` callback (DB handles it)

### 5. Gateway changes (`@ccbuddy/gateway`)

**File:** `packages/gateway/src/gateway.ts`

Minimal changes:

- Pass `platform` and `channelId` to `sessionStore.getOrCreate()` (already available on the message)
- Read model from `sessionStore.getModel()` instead of `readModelFile()`
- When restoring a paused session: `getOrCreate()` returns `isNew: false`, gateway resumes as normal and session auto-unpauses

### 6. Dashboard API changes (`@ccbuddy/dashboard`)

**File:** `packages/dashboard/src/server/index.ts`

- `GET /api/sessions` — Accepts optional `?status=active|paused|archived` query param. Default: returns all sessions from `sessionStore.getHistory()` (single DB query), sorted by last_activity desc.

- `DELETE /api/sessions/:key` — Hard-deletes session from DB and memory via `sessionStore.deleteSession(key)`

### 7. Dashboard UI changes (`@ccbuddy/dashboard`)

**Sessions page:**

- Status badges: green dot = active, yellow dot = paused, gray dot = archived
- Filter toggle: All | Active | Paused | Archived (default: All)
- Archived sessions link to event replay (read-only, same as active)
- Delete button on each session row (with confirmation)

### 8. Bootstrap wiring (`@ccbuddy/main`)

**File:** `packages/main/src/bootstrap.ts`

```typescript
// Create SessionDatabase (implements SessionPersistence) from existing MemoryDatabase
const sessionDb = new SessionDatabase(memoryDb.getDatabase());

// Pass as SessionPersistence interface — @ccbuddy/agent never imports @ccbuddy/memory
const sessionStore = new SessionStore(
  config.agent.session_timeout_ms,
  config.agent.max_pause_ms,  // 7 days default
  sessionDb  // satisfies SessionPersistence
);

// Hydrate active/paused sessions from DB on startup (before tick interval starts)
sessionStore.hydrate();
```

## What Stays the Same

- Session key computation logic in gateway (platform-channelId or user-platform-channelId)
- SDK backend resume logic (`resume: uuid` for existing, `sessionId: uuid` for new)
- Message and agent event storage (already keyed by session_id)
- Gateway message handling flow (still calls getOrCreate, touch, etc.)
- SessionManager in AgentService (concurrency tracking, separate concern)
- Memory consolidation and backup (session-unaware, operates on messages)

## Testing

- **SessionDatabase:** CRUD operations, filters, upsert idempotency
- **SessionStore with persistence:** hydrate on startup, pause/unpause lifecycle, tick skips paused, archive on expiry, model stored in DB
- **Gateway integration:** session restored from DB after simulated restart, paused session resumes
- **MCP pause_session tool:** session status changes to paused
- **Dashboard API:** filter params, delete, merged active+archived list

## Migration

On first run after deploy, `MemoryDatabase.initialize()` creates the `sessions` table. Existing in-flight sessions won't be in the DB — they'll create new SDK sessions on next message, which is acceptable (same as current restart behavior). Model files in `data/sessions/` can be cleaned up manually or left to be ignored.
