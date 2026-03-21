import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventBus, User, MessageTarget, Disposable } from '@ccbuddy/core';
import { NotificationService } from '../notification-service.js';
import type { NotificationPreferences, NotificationServiceDeps } from '../notification-service.js';

function defaultPrefs(overrides: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return {
    enabled: true,
    types: { health: true, memory: true, errors: true, sessions: true },
    target: { platform: 'discord', channel: 'dm' },
    quietHours: null,
    muteUntil: null,
    ...overrides,
  };
}

function createMockEventBus(): EventBus & {
  handlers: Map<string, Array<(payload: unknown) => void>>;
  emit: (event: string, payload: unknown) => void;
} {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  return {
    handlers,
    publish: vi.fn(async () => {}),
    subscribe: vi.fn((event: string, handler: (payload: unknown) => void): Disposable => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
      return { dispose: vi.fn() };
    }),
    emit(event: string, payload: unknown) {
      const fns = handlers.get(event) || [];
      for (const fn of fns) fn(payload);
    },
  };
}

function makeUser(name: string, discordId = `${name}-discord-id`): User {
  return { name, role: 'admin', platformIds: { discord: discordId } };
}

function createDeps(overrides: Partial<NotificationServiceDeps> = {}): {
  deps: NotificationServiceDeps;
  eventBus: ReturnType<typeof createMockEventBus>;
  sendProactiveMessage: ReturnType<typeof vi.fn>;
  getPreferences: ReturnType<typeof vi.fn>;
  resolveDMChannel: ReturnType<typeof vi.fn>;
} {
  const eventBus = createMockEventBus();
  const sendProactiveMessage = vi.fn(async () => {});
  const getPreferences = vi.fn(() => defaultPrefs());
  const resolveDMChannel = vi.fn(async (_platform: string, platformUserId: string) => `dm-${platformUserId}`);
  const getUsers = vi.fn(() => [makeUser('alice'), makeUser('bob')]);

  const deps: NotificationServiceDeps = {
    eventBus,
    sendProactiveMessage,
    getPreferences,
    getUsers,
    resolveDMChannel,
    ...overrides,
  };

  return { deps, eventBus, sendProactiveMessage, getPreferences, resolveDMChannel };
}

describe('NotificationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delivers health alert via DM', async () => {
    const { deps, eventBus, sendProactiveMessage } = createDeps();
    const svc = new NotificationService(deps);
    svc.start();

    eventBus.emit('alert.health', {
      module: 'database',
      status: 'down',
      message: 'Database is down',
      timestamp: Date.now(),
    });

    // Wait for async notification delivery
    await vi.waitFor(() => {
      expect(sendProactiveMessage).toHaveBeenCalled();
    });

    expect(sendProactiveMessage).toHaveBeenCalledWith(
      { platform: 'discord', channel: 'dm-alice-discord-id' },
      '[Health] Module "database" is down',
    );
    expect(sendProactiveMessage).toHaveBeenCalledWith(
      { platform: 'discord', channel: 'dm-bob-discord-id' },
      '[Health] Module "database" is down',
    );

    svc.stop();
  });

  it('delivers health recovery notification', async () => {
    const { deps, eventBus, sendProactiveMessage } = createDeps();
    const svc = new NotificationService(deps);
    svc.start();

    eventBus.emit('alert.health', {
      module: 'agent',
      status: 'recovered',
      message: 'Agent recovered',
      timestamp: Date.now(),
    });

    await vi.waitFor(() => {
      expect(sendProactiveMessage).toHaveBeenCalled();
    });

    expect(sendProactiveMessage).toHaveBeenCalledWith(
      expect.any(Object),
      '[Health] Module "agent" has recovered',
    );

    svc.stop();
  });

  it('skips when type is disabled', async () => {
    const { deps, eventBus, sendProactiveMessage, getPreferences } = createDeps();
    getPreferences.mockReturnValue(defaultPrefs({ types: { health: false, memory: true, errors: true, sessions: true } }));
    const svc = new NotificationService(deps);
    svc.start();

    eventBus.emit('alert.health', {
      module: 'database',
      status: 'down',
      message: 'down',
      timestamp: Date.now(),
    });

    // Give async handlers time to run
    await new Promise((r) => setTimeout(r, 50));
    expect(sendProactiveMessage).not.toHaveBeenCalled();

    svc.stop();
  });

  it('skips when master switch is off', async () => {
    const { deps, eventBus, sendProactiveMessage, getPreferences } = createDeps();
    getPreferences.mockReturnValue(defaultPrefs({ enabled: false }));
    const svc = new NotificationService(deps);
    svc.start();

    eventBus.emit('alert.health', {
      module: 'database',
      status: 'down',
      message: 'down',
      timestamp: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(sendProactiveMessage).not.toHaveBeenCalled();

    svc.stop();
  });

  it('skips when muted', async () => {
    const { deps, eventBus, sendProactiveMessage, getPreferences } = createDeps();
    getPreferences.mockReturnValue(defaultPrefs({ muteUntil: Date.now() + 60_000 }));
    const svc = new NotificationService(deps);
    svc.start();

    eventBus.emit('alert.health', {
      module: 'database',
      status: 'down',
      message: 'down',
      timestamp: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(sendProactiveMessage).not.toHaveBeenCalled();

    svc.stop();
  });

  it('queues notification during quiet hours', async () => {
    const { deps, eventBus, sendProactiveMessage, getPreferences } = createDeps();
    // Use quiet hours that span all day to guarantee we're in them
    getPreferences.mockReturnValue(
      defaultPrefs({ quietHours: { start: '00:00', end: '23:59', timezone: 'UTC' } }),
    );
    const svc = new NotificationService(deps);
    svc.start();

    eventBus.emit('alert.health', {
      module: 'database',
      status: 'down',
      message: 'down',
      timestamp: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(sendProactiveMessage).not.toHaveBeenCalled();
    expect(svc.queueSize).toBeGreaterThan(0);

    svc.stop();
  });

  it('flushes queue when quiet hours end', async () => {
    const { deps, eventBus, sendProactiveMessage, getPreferences } = createDeps();
    // First call: quiet hours active (for notification). Second call: quiet hours off (for tick).
    let callCount = 0;
    getPreferences.mockImplementation(() => {
      callCount++;
      // First 2 calls (one per user) during notification: quiet hours active
      if (callCount <= 2) {
        return defaultPrefs({ quietHours: { start: '00:00', end: '23:59', timezone: 'UTC' } });
      }
      // During tick: quiet hours off
      return defaultPrefs({ quietHours: null });
    });

    const svc = new NotificationService(deps);
    svc.start();

    eventBus.emit('alert.health', {
      module: 'database',
      status: 'down',
      message: 'down',
      timestamp: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(svc.queueSize).toBeGreaterThan(0);

    // Now tick with quiet hours off
    await svc.tick();

    expect(sendProactiveMessage).toHaveBeenCalled();
    expect(svc.queueSize).toBe(0);

    svc.stop();
  });

  it('caps queue at 100 per user', async () => {
    const { deps, eventBus, sendProactiveMessage, getPreferences } = createDeps({
      getUsers: () => [makeUser('alice')],
    });
    getPreferences.mockReturnValue(
      defaultPrefs({ quietHours: { start: '00:00', end: '23:59', timezone: 'UTC' } }),
    );
    const svc = new NotificationService(deps);
    svc.start();

    // Emit 110 events
    for (let i = 0; i < 110; i++) {
      eventBus.emit('backup.complete', { path: '/backup' });
    }

    await new Promise((r) => setTimeout(r, 200));
    expect(svc.queueSize).toBe(100);
    expect(sendProactiveMessage).not.toHaveBeenCalled();

    svc.stop();
  });

  it('sends to fixed channel target (not DM)', async () => {
    const { deps, eventBus, sendProactiveMessage, getPreferences, resolveDMChannel } = createDeps();
    getPreferences.mockReturnValue(
      defaultPrefs({ target: { platform: 'discord', channel: 'alerts-channel' } }),
    );
    const svc = new NotificationService(deps);
    svc.start();

    eventBus.emit('alert.health', {
      module: 'agent',
      status: 'degraded',
      message: 'degraded',
      timestamp: Date.now(),
    });

    await vi.waitFor(() => {
      expect(sendProactiveMessage).toHaveBeenCalled();
    });

    // Should NOT call resolveDMChannel since target is not 'dm'
    expect(resolveDMChannel).not.toHaveBeenCalled();
    expect(sendProactiveMessage).toHaveBeenCalledWith(
      { platform: 'discord', channel: 'alerts-channel' },
      '[Health] Module "agent" is degraded',
    );

    svc.stop();
  });

  it('backup and consolidation events map to memory type', async () => {
    const { deps, eventBus, sendProactiveMessage, getPreferences } = createDeps({
      getUsers: () => [makeUser('alice')],
    });
    // Disable memory type
    getPreferences.mockReturnValue(defaultPrefs({ types: { health: true, memory: false, errors: true, sessions: true } }));
    const svc = new NotificationService(deps);
    svc.start();

    eventBus.emit('backup.complete', { path: '/backup' });
    eventBus.emit('consolidation.complete', {
      userId: 'alice',
      messagesChunked: 10,
      leafNodesCreated: 2,
      condensedNodesCreated: 3,
      messagesPruned: 5,
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(sendProactiveMessage).not.toHaveBeenCalled();

    svc.stop();
  });

  it('suppresses self-notification for session.started', async () => {
    const { deps, eventBus, sendProactiveMessage } = createDeps();
    const svc = new NotificationService(deps);
    svc.start();

    eventBus.emit('session.started', {
      userId: 'alice',
      platform: 'discord',
      channelId: 'ch1',
      sessionKey: 'key1',
      timestamp: Date.now(),
    });

    await vi.waitFor(() => {
      expect(sendProactiveMessage).toHaveBeenCalled();
    });

    // Should only notify bob, not alice
    expect(sendProactiveMessage).toHaveBeenCalledTimes(1);
    expect(sendProactiveMessage).toHaveBeenCalledWith(
      { platform: 'discord', channel: 'dm-bob-discord-id' },
      '[Session] New chat started by alice on discord/ch1',
    );

    svc.stop();
  });

  it('suppresses self-notification for agent.error', async () => {
    const { deps, eventBus, sendProactiveMessage } = createDeps();
    const svc = new NotificationService(deps);
    svc.start();

    eventBus.emit('agent.error', {
      userId: 'bob',
      platform: 'discord',
      channelId: 'ch1',
      error: 'timeout',
      timestamp: Date.now(),
    });

    await vi.waitFor(() => {
      expect(sendProactiveMessage).toHaveBeenCalled();
    });

    // Should only notify alice, not bob
    expect(sendProactiveMessage).toHaveBeenCalledTimes(1);
    expect(sendProactiveMessage).toHaveBeenCalledWith(
      { platform: 'discord', channel: 'dm-alice-discord-id' },
      '[Error] Agent request failed for bob in ch1',
    );

    svc.stop();
  });

  it('multi-user: only other users notified for session.started', async () => {
    const charlie = makeUser('charlie', 'charlie-discord-id');
    const { deps, eventBus, sendProactiveMessage } = createDeps({
      getUsers: () => [makeUser('alice'), makeUser('bob'), charlie],
    });
    const svc = new NotificationService(deps);
    svc.start();

    eventBus.emit('session.started', {
      userId: 'alice',
      platform: 'discord',
      channelId: 'ch1',
      sessionKey: 'key1',
      timestamp: Date.now(),
    });

    await vi.waitFor(() => {
      expect(sendProactiveMessage).toHaveBeenCalledTimes(2);
    });

    // Bob and Charlie notified, alice not
    const calls = sendProactiveMessage.mock.calls.map((c: unknown[]) => (c[0] as MessageTarget).channel);
    expect(calls).toContain('dm-bob-discord-id');
    expect(calls).toContain('dm-charlie-discord-id');
    expect(calls).not.toContain('dm-alice-discord-id');

    svc.stop();
  });

  it('consolidation notification includes correct stats', async () => {
    const { deps, eventBus, sendProactiveMessage } = createDeps({
      getUsers: () => [makeUser('alice')],
    });
    const svc = new NotificationService(deps);
    svc.start();

    eventBus.emit('consolidation.complete', {
      userId: 'alice',
      messagesChunked: 42,
      leafNodesCreated: 5,
      condensedNodesCreated: 7,
      messagesPruned: 30,
    });

    await vi.waitFor(() => {
      expect(sendProactiveMessage).toHaveBeenCalled();
    });

    expect(sendProactiveMessage).toHaveBeenCalledWith(
      expect.any(Object),
      '[Memory] Consolidation complete: 42 messages chunked, 7 nodes condensed',
    );

    svc.stop();
  });

  it('backup integrity failed notification includes error', async () => {
    const { deps, eventBus, sendProactiveMessage } = createDeps({
      getUsers: () => [makeUser('alice')],
    });
    const svc = new NotificationService(deps);
    svc.start();

    eventBus.emit('backup.integrity_failed', {
      path: '/backup/db.sqlite',
      error: 'checksum mismatch',
    });

    await vi.waitFor(() => {
      expect(sendProactiveMessage).toHaveBeenCalled();
    });

    expect(sendProactiveMessage).toHaveBeenCalledWith(
      expect.any(Object),
      '[Backup] Integrity check failed: checksum mismatch',
    );

    svc.stop();
  });
});
