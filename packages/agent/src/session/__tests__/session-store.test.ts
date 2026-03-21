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
});
