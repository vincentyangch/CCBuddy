import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionStore } from '../session-store.js';

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
