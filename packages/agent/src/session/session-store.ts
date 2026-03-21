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
  private readonly onExpiry?: (sessionKey: string) => void;
  private readonly persistence?: SessionPersistence;
  private readonly maxPauseMs: number;

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
        if (now - entry.lastActivity > this.maxPauseMs) {
          this.entries.delete(key);
          this.persistence?.updateStatus(key, 'archived');
          this.onExpiry?.(key);
        }
        continue;
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
