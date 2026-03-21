import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionStore } from '../session-store.js';
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
    const r = this.rows.get(key); if (r) r.status = status;
  }
  updateLastActivity(key: string, ts: number): void {
    const r = this.rows.get(key); if (r) r.last_activity = ts;
  }
  updateModel(key: string, model: string | null): void {
    const r = this.rows.get(key); if (r) r.model = model;
  }
  delete(key: string): void { this.rows.delete(key); }
}

describe('SessionStore', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('creates a new session with a UUID', () => {
    const store = new SessionStore(3_600_000);
    const { sdkSessionId, isNew } = store.getOrCreate('dad-discord-ch1', false);
    expect(isNew).toBe(true);
    expect(sdkSessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns existing session on second call', () => {
    const store = new SessionStore(3_600_000);
    const first = store.getOrCreate('dad-discord-ch1', false);
    const second = store.getOrCreate('dad-discord-ch1', false);
    expect(second.isNew).toBe(false);
    expect(second.sdkSessionId).toBe(first.sdkSessionId);
  });

  it('touch updates lastActivity', () => {
    const store = new SessionStore(3_600_000);
    store.getOrCreate('dad-discord-ch1', false);
    vi.advanceTimersByTime(1_000);
    store.touch('dad-discord-ch1');
    vi.advanceTimersByTime(3_599_500);
    store.tick();
    const result = store.getOrCreate('dad-discord-ch1', false);
    expect(result.isNew).toBe(false);
  });

  it('expires sessions after timeout', () => {
    const store = new SessionStore(3_600_000);
    store.getOrCreate('dad-discord-ch1', false);
    vi.advanceTimersByTime(3_600_001);
    store.tick();
    const result = store.getOrCreate('dad-discord-ch1', false);
    expect(result.isNew).toBe(true);
  });

  it('remove deletes the session', () => {
    const store = new SessionStore(3_600_000);
    const first = store.getOrCreate('dad-discord-ch1', false);
    store.remove('dad-discord-ch1');
    const second = store.getOrCreate('dad-discord-ch1', false);
    expect(second.isNew).toBe(true);
    expect(second.sdkSessionId).not.toBe(first.sdkSessionId);
  });

  it('handles multiple independent session keys', () => {
    const store = new SessionStore(3_600_000);
    const s1 = store.getOrCreate('dad-discord-ch1', false);
    const s2 = store.getOrCreate('discord-ch1', true);
    expect(s1.sdkSessionId).not.toBe(s2.sdkSessionId);
  });

  it('tick does not expire fresh sessions', () => {
    const store = new SessionStore(3_600_000);
    store.getOrCreate('dad-discord-ch1', false);
    vi.advanceTimersByTime(1_800_000);
    store.tick();
    const result = store.getOrCreate('dad-discord-ch1', false);
    expect(result.isNew).toBe(false);
  });

  it('getAll returns all active sessions', () => {
    const store = new SessionStore(3_600_000);
    store.getOrCreate('dad-discord-ch1', false);
    store.getOrCreate('discord-ch2', true);

    const all = store.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].sessionKey).toBe('dad-discord-ch1');
    expect(all[0].isGroupChannel).toBe(false);
    expect(all[1].sessionKey).toBe('discord-ch2');
    expect(all[1].isGroupChannel).toBe(true);
  });

  it('getAll returns empty array when no sessions', () => {
    const store = new SessionStore(3_600_000);
    expect(store.getAll()).toEqual([]);
  });
});

describe('SessionStore model field', () => {
  it('returns null model for new sessions', () => {
    const store = new SessionStore(60_000);
    store.getOrCreate('key1', false);
    const info = store.getAll();
    expect(info[0].model).toBeNull();
  });

  it('setModel updates model for existing session', () => {
    const store = new SessionStore(60_000);
    store.getOrCreate('key1', false);
    store.setModel('key1', 'opus[1m]');
    const info = store.getAll();
    expect(info[0].model).toBe('opus[1m]');
  });

  it('getModel returns null for unknown session', () => {
    const store = new SessionStore(60_000);
    expect(store.getModel('nonexistent')).toBeNull();
  });

  it('tick() clears model when session expires', () => {
    vi.useFakeTimers();
    const store = new SessionStore(60_000);
    store.getOrCreate('key1', false);
    store.setModel('key1', 'opus');

    vi.advanceTimersByTime(61_000);
    store.tick();
    expect(store.getModel('key1')).toBeNull();
    expect(store.getAll()).toHaveLength(0);
    vi.useRealTimers();
  });

  it('calls onExpiry callback when session expires', () => {
    vi.useFakeTimers();
    const expired: string[] = [];
    const store = new SessionStore(60_000, { onExpiry: (key) => expired.push(key) });
    store.getOrCreate('key1', false);

    vi.advanceTimersByTime(61_000);
    store.tick();
    expect(expired).toEqual(['key1']);
    vi.useRealTimers();
  });
});

describe('SessionStore with persistence', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('persists new sessions to DB on create', () => {
    const db = new MockPersistence();
    const store = new SessionStore(60_000, { persistence: db });
    const { sdkSessionId } = store.getOrCreate('key1', false, 'discord', 'ch1', 'user1');

    const row = db.getByKey('key1');
    expect(row).not.toBeNull();
    expect(row!.sdk_session_id).toBe(sdkSessionId);
    expect(row!.platform).toBe('discord');
    expect(row!.channel_id).toBe('ch1');
    expect(row!.user_id).toBe('user1');
    expect(row!.status).toBe('active');
  });

  it('restores session from DB when not in memory', () => {
    const db = new MockPersistence();
    const now = Date.now();
    db.upsert({
      session_key: 'key1',
      sdk_session_id: 'sdk-123',
      user_id: 'user1',
      platform: 'discord',
      channel_id: 'ch1',
      is_group_channel: false,
      model: 'sonnet',
      status: 'active',
      created_at: now - 1000,
      last_activity: now - 1000,
    });

    const store = new SessionStore(60_000, { persistence: db });
    const { sdkSessionId, isNew } = store.getOrCreate('key1', false);

    expect(isNew).toBe(false);
    expect(sdkSessionId).toBe('sdk-123');
  });

  it('does not restore archived sessions from DB', () => {
    const db = new MockPersistence();
    db.upsert({
      session_key: 'key1',
      sdk_session_id: 'sdk-old',
      user_id: null,
      platform: 'discord',
      channel_id: 'ch1',
      is_group_channel: false,
      model: null,
      status: 'archived',
      created_at: Date.now() - 5000,
      last_activity: Date.now() - 5000,
    });

    const store = new SessionStore(60_000, { persistence: db });
    const { sdkSessionId, isNew } = store.getOrCreate('key1', false, 'discord', 'ch1');

    expect(isNew).toBe(true);
    expect(sdkSessionId).not.toBe('sdk-old');
  });

  it('restores paused sessions and sets them active', () => {
    const db = new MockPersistence();
    db.upsert({
      session_key: 'key1',
      sdk_session_id: 'sdk-paused',
      user_id: null,
      platform: 'discord',
      channel_id: 'ch1',
      is_group_channel: false,
      model: null,
      status: 'paused',
      created_at: Date.now() - 5000,
      last_activity: Date.now() - 5000,
    });

    const store = new SessionStore(60_000, { persistence: db });
    const { sdkSessionId, isNew } = store.getOrCreate('key1', false);

    expect(isNew).toBe(false);
    expect(sdkSessionId).toBe('sdk-paused');

    const row = db.getByKey('key1');
    expect(row!.status).toBe('active');
  });

  it('touch updates DB last_activity', () => {
    const db = new MockPersistence();
    const store = new SessionStore(60_000, { persistence: db });
    store.getOrCreate('key1', false, 'discord', 'ch1');

    const beforeTouch = db.getByKey('key1')!.last_activity;
    vi.advanceTimersByTime(5_000);
    store.touch('key1');

    const afterTouch = db.getByKey('key1')!.last_activity;
    expect(afterTouch).toBeGreaterThan(beforeTouch);
  });

  it('setModel persists to DB', () => {
    const db = new MockPersistence();
    const store = new SessionStore(60_000, { persistence: db });
    store.getOrCreate('key1', false, 'discord', 'ch1');
    store.setModel('key1', 'opus');

    expect(db.getByKey('key1')!.model).toBe('opus');
  });

  it('tick archives expired sessions in DB', () => {
    const db = new MockPersistence();
    const store = new SessionStore(60_000, { persistence: db });
    store.getOrCreate('key1', false, 'discord', 'ch1');

    vi.advanceTimersByTime(61_000);
    store.tick();

    expect(db.getByKey('key1')!.status).toBe('archived');
    expect(store.getAll()).toHaveLength(0);
  });

  it('tick skips paused sessions', () => {
    const db = new MockPersistence();
    const store = new SessionStore(60_000, { persistence: db });
    store.getOrCreate('key1', false, 'discord', 'ch1');
    store.pause('key1');

    vi.advanceTimersByTime(61_000);
    store.tick();

    // Paused session should not be expired by normal timeout
    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].status).toBe('paused');
  });

  it('tick syncs pause status from DB (out-of-band MCP write)', () => {
    const db = new MockPersistence();
    const store = new SessionStore(60_000, { persistence: db });
    store.getOrCreate('key1', false, 'discord', 'ch1');

    // Simulate MCP subprocess writing 'paused' directly to DB
    db.updateStatus('key1', 'paused');

    store.tick();

    const sessions = store.getAll();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('paused');
  });

  it('getModel syncs model from DB (out-of-band MCP write)', () => {
    const db = new MockPersistence();
    const store = new SessionStore(60_000, { persistence: db });
    store.getOrCreate('key1', false, 'discord', 'ch1');

    // Simulate MCP subprocess writing model directly to DB
    db.updateModel('key1', 'haiku');

    const model = store.getModel('key1');
    expect(model).toBe('haiku');
  });

  it('tick auto-archives paused sessions after maxPauseMs', () => {
    const db = new MockPersistence();
    const expired: string[] = [];
    const store = new SessionStore(60_000, {
      persistence: db,
      maxPauseMs: 120_000,
      onExpiry: (key) => expired.push(key),
    });
    store.getOrCreate('key1', false, 'discord', 'ch1');
    store.pause('key1');

    vi.advanceTimersByTime(121_000);
    store.tick();

    expect(store.getAll()).toHaveLength(0);
    expect(db.getByKey('key1')!.status).toBe('archived');
    expect(expired).toEqual(['key1']);
  });

  it('archive sets DB status and removes from memory', () => {
    const db = new MockPersistence();
    const store = new SessionStore(60_000, { persistence: db });
    store.getOrCreate('key1', false, 'discord', 'ch1');

    store.archive('key1');

    expect(store.getAll()).toHaveLength(0);
    expect(db.getByKey('key1')!.status).toBe('archived');
  });

  it('deleteSession hard-deletes from DB and memory', () => {
    const db = new MockPersistence();
    const store = new SessionStore(60_000, { persistence: db });
    store.getOrCreate('key1', false, 'discord', 'ch1');

    store.deleteSession('key1');

    expect(store.getAll()).toHaveLength(0);
    expect(db.getByKey('key1')).toBeNull();
  });

  it('hydrate loads active and paused sessions into memory', () => {
    const db = new MockPersistence();
    const now = Date.now();
    db.upsert({
      session_key: 'key1', sdk_session_id: 'sdk-1', user_id: null,
      platform: 'discord', channel_id: 'ch1', is_group_channel: false,
      model: 'opus', status: 'active', created_at: now, last_activity: now,
    });
    db.upsert({
      session_key: 'key2', sdk_session_id: 'sdk-2', user_id: null,
      platform: 'discord', channel_id: 'ch2', is_group_channel: true,
      model: null, status: 'paused', created_at: now, last_activity: now,
    });
    db.upsert({
      session_key: 'key3', sdk_session_id: 'sdk-3', user_id: null,
      platform: 'discord', channel_id: 'ch3', is_group_channel: false,
      model: null, status: 'archived', created_at: now - 10000, last_activity: now - 10000,
    });

    const store = new SessionStore(60_000, { persistence: db });
    store.hydrate();

    const all = store.getAll();
    expect(all).toHaveLength(2);
    expect(all.map(s => s.sessionKey).sort()).toEqual(['key1', 'key2']);
  });

  it('getHistory delegates to persistence', () => {
    const db = new MockPersistence();
    const now = Date.now();
    db.upsert({
      session_key: 'key1', sdk_session_id: 'sdk-1', user_id: null,
      platform: 'discord', channel_id: 'ch1', is_group_channel: false,
      model: null, status: 'archived', created_at: now, last_activity: now,
    });
    db.upsert({
      session_key: 'key2', sdk_session_id: 'sdk-2', user_id: null,
      platform: 'telegram', channel_id: 'ch2', is_group_channel: false,
      model: null, status: 'active', created_at: now, last_activity: now,
    });

    const store = new SessionStore(60_000, { persistence: db });

    const all = store.getHistory();
    expect(all).toHaveLength(2);

    const discordOnly = store.getHistory({ platform: 'discord' });
    expect(discordOnly).toHaveLength(1);
    expect(discordOnly[0].platform).toBe('discord');
  });

  it('getHistory returns empty when no persistence', () => {
    const store = new SessionStore(60_000);
    expect(store.getHistory()).toEqual([]);
  });
});
