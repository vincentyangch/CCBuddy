import type { EventBus, MessageTarget, User, Disposable } from '@ccbuddy/core';

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
  target: MessageTarget;
  text: string;
}

export class NotificationService {
  private readonly deps: NotificationServiceDeps;
  private readonly subscriptions: Disposable[] = [];
  private readonly dmChannelCache = new Map<string, string>();
  private readonly _queue = new Map<string, QueuedNotification[]>();
  private static readonly MAX_QUEUE_SIZE = 100;

  constructor(deps: NotificationServiceDeps) {
    this.deps = deps;
  }

  get queueSize(): number {
    let total = 0;
    for (const items of this._queue.values()) {
      total += items.length;
    }
    return total;
  }

  get queue(): Map<string, QueuedNotification[]> {
    return this._queue;
  }

  start(): void {
    const { eventBus } = this.deps;

    this.subscriptions.push(
      eventBus.subscribe('alert.health', (payload) => {
        void this.notify('health', this.formatHealth(payload));
      }),
    );

    this.subscriptions.push(
      eventBus.subscribe('consolidation.complete', (payload) => {
        void this.notify(
          'memory',
          `[Memory] Consolidation complete: ${payload.messagesChunked} messages chunked, ${payload.condensedNodesCreated} nodes condensed`,
        );
      }),
    );

    this.subscriptions.push(
      eventBus.subscribe('backup.complete', () => {
        void this.notify('memory', '[Backup] Completed successfully');
      }),
    );

    this.subscriptions.push(
      eventBus.subscribe('backup.integrity_failed', (payload) => {
        void this.notify('memory', `[Backup] Integrity check failed: ${payload.error}`);
      }),
    );

    this.subscriptions.push(
      eventBus.subscribe('agent.error', (payload) => {
        void this.notify(
          'errors',
          `[Error] Agent request failed for ${payload.userId} in ${payload.channelId}`,
          payload.userId,
        );
      }),
    );

    this.subscriptions.push(
      eventBus.subscribe('session.started', (payload) => {
        void this.notify(
          'sessions',
          `[Session] New chat started by ${payload.userId} on ${payload.platform}/${payload.channelId}`,
          payload.userId,
        );
      }),
    );

    console.log('[NotificationService] Started');
  }

  stop(): void {
    for (const sub of this.subscriptions) {
      sub.dispose();
    }
    this.subscriptions.length = 0;
    console.log('[NotificationService] Stopped');
  }

  /** Flush queued notifications for users no longer in quiet hours */
  async tick(): Promise<void> {
    for (const [userId, items] of this._queue.entries()) {
      const prefs = this.deps.getPreferences(userId);
      if (!this.isQuietHours(prefs)) {
        // Flush all queued notifications
        for (const item of items) {
          try {
            await this.deps.sendProactiveMessage(item.target, item.text);
          } catch (err) {
            console.error(`[NotificationService] Failed to flush queued notification for ${userId}:`, err);
          }
        }
        this._queue.delete(userId);
      }
    }
  }

  private formatHealth(payload: { module: string; status: string; message: string }): string {
    if (payload.status === 'recovered') {
      return `[Health] Module "${payload.module}" has recovered`;
    }
    return `[Health] Module "${payload.module}" is ${payload.status}`;
  }

  private async notify(type: string, text: string, skipUserId?: string): Promise<void> {
    const users = this.deps.getUsers();

    for (const user of users) {
      // Self-notification suppression
      if (skipUserId && user.name === skipUserId) continue;

      const prefs = this.deps.getPreferences(user.name);

      // Master switch
      if (!prefs.enabled) continue;

      // Muted
      if (prefs.muteUntil && prefs.muteUntil > Date.now()) continue;

      // Type check
      if (prefs.types[type] === false) continue;

      // Resolve target
      const target = await this.resolveTarget(prefs, user);
      if (!target) continue;

      // Quiet hours → queue
      if (this.isQuietHours(prefs)) {
        this.enqueue(user.name, { target, text });
        continue;
      }

      try {
        await this.deps.sendProactiveMessage(target, text);
      } catch (err) {
        console.error(`[NotificationService] Failed to send notification to ${user.name}:`, err);
      }
    }
  }

  private async resolveTarget(prefs: NotificationPreferences, user: User): Promise<MessageTarget | null> {
    // If the target channel is 'dm', resolve the DM channel
    if (prefs.target.channel === 'dm') {
      const platform = prefs.target.platform;
      const platformUserId = user.platformIds[platform];
      if (!platformUserId) return null;

      const cacheKey = `${platform}:${platformUserId}`;
      const cached = this.dmChannelCache.get(cacheKey);
      if (cached) {
        return { platform, channel: cached };
      }

      const resolved = await this.deps.resolveDMChannel(platform, platformUserId);
      if (!resolved) return null;

      this.dmChannelCache.set(cacheKey, resolved);
      return { platform, channel: resolved };
    }

    return prefs.target;
  }

  private enqueue(userId: string, notification: QueuedNotification): void {
    let items = this._queue.get(userId);
    if (!items) {
      items = [];
      this._queue.set(userId, items);
    }
    if (items.length >= NotificationService.MAX_QUEUE_SIZE) return;
    items.push(notification);
  }

  private isQuietHours(prefs: NotificationPreferences): boolean {
    if (!prefs.quietHours) return false;
    const { start, end, timezone } = prefs.quietHours;
    const now = new Date();
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
    if (startMin <= endMin) return nowMin >= startMin && nowMin < endMin; // same-day
    return nowMin >= startMin || nowMin < endMin; // overnight
  }
}
