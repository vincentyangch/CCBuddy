import { describe, it, expect, vi } from 'vitest';
import type { NotificationConfig } from '@ccbuddy/core';
import { resolvePreferences } from '../resolve-preferences.js';

function makeConfig(overrides: Partial<NotificationConfig> = {}): NotificationConfig {
  return {
    enabled: true,
    default_target: { platform: 'discord', channel: 'dm' },
    quiet_hours: { start: '22:00', end: '08:00', timezone: 'America/New_York' },
    types: { health: true, memory: true, errors: true, sessions: false },
    ...overrides,
  };
}

function makeProfileStore(data: Record<string, Record<string, string>> = {}) {
  return {
    get(userId: string, key: string): string | undefined {
      return data[userId]?.[key];
    },
  };
}

describe('resolvePreferences', () => {
  it('returns config defaults when no profile overrides', () => {
    const config = makeConfig();
    const store = makeProfileStore();
    const prefs = resolvePreferences(config, store, 'alice');

    expect(prefs.enabled).toBe(true);
    expect(prefs.types).toEqual({ health: true, memory: true, errors: true, sessions: false });
    expect(prefs.target).toEqual({ platform: 'discord', channel: 'dm' });
    expect(prefs.quietHours).toEqual({ start: '22:00', end: '08:00', timezone: 'America/New_York' });
    expect(prefs.muteUntil).toBeNull();
  });

  it('profile overrides enabled', () => {
    const config = makeConfig({ enabled: true });
    const store = makeProfileStore({ alice: { notification_enabled: 'false' } });
    const prefs = resolvePreferences(config, store, 'alice');

    expect(prefs.enabled).toBe(false);
  });

  it('profile overrides types', () => {
    const config = makeConfig();
    const store = makeProfileStore({
      alice: { notification_types: JSON.stringify({ sessions: true, health: false }) },
    });
    const prefs = resolvePreferences(config, store, 'alice');

    // Merged: config defaults + profile overrides
    expect(prefs.types).toEqual({ health: false, memory: true, errors: true, sessions: true });
  });

  it('profile overrides target', () => {
    const config = makeConfig();
    const store = makeProfileStore({
      alice: { notification_target: JSON.stringify({ platform: 'telegram', channel: 'tg-123' }) },
    });
    const prefs = resolvePreferences(config, store, 'alice');

    expect(prefs.target).toEqual({ platform: 'telegram', channel: 'tg-123' });
  });

  it('profile overrides quiet hours', () => {
    const config = makeConfig();
    const store = makeProfileStore({
      alice: {
        notification_quiet_hours: JSON.stringify({ start: '23:00', end: '07:00', timezone: 'UTC' }),
      },
    });
    const prefs = resolvePreferences(config, store, 'alice');

    expect(prefs.quietHours).toEqual({ start: '23:00', end: '07:00', timezone: 'UTC' });
  });

  it('reads mute_until when set to future date', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const config = makeConfig();
    const store = makeProfileStore({
      alice: { notification_mute_until: future },
    });
    const prefs = resolvePreferences(config, store, 'alice');

    expect(prefs.muteUntil).toBeGreaterThan(Date.now());
  });

  it('expired mute_until returns null', () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const config = makeConfig();
    const store = makeProfileStore({
      alice: { notification_mute_until: past },
    });
    const prefs = resolvePreferences(config, store, 'alice');

    expect(prefs.muteUntil).toBeNull();
  });

  it('malformed JSON falls back to config defaults', () => {
    const config = makeConfig();
    const store = makeProfileStore({
      alice: {
        notification_types: 'not-json',
        notification_target: '{bad',
        notification_quiet_hours: '???',
      },
    });
    const prefs = resolvePreferences(config, store, 'alice');

    expect(prefs.types).toEqual(config.types);
    expect(prefs.target).toEqual(config.default_target);
    expect(prefs.quietHours).toEqual(config.quiet_hours);
  });
});
