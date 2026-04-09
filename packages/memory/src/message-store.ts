import { MemoryDatabase } from './database.js';
import { estimateTokens } from './token-counter.js';

export interface StoredMessage {
  id: number;
  userId: string;
  sessionId: string;
  platform: string;
  content: string;
  role: 'user' | 'assistant';
  attachments: string | null;
  timestamp: number;
  tokens: number;
}

export interface AddMessageParams {
  userId: string;
  sessionId: string;
  platform: string;
  content: string;
  role: 'user' | 'assistant';
  attachments?: string;
  timestamp?: number;
  tokens?: number;
}

export interface MessageQueryParams {
  user?: string;
  platform?: string;
  dateFrom?: number;
  dateTo?: number;
  search?: string;
  page: number;
  pageSize: number;
}

export interface MessageQueryResult {
  messages: StoredMessage[];
  total: number;
  page: number;
  pageSize: number;
}

export class MessageStore {
  private db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.db = db;
  }

  add(params: AddMessageParams): number {
    const timestamp = params.timestamp ?? Date.now();
    const tokens = params.tokens ?? estimateTokens(params.content);

    const result = this.db.raw().prepare(`
      INSERT INTO messages (user_id, session_id, platform, content, role, attachments, timestamp, tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.userId,
      params.sessionId,
      params.platform,
      params.content,
      params.role,
      params.attachments ?? null,
      timestamp,
      tokens,
    );

    return result.lastInsertRowid as number;
  }

  getById(id: number): StoredMessage | undefined {
    const row = this.db.raw().prepare(
      'SELECT * FROM messages WHERE id = ?'
    ).get(id);
    if (!row) return undefined;
    return this.toMessage(row as any);
  }

  getFreshTail(userId: string, sessionId: string, limit: number): StoredMessage[] {
    // Fetch the last `limit` rows by timestamp DESC, then reverse to get chronological order
    const rows = this.db.raw().prepare(`
      SELECT * FROM messages
      WHERE user_id = ? AND session_id = ?
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(userId, sessionId, limit);
    return rows.reverse().map((r: any) => this.toMessage(r));
  }

  getByUser(userId: string, limit?: number): StoredMessage[] {
    if (limit !== undefined) {
      const rows = this.db.raw().prepare(`
        SELECT * FROM messages WHERE user_id = ? ORDER BY timestamp ASC, id ASC LIMIT ?
      `).all(userId, limit);
      return rows.map((r: any) => this.toMessage(r));
    }
    const rows = this.db.raw().prepare(`
      SELECT * FROM messages WHERE user_id = ? ORDER BY timestamp ASC, id ASC
    `).all(userId);
    return rows.map((r: any) => this.toMessage(r));
  }

  getByTimeRange(userId: string, startMs: number, endMs: number): StoredMessage[] {
    const rows = this.db.raw().prepare(`
      SELECT * FROM messages
      WHERE user_id = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC, id ASC
    `).all(userId, startMs, endMs);
    return rows.map((r: any) => this.toMessage(r));
  }

  getTotalTokens(userId: string): number {
    const row = this.db.raw().prepare(
      'SELECT COALESCE(SUM(tokens), 0) as total FROM messages WHERE user_id = ?'
    ).get(userId) as { total: number };
    return row.total;
  }

  search(userId: string, query: string): StoredMessage[] {
    // Escape LIKE special characters so they match literally
    const escaped = query.replace(/[%_\\]/g, '\\$&');
    const rows = this.db.raw().prepare(`
      SELECT * FROM messages
      WHERE user_id = ? AND content LIKE ? ESCAPE '\\'
      ORDER BY timestamp ASC, id ASC
    `).all(userId, `%${escaped}%`);
    return rows.map((r: any) => this.toMessage(r));
  }

  getMessageCount(userId: string): number {
    const row = this.db.raw().prepare(
      'SELECT COUNT(*) as count FROM messages WHERE user_id = ?'
    ).get(userId) as { count: number };
    return row.count;
  }

  getDistinctUserIds(): string[] {
    const rows = this.db.raw().prepare(
      'SELECT DISTINCT user_id FROM messages'
    ).all() as Array<{ user_id: string }>;
    return rows.map(r => r.user_id);
  }

  getUnsummarizedMessages(userId: string, excludeRecent: number): StoredMessage[] {
    const rows = this.db.raw().prepare(`
      SELECT * FROM messages
      WHERE user_id = ? AND summarized_at IS NULL
      ORDER BY timestamp ASC, id ASC
    `).all(userId) as any[];

    const cutoff = Math.max(0, rows.length - excludeRecent);
    return rows.slice(0, cutoff).map((r: any) => this.toMessage(r));
  }

  markSummarized(ids: number[], timestamp: number): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.raw().prepare(
      `UPDATE messages SET summarized_at = ? WHERE id IN (${placeholders})`
    ).run(timestamp, ...ids);
  }

  pruneOldSummarized(beforeTimestamp: number): number {
    const result = this.db.raw().prepare(
      'DELETE FROM messages WHERE summarized_at IS NOT NULL AND summarized_at < ?'
    ).run(beforeTimestamp);
    return result.changes;
  }

  deleteBySessionId(sessionId: string): number {
    const result = this.db.raw().prepare(
      'DELETE FROM messages WHERE session_id = ?'
    ).run(sessionId);
    return result.changes;
  }

  /**
   * Return pairs of [trigger, response] messages for scheduled briefings.
   * Each trigger is a user message with content `[Scheduled: <jobName>]`
   * and the response is the assistant message with the immediately following id.
   *
   * If jobName is provided, filters to only that job (e.g. "evening_briefing").
   * Otherwise returns all scheduled job pairs.
   *
   * Options:
   * - limit: max number of briefing pairs to return (default: all)
   * - startMs/endMs: filter by trigger timestamp range
   *
   * Results are returned newest-first (most recent briefing at index 0).
   */
  getBriefs(
    userId: string,
    jobName?: string,
    opts?: { limit?: number; startMs?: number; endMs?: number },
  ): Array<{ trigger: StoredMessage; response: StoredMessage | undefined }> {
    // Build the LIKE pattern for the trigger message content
    const likePattern = jobName
      ? `[Scheduled: ${jobName.replace(/[%_\\]/g, '\\$&')}]`
      : '[Scheduled: %]';

    const conditions = ["user_id = ?", "role = 'user'", "content LIKE ? ESCAPE '\\'"];
    const params: (string | number)[] = [userId, likePattern];

    if (opts?.startMs !== undefined) {
      conditions.push('timestamp >= ?');
      params.push(opts.startMs);
    }
    if (opts?.endMs !== undefined) {
      conditions.push('timestamp <= ?');
      params.push(opts.endMs);
    }

    let sql = `SELECT * FROM messages WHERE ${conditions.join(' AND ')} ORDER BY timestamp DESC, id DESC`;
    if (opts?.limit !== undefined && opts.limit > 0) {
      sql += ` LIMIT ?`;
      params.push(opts.limit);
    }

    const triggers = this.db.raw().prepare(sql).all(...params) as any[];

    return triggers.map((triggerRow: any) => {
      const trigger = this.toMessage(triggerRow);
      // Find the next assistant message in the same session after this trigger
      const responseRow = this.db.raw().prepare(`
        SELECT * FROM messages
        WHERE user_id = ? AND session_id = ? AND role = 'assistant' AND id > ?
        ORDER BY id ASC
        LIMIT 1
      `).get(userId, trigger.sessionId, trigger.id) as any | undefined;
      return {
        trigger,
        response: responseRow ? this.toMessage(responseRow) : undefined,
      };
    });
  }

  query(params: MessageQueryParams): MessageQueryResult {
    const conditions: string[] = [];
    const values: (string | number)[] = [];

    if (params.user) {
      conditions.push('user_id = ?');
      values.push(params.user);
    }
    if (params.platform) {
      conditions.push('platform = ?');
      values.push(params.platform);
    }
    if (params.dateFrom !== undefined) {
      conditions.push('timestamp >= ?');
      values.push(params.dateFrom);
    }
    if (params.dateTo !== undefined) {
      conditions.push('timestamp <= ?');
      values.push(params.dateTo);
    }
    if (params.search) {
      const escaped = params.search.replace(/[%_\\]/g, '\\$&');
      conditions.push("content LIKE ? ESCAPE '\\'");
      values.push(`%${escaped}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db.raw().prepare(
      `SELECT COUNT(*) as count FROM messages ${where}`
    ).get(...values) as { count: number };

    const offset = (params.page - 1) * params.pageSize;
    const rows = this.db.raw().prepare(
      `SELECT * FROM messages ${where} ORDER BY timestamp ASC, id ASC LIMIT ? OFFSET ?`
    ).all(...values, params.pageSize, offset);

    return {
      messages: rows.map((r: any) => this.toMessage(r)),
      total: countRow.count,
      page: params.page,
      pageSize: params.pageSize,
    };
  }

  private toMessage(row: any): StoredMessage {
    return {
      id: row.id,
      userId: row.user_id,
      sessionId: row.session_id,
      platform: row.platform,
      content: row.content,
      role: row.role as 'user' | 'assistant',
      attachments: row.attachments,
      timestamp: row.timestamp,
      tokens: row.tokens,
    };
  }
}
