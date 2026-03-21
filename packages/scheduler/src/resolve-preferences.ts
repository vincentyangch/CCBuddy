import type { NotificationConfig } from '@ccbuddy/core';
import type { NotificationPreferences } from './notification-service.js';

interface ProfileReader {
  get(userId: string, key: string): string | undefined;
}

export function resolvePreferences(
  config: NotificationConfig,
  profileStore: ProfileReader,
  userId: string,
): NotificationPreferences {
  // enabled: profile override or config default
  const enabledStr = profileStore.get(userId, 'notification_enabled');
  const enabled = enabledStr !== undefined ? enabledStr === 'true' : config.enabled;

  // types: config defaults merged with profile JSON override
  let types: Record<string, boolean> = { ...config.types };
  const typesStr = profileStore.get(userId, 'notification_types');
  if (typesStr) {
    try {
      types = { ...types, ...JSON.parse(typesStr) };
    } catch {
      // malformed JSON, keep config defaults
    }
  }

  // target
  let target = { ...config.default_target };
  const targetStr = profileStore.get(userId, 'notification_target');
  if (targetStr) {
    try {
      target = JSON.parse(targetStr);
    } catch {
      // malformed JSON, keep config default
    }
  }

  // quiet hours
  let quietHours: NotificationPreferences['quietHours'] = config.quiet_hours
    ? { ...config.quiet_hours }
    : null;
  const quietStr = profileStore.get(userId, 'notification_quiet_hours');
  if (quietStr) {
    try {
      quietHours = JSON.parse(quietStr);
    } catch {
      // malformed JSON, keep config default
    }
  }

  // mute until
  let muteUntil: number | null = null;
  const muteStr = profileStore.get(userId, 'notification_mute_until');
  if (muteStr) {
    const ts = new Date(muteStr).getTime();
    if (!isNaN(ts) && ts > Date.now()) muteUntil = ts;
  }

  return { enabled, types, target, quietHours, muteUntil };
}
