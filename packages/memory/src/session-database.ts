import type Database from 'better-sqlite3';
import type { SessionRow, SessionStatus, SessionQueryFilters, SessionPersistence } from '@ccbuddy/core';

export class SessionDatabase implements SessionPersistence {
  private db: Database.Database;

  private stmts!: {
    upsert: Database.Statement;
    getByKey: Database.Statement;
    updateStatus: Database.Statement;
    updateLastActivity: Database.Statement;
    updateModel: Database.Statement;
    delete: Database.Statement;
  };

  constructor(db: Database.Database) {
    this.db = db;
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmts = {
      upsert: this.db.prepare(`
        INSERT INTO sessions (session_key, sdk_session_id, user_id, platform, channel_id, is_group_channel, model, status, created_at, last_activity)
        VALUES (@session_key, @sdk_session_id, @user_id, @platform, @channel_id, @is_group_channel, @model, @status, @created_at, @last_activity)
        ON CONFLICT(session_key) DO UPDATE SET
          sdk_session_id = @sdk_session_id,
          user_id = @user_id,
          model = @model,
          status = @status,
          last_activity = @last_activity
      `),
      getByKey: this.db.prepare('SELECT * FROM sessions WHERE session_key = ?'),
      updateStatus: this.db.prepare('UPDATE sessions SET status = ? WHERE session_key = ?'),
      updateLastActivity: this.db.prepare('UPDATE sessions SET last_activity = ? WHERE session_key = ?'),
      updateModel: this.db.prepare('UPDATE sessions SET model = ? WHERE session_key = ?'),
      delete: this.db.prepare('DELETE FROM sessions WHERE session_key = ?'),
    };
  }

  upsert(row: SessionRow): void {
    this.stmts.upsert.run({
      session_key: row.session_key,
      sdk_session_id: row.sdk_session_id,
      user_id: row.user_id,
      platform: row.platform,
      channel_id: row.channel_id,
      is_group_channel: row.is_group_channel ? 1 : 0,
      model: row.model,
      status: row.status,
      created_at: row.created_at,
      last_activity: row.last_activity,
    });
  }

  getByKey(sessionKey: string): SessionRow | null {
    const row = this.stmts.getByKey.get(sessionKey) as any;
    return row ? this.toSessionRow(row) : null;
  }

  getAll(filters?: SessionQueryFilters): SessionRow[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters?.status) {
      conditions.push('status = ?');
      params.push(filters.status);
    }
    if (filters?.platform) {
      conditions.push('platform = ?');
      params.push(filters.platform);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM sessions ${where} ORDER BY last_activity DESC`;
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(r => this.toSessionRow(r));
  }

  updateStatus(sessionKey: string, status: SessionStatus): void {
    this.stmts.updateStatus.run(status, sessionKey);
  }

  updateLastActivity(sessionKey: string, timestamp: number): void {
    this.stmts.updateLastActivity.run(timestamp, sessionKey);
  }

  updateModel(sessionKey: string, model: string | null): void {
    this.stmts.updateModel.run(model, sessionKey);
  }

  delete(sessionKey: string): void {
    this.stmts.delete.run(sessionKey);
  }

  private toSessionRow(row: any): SessionRow {
    return {
      session_key: row.session_key,
      sdk_session_id: row.sdk_session_id,
      user_id: row.user_id ?? null,
      platform: row.platform,
      channel_id: row.channel_id,
      is_group_channel: !!row.is_group_channel,
      model: row.model ?? null,
      status: row.status,
      created_at: row.created_at,
      last_activity: row.last_activity,
    };
  }
}
