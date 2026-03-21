# Notification Preferences

**Date:** 2026-03-21
**Status:** Approved

## Problem

CCBuddy has no way to proactively notify users about system events. Health alerts go to a fixed channel (if configured), and memory/error/session events are only visible in logs. Users should receive relevant notifications via Discord DM (or a configured channel), with per-user preferences and quiet hours.

## Goals

1. Proactive notifications for: system health, memory lifecycle, errors, and new sessions
2. Per-user preferences with config file defaults and runtime overrides via chat
3. Quiet hours with queuing — notifications held during quiet period, flushed when it ends
4. Configurable delivery target per user (DM or specific channel)

## Non-Goals

- Notification history table (use existing message store for audit)
- Push notifications to mobile (rely on Discord's own push)
- Notification preferences UI in dashboard (configure via chat or config)
- Replacing scheduler briefings (those are full agent conversations, not notifications)

## Notification Types

| Type | Event Source | Example |
|------|-------------|---------|
| `health` | `alert.health` event | `[Health] Module "database" is degraded` |
| `memory` | `consolidation.complete`, `backup.complete`, `backup.integrity_failed` | `[Backup] Completed (14.2 MB)` |
| `errors` | `agent.error` (new event) | `[Error] Agent request failed for user dad in #general` |
| `sessions` | `message.incoming` (new session only) | `[Session] New chat started by dad on discord/#general` |

## Preference Data Model

Preferences are layered: config file defaults → ProfileStore overrides (per-user).

### Config Defaults

```yaml
notifications:
  enabled: true
  default_target:
    platform: discord
    channel: DM    # special value: resolve to user's DM channel at send time
  quiet_hours:
    start: "23:00"
    end: "07:00"
    timezone: "America/Chicago"
  types:
    health: true
    memory: true
    errors: true
    sessions: true
```

Added to `CCBuddyConfig` as `notifications: NotificationConfig`. Default values added to `DEFAULT_CONFIG` in `packages/core/src/config/schema.ts`.

### Per-User Overrides (ProfileStore)

Stored in `user_profiles` table with keys:

- `notification_enabled` → `"true"` / `"false"` (master switch)
- `notification_types` → JSON: `{"health": true, "memory": false, "errors": true, "sessions": true}`
- `notification_target` → JSON: `{"platform": "discord", "channel": "DM"}`
- `notification_quiet_hours` → JSON: `{"start": "23:00", "end": "07:00", "timezone": "America/Chicago"}`
- `notification_mute_until` → ISO timestamp for temporary mute (e.g., `"2026-03-21T20:00:00-05:00"`)

When a ProfileStore key exists, it overrides the config default. When absent, config default applies.

## Component Design

### NotificationService (new — `@ccbuddy/scheduler`)

**File:** `packages/scheduler/src/notification-service.ts`

Lives in `@ccbuddy/scheduler` alongside HeartbeatMonitor — both are runtime services with event subscriptions and side effects. `@ccbuddy/core` stays limited to types, config, and utilities. Preference types/interfaces can be defined in `@ccbuddy/core` for cross-package use.

```typescript
interface NotificationServiceDeps {
  eventBus: EventBus;
  sendProactiveMessage: (target: MessageTarget, text: string) => Promise<void>;
  getPreferences: (userId: string) => NotificationPreferences;
  getUsers: () => User[];
  resolveDMChannel: (platform: string, platformUserId: string) => Promise<string | null>;
}

class NotificationService {
  private queue: QueuedNotification[] = [];  // quiet hours queue, max 100 entries

  constructor(deps: NotificationServiceDeps)
  start(): void        // subscribe to events
  stop(): void         // unsubscribe
  tick(): void         // flush queued notifications if quiet hours ended
}
```

**Responsibilities:**
- Subscribes to event bus events on `start()`
- For each event: iterates all users, checks preferences, formats message, delivers or queues
- `tick()` called on the existing 60-second interval — checks if quiet hours ended, flushes queue

### Preference Resolution

```typescript
interface NotificationPreferences {
  enabled: boolean;
  types: Record<string, boolean>;
  target: MessageTarget;
  quietHours: { start: string; end: string; timezone: string } | null;
  muteUntil: number | null;  // epoch ms
}

function resolvePreferences(
  config: NotificationConfig,
  profileStore: ProfileStore,
  userId: string,
): NotificationPreferences
```

Reads config defaults, overlays any ProfileStore keys that exist. Returns a merged `NotificationPreferences` object.

### Event Subscriptions

The service subscribes to these events:

1. **`alert.health`** → type `health`
   - Format: `[Health] Module "{module}" is {status}`
   - Includes both degradation (healthy→degraded→down) and recovery transitions
   - HeartbeatMonitor already publishes `alert.health` for degradation. Extend to also publish on recovery (status: `'recovered'`) so NotificationService can format: `[Health] Module "{module}" has recovered`

2. **`consolidation.complete`** → type `memory`
   - Format: `[Memory] Consolidation complete: {messagesChunked} messages chunked, {condensedNodesCreated} nodes condensed`
   - Uses `ConsolidationStats` fields: `messagesChunked`, `condensedNodesCreated`

3. **`backup.complete`** → type `memory`
   - Format: `[Backup] Completed successfully`

4. **`backup.integrity_failed`** → type `memory`
   - Format: `[Backup] Integrity check failed — manual review needed`

5. **Agent errors** → type `errors`
   - New event: `agent.error` published by gateway in the `executeAndRoute` catch block (around line 460 of `gateway.ts`), right before sending the error message to the user
   - Format: `[Error] Agent request failed for {userId} in {channelId}`
   - Payload: `{ userId, platform, channelId, error: string, timestamp }`
   - Self-notification suppressed: skip notifying the user who triggered the error (they already see the error reply)

6. **`session.started`** → type `sessions`
   - Published by gateway in `handleIncomingMessage`, after the session lookup block (around line 172 of `gateway.ts`), when `isNewSession` is true
   - Format: `[Session] New chat started by {userId} on {platform}/{channelId}`
   - Self-notification suppressed: skip notifying the user who started the session

### DM Channel Resolution

When target channel is `"DM"`:

1. Look up user's platform ID from `User.platformIds`
2. Use Discord client to create/fetch DM channel: `client.users.fetch(platformUserId).then(u => u.createDM())`
3. Cache the DM channel ID in memory (Map) to avoid repeated API calls
4. If resolution fails (user not found, bot can't DM), log warning and skip

Add `resolveDMChannel` as an optional method on the `PlatformAdapter` interface in `packages/core/src/types/platform.ts` (consistent with how `editMessage`, `sendButtons`, and `sendVoice` are optional):

```typescript
// In PlatformAdapter interface
resolveDMChannel?(platformUserId: string): Promise<string | null>;
```

Discord adapter implements it:

```typescript
async resolveDMChannel(platformUserId: string): Promise<string | null> {
  try {
    const user = await this.client.users.fetch(platformUserId);
    const dm = await user.createDM();
    return dm.id;
  } catch {
    return null;
  }
}
```

Telegram adapter can implement it later if needed.

### Quiet Hours

Quiet hours are checked against the user's configured timezone:

```typescript
function isQuietHours(prefs: NotificationPreferences): boolean {
  if (!prefs.quietHours) return false;
  const now = new Date();
  // Convert to user's timezone, compare against start/end times
  // Handle overnight ranges (e.g., 23:00 → 07:00)
}
```

When quiet hours are active:
- Notifications are queued in memory (`queue: QueuedNotification[]`), max 100 entries per user
- When queue exceeds max, oldest notifications are dropped
- Each tick (60s), check if quiet hours ended → flush queue
- Queue is not persisted — notifications during a restart within quiet hours are lost (acceptable)

### Temporary Mute

The `notification_mute` MCP tool sets `notification_mute_until` in ProfileStore:

```typescript
// notification_mute tool input: { minutes: number }
// Sets: notification_mute_until = new Date(Date.now() + minutes * 60000).toISOString()
```

Preference resolution checks `muteUntil` — if set and in future, treat as `enabled: false`.

### Heartbeat Alert Migration

Currently, HeartbeatMonitor sends alerts directly via `sendProactiveMessage` to a fixed `alertTarget`. With NotificationService:

- HeartbeatMonitor continues to publish `alert.health` events (already does this for degradation)
- Extend HeartbeatMonitor to also publish `alert.health` on recovery transitions (degraded→healthy, down→healthy) with status `'recovered'`
- Remove direct `sendProactiveMessage` calls from HeartbeatMonitor — NotificationService handles all delivery
- Remove `alertTarget` from HeartbeatMonitor config
- `sendProactiveMessage` dependency can be removed from HeartbeatMonitor constructor

## MCP Tools

### `notification_get`

Returns current notification preferences for the calling user.

```typescript
{
  name: 'notification_get',
  description: 'Get the current notification preferences for this user.',
  inputSchema: { type: 'object', properties: {} }
}
```

Response: JSON of merged preferences (config + profile overrides).

### `notification_set`

Updates notification preferences.

```typescript
{
  name: 'notification_set',
  description: 'Update notification preferences. Can enable/disable specific notification types, change delivery target, or set quiet hours.',
  inputSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', description: 'Master notification switch' },
      type: { type: 'string', description: 'Notification type to configure (health, memory, errors, sessions)' },
      type_enabled: { type: 'boolean', description: 'Enable/disable the specified type' },
      target_platform: { type: 'string' },
      target_channel: { type: 'string' },
      quiet_start: { type: 'string', description: 'Quiet hours start (HH:MM)' },
      quiet_end: { type: 'string', description: 'Quiet hours end (HH:MM)' },
      quiet_timezone: { type: 'string' },
    }
  }
}
```

### `notification_mute`

Temporarily mute all notifications.

```typescript
{
  name: 'notification_mute',
  description: 'Mute all notifications for a specified number of minutes.',
  inputSchema: {
    type: 'object',
    properties: {
      minutes: { type: 'number', description: 'Minutes to mute (0 to unmute)' }
    },
    required: ['minutes']
  }
}
```

## New Events

Add to `EventMap` in `packages/core/src/types/events.ts`:

```typescript
'agent.error': {
  userId: string;
  platform: string;
  channelId: string;
  error: string;
  timestamp: number;
};

'session.started': {
  userId: string;
  platform: string;
  channelId: string;
  sessionKey: string;
  timestamp: number;
};
```

## Bootstrap Wiring

```typescript
const notificationService = new NotificationService({
  eventBus,
  sendProactiveMessage,
  getPreferences: (userId) => resolvePreferences(config.notifications, profileStore, userId),
  getUsers: () => userManager.getAll(),  // UserManager.getAll() returns User[]
  resolveDMChannel: async (platform, platformUserId) => {
    const adapter = gateway.getAdapter(platform);
    return adapter?.resolveDMChannel?.(platformUserId) ?? null;
  },
});
notificationService.start();

// Add tick to existing interval
tickInterval = setInterval(() => {
  agentService.tick();
  sessionStore.tick();
  notificationService.tick();  // flush quiet hours queue
}, 60_000);
```

Note: `UserManager.getAll()` needs to be added — returns all registered users. Currently UserManager has `findByPlatformId` and `findByName` but no way to iterate all users.

## What Stays the Same

- Event bus and all existing event publishers
- ProfileStore API and storage
- Scheduler briefings (separate concern)
- sendProactiveMessage implementation
- Gateway message routing

## Testing

- **NotificationService:** event subscription, preference filtering, quiet hours queueing/flushing, mute logic, DM resolution
- **resolvePreferences:** config-only, profile override, partial override, mute active/expired
- **isQuietHours:** same-day range, overnight range, timezone conversion
- **MCP tools:** get/set/mute round-trips
- **Integration:** health alert → notification delivered to correct user based on preferences
