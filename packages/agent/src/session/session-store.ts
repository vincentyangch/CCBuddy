import { randomUUID } from 'node:crypto';

interface SessionEntry {
  sdkSessionId: string;
  lastActivity: number;
  isGroupChannel: boolean;
}

export interface SessionInfo {
  sessionKey: string;
  sdkSessionId: string;
  lastActivity: number;
  isGroupChannel: boolean;
}

export class SessionStore {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  getOrCreate(sessionKey: string, isGroupChannel: boolean): { sdkSessionId: string; isNew: boolean } {
    const existing = this.entries.get(sessionKey);
    if (existing) {
      existing.lastActivity = Date.now(); // Prevent expiry during long-running requests
      return { sdkSessionId: existing.sdkSessionId, isNew: false };
    }

    const entry: SessionEntry = {
      sdkSessionId: randomUUID(),
      lastActivity: Date.now(),
      isGroupChannel,
    };
    this.entries.set(sessionKey, entry);
    return { sdkSessionId: entry.sdkSessionId, isNew: true };
  }

  touch(sessionKey: string): void {
    const entry = this.entries.get(sessionKey);
    if (entry) {
      entry.lastActivity = Date.now();
    }
  }

  remove(sessionKey: string): void {
    this.entries.delete(sessionKey);
  }

  tick(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastActivity > this.timeoutMs) {
        this.entries.delete(key);
      }
    }
  }

  getAll(): SessionInfo[] {
    return Array.from(this.entries.entries()).map(([key, entry]) => ({
      sessionKey: key,
      sdkSessionId: entry.sdkSessionId,
      lastActivity: entry.lastActivity,
      isGroupChannel: entry.isGroupChannel,
    }));
  }
}
