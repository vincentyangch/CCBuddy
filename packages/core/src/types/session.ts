import type { ReasoningEffort, Verbosity } from './agent.js';

export type SessionStatus = 'active' | 'paused' | 'archived';

export interface SessionRow {
  session_key: string;
  sdk_session_id: string;
  user_id: string | null;
  platform: string;
  channel_id: string;
  is_group_channel: boolean;
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  verbosity: Verbosity | null;
  status: SessionStatus;
  turns: number;
  created_at: number;
  last_activity: number;
}

export interface SessionQueryFilters {
  status?: SessionStatus;
  platform?: string;
}

export interface SessionPersistence {
  upsert(row: SessionRow): void;
  getByKey(sessionKey: string): SessionRow | null;
  getAll(filters?: SessionQueryFilters): SessionRow[];
  updateStatus(sessionKey: string, status: SessionStatus): void;
  updateLastActivity(sessionKey: string, timestamp: number): void;
  updateModel(sessionKey: string, model: string | null): void;
  updateReasoningEffort(sessionKey: string, reasoningEffort: ReasoningEffort | null): void;
  updateVerbosity(sessionKey: string, verbosity: Verbosity | null): void;
  updateTurns(sessionKey: string, turns: number): void;
  updateSdkSessionId?(sessionKey: string, sdkSessionId: string): void;
  delete(sessionKey: string): void;
}
