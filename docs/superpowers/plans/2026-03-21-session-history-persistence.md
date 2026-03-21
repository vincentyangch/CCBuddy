# Session History Persistence Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist session key → SDK UUID mappings to SQLite so sessions survive restarts, support explicit pause/resume, and show session history in the dashboard.

**Architecture:** Add a `sessions` table to the existing SQLite database. `SessionPersistence` interface in `@ccbuddy/core` decouples `@ccbuddy/agent` from `@ccbuddy/memory`. SessionStore stays as in-memory cache backed by DB. MCP subprocess writes directly to SQLite for pause/model operations (same pattern as ProfileStore).

**Tech Stack:** TypeScript, better-sqlite3, Vitest, React, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-03-21-session-history-persistence-design.md`

---

## Chunk 1: Core Types + SessionDatabase

### Task 1: SessionPersistence interface in `@ccbuddy/core`

**Files:**
- Create: `packages/core/src/types/session.ts`
- Modify: `packages/core/src/types/index.ts`

- [ ] **Step 1: Create the SessionPersistence interface**

```typescript
// packages/core/src/types/session.ts

export type SessionStatus = 'active' | 'paused' | 'archived';

export interface SessionRow {
  session_key: string;
  sdk_session_id: string;
  user_id: string | null;
  platform: string;
  channel_id: string;
  is_group_channel: boolean;
  model: string | null;
  status: SessionStatus;
  created_at: number;
  last_activity: number;
}

export interface SessionQueryFilters {
  status?: SessionStatus;
  platform?: string;
}

export interface SessionPersistence {
  upsert(row: SessionRow): void;
  getByKey(sessionKey: string): SessionRow | null;
  getAll(filters?: SessionQueryFilters): SessionRow[];
  updateStatus(sessionKey: string, status: SessionStatus): void;
  updateLastActivity(sessionKey: string, timestamp: number): void;
  updateModel(sessionKey: string, model: string | null): void;
  delete(sessionKey: string): void;
}
```

- [ ] **Step 2: Export from types index**

Add to `packages/core/src/types/index.ts`:

```typescript
export * from './session.js';
```

- [ ] **Step 3: Build and verify**

Run: `npm run build -w packages/core`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types/session.ts packages/core/src/types/index.ts
git commit -m "feat(core): add SessionPersistence interface and session types"
```

---

### Task 2: Add `max_pause_ms` to config schema

**Files:**
- Modify: `packages/core/src/config/schema.ts:16-36` (AgentConfig interface)
- Modify: `packages/core/src/config/schema.ts:~200` (DEFAULT_CONFIG)

- [ ] **Step 1: Add `max_pause_ms` to AgentConfig interface**

In `packages/core/src/config/schema.ts`, add after `user_input_timeout_ms` (line 34):

```typescript
  max_pause_ms: number;
```

- [ ] **Step 2: Add default value**

In `DEFAULT_CONFIG.agent`, add after `user_input_timeout_ms: 300_000`:

```typescript
    max_pause_ms: 604_800_000, // 7 days
```

- [ ] **Step 3: Build and verify**

Run: `npm run build -w packages/core`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/config/schema.ts
git commit -m "feat(core): add max_pause_ms config for paused session safety net"
```

---

### Task 3: SessionDatabase in `@ccbuddy/memory`

**Files:**
- Modify: `packages/memory/src/database.ts:14-62` (add sessions table)
- Create: `packages/memory/src/session-database.ts`
- Modify: `packages/memory/src/index.ts`
- Create: `packages/memory/src/__tests__/session-database.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/memory/src/__tests__/session-database.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDatabase } from '../database.js';
import { SessionDatabase } from '../session-database.js';
import type { SessionRow } from '@ccbuddy/core';

function makeRow(overrides?: Partial<SessionRow>): SessionRow {
  return {
    session_key: 'dad-discord-ch1',
    sdk_session_id: 'uuid-1234',
    user_id: 'dad',
    platform: 'discord',
    channel_id: 'ch1',
    is_group_channel: false,
    model: null,
    status: 'active',
    created_at: 1000,
    last_activity: 1000,
    ...overrides,
  };
}

describe('SessionDatabase', () => {
  let db: MemoryDatabase;
  let sessionDb: SessionDatabase;

  beforeEach(() => {
    db = new MemoryDatabase(':memory:');
    db.init();
    sessionDb = new SessionDatabase(db.raw());
  });

  it('upsert + getByKey round-trips a row', () => {
    const row = makeRow();
    sessionDb.upsert(row);
    const result = sessionDb.getByKey('dad-discord-ch1');
    expect(result).toEqual(row);
  });

  it('getByKey returns null for unknown key', () => {
    expect(sessionDb.getByKey('nonexistent')).toBeNull();
  });

  it('upsert overwrites existing row', () => {
    sessionDb.upsert(makeRow());
    sessionDb.upsert(makeRow({ model: 'opus', last_activity: 2000 }));
    const result = sessionDb.getByKey('dad-discord-ch1');
    expect(result!.model).toBe('opus');
    expect(result!.last_activity).toBe(2000);
  });

  it('getAll returns all rows sorted by last_activity desc', () => {
    sessionDb.upsert(makeRow({ session_key: 'a', last_activity: 100 }));
    sessionDb.upsert(makeRow({ session_key: 'b', last_activity: 300 }));
    sessionDb.upsert(makeRow({ session_key: 'c', last_activity: 200 }));
    const all = sessionDb.getAll();
    expect(all.map(r => r.session_key)).toEqual(['b', 'c', 'a']);
  });

  it('getAll filters by status', () => {
    sessionDb.upsert(makeRow({ session_key: 'a', status: 'active' }));
    sessionDb.upsert(makeRow({ session_key: 'b', status: 'archived' }));
    const active = sessionDb.getAll({ status: 'active' });
    expect(active).toHaveLength(1);
    expect(active[0].session_key).toBe('a');
  });

  it('getAll filters by platform', () => {
    sessionDb.upsert(makeRow({ session_key: 'a', platform: 'discord' }));
    sessionDb.upsert(makeRow({ session_key: 'b', platform: 'telegram' }));
    const discord = sessionDb.getAll({ platform: 'discord' });
    expect(discord).toHaveLength(1);
    expect(discord[0].session_key).toBe('a');
  });

  it('updateStatus changes status', () => {
    sessionDb.upsert(makeRow());
    sessionDb.updateStatus('dad-discord-ch1', 'paused');
    expect(sessionDb.getByKey('dad-discord-ch1')!.status).toBe('paused');
  });

  it('updateLastActivity changes timestamp', () => {
    sessionDb.upsert(makeRow());
    sessionDb.updateLastActivity('dad-discord-ch1', 9999);
    expect(sessionDb.getByKey('dad-discord-ch1')!.last_activity).toBe(9999);
  });

  it('updateModel changes model', () => {
    sessionDb.upsert(makeRow());
    sessionDb.updateModel('dad-discord-ch1', 'opus[1m]');
    expect(sessionDb.getByKey('dad-discord-ch1')!.model).toBe('opus[1m]');
  });

  it('updateModel sets null', () => {
    sessionDb.upsert(makeRow({ model: 'opus' }));
    sessionDb.updateModel('dad-discord-ch1', null);
    expect(sessionDb.getByKey('dad-discord-ch1')!.model).toBeNull();
  });

  it('delete removes the row', () => {
    sessionDb.upsert(makeRow());
    sessionDb.delete('dad-discord-ch1');
    expect(sessionDb.getByKey('dad-discord-ch1')).toBeNull();
  });

  it('delete is no-op for unknown key', () => {
    sessionDb.delete('nonexistent'); // should not throw
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/memory -- --run`
Expected: FAIL — `session-database.ts` does not exist

- [ ] **Step 3: Add sessions table to MemoryDatabase.init()**

In `packages/memory/src/database.ts`, add after the `agent_events` index (line 61), before the closing `\`);`:

```sql
      CREATE TABLE IF NOT EXISTS sessions (
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
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
```

- [ ] **Step 4: Implement SessionDatabase**

Create `packages/memory/src/session-database.ts`:

```typescript
import type Database from 'better-sqlite3';
import type { SessionRow, SessionStatus, SessionQueryFilters, SessionPersistence } from '@ccbuddy/core';

export class SessionDatabase implements SessionPersistence {
  private db: Database.Database;

  private stmts!: {
    upsert: Database.Statement;
    getByKey: Database.Statement;
    updateStatus: Database.Statement;
    updateLastActivity: Database.Statement;
    updateModel: Database.Statement;
    delete: Database.Statement;
  };

  constructor(db: Database.Database) {
    this.db = db;
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmts = {
      upsert: this.db.prepare(`
        INSERT INTO sessions (session_key, sdk_session_id, user_id, platform, channel_id, is_group_channel, model, status, created_at, last_activity)
        VALUES (@session_key, @sdk_session_id, @user_id, @platform, @channel_id, @is_group_channel, @model, @status, @created_at, @last_activity)
        ON CONFLICT(session_key) DO UPDATE SET
          sdk_session_id = @sdk_session_id,
          user_id = @user_id,
          model = @model,
          status = @status,
          last_activity = @last_activity
      `),
      getByKey: this.db.prepare('SELECT * FROM sessions WHERE session_key = ?'),
      updateStatus: this.db.prepare('UPDATE sessions SET status = ? WHERE session_key = ?'),
      updateLastActivity: this.db.prepare('UPDATE sessions SET last_activity = ? WHERE session_key = ?'),
      updateModel: this.db.prepare('UPDATE sessions SET model = ? WHERE session_key = ?'),
      delete: this.db.prepare('DELETE FROM sessions WHERE session_key = ?'),
    };
  }

  upsert(row: SessionRow): void {
    this.stmts.upsert.run({
      session_key: row.session_key,
      sdk_session_id: row.sdk_session_id,
      user_id: row.user_id,
      platform: row.platform,
      channel_id: row.channel_id,
      is_group_channel: row.is_group_channel ? 1 : 0,
      model: row.model,
      status: row.status,
      created_at: row.created_at,
      last_activity: row.last_activity,
    });
  }

  getByKey(sessionKey: string): SessionRow | null {
    const row = this.stmts.getByKey.get(sessionKey) as any;
    return row ? this.toSessionRow(row) : null;
  }

  getAll(filters?: SessionQueryFilters): SessionRow[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters?.status) {
      conditions.push('status = ?');
      params.push(filters.status);
    }
    if (filters?.platform) {
      conditions.push('platform = ?');
      params.push(filters.platform);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM sessions ${where} ORDER BY last_activity DESC`;
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(r => this.toSessionRow(r));
  }

  updateStatus(sessionKey: string, status: SessionStatus): void {
    this.stmts.updateStatus.run(status, sessionKey);
  }

  updateLastActivity(sessionKey: string, timestamp: number): void {
    this.stmts.updateLastActivity.run(timestamp, sessionKey);
  }

  updateModel(sessionKey: string, model: string | null): void {
    this.stmts.updateModel.run(model, sessionKey);
  }

  delete(sessionKey: string): void {
    this.stmts.delete.run(sessionKey);
  }

  private toSessionRow(row: any): SessionRow {
    return {
      session_key: row.session_key,
      sdk_session_id: row.sdk_session_id,
      user_id: row.user_id ?? null,
      platform: row.platform,
      channel_id: row.channel_id,
      is_group_channel: !!row.is_group_channel,
      model: row.model ?? null,
      status: row.status,
      created_at: row.created_at,
      last_activity: row.last_activity,
    };
  }
}
```

- [ ] **Step 5: Export from memory index**

Add to `packages/memory/src/index.ts`:

```typescript
export { SessionDatabase } from './session-database.js';
```

- [ ] **Step 6: Build and run tests**

Run: `npm run build -w packages/core -w packages/memory && npm test -w packages/memory -- --run`
Expected: All tests pass including new SessionDatabase tests

- [ ] **Step 7: Commit**

```bash
git add packages/memory/src/database.ts packages/memory/src/session-database.ts packages/memory/src/index.ts packages/memory/src/__tests__/session-database.test.ts
git commit -m "feat(memory): add sessions table and SessionDatabase CRUD layer"
```

---

## Chunk 2: SessionStore Persistence

### Task 4: Update SessionStore with persistence backing

**Files:**
- Modify: `packages/agent/src/session/session-store.ts`
- Modify: `packages/agent/src/session/__tests__/session-store.test.ts`

- [ ] **Step 1: Write failing tests for new persistence behavior**

Add these tests to `packages/agent/src/session/__tests__/session-store.test.ts`. You'll need to create a mock `SessionPersistence`:

```typescript
import type { SessionPersistence, SessionRow, SessionStatus, SessionQueryFilters } from '@ccbuddy/core';

class MockPersistence implements SessionPersistence {
  rows = new Map<string, SessionRow>();
  upsert(row: SessionRow): void { this.rows.set(row.session_key, { ...row }); }
  getByKey(key: string): SessionRow | null { return this.rows.get(key) ?? null; }
  getAll(filters?: SessionQueryFilters): SessionRow[] {
    let results = Array.from(this.rows.values());
    if (filters?.status) results = results.filter(r => r.status === filters.status);
    if (filters?.platform) results = results.filter(r => r.platform === filters.platform);
    return results.sort((a, b) => b.last_activity - a.last_activity);
  }
  updateStatus(key: string, status: SessionStatus): void {
    const r = this.rows.get(key);
    if (r) r.status = status;
  }
  updateLastActivity(key: string, ts: number): void {
    const r = this.rows.get(key);
    if (r) r.last_activity = ts;
  }
  updateModel(key: string, model: string | null): void {
    const r = this.rows.get(key);
    if (r) r.model = model;
  }
  delete(key: string): void { this.rows.delete(key); }
}
```

Add a new `describe('SessionStore with persistence')` block:

```typescript
describe('SessionStore with persistence', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('persists new sessions to DB on create', () => {
    const db = new MockPersistence();
    const store = new SessionStore(60_000, { persistence: db });
    store.getOrCreate('dad-discord-ch1', false, 'discord', 'ch1', 'dad');
    expect(db.rows.has('dad-discord-ch1')).toBe(true);
    expect(db.rows.get('dad-discord-ch1')!.status).toBe('active');
  });

  it('restores session from DB when not in memory', () => {
    const db = new MockPersistence();
    db.upsert({
      session_key: 'dad-discord-ch1',
      sdk_session_id: 'saved-uuid',
      user_id: 'dad',
      platform: 'discord',
      channel_id: 'ch1',
      is_group_channel: false,
      model: null,
      status: 'active',
      created_at: 1000,
      last_activity: 1000,
    });
    const store = new SessionStore(60_000, { persistence: db });
    const result = store.getOrCreate('dad-discord-ch1', false, 'discord', 'ch1', 'dad');
    expect(result.isNew).toBe(false);
    expect(result.sdkSessionId).toBe('saved-uuid');
  });

  it('does not restore archived sessions from DB', () => {
    const db = new MockPersistence();
    db.upsert({
      session_key: 'old-key',
      sdk_session_id: 'old-uuid',
      user_id: 'dad',
      platform: 'discord',
      channel_id: 'ch1',
      is_group_channel: false,
      model: null,
      status: 'archived',
      created_at: 1000,
      last_activity: 1000,
    });
    const store = new SessionStore(60_000, { persistence: db });
    const result = store.getOrCreate('old-key', false, 'discord', 'ch1', 'dad');
    expect(result.isNew).toBe(true);
    expect(result.sdkSessionId).not.toBe('old-uuid');
  });

  it('restores paused sessions and sets them active', () => {
    const db = new MockPersistence();
    db.upsert({
      session_key: 'paused-key',
      sdk_session_id: 'paused-uuid',
      user_id: 'dad',
      platform: 'discord',
      channel_id: 'ch1',
      is_group_channel: false,
      model: null,
      status: 'paused',
      created_at: 1000,
      last_activity: 1000,
    });
    const store = new SessionStore(60_000, { persistence: db });
    const result = store.getOrCreate('paused-key', false, 'discord', 'ch1', 'dad');
    expect(result.isNew).toBe(false);
    expect(result.sdkSessionId).toBe('paused-uuid');
    expect(db.rows.get('paused-key')!.status).toBe('active');
  });

  it('touch updates DB last_activity', () => {
    const db = new MockPersistence();
    const store = new SessionStore(60_000, { persistence: db });
    store.getOrCreate('k1', false, 'discord', 'ch1', 'dad');
    vi.advanceTimersByTime(5000);
    store.touch('k1');
    expect(db.rows.get('k1')!.last_activity).toBeGreaterThan(1000);
  });

  it('setModel persists to DB', () => {
    const db = new MockPersistence();
    const store = new SessionStore(60_000, { persistence: db });
    store.getOrCreate('k1', false, 'discord', 'ch1', 'dad');
    store.setModel('k1', 'opus[1m]');
    expect(db.rows.get('k1')!.model).toBe('opus[1m]');
  });

  it('tick archives expired sessions in DB', () => {
    const db = new MockPersistence();
    const store = new SessionStore(60_000, { persistence: db });
    store.getOrCreate('k1', false, 'discord', 'ch1', 'dad');
    vi.advanceTimersByTime(61_000);
    store.tick();
    expect(db.rows.get('k1')!.status).toBe('archived');
    expect(store.getAll()).toHaveLength(0);
  });

  it('tick skips paused sessions', () => {
    const db = new MockPersistence();
    const store = new SessionStore(60_000, { persistence: db });
    store.getOrCreate('k1', false, 'discord', 'ch1', 'dad');
    store.pause('k1');
    vi.advanceTimersByTime(61_000);
    store.tick();
    expect(store.getAll()).toHaveLength(1);
    expect(db.rows.get('k1')!.status).toBe('paused');
  });

  it('tick syncs pause status from DB (out-of-band MCP write)', () => {
    const db = new MockPersistence();
    const store = new SessionStore(60_000, { persistence: db });
    store.getOrCreate('k1', false, 'discord', 'ch1', 'dad');
    // Simulate MCP subprocess writing paused status directly to DB
    db.updateStatus('k1', 'paused');
    vi.advanceTimersByTime(61_000);
    store.tick();
    // Session should NOT be archived — tick synced the paused status from DB
    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].status).toBe('paused');
  });

  it('getModel syncs model from DB (out-of-band MCP write)', () => {
    const db = new MockPersistence();
    const store = new SessionStore(60_000, { persistence: db });
    store.getOrCreate('k1', false, 'discord', 'ch1', 'dad');
    // Simulate MCP subprocess writing model directly to DB
    db.updateModel('k1', 'opus[1m]');
    expect(store.getModel('k1')).toBe('opus[1m]');
  });

  it('tick auto-archives paused sessions after maxPauseMs', () => {
    const db = new MockPersistence();
    const maxPauseMs = 120_000;
    const store = new SessionStore(60_000, { persistence: db, maxPauseMs });
    store.getOrCreate('k1', false, 'discord', 'ch1', 'dad');
    store.pause('k1');
    vi.advanceTimersByTime(121_000);
    store.tick();
    expect(store.getAll()).toHaveLength(0);
    expect(db.rows.get('k1')!.status).toBe('archived');
  });

  it('archive sets DB status and removes from memory', () => {
    const db = new MockPersistence();
    const store = new SessionStore(60_000, { persistence: db });
    store.getOrCreate('k1', false, 'discord', 'ch1', 'dad');
    store.archive('k1');
    expect(store.getAll()).toHaveLength(0);
    expect(db.rows.get('k1')!.status).toBe('archived');
  });

  it('deleteSession hard-deletes from DB and memory', () => {
    const db = new MockPersistence();
    const store = new SessionStore(60_000, { persistence: db });
    store.getOrCreate('k1', false, 'discord', 'ch1', 'dad');
    store.deleteSession('k1');
    expect(store.getAll()).toHaveLength(0);
    expect(db.rows.has('k1')).toBe(false);
  });

  it('hydrate loads active and paused sessions into memory', () => {
    const db = new MockPersistence();
    db.upsert({ session_key: 'a', sdk_session_id: 'u1', user_id: null, platform: 'discord', channel_id: 'c1', is_group_channel: true, model: null, status: 'active', created_at: 1, last_activity: 1 });
    db.upsert({ session_key: 'b', sdk_session_id: 'u2', user_id: 'dad', platform: 'discord', channel_id: 'c2', is_group_channel: false, model: 'opus', status: 'paused', created_at: 2, last_activity: 2 });
    db.upsert({ session_key: 'c', sdk_session_id: 'u3', user_id: null, platform: 'discord', channel_id: 'c3', is_group_channel: true, model: null, status: 'archived', created_at: 3, last_activity: 3 });

    const store = new SessionStore(60_000, { persistence: db });
    store.hydrate();

    const all = store.getAll();
    expect(all).toHaveLength(2);
    expect(all.map(s => s.sessionKey).sort()).toEqual(['a', 'b']);
    expect(store.getModel('b')).toBe('opus');
  });

  it('getHistory delegates to persistence', () => {
    const db = new MockPersistence();
    db.upsert({ session_key: 'a', sdk_session_id: 'u1', user_id: null, platform: 'discord', channel_id: 'c1', is_group_channel: true, model: null, status: 'active', created_at: 1, last_activity: 1 });
    db.upsert({ session_key: 'b', sdk_session_id: 'u2', user_id: null, platform: 'discord', channel_id: 'c2', is_group_channel: true, model: null, status: 'archived', created_at: 2, last_activity: 2 });
    const store = new SessionStore(60_000, { persistence: db });
    const history = store.getHistory({ status: 'archived' });
    expect(history).toHaveLength(1);
    expect(history[0].session_key).toBe('b');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/agent -- --run`
Expected: FAIL — `pause`, `archive`, `deleteSession`, `hydrate`, `getHistory` don't exist yet

- [ ] **Step 3: Implement updated SessionStore**

Rewrite `packages/agent/src/session/session-store.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import type { SessionPersistence, SessionRow, SessionQueryFilters } from '@ccbuddy/core';

interface SessionEntry {
  sdkSessionId: string;
  lastActivity: number;
  isGroupChannel: boolean;
  model: string | null;
  status: 'active' | 'paused';
}

export interface SessionInfo {
  sessionKey: string;
  sdkSessionId: string;
  lastActivity: number;
  isGroupChannel: boolean;
  model: string | null;
  status: 'active' | 'paused';
}

export interface SessionStoreOptions {
  onExpiry?: (sessionKey: string) => void;
  persistence?: SessionPersistence;
  maxPauseMs?: number;
}

export class SessionStore {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly timeoutMs: number;
  private readonly maxPauseMs: number;
  private readonly onExpiry?: (sessionKey: string) => void;
  private readonly persistence?: SessionPersistence;

  constructor(timeoutMs: number, options?: SessionStoreOptions) {
    this.timeoutMs = timeoutMs;
    this.onExpiry = options?.onExpiry;
    this.persistence = options?.persistence;
    this.maxPauseMs = options?.maxPauseMs ?? 604_800_000; // 7 days
  }

  getOrCreate(
    sessionKey: string,
    isGroupChannel: boolean,
    platform?: string,
    channelId?: string,
    userId?: string,
  ): { sdkSessionId: string; isNew: boolean } {
    // 1. Check memory
    const existing = this.entries.get(sessionKey);
    if (existing) {
      existing.lastActivity = Date.now();
      return { sdkSessionId: existing.sdkSessionId, isNew: false };
    }

    // 2. Check DB for active/paused session
    if (this.persistence) {
      const row = this.persistence.getByKey(sessionKey);
      if (row && (row.status === 'active' || row.status === 'paused')) {
        const now = Date.now();
        const entry: SessionEntry = {
          sdkSessionId: row.sdk_session_id,
          lastActivity: now,
          isGroupChannel: row.is_group_channel,
          model: row.model,
          status: 'active',
        };
        this.entries.set(sessionKey, entry);
        // If it was paused, set back to active
        if (row.status === 'paused') {
          this.persistence.updateStatus(sessionKey, 'active');
        }
        this.persistence.updateLastActivity(sessionKey, now);
        return { sdkSessionId: row.sdk_session_id, isNew: false };
      }
    }

    // 3. Create new
    const now = Date.now();
    const entry: SessionEntry = {
      sdkSessionId: randomUUID(),
      lastActivity: now,
      isGroupChannel,
      model: null,
      status: 'active',
    };
    this.entries.set(sessionKey, entry);

    if (this.persistence && platform && channelId) {
      this.persistence.upsert({
        session_key: sessionKey,
        sdk_session_id: entry.sdkSessionId,
        user_id: userId ?? null,
        platform,
        channel_id: channelId,
        is_group_channel: isGroupChannel,
        model: null,
        status: 'active',
        created_at: now,
        last_activity: now,
      });
    }

    return { sdkSessionId: entry.sdkSessionId, isNew: true };
  }

  touch(sessionKey: string): void {
    const entry = this.entries.get(sessionKey);
    if (entry) {
      const now = Date.now();
      entry.lastActivity = now;
      this.persistence?.updateLastActivity(sessionKey, now);
    }
  }

  /** @deprecated Use archive() instead */
  remove(sessionKey: string): void {
    this.archive(sessionKey);
  }

  archive(sessionKey: string): void {
    this.entries.delete(sessionKey);
    this.persistence?.updateStatus(sessionKey, 'archived');
  }

  pause(sessionKey: string): void {
    const entry = this.entries.get(sessionKey);
    if (entry) {
      entry.status = 'paused';
      this.persistence?.updateStatus(sessionKey, 'paused');
    }
  }

  unpause(sessionKey: string): void {
    const entry = this.entries.get(sessionKey);
    if (entry) {
      entry.status = 'active';
      entry.lastActivity = Date.now();
      this.persistence?.updateStatus(sessionKey, 'active');
      this.persistence?.updateLastActivity(sessionKey, entry.lastActivity);
    }
  }

  tick(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      // Sync status from DB — MCP subprocess may have written 'paused' directly
      if (this.persistence) {
        const dbRow = this.persistence.getByKey(key);
        if (dbRow && dbRow.status !== entry.status) {
          entry.status = dbRow.status as 'active' | 'paused';
          if (dbRow.model !== entry.model) {
            entry.model = dbRow.model;
          }
        }
      }

      if (entry.status === 'paused') {
        // Safety net: auto-archive after maxPauseMs
        if (now - entry.lastActivity > this.maxPauseMs) {
          this.entries.delete(key);
          this.persistence?.updateStatus(key, 'archived');
          this.onExpiry?.(key);
        }
        continue; // skip normal timeout for paused
      }
      if (now - entry.lastActivity > this.timeoutMs) {
        this.entries.delete(key);
        this.persistence?.updateStatus(key, 'archived');
        this.onExpiry?.(key);
      }
    }
  }

  getAll(): SessionInfo[] {
    return Array.from(this.entries.entries()).map(([key, entry]) => ({
      sessionKey: key,
      sdkSessionId: entry.sdkSessionId,
      lastActivity: entry.lastActivity,
      isGroupChannel: entry.isGroupChannel,
      model: entry.model,
      status: entry.status,
    }));
  }

  setModel(sessionKey: string, model: string): void {
    const entry = this.entries.get(sessionKey);
    if (entry) {
      entry.model = model;
      this.persistence?.updateModel(sessionKey, model);
    }
  }

  getModel(sessionKey: string): string | null {
    const entry = this.entries.get(sessionKey);
    if (!entry) return null;
    // Sync from DB — MCP subprocess may have written a model change directly
    if (this.persistence) {
      const dbRow = this.persistence.getByKey(sessionKey);
      if (dbRow && dbRow.model !== entry.model) {
        entry.model = dbRow.model;
      }
    }
    return entry.model;
  }

  deleteSession(sessionKey: string): void {
    this.entries.delete(sessionKey);
    this.persistence?.delete(sessionKey);
  }

  hydrate(): void {
    if (!this.persistence) return;
    const active = this.persistence.getAll({ status: 'active' });
    const paused = this.persistence.getAll({ status: 'paused' });
    for (const row of [...active, ...paused]) {
      this.entries.set(row.session_key, {
        sdkSessionId: row.sdk_session_id,
        lastActivity: row.last_activity,
        isGroupChannel: row.is_group_channel,
        model: row.model,
        status: row.status as 'active' | 'paused',
      });
    }
  }

  getHistory(filters?: SessionQueryFilters): SessionRow[] {
    return this.persistence?.getAll(filters) ?? [];
  }
}
```

- [ ] **Step 4: Update SessionInfo export if needed**

The `SessionInfo` interface now has a `status` field. Check `packages/agent/src/session/index.ts` — it should re-export `SessionInfo` from `session-store.ts`. No change needed if it already does.

- [ ] **Step 5: Run all tests**

Run: `npm run build -w packages/core -w packages/memory -w packages/agent && npm test -w packages/agent -- --run`
Expected: All existing + new tests pass

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/session/session-store.ts packages/agent/src/session/__tests__/session-store.test.ts
git commit -m "feat(agent): add persistence backing to SessionStore with pause/archive lifecycle"
```

---

## Chunk 3: Gateway + Bootstrap Integration

### Task 5: Update gateway to use SessionStore for model resolution

**Files:**
- Modify: `packages/gateway/src/gateway.ts:36-54` (GatewayDeps — remove readModelFile)
- Modify: `packages/gateway/src/gateway.ts:164-196` (session lookup + model resolution)
- Modify: `packages/gateway/src/gateway.ts:464-467` (resume failure — rename remove to archive)

- [ ] **Step 1: Remove `readModelFile` from GatewayDeps**

In `packages/gateway/src/gateway.ts`, remove line 51:

```typescript
  readModelFile?: (sessionKey: string) => string | null;
```

- [ ] **Step 2: Update getOrCreate call to pass platform/channelId/userId**

Replace the session lookup block (lines 164-172):

```typescript
    if (this.deps.sessionStore) {
      const session = this.deps.sessionStore.getOrCreate(
        sessionKey, isGroupChannel, msg.platform, msg.channelId, user.name,
      );
      isNewSession = session.isNew;
      if (session.isNew) {
        sdkSessionId = session.sdkSessionId;
      } else {
        resumeSessionId = session.sdkSessionId;
      }
    }
```

- [ ] **Step 3: Simplify model resolution**

Replace the model resolution block (lines 174-196) with:

```typescript
    // 3d. Resolve model for this session
    let sessionModel: string | undefined;
    if (this.deps.sessionStore) {
      const storeModel = this.deps.sessionStore.getModel(sessionKey);
      if (storeModel) {
        sessionModel = storeModel;
      }
    }
    const effectiveModel = sessionModel ?? this.deps.defaultModel;
```

Note: The `session.model_changed` event publishing is no longer needed here — the MCP `switch_model` tool writes to DB, and the gateway just reads whatever model is current. If model change events are still needed, they can be emitted by the MCP tool via the event bus in a future enhancement.

- [ ] **Step 4: Rename `remove` to `archive` in resume failure path**

In the catch block (line 466), change:

```typescript
        this.deps.sessionStore.remove(sessionKey);
```
to:
```typescript
        this.deps.sessionStore.archive(sessionKey);
```

And update the `getOrCreate` call on line 467 to pass the new params:

```typescript
        const newSession = this.deps.sessionStore.getOrCreate(
          sessionKey, msg.channelType === 'group', msg.platform, msg.channelId, user.name,
        );
```

- [ ] **Step 5: Update gateway tests**

The gateway test file (`packages/gateway/src/__tests__/gateway.test.ts`) has multiple tests that reference `readModelFile` in the mock deps. For each test that sets `readModelFile` in the deps object:
- Remove the `readModelFile` property from the mock deps
- If the test verifies model resolution behavior, update it to use `sessionStore.setModel()` instead (the sessionStore mock should already be in the test setup)

- [ ] **Step 6: Build and run gateway tests**

Run: `npm run build -w packages/gateway && npm test -w packages/gateway -- --run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/gateway.ts packages/gateway/src/__tests__/gateway.test.ts
git commit -m "feat(gateway): use SessionStore for model resolution, remove readModelFile"
```

---

### Task 6: Update bootstrap wiring

**Files:**
- Modify: `packages/main/src/bootstrap.ts:~4-24` (imports)
- Modify: `packages/main/src/bootstrap.ts:~105-110` (SessionStore creation)
- Modify: `packages/main/src/bootstrap.ts:~279-282` (remove readModelFile from gateway deps)

- [ ] **Step 1: Update imports**

In `packages/main/src/bootstrap.ts`, add `SessionDatabase` import from `@ccbuddy/memory` (near existing memory imports). Remove `readModelFile` and `writeModelFile` from `@ccbuddy/core` import.

- [ ] **Step 2: Create SessionDatabase and update SessionStore construction**

Replace the SessionStore creation block (lines ~105-110):

```typescript
  const sessionDb = new SessionDatabase(database.raw());
  const sessionStore = new SessionStore(config.agent.session_timeout_ms, {
    persistence: sessionDb,
    maxPauseMs: config.agent.max_pause_ms,
  });
  sessionStore.hydrate();
```

Remove the `onExpiry` callback that deletes model files — model data is now in DB.

- [ ] **Step 3: Remove readModelFile from gateway deps**

In the Gateway constructor call (lines ~278-282), remove the `readModelFile` property entirely:

```typescript
    // DELETE this block:
    // readModelFile: (sessionKey: string) => {
    //   const filePath = join(resolve(config.data_dir), 'sessions', `${sessionKey}.model`);
    //   return readModelFile(filePath);
    // },
```

- [ ] **Step 4: Build and verify**

Run: `npm run build -w packages/main`
Expected: Clean build

- [ ] **Step 5: Commit**

```bash
git add packages/main/src/bootstrap.ts
git commit -m "feat(main): wire SessionDatabase into SessionStore, remove model file deps"
```

---

## Chunk 4: MCP Server + Model File Cleanup

### Task 7: Remove model-file.ts and update MCP server for DB-backed model + pause_session

These are combined into one task to avoid a broken-build window (deleting model-file.ts before MCP server is updated would break the build).

**Files:**
- Delete: `packages/core/src/config/model-file.ts`
- Delete: `packages/core/src/config/__tests__/model-file.test.ts` (if exists)
- Modify: `packages/core/src/config/index.ts` (remove export)
- Modify: `packages/skills/src/mcp-server.ts:32` (imports)
- Modify: `packages/skills/src/mcp-server.ts:239-259` (tool definitions — add pause_session)
- Modify: `packages/skills/src/mcp-server.ts:720-736` (tool handlers — switch to DB)

- [ ] **Step 1: Remove model-file.ts and its export**

In `packages/core/src/config/index.ts`, remove:

```typescript
export { writeModelFile, readModelFile } from './model-file.js';
```

Then delete the file and any test file:

```bash
rm packages/core/src/config/model-file.ts
rm -f packages/core/src/config/__tests__/model-file.test.ts
```

- [ ] **Step 2: Update MCP server imports**

In `packages/skills/src/mcp-server.ts`, replace the `readModelFile, writeModelFile` import from `@ccbuddy/core` (line 32):

```typescript
import { isValidModel } from '@ccbuddy/core';
```

Add import for SessionDatabase:

```typescript
import { SessionDatabase } from '@ccbuddy/memory';
```

- [ ] **Step 3: Create a session DB connection in the MCP server**

Near the existing `profileDatabase`/`profileStore` initialization (around line 134-136), add:

```typescript
    let sessionDb: SessionDatabase | undefined;
    if (args.memoryDbPath) {
      // Reuse the same writable DB connection as profileStore
      sessionDb = new SessionDatabase(profileDatabase!.raw());
    }
```

Note: `profileDatabase` is already created from `args.memoryDbPath` — reuse the same connection (WAL mode supports this).

- [ ] **Step 4: Add pause_session tool definition**

Inside the `if (args.sessionKey)` block, after the `get_current_model` tool push (around line 258), add:

```typescript
      tools.push({
        name: 'pause_session',
        description: 'Pause the current session so it can be resumed later, even after hours or days. Use when the user says they are stepping away and want to continue later.',
        inputSchema: { type: 'object', properties: {} },
      });
```

This must be inside the `if (args.sessionKey)` guard — same as `switch_model` and `get_current_model`.

- [ ] **Step 5: Update switch_model handler to use DB**

Replace the `switch_model` case (lines 720-729):

```typescript
      case 'switch_model': {
        const { model } = toolArgs as { model: string };
        if (!isValidModel(model)) {
          return { content: [{ type: 'text', text: `Invalid model: "${model}". Use an alias (sonnet, opus, haiku, opus[1m], sonnet[1m], opusplan) or a full model ID (e.g., claude-opus-4-6).` }] };
        }
        if (sessionDb && args.sessionKey) {
          sessionDb.updateModel(args.sessionKey, model);
        }
        return { content: [{ type: 'text', text: `Model switched to ${model}. This takes effect on the next message.` }] };
      }
```

- [ ] **Step 6: Update get_current_model handler to use DB**

Replace the `get_current_model` case (lines 731-734):

```typescript
      case 'get_current_model': {
        if (sessionDb && args.sessionKey) {
          const row = sessionDb.getByKey(args.sessionKey);
          const model = row?.model ?? null;
          return { content: [{ type: 'text', text: model ? `Current model override: ${model}` : 'No model override — using config default.' }] };
        }
        return { content: [{ type: 'text', text: 'No model override — using config default.' }] };
      }
```

- [ ] **Step 7: Add pause_session handler**

Add after the `get_current_model` case:

```typescript
      case 'pause_session': {
        if (sessionDb && args.sessionKey) {
          sessionDb.updateStatus(args.sessionKey, 'paused');
          return { content: [{ type: 'text', text: 'Session paused. It will be resumed when you send your next message, even after hours or days.' }] };
        }
        return { content: [{ type: 'text', text: 'Session pausing is not available (no session key).' }] };
      }
```

- [ ] **Step 8: Remove unused mkdirSync/file imports**

Remove the `mkdirSync` usage for `data/sessions` directory creation that was used for model files (if no other code uses it).

- [ ] **Step 9: Search for remaining model-file references**

Run: `grep -r "model-file\|readModelFile\|writeModelFile" packages/ --include="*.ts" -l`
Fix any remaining imports.

- [ ] **Step 10: Build and run tests**

Run: `npm run build && npm test -- --run`
Expected: All tests pass

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/config/model-file.ts packages/core/src/config/index.ts packages/skills/src/mcp-server.ts
git commit -m "feat(skills): DB-backed model/pause tools, remove model-file.ts"
```

---

## Chunk 5: Dashboard API + UI

### Task 8: Update dashboard API for session history

**Files:**
- Modify: `packages/dashboard/src/server/index.ts:16-32` (DashboardDeps)
- Modify: `packages/dashboard/src/server/index.ts:131-134` (GET /api/sessions)
- Add new endpoint: `DELETE /api/sessions/:key`

- [ ] **Step 1: Add sessionStore to DashboardDeps**

In `packages/dashboard/src/server/index.ts`, update the `DashboardDeps` interface. Add to the `agentService` interface:

```typescript
  agentService: {
    getSessionInfo(): SessionInfo[];
    readonly queueSize: number;
  };
  sessionStore?: {
    getHistory(filters?: { status?: string; platform?: string }): Array<{
      session_key: string;
      sdk_session_id: string;
      user_id: string | null;
      platform: string;
      channel_id: string;
      is_group_channel: boolean;
      model: string | null;
      status: string;
      created_at: number;
      last_activity: number;
    }>;
    deleteSession(sessionKey: string): void;
  };
```

- [ ] **Step 2: Update GET /api/sessions endpoint**

Replace the existing endpoint (lines 131-134):

```typescript
    this.app.get('/api/sessions', async (request) => {
      const q = request.query as Record<string, string>;
      const status = q.status as string | undefined;
      const platform = q.platform as string | undefined;

      if (this.deps.sessionStore) {
        const filters: Record<string, string> = {};
        if (status) filters.status = status;
        if (platform) filters.platform = platform;
        const sessions = this.deps.sessionStore.getHistory(
          Object.keys(filters).length > 0 ? filters : undefined,
        );
        return { sessions };
      }
      // Fallback: active-only from AgentService
      return { sessions: this.deps.agentService.getSessionInfo() };
    });
```

- [ ] **Step 3: Add DELETE /api/sessions/:key endpoint**

After the GET sessions endpoint, add:

```typescript
    this.app.delete<{ Params: { key: string } }>('/api/sessions/:key', async (request) => {
      const { key } = request.params;
      if (this.deps.sessionStore) {
        this.deps.sessionStore.deleteSession(key);
      }
      return { success: true };
    });
```

- [ ] **Step 4: Build and verify**

Run: `npm run build -w packages/dashboard`
Expected: Clean build

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/server/index.ts
git commit -m "feat(dashboard): add session history API with status filter and delete endpoint"
```

---

### Task 9: Wire sessionStore into DashboardServer in bootstrap

**Files:**
- Modify: `packages/main/src/bootstrap.ts` (DashboardServer construction)

- [ ] **Step 1: Find DashboardServer construction in bootstrap**

Look for where `new DashboardServer(...)` is called and add `sessionStore` to the deps object:

```typescript
    sessionStore,
```

- [ ] **Step 2: Build and verify**

Run: `npm run build -w packages/main`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
git add packages/main/src/bootstrap.ts
git commit -m "feat(main): pass sessionStore to DashboardServer for session history"
```

---

### Task 10: Update dashboard UI SessionsPage

**Files:**
- Modify: `packages/dashboard/client/src/pages/SessionsPage.tsx`
- Modify: `packages/dashboard/client/src/lib/api.ts` (add delete method, update sessions method)

- [ ] **Step 1: Update api.ts**

In `packages/dashboard/client/src/lib/api.ts`, update the sessions method to accept optional status filter, and add delete:

```typescript
  sessions: (status?: string) => {
    const params = status ? `?status=${status}` : '';
    return request<{ sessions: any[] }>(`/api/sessions${params}`);
  },
  deleteSession: (key: string) =>
    request<{ success: boolean }>(`/api/sessions/${encodeURIComponent(key)}`, { method: 'DELETE' }),
```

- [ ] **Step 2: Update SessionsPage.tsx**

Replace `packages/dashboard/client/src/pages/SessionsPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-500',
  paused: 'bg-yellow-500',
  archived: 'bg-gray-500',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
};

const FILTERS = ['all', 'active', 'paused', 'archived'] as const;

export function SessionsPage() {
  const [sessions, setSessions] = useState<any[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = () => {
    const status = filter === 'all' ? undefined : filter;
    api.sessions(status).then(d => setSessions(d.sessions));
  };

  useEffect(() => { load(); }, [filter]);

  const handleDelete = async (key: string) => {
    if (!confirm(`Delete session "${key}"? This cannot be undone.`)) return;
    setDeleting(key);
    await api.deleteSession(key);
    load();
    setDeleting(null);
  };

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Sessions</h2>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-4">
        {FILTERS.map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded text-sm ${
              filter === f
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {sessions.length === 0 ? (
        <p className="text-gray-400">No sessions found</p>
      ) : (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-800/50">
              <tr>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Status</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Session Key</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Type</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Model</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Last Activity</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s: any) => {
                const status = s.status ?? 'active';
                const key = s.session_key ?? s.sessionKey;
                return (
                  <tr key={key} className="border-t border-gray-800 hover:bg-gray-800/30">
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${STATUS_COLORS[status] ?? 'bg-gray-500'}`} />
                        <span className="text-xs text-gray-400">{STATUS_LABELS[status] ?? status}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to={`/sessions/${encodeURIComponent(key)}`}
                        className="text-blue-400 hover:underline font-mono"
                      >
                        {key}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-gray-400">
                      {s.is_group_channel ?? s.isGroupChannel ? 'Group' : 'DM'}
                    </td>
                    <td className="px-4 py-3">
                      {s.model ? (
                        <span className="text-xs px-2 py-0.5 rounded bg-blue-900 text-blue-300">{s.model}</span>
                      ) : (
                        <span className="text-gray-600">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-400">
                      {new Date(s.last_activity ?? s.lastActivity).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleDelete(key)}
                        disabled={deleting === key}
                        className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
                      >
                        {deleting === key ? '...' : 'Delete'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Build dashboard client**

Run: `cd packages/dashboard/client && npm run build && cd ../../..`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/client/src/pages/SessionsPage.tsx packages/dashboard/client/src/lib/api.ts
git commit -m "feat(dashboard): sessions page with status badges, filters, and delete"
```

---

## Chunk 6: Final Integration + Tests

### Task 11: Run full test suite and fix any issues

**Files:**
- Any files needing test/type fixes

- [ ] **Step 1: Build all packages**

Run: `npm run build`
Expected: Clean build across all 12 packages

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass (607+ existing + new tests)

- [ ] **Step 3: Fix any failures**

Common issues to check:
- Gateway test mocks may reference `readModelFile` — remove from mock deps
- Dashboard test mocks may need `sessionStore` added
- Any import of `readModelFile`/`writeModelFile` from `@ccbuddy/core` will fail

- [ ] **Step 4: Commit fixes if any**

```bash
git add -A
git commit -m "fix: resolve test failures from session persistence integration"
```

---

### Task 12: Verify end-to-end behavior

- [ ] **Step 1: Verify DB table creation**

The `sessions` table should be created automatically on startup via `MemoryDatabase.init()`. Check by running:

```bash
sqlite3 data/memory.db ".schema sessions"
```

- [ ] **Step 2: Verify session hydration after restart**

1. Start CCBuddy
2. Send a message (creates a session)
3. Restart CCBuddy (`launchctl bootout` / `launchctl bootstrap`)
4. Send another message — should resume the same SDK session (not create new)

- [ ] **Step 3: Verify pause/resume**

1. Tell Po "I'm going to step away, pause this session"
2. Verify Po calls `pause_session` tool
3. Wait for normal session timeout to pass
4. Send a new message — should resume the same session

- [ ] **Step 4: Verify dashboard**

1. Open dashboard at localhost:18801
2. Navigate to Sessions page
3. Verify filter tabs work (All/Active/Paused/Archived)
4. Verify status badges display correctly
5. Verify delete button works
