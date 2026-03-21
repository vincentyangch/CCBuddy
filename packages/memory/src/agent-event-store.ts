import { MemoryDatabase } from './database.js';

export interface StoredAgentEvent {
  id: number;
  userId: string;
  sessionId: string;
  platform: string;
  eventType: string;
  content: string;
  toolInput: string | null;
  toolOutput: string | null;
  timestamp: number;
}

export interface AddAgentEventParams {
  userId: string;
  sessionId: string;
  platform: string;
  eventType: string;
  content: string;
  toolInput?: string;
  toolOutput?: string;
  timestamp?: number;
}

export class AgentEventStore {
  private db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.db = db;
  }

  add(params: AddAgentEventParams): number {
    const timestamp = params.timestamp ?? Date.now();
    const result = this.db.raw().prepare(`
      INSERT INTO agent_events (user_id, session_id, platform, event_type, content, tool_input, tool_output, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.userId,
      params.sessionId,
      params.platform,
      params.eventType,
      params.content,
      params.toolInput ?? null,
      params.toolOutput ?? null,
      timestamp,
    );
    return result.lastInsertRowid as number;
  }

  getBySession(sessionId: string, pagination?: { limit: number; offset: number }): StoredAgentEvent[] {
    if (pagination) {
      const rows = this.db.raw().prepare(`
        SELECT * FROM agent_events WHERE session_id = ?
        ORDER BY timestamp ASC, id ASC
        LIMIT ? OFFSET ?
      `).all(sessionId, pagination.limit, pagination.offset);
      return rows.map((r: any) => this.toEvent(r));
    }
    const rows = this.db.raw().prepare(`
      SELECT * FROM agent_events WHERE session_id = ?
      ORDER BY timestamp ASC, id ASC
    `).all(sessionId);
    return rows.map((r: any) => this.toEvent(r));
  }

  private toEvent(row: any): StoredAgentEvent {
    return {
      id: row.id,
      userId: row.user_id,
      sessionId: row.session_id,
      platform: row.platform,
      eventType: row.event_type,
      content: row.content,
      toolInput: row.tool_input,
      toolOutput: row.tool_output,
      timestamp: row.timestamp,
    };
  }
}
