export type SessionStatus = 'active' | 'paused' | 'archived';

export interface SessionRow {
  session_key: string;
  sdk_session_id: string;
  user_id: string | null;
  platform: string;
  channel_id: string;
  is_group_channel: boolean;
  model: string | null;
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
  updateTurns(sessionKey: string, turns: number): void;
  delete(sessionKey: string): void;
}
