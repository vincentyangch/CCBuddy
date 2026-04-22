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
    updateReasoningEffort: Database.Statement;
    updateServiceTier: Database.Statement;
    updateVerbosity: Database.Statement;
    updateTurns: Database.Statement;
    updateSdkSessionId: Database.Statement;
    delete: Database.Statement;
  };

  constructor(db: Database.Database) {
    this.db = db;
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmts = {
      upsert: this.db.prepare(`
        INSERT INTO sessions (session_key, sdk_session_id, user_id, platform, channel_id, is_group_channel, model, reasoning_effort, service_tier, verbosity, status, created_at, last_activity, turns)
        VALUES (@session_key, @sdk_session_id, @user_id, @platform, @channel_id, @is_group_channel, @model, @reasoning_effort, @service_tier, @verbosity, @status, @created_at, @last_activity, @turns)
        ON CONFLICT(session_key) DO UPDATE SET
          sdk_session_id = @sdk_session_id,
          user_id = @user_id,
          model = @model,
          reasoning_effort = @reasoning_effort,
          service_tier = @service_tier,
          verbosity = @verbosity,
          status = @status,
          last_activity = @last_activity,
          turns = @turns
      `),
      getByKey: this.db.prepare('SELECT * FROM sessions WHERE session_key = ?'),
      updateStatus: this.db.prepare('UPDATE sessions SET status = ? WHERE session_key = ?'),
      updateLastActivity: this.db.prepare('UPDATE sessions SET last_activity = ? WHERE session_key = ?'),
      updateModel: this.db.prepare('UPDATE sessions SET model = ? WHERE session_key = ?'),
      updateReasoningEffort: this.db.prepare('UPDATE sessions SET reasoning_effort = ? WHERE session_key = ?'),
      updateServiceTier: this.db.prepare('UPDATE sessions SET service_tier = ? WHERE session_key = ?'),
      updateVerbosity: this.db.prepare('UPDATE sessions SET verbosity = ? WHERE session_key = ?'),
      updateTurns: this.db.prepare('UPDATE sessions SET turns = ? WHERE session_key = ?'),
      updateSdkSessionId: this.db.prepare('UPDATE sessions SET sdk_session_id = ? WHERE session_key = ?'),
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
      reasoning_effort: row.reasoning_effort,
      service_tier: row.service_tier,
      verbosity: row.verbosity,
      status: row.status,
      created_at: row.created_at,
      last_activity: row.last_activity,
      turns: row.turns ?? 0,
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

  updateReasoningEffort(sessionKey: string, reasoningEffort: SessionRow['reasoning_effort']): void {
    this.stmts.updateReasoningEffort.run(reasoningEffort, sessionKey);
  }

  updateServiceTier(sessionKey: string, serviceTier: SessionRow['service_tier']): void {
    this.stmts.updateServiceTier.run(serviceTier, sessionKey);
  }

  updateVerbosity(sessionKey: string, verbosity: SessionRow['verbosity']): void {
    this.stmts.updateVerbosity.run(verbosity, sessionKey);
  }

  updateTurns(sessionKey: string, turns: number): void {
    this.stmts.updateTurns.run(turns, sessionKey);
  }

  updateSdkSessionId(sessionKey: string, sdkSessionId: string): void {
    this.stmts.updateSdkSessionId.run(sdkSessionId, sessionKey);
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
      reasoning_effort: row.reasoning_effort ?? null,
      service_tier: row.service_tier ?? null,
      verbosity: row.verbosity ?? null,
      turns: row.turns ?? 0,
      status: row.status,
      created_at: row.created_at,
      last_activity: row.last_activity,
    };
  }
}
