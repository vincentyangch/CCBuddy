# Notification Preferences Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Proactive notifications for system health, memory lifecycle, errors, and new sessions — delivered via Discord DM or configured channel, with per-user preferences and quiet hours.

**Architecture:** A `NotificationService` in `@ccbuddy/scheduler` subscribes to events, checks per-user preferences (config defaults + ProfileStore overrides), respects quiet hours (queuing), and delivers via `sendProactiveMessage`. MCP tools let users configure preferences at runtime. Heartbeat migrated from direct sending to event-only.

**Tech Stack:** TypeScript, Vitest, better-sqlite3 (ProfileStore)

**Spec:** `docs/superpowers/specs/2026-03-21-notification-preferences-design.md`

---

## Chunk 1: Core Types + Config

### Task 1: Add new events to EventMap

**Files:**
- Modify: `packages/core/src/types/events.ts:41-46,111-124`

- [ ] **Step 1: Extend HealthAlertEvent to support recovery**

In `packages/core/src/types/events.ts`, update the `HealthAlertEvent` interface (line 41-46):

```typescript
export interface HealthAlertEvent {
  module: string;
  status: 'degraded' | 'down' | 'recovered';
  message: string;
  timestamp: number;
}
```

- [ ] **Step 2: Add AgentErrorEvent and SessionStartedEvent**

Add before the `EventMap` interface (before line 111):

```typescript
export interface AgentErrorEvent {
  userId: string;
  platform: string;
  channelId: string;
  error: string;
  timestamp: number;
}

export interface SessionStartedEvent {
  userId: string;
  platform: string;
  channelId: string;
  sessionKey: string;
  timestamp: number;
}
```

- [ ] **Step 3: Add new events to EventMap**

In the `EventMap` interface, add after `'session.model_changed'` (line 123):

```typescript
  'agent.error': AgentErrorEvent;
  'session.started': SessionStartedEvent;
```

- [ ] **Step 4: Build and verify**

Run: `npm run build -w packages/core`
Expected: Clean build

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types/events.ts
git commit -m "feat(core): add agent.error, session.started events and recovery status to health alerts"
```

---

### Task 2: Add NotificationConfig to config schema

**Files:**
- Modify: `packages/core/src/config/schema.ts:155-180,269-276`

- [ ] **Step 1: Add NotificationConfig interface**

In `packages/core/src/config/schema.ts`, add after `DashboardConfig` (after line 162):

```typescript
export interface NotificationConfig {
  enabled: boolean;
  default_target: {
    platform: string;
    channel: string;  // 'DM' = resolve to user's DM channel
  };
  quiet_hours: {
    start: string;  // HH:MM
    end: string;    // HH:MM
    timezone: string;
  };
  types: {
    health: boolean;
    memory: boolean;
    errors: boolean;
    sessions: boolean;
  };
}
```

- [ ] **Step 2: Add to CCBuddyConfig**

Add `notifications: NotificationConfig;` to the `CCBuddyConfig` interface (after `dashboard` on line 178):

```typescript
  notifications: NotificationConfig;
```

- [ ] **Step 3: Add defaults to DEFAULT_CONFIG**

Add after the `dashboard` section in `DEFAULT_CONFIG` (after line 274, before `users`):

```typescript
  notifications: {
    enabled: true,
    default_target: {
      platform: 'discord',
      channel: 'DM',
    },
    quiet_hours: {
      start: '23:00',
      end: '07:00',
      timezone: 'America/Chicago',
    },
    types: {
      health: true,
      memory: true,
      errors: true,
      sessions: true,
    },
  },
```

- [ ] **Step 4: Build and verify**

Run: `npm run build -w packages/core`
Expected: Clean build

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/schema.ts
git commit -m "feat(core): add NotificationConfig to config schema with defaults"
```

---

### Task 3: Add `resolveDMChannel` to PlatformAdapter interface

**Files:**
- Modify: `packages/core/src/types/platform.ts:15-34`
- Modify: `packages/platforms/discord/src/discord-adapter.ts`

- [ ] **Step 1: Add optional method to PlatformAdapter**

In `packages/core/src/types/platform.ts`, add after `sendButtons?` (before the closing brace on line 34):

```typescript
  /** Resolve a DM channel ID for a platform user. Returns null if DM cannot be created. */
  resolveDMChannel?(platformUserId: string): Promise<string | null>;
```

- [ ] **Step 2: Implement in Discord adapter**

In `packages/platforms/discord/src/discord-adapter.ts`, add a new method to the `DiscordAdapter` class:

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

- [ ] **Step 3: Build and verify**

Run: `npm run build -w packages/core -w packages/platform-discord`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types/platform.ts packages/platforms/discord/src/discord-adapter.ts
git commit -m "feat(core,discord): add resolveDMChannel to PlatformAdapter interface"
```

---

## Chunk 2: NotificationService

### Task 4: Implement NotificationService

**Files:**
- Create: `packages/scheduler/src/notification-service.ts`
- Create: `packages/scheduler/src/__tests__/notification-service.test.ts`
- Modify: `packages/scheduler/src/index.ts`

- [ ] **Step 1: Write the tests**

Create `packages/scheduler/src/__tests__/notification-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotificationService } from '../notification-service.js';
import type { NotificationPreferences } from '../notification-service.js';
import type { EventBus, MessageTarget, Disposable } from '@ccbuddy/core';

function createMockEventBus(): EventBus & { handlers: Map<string, Function[]> } {
  const handlers = new Map<string, Function[]>();
  return {
    handlers,
    publish: vi.fn(async (event: string, payload: any) => {
      for (const h of handlers.get(event) ?? []) h(payload);
    }),
    subscribe: vi.fn((event: string, handler: Function): Disposable => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
      return { dispose: () => {} };
    }),
  };
}

function defaultPrefs(overrides?: Partial<NotificationPreferences>): NotificationPreferences {
  return {
    enabled: true,
    types: { health: true, memory: true, errors: true, sessions: true },
    target: { platform: 'discord', channel: 'DM' },
    quietHours: null,
    muteUntil: null,
    ...overrides,
  };
}

describe('NotificationService', () => {
  let eventBus: ReturnType<typeof createMockEventBus>;
  let sendProactiveMessage: ReturnType<typeof vi.fn>;
  let resolveDMChannel: ReturnType<typeof vi.fn>;
  let service: NotificationService;
  const users = [
    { name: 'dad', role: 'admin' as const, platformIds: { discord: '123' } },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = createMockEventBus();
    sendProactiveMessage = vi.fn().mockResolvedValue(undefined);
    resolveDMChannel = vi.fn().mockResolvedValue('dm-channel-123');
  });

  afterEach(() => {
    vi.useRealTimers();
    service?.stop();
  });

  function createService(prefs?: NotificationPreferences) {
    service = new NotificationService({
      eventBus,
      sendProactiveMessage,
      getPreferences: () => prefs ?? defaultPrefs(),
      getUsers: () => users,
      resolveDMChannel,
    });
    service.start();
    return service;
  }

  it('delivers health alert to user via DM', async () => {
    createService();
    await eventBus.publish('alert.health', {
      module: 'database',
      status: 'degraded',
      message: 'test',
      timestamp: Date.now(),
    });
    expect(resolveDMChannel).toHaveBeenCalledWith('discord', '123');
    expect(sendProactiveMessage).toHaveBeenCalledWith(
      { platform: 'discord', channel: 'dm-channel-123' },
      expect.stringContaining('[Health]'),
    );
  });

  it('delivers health recovery notification', async () => {
    createService();
    await eventBus.publish('alert.health', {
      module: 'database',
      status: 'recovered',
      message: 'recovered',
      timestamp: Date.now(),
    });
    expect(sendProactiveMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('[Health]'),
    );
    expect(sendProactiveMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('recovered'),
    );
  });

  it('skips notification when type is disabled', async () => {
    createService(defaultPrefs({ types: { health: false, memory: true, errors: true, sessions: true } }));
    await eventBus.publish('alert.health', {
      module: 'database',
      status: 'degraded',
      message: 'test',
      timestamp: Date.now(),
    });
    expect(sendProactiveMessage).not.toHaveBeenCalled();
  });

  it('skips notification when master switch is off', async () => {
    createService(defaultPrefs({ enabled: false }));
    await eventBus.publish('alert.health', {
      module: 'database',
      status: 'degraded',
      message: 'test',
      timestamp: Date.now(),
    });
    expect(sendProactiveMessage).not.toHaveBeenCalled();
  });

  it('skips notification when muted', async () => {
    createService(defaultPrefs({ muteUntil: Date.now() + 60_000 }));
    await eventBus.publish('alert.health', {
      module: 'database',
      status: 'degraded',
      message: 'test',
      timestamp: Date.now(),
    });
    expect(sendProactiveMessage).not.toHaveBeenCalled();
  });

  it('queues notification during quiet hours', async () => {
    // Set quiet hours to current time window
    const now = new Date();
    const startHour = now.getHours();
    const endHour = (startHour + 2) % 24;
    const start = `${String(startHour).padStart(2, '0')}:00`;
    const end = `${String(endHour).padStart(2, '0')}:00`;

    createService(defaultPrefs({
      quietHours: { start, end, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    }));

    await eventBus.publish('alert.health', {
      module: 'database',
      status: 'degraded',
      message: 'test',
      timestamp: Date.now(),
    });

    // Should be queued, not sent
    expect(sendProactiveMessage).not.toHaveBeenCalled();
    expect(service.queueSize).toBe(1);
  });

  it('flushes queue when quiet hours end', async () => {
    // Set quiet hours that have already ended
    const now = new Date();
    const endHour = (now.getHours() - 1 + 24) % 24;
    const startHour = (endHour - 2 + 24) % 24;
    const start = `${String(startHour).padStart(2, '0')}:00`;
    const end = `${String(endHour).padStart(2, '0')}:00`;

    createService(defaultPrefs({
      quietHours: { start, end, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    }));

    // Manually add to queue
    (service as any).queue.push({
      userId: 'dad',
      target: { platform: 'discord', channel: 'dm-channel-123' },
      message: '[Health] Test',
      timestamp: Date.now(),
    });

    service.tick();
    // Wait for async flush
    await vi.advanceTimersByTimeAsync(100);

    expect(sendProactiveMessage).toHaveBeenCalledWith(
      { platform: 'discord', channel: 'dm-channel-123' },
      '[Health] Test',
    );
  });

  it('caps queue at 100 entries per user', async () => {
    const now = new Date();
    const startHour = now.getHours();
    const endHour = (startHour + 2) % 24;
    const start = `${String(startHour).padStart(2, '0')}:00`;
    const end = `${String(endHour).padStart(2, '0')}:00`;

    createService(defaultPrefs({
      quietHours: { start, end, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    }));

    for (let i = 0; i < 110; i++) {
      await eventBus.publish('alert.health', {
        module: 'database',
        status: 'degraded',
        message: `test-${i}`,
        timestamp: Date.now(),
      });
    }

    expect(service.queueSize).toBeLessThanOrEqual(100);
  });

  it('delivers to fixed channel when target is not DM', async () => {
    createService(defaultPrefs({
      target: { platform: 'discord', channel: 'fixed-channel-456' },
    }));
    await eventBus.publish('alert.health', {
      module: 'database',
      status: 'degraded',
      message: 'test',
      timestamp: Date.now(),
    });
    expect(resolveDMChannel).not.toHaveBeenCalled();
    expect(sendProactiveMessage).toHaveBeenCalledWith(
      { platform: 'discord', channel: 'fixed-channel-456' },
      expect.stringContaining('[Health]'),
    );
  });

  it('delivers backup.complete as memory notification', async () => {
    createService();
    await eventBus.publish('backup.complete', { path: '/tmp/backup.db' });
    expect(sendProactiveMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('[Backup]'),
    );
  });

  it('delivers consolidation.complete as memory notification', async () => {
    createService();
    await eventBus.publish('consolidation.complete', {
      userId: 'dad',
      messagesChunked: 42,
      leafNodesCreated: 5,
      condensedNodesCreated: 2,
      messagesPruned: 10,
    });
    expect(sendProactiveMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('[Memory]'),
    );
  });

  it('suppresses self-notification for session.started', async () => {
    createService();
    await eventBus.publish('session.started', {
      userId: 'dad',
      platform: 'discord',
      channelId: 'ch1',
      sessionKey: 'dad-discord-ch1',
      timestamp: Date.now(),
    });
    // dad started the session, dad is the only user — no notification
    expect(sendProactiveMessage).not.toHaveBeenCalled();
  });

  it('suppresses self-notification for agent.error', async () => {
    createService();
    await eventBus.publish('agent.error', {
      userId: 'dad',
      platform: 'discord',
      channelId: 'ch1',
      error: 'test error',
      timestamp: Date.now(),
    });
    // dad caused the error, dad is the only user — no notification
    expect(sendProactiveMessage).not.toHaveBeenCalled();
  });

  it('notifies other users for session.started (not self)', async () => {
    const multiUsers = [
      { name: 'dad', role: 'admin' as const, platformIds: { discord: '123' } },
      { name: 'mom', role: 'admin' as const, platformIds: { discord: '456' } },
    ];
    service = new NotificationService({
      eventBus,
      sendProactiveMessage,
      getPreferences: () => defaultPrefs(),
      getUsers: () => multiUsers,
      resolveDMChannel,
    });
    service.start();

    await eventBus.publish('session.started', {
      userId: 'dad',
      platform: 'discord',
      channelId: 'ch1',
      sessionKey: 'dad-discord-ch1',
      timestamp: Date.now(),
    });

    // mom should be notified, dad should not
    expect(sendProactiveMessage).toHaveBeenCalledTimes(1);
    expect(resolveDMChannel).toHaveBeenCalledWith('discord', '456');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/scheduler -- --run`
Expected: FAIL — `notification-service.ts` does not exist

- [ ] **Step 3: Implement NotificationService**

Create `packages/scheduler/src/notification-service.ts`:

```typescript
import type { EventBus, MessageTarget, Disposable, User } from '@ccbuddy/core';

export interface NotificationPreferences {
  enabled: boolean;
  types: Record<string, boolean>;
  target: MessageTarget;
  quietHours: { start: string; end: string; timezone: string } | null;
  muteUntil: number | null;
}

export interface NotificationServiceDeps {
  eventBus: EventBus;
  sendProactiveMessage: (target: MessageTarget, text: string) => Promise<void>;
  getPreferences: (userId: string) => NotificationPreferences;
  getUsers: () => ReadonlyArray<User>;
  resolveDMChannel: (platform: string, platformUserId: string) => Promise<string | null>;
}

interface QueuedNotification {
  userId: string;
  target: MessageTarget;
  message: string;
  timestamp: number;
}

const MAX_QUEUE_PER_USER = 100;

export class NotificationService {
  private readonly deps: NotificationServiceDeps;
  private readonly subscriptions: Disposable[] = [];
  private readonly dmCache = new Map<string, string>(); // platform:userId → channelId
  queue: QueuedNotification[] = [];

  constructor(deps: NotificationServiceDeps) {
    this.deps = deps;
  }

  get queueSize(): number {
    return this.queue.length;
  }

  start(): void {
    const { eventBus } = this.deps;

    this.subscriptions.push(
      eventBus.subscribe('alert.health', (e) => {
        const status = e.status === 'recovered'
          ? `Module "${e.module}" has recovered`
          : `Module "${e.module}" is ${e.status}`;
        this.notify('health', `[Health] ${status}`, null);
      }),
      eventBus.subscribe('consolidation.complete', (e) => {
        this.notify(
          'memory',
          `[Memory] Consolidation complete: ${e.messagesChunked} messages chunked, ${e.condensedNodesCreated} nodes condensed`,
          null,
        );
      }),
      eventBus.subscribe('backup.complete', () => {
        this.notify('memory', '[Backup] Completed successfully', null);
      }),
      eventBus.subscribe('backup.integrity_failed', (e) => {
        this.notify('memory', `[Backup] Integrity check failed: ${e.error}`, null);
      }),
      eventBus.subscribe('agent.error', (e) => {
        this.notify('errors', `[Error] Agent request failed for ${e.userId} in ${e.channelId}`, e.userId);
      }),
      eventBus.subscribe('session.started', (e) => {
        this.notify('sessions', `[Session] New chat started by ${e.userId} on ${e.platform}/${e.channelId}`, e.userId);
      }),
    );
  }

  stop(): void {
    for (const sub of this.subscriptions) sub.dispose();
    this.subscriptions.length = 0;
  }

  tick(): void {
    if (this.queue.length === 0) return;

    const toFlush: QueuedNotification[] = [];
    const remaining: QueuedNotification[] = [];

    for (const item of this.queue) {
      const prefs = this.deps.getPreferences(item.userId);
      if (this.isQuietHours(prefs)) {
        remaining.push(item);
      } else {
        toFlush.push(item);
      }
    }

    this.queue = remaining;

    for (const item of toFlush) {
      this.deps.sendProactiveMessage(item.target, item.message).catch((err) => {
        console.error(`[Notifications] Failed to flush queued notification for ${item.userId}:`, err);
      });
    }
  }

  private async notify(type: string, message: string, skipUserId: string | null): Promise<void> {
    const users = this.deps.getUsers();

    for (const user of users) {
      // Self-notification suppression
      if (skipUserId && user.name === skipUserId) continue;

      const prefs = this.deps.getPreferences(user.name);

      // Master switch
      if (!prefs.enabled) continue;

      // Mute check
      if (prefs.muteUntil && prefs.muteUntil > Date.now()) continue;

      // Type check
      if (!prefs.types[type]) continue;

      // Resolve target
      const target = await this.resolveTarget(prefs.target, user);
      if (!target) continue;

      // Quiet hours check — queue if in quiet hours
      if (this.isQuietHours(prefs)) {
        this.enqueue(user.name, target, message);
        continue;
      }

      // Deliver
      try {
        await this.deps.sendProactiveMessage(target, message);
      } catch (err) {
        console.error(`[Notifications] Failed to notify ${user.name}:`, err);
      }
    }
  }

  private async resolveTarget(target: MessageTarget, user: User): Promise<MessageTarget | null> {
    if (target.channel !== 'DM') {
      return target;
    }

    // Find the user's platform ID for the target platform
    const platformUserId = user.platformIds[target.platform];
    if (!platformUserId) return null;

    // Check cache
    const cacheKey = `${target.platform}:${platformUserId}`;
    const cached = this.dmCache.get(cacheKey);
    if (cached) return { platform: target.platform, channel: cached };

    // Resolve DM channel
    const channelId = await this.deps.resolveDMChannel(target.platform, platformUserId);
    if (!channelId) return null;

    this.dmCache.set(cacheKey, channelId);
    return { platform: target.platform, channel: channelId };
  }

  private enqueue(userId: string, target: MessageTarget, message: string): void {
    // Count existing entries for this user
    const userCount = this.queue.filter(q => q.userId === userId).length;
    if (userCount >= MAX_QUEUE_PER_USER) {
      // Drop oldest for this user
      const idx = this.queue.findIndex(q => q.userId === userId);
      if (idx !== -1) this.queue.splice(idx, 1);
    }

    this.queue.push({ userId, target, message, timestamp: Date.now() });
  }

  private isQuietHours(prefs: NotificationPreferences): boolean {
    if (!prefs.quietHours) return false;

    const { start, end, timezone } = prefs.quietHours;
    const now = new Date();

    // Get current time in user's timezone
    const timeStr = now.toLocaleTimeString('en-US', {
      timeZone: timezone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });

    const [startH, startM] = start.split(':').map(Number);
    const [endH, endM] = end.split(':').map(Number);
    const [nowH, nowM] = timeStr.split(':').map(Number);

    const startMin = startH * 60 + startM;
    const endMin = endH * 60 + endM;
    const nowMin = nowH * 60 + nowM;

    if (startMin <= endMin) {
      // Same-day range: e.g., 09:00 to 17:00
      return nowMin >= startMin && nowMin < endMin;
    } else {
      // Overnight range: e.g., 23:00 to 07:00
      return nowMin >= startMin || nowMin < endMin;
    }
  }
}
```

- [ ] **Step 4: Export from scheduler index**

Add to `packages/scheduler/src/index.ts` after the HeartbeatMonitor export (after line 17):

```typescript
export { NotificationService } from './notification-service.js';
export type { NotificationPreferences, NotificationServiceDeps } from './notification-service.js';
```

- [ ] **Step 5: Build and run tests**

Run: `npm run build -w packages/core -w packages/scheduler && npm test -w packages/scheduler -- --run`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add packages/scheduler/src/notification-service.ts packages/scheduler/src/__tests__/notification-service.test.ts packages/scheduler/src/index.ts
git commit -m "feat(scheduler): add NotificationService with preference filtering and quiet hours"
```

---

### Task 5: Implement preference resolution

**Files:**
- Create: `packages/scheduler/src/resolve-preferences.ts`
- Create: `packages/scheduler/src/__tests__/resolve-preferences.test.ts`

- [ ] **Step 1: Write the tests**

Create `packages/scheduler/src/__tests__/resolve-preferences.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { resolvePreferences } from '../resolve-preferences.js';
import type { NotificationConfig } from '@ccbuddy/core';

const defaultConfig: NotificationConfig = {
  enabled: true,
  default_target: { platform: 'discord', channel: 'DM' },
  quiet_hours: { start: '23:00', end: '07:00', timezone: 'America/Chicago' },
  types: { health: true, memory: true, errors: true, sessions: true },
};

function mockProfileStore(data: Record<string, string> = {}) {
  return {
    get: vi.fn((userId: string, key: string) => data[key]),
    getAll: vi.fn(() => data),
  };
}

describe('resolvePreferences', () => {
  it('returns config defaults when no profile overrides', () => {
    const prefs = resolvePreferences(defaultConfig, mockProfileStore(), 'dad');
    expect(prefs.enabled).toBe(true);
    expect(prefs.types).toEqual({ health: true, memory: true, errors: true, sessions: true });
    expect(prefs.target).toEqual({ platform: 'discord', channel: 'DM' });
    expect(prefs.quietHours).toEqual({ start: '23:00', end: '07:00', timezone: 'America/Chicago' });
    expect(prefs.muteUntil).toBeNull();
  });

  it('overrides enabled from profile', () => {
    const prefs = resolvePreferences(defaultConfig, mockProfileStore({ notification_enabled: 'false' }), 'dad');
    expect(prefs.enabled).toBe(false);
  });

  it('overrides types from profile', () => {
    const prefs = resolvePreferences(
      defaultConfig,
      mockProfileStore({ notification_types: JSON.stringify({ health: false, memory: true, errors: true, sessions: false }) }),
      'dad',
    );
    expect(prefs.types.health).toBe(false);
    expect(prefs.types.sessions).toBe(false);
    expect(prefs.types.memory).toBe(true);
  });

  it('overrides target from profile', () => {
    const prefs = resolvePreferences(
      defaultConfig,
      mockProfileStore({ notification_target: JSON.stringify({ platform: 'telegram', channel: 'ch1' }) }),
      'dad',
    );
    expect(prefs.target).toEqual({ platform: 'telegram', channel: 'ch1' });
  });

  it('overrides quiet hours from profile', () => {
    const prefs = resolvePreferences(
      defaultConfig,
      mockProfileStore({ notification_quiet_hours: JSON.stringify({ start: '22:00', end: '06:00', timezone: 'UTC' }) }),
      'dad',
    );
    expect(prefs.quietHours).toEqual({ start: '22:00', end: '06:00', timezone: 'UTC' });
  });

  it('reads mute_until from profile', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const prefs = resolvePreferences(
      defaultConfig,
      mockProfileStore({ notification_mute_until: future }),
      'dad',
    );
    expect(prefs.muteUntil).toBeGreaterThan(Date.now() - 1000);
  });

  it('returns null muteUntil when expired', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const prefs = resolvePreferences(
      defaultConfig,
      mockProfileStore({ notification_mute_until: past }),
      'dad',
    );
    expect(prefs.muteUntil).toBeNull();
  });

  it('handles malformed JSON gracefully', () => {
    const prefs = resolvePreferences(
      defaultConfig,
      mockProfileStore({ notification_types: 'not-json' }),
      'dad',
    );
    // Should fall back to config defaults
    expect(prefs.types).toEqual({ health: true, memory: true, errors: true, sessions: true });
  });
});
```

- [ ] **Step 2: Implement resolvePreferences**

Create `packages/scheduler/src/resolve-preferences.ts`:

```typescript
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
  // Enabled
  const enabledStr = profileStore.get(userId, 'notification_enabled');
  const enabled = enabledStr !== undefined ? enabledStr === 'true' : config.enabled;

  // Types
  let types = { ...config.types };
  const typesStr = profileStore.get(userId, 'notification_types');
  if (typesStr) {
    try {
      const parsed = JSON.parse(typesStr);
      types = { ...types, ...parsed };
    } catch { /* use config defaults */ }
  }

  // Target
  let target = { ...config.default_target };
  const targetStr = profileStore.get(userId, 'notification_target');
  if (targetStr) {
    try {
      target = JSON.parse(targetStr);
    } catch { /* use config defaults */ }
  }

  // Quiet hours
  let quietHours = config.quiet_hours ? { ...config.quiet_hours } : null;
  const quietStr = profileStore.get(userId, 'notification_quiet_hours');
  if (quietStr) {
    try {
      quietHours = JSON.parse(quietStr);
    } catch { /* use config defaults */ }
  }

  // Mute until
  let muteUntil: number | null = null;
  const muteStr = profileStore.get(userId, 'notification_mute_until');
  if (muteStr) {
    const ts = new Date(muteStr).getTime();
    if (!isNaN(ts) && ts > Date.now()) {
      muteUntil = ts;
    }
  }

  return { enabled, types, target, quietHours, muteUntil };
}
```

- [ ] **Step 3: Export from scheduler index**

Add to `packages/scheduler/src/index.ts`:

```typescript
export { resolvePreferences } from './resolve-preferences.js';
```

- [ ] **Step 4: Build and run tests**

Run: `npm run build -w packages/scheduler && npm test -w packages/scheduler -- --run`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/scheduler/src/resolve-preferences.ts packages/scheduler/src/__tests__/resolve-preferences.test.ts packages/scheduler/src/index.ts
git commit -m "feat(scheduler): add resolvePreferences for config + ProfileStore layering"
```

---

## Chunk 3: Event Publishers + Heartbeat Migration

### Task 6: Publish session.started and agent.error events from gateway

**Files:**
- Modify: `packages/gateway/src/gateway.ts`

- [ ] **Step 1: Publish session.started when a new session is created**

In `packages/gateway/src/gateway.ts`, after the session lookup block (where `isNewSession` is set, around line 172), add inside the `if (this.deps.sessionStore)` block, after setting `sdkSessionId`:

```typescript
      if (session.isNew) {
        sdkSessionId = session.sdkSessionId;
        // Publish session.started event for notifications
        void this.deps.eventBus.publish('session.started', {
          userId: user.name,
          platform: msg.platform,
          channelId: msg.channelId,
          sessionKey,
          timestamp: Date.now(),
        });
      }
```

- [ ] **Step 2: Publish agent.error in the executeAndRoute catch block**

In the catch block of `executeAndRoute` (around line 460), add before the error message is sent to the user:

```typescript
      // Publish agent.error event for notifications
      void this.deps.eventBus.publish('agent.error', {
        userId: request.userId,
        platform: msg.platform,
        channelId: msg.channelId,
        error: (err as Error).message ?? String(err),
        timestamp: Date.now(),
      });
```

- [ ] **Step 3: Build and run gateway tests**

Run: `npm run build -w packages/gateway && npm test -w packages/gateway -- --run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): publish session.started and agent.error events"
```

---

### Task 7: Migrate heartbeat to publish recovery events and remove direct sending

**Files:**
- Modify: `packages/scheduler/src/heartbeat.ts:177-218`

- [ ] **Step 1: Add recovery event publishing**

In `packages/scheduler/src/heartbeat.ts`, in the `handleTransitions` method (around line 209-216), add after the recovery check:

```typescript
      if (isRecovery) {
        // Publish recovery event
        await this.opts.eventBus.publish('alert.health', {
          module,
          status: 'recovered' as any,  // type extended to include 'recovered'
          message: `Module "${module}" has recovered`,
          timestamp: Date.now(),
        });
      }
```

- [ ] **Step 2: Remove direct sendProactiveMessage calls**

Remove the direct `sendProactiveMessage` calls from both degradation (lines 189-194) and recovery (lines 210-214) blocks. The event publishing stays — NotificationService handles delivery.

After this change, `handleTransitions` should look like:

```typescript
  private async handleTransitions(modules: Record<string, ModuleStatus>): Promise<void> {
    for (const [module, currentStatus] of Object.entries(modules)) {
      const previousStatus = this.previousStatus[module];
      if (!previousStatus) continue;

      const isDegrading =
        (previousStatus === 'healthy' && (currentStatus === 'degraded' || currentStatus === 'down')) ||
        (previousStatus === 'degraded' && currentStatus === 'down');

      if (isDegrading) {
        await this.opts.eventBus.publish('alert.health', {
          module,
          status: currentStatus as 'degraded' | 'down',
          message: `Module "${module}" transitioned from ${previousStatus} to ${currentStatus}`,
          timestamp: Date.now(),
        });
      }

      const isRecovery =
        (previousStatus === 'degraded' || previousStatus === 'down') &&
        currentStatus === 'healthy';

      if (isRecovery) {
        await this.opts.eventBus.publish('alert.health', {
          module,
          status: 'recovered' as any,
          message: `Module "${module}" has recovered`,
          timestamp: Date.now(),
        });
      }
    }
  }
```

- [ ] **Step 3: Make alertTarget and sendProactiveMessage optional in HeartbeatOptions**

In the `HeartbeatOptions` interface (line 8-17), `sendProactiveMessage` can now be made optional since heartbeat no longer sends directly. However, to avoid breaking existing code, keep it for now but just stop calling it in `handleTransitions`. The field can be cleaned up later.

- [ ] **Step 4: Build and run tests**

Run: `npm run build -w packages/scheduler && npm test -w packages/scheduler -- --run`
Expected: All tests pass (update any heartbeat tests that expect `sendProactiveMessage` to be called on transitions)

- [ ] **Step 5: Commit**

```bash
git add packages/scheduler/src/heartbeat.ts
git commit -m "feat(scheduler): heartbeat publishes recovery events, stops direct sending"
```

---

## Chunk 4: MCP Tools + Bootstrap

### Task 8: Add notification MCP tools

**Files:**
- Modify: `packages/skills/src/mcp-server.ts`

- [ ] **Step 1: Add tool definitions**

In `packages/skills/src/mcp-server.ts`, after the profile tools section (after `profile_delete` tool push, around line 330), add:

```typescript
    // Notification preference tools
    if (profileStore) {
      tools.push({
        name: 'notification_get',
        description: 'Get the current notification preferences for a user. Returns merged config defaults + user overrides.',
        inputSchema: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'The user ID' },
          },
          required: ['userId'],
        },
      });
      tools.push({
        name: 'notification_set',
        description: 'Update notification preferences for a user. Can toggle master switch, enable/disable specific types (health, memory, errors, sessions), change delivery target, or set quiet hours.',
        inputSchema: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'The user ID' },
            enabled: { type: 'boolean', description: 'Master notification switch' },
            type: { type: 'string', description: 'Notification type to configure (health, memory, errors, sessions)' },
            type_enabled: { type: 'boolean', description: 'Enable/disable the specified type (requires type)' },
            target_platform: { type: 'string', description: 'Delivery platform (e.g., discord)' },
            target_channel: { type: 'string', description: 'Delivery channel ID or "DM"' },
            quiet_start: { type: 'string', description: 'Quiet hours start (HH:MM)' },
            quiet_end: { type: 'string', description: 'Quiet hours end (HH:MM)' },
            quiet_timezone: { type: 'string', description: 'Quiet hours timezone' },
          },
          required: ['userId'],
        },
      });
      tools.push({
        name: 'notification_mute',
        description: 'Temporarily mute all notifications for a user for a specified number of minutes. Pass 0 to unmute.',
        inputSchema: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'The user ID' },
            minutes: { type: 'number', description: 'Minutes to mute (0 to unmute)' },
          },
          required: ['userId', 'minutes'],
        },
      });
    }
```

- [ ] **Step 2: Add tool handlers**

In the tool handler switch statement (before the `// ── Unknown tool` section), add:

```typescript
    // ── notification_get ───────────────────────────────────────────────
    if (profileStore && name === 'notification_get') {
      const userId = toolArgs.userId as string;
      const prefs: Record<string, string | undefined> = {
        notification_enabled: profileStore.get(userId, 'notification_enabled'),
        notification_types: profileStore.get(userId, 'notification_types'),
        notification_target: profileStore.get(userId, 'notification_target'),
        notification_quiet_hours: profileStore.get(userId, 'notification_quiet_hours'),
        notification_mute_until: profileStore.get(userId, 'notification_mute_until'),
      };
      // Filter out undefined values
      const result = Object.fromEntries(Object.entries(prefs).filter(([, v]) => v !== undefined));
      return {
        content: [{
          type: 'text',
          text: Object.keys(result).length > 0
            ? JSON.stringify(result, null, 2)
            : 'No notification preferences set — using config defaults.',
        }],
      };
    }

    // ── notification_set ───────────────────────────────────────────────
    if (profileStore && name === 'notification_set') {
      const userId = toolArgs.userId as string;
      const changes: string[] = [];

      if (toolArgs.enabled !== undefined) {
        profileStore.set(userId, 'notification_enabled', String(toolArgs.enabled));
        changes.push(`enabled: ${toolArgs.enabled}`);
      }

      if (toolArgs.type && toolArgs.type_enabled !== undefined) {
        const existing = profileStore.get(userId, 'notification_types');
        let types: Record<string, boolean> = {};
        if (existing) try { types = JSON.parse(existing); } catch {}
        types[toolArgs.type as string] = toolArgs.type_enabled as boolean;
        profileStore.set(userId, 'notification_types', JSON.stringify(types));
        changes.push(`${toolArgs.type}: ${toolArgs.type_enabled}`);
      }

      if (toolArgs.target_platform || toolArgs.target_channel) {
        const target = {
          platform: (toolArgs.target_platform as string) ?? 'discord',
          channel: (toolArgs.target_channel as string) ?? 'DM',
        };
        profileStore.set(userId, 'notification_target', JSON.stringify(target));
        changes.push(`target: ${target.platform}/${target.channel}`);
      }

      if (toolArgs.quiet_start || toolArgs.quiet_end) {
        const quietHours = {
          start: (toolArgs.quiet_start as string) ?? '23:00',
          end: (toolArgs.quiet_end as string) ?? '07:00',
          timezone: (toolArgs.quiet_timezone as string) ?? 'America/Chicago',
        };
        profileStore.set(userId, 'notification_quiet_hours', JSON.stringify(quietHours));
        changes.push(`quiet hours: ${quietHours.start}-${quietHours.end} ${quietHours.timezone}`);
      }

      return {
        content: [{
          type: 'text',
          text: changes.length > 0
            ? `Notification preferences updated: ${changes.join(', ')}`
            : 'No changes specified.',
        }],
      };
    }

    // ── notification_mute ──────────────────────────────────────────────
    if (profileStore && name === 'notification_mute') {
      const userId = toolArgs.userId as string;
      const minutes = toolArgs.minutes as number;

      if (minutes <= 0) {
        profileStore.delete(userId, 'notification_mute_until');
        return { content: [{ type: 'text', text: 'Notifications unmuted.' }] };
      }

      const until = new Date(Date.now() + minutes * 60_000).toISOString();
      profileStore.set(userId, 'notification_mute_until', until);
      return {
        content: [{ type: 'text', text: `Notifications muted until ${until} (${minutes} minutes).` }],
      };
    }
```

- [ ] **Step 3: Build and run tests**

Run: `npm run build && npm test -w packages/skills -- --run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/skills/src/mcp-server.ts
git commit -m "feat(skills): add notification_get, notification_set, notification_mute MCP tools"
```

---

### Task 9: Wire NotificationService into bootstrap

**Files:**
- Modify: `packages/main/src/bootstrap.ts`

- [ ] **Step 1: Add imports**

Add `NotificationService` and `resolvePreferences` to the `@ccbuddy/scheduler` import:

```typescript
import { SchedulerService, NotificationService, resolvePreferences } from '@ccbuddy/scheduler';
```

(Or add to the existing import line for `@ccbuddy/scheduler`.)

- [ ] **Step 2: Create and start NotificationService**

After the `schedulerService.start()` call (around line 461), add:

```typescript
  // 16. Create and start notification service
  const notificationService = new NotificationService({
    eventBus,
    sendProactiveMessage,
    getPreferences: (userId) => resolvePreferences(config.notifications, profileStore, userId),
    getUsers: () => userManager.getAllUsers(),
    resolveDMChannel: async (platform, platformUserId) => {
      const adapter = gateway.getAdapter(platform);
      return adapter?.resolveDMChannel?.(platformUserId) ?? null;
    },
  });
  notificationService.start();
```

- [ ] **Step 3: Add tick to interval**

Update the tick interval (line 312-316) to include `notificationService.tick()`:

```typescript
  const tickInterval = setInterval(() => {
    agentService.tick();
    sessionStore.tick();
    notificationService.tick();
  }, 60_000);
```

Note: `notificationService` is created after the tick interval setup. Either move the interval setup after notification service creation, or create a mutable reference. The simplest approach: move the `setInterval` call to after all services are created, or use a variable that gets set later. Check the current bootstrap flow and adjust accordingly.

- [ ] **Step 4: Register shutdown**

Add after the scheduler shutdown registration:

```typescript
  shutdownHandler.register('notifications', async () => {
    notificationService.stop();
  });
```

- [ ] **Step 5: Build and verify**

Run: `npm run build -w packages/main`
Expected: Clean build

- [ ] **Step 6: Commit**

```bash
git add packages/main/src/bootstrap.ts
git commit -m "feat(main): wire NotificationService into bootstrap with tick and shutdown"
```

---

## Chunk 5: Integration Testing

### Task 10: Run full test suite and fix issues

**Files:**
- Any files needing test/type fixes

- [ ] **Step 1: Build all packages**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Fix any failures**

Common issues to check:
- Scheduler tests may need updated mocks for `NotificationConfig` in config
- Bootstrap tests may need updated mocks for `NotificationService` imports
- Heartbeat tests may need updated expectations (no more direct sendProactiveMessage calls in transitions)
- Gateway tests may need to handle new event publishing

- [ ] **Step 4: Commit fixes if any**

```bash
git add -A
git commit -m "fix: resolve test failures from notification preferences integration"
```

---

### Task 11: Verify end-to-end

- [ ] **Step 1: Add notification config to local.yaml**

Add to `config/local.yaml`:

```yaml
notifications:
  enabled: true
  default_target:
    platform: discord
    channel: DM
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

- [ ] **Step 2: Restart CCBuddy**

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
```

- [ ] **Step 3: Test notification delivery**

1. Send a message to Po from a second Discord account or new channel — should trigger a session.started notification DM
2. Tell Po: "mute notifications for 5 minutes" — should call notification_mute tool
3. Tell Po: "turn off health notifications" — should call notification_set tool
4. Tell Po: "show my notification preferences" — should call notification_get tool
