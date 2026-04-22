export class SessionDatabase {
    db;
    stmts;
    constructor(db) {
        this.db = db;
        this.prepareStatements();
    }
    prepareStatements() {
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
    upsert(row) {
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
    getByKey(sessionKey) {
        const row = this.stmts.getByKey.get(sessionKey);
        return row ? this.toSessionRow(row) : null;
    }
    getAll(filters) {
        const conditions = [];
        const params = [];
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
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(r => this.toSessionRow(r));
    }
    updateStatus(sessionKey, status) {
        this.stmts.updateStatus.run(status, sessionKey);
    }
    updateLastActivity(sessionKey, timestamp) {
        this.stmts.updateLastActivity.run(timestamp, sessionKey);
    }
    updateModel(sessionKey, model) {
        this.stmts.updateModel.run(model, sessionKey);
    }
    updateReasoningEffort(sessionKey, reasoningEffort) {
        this.stmts.updateReasoningEffort.run(reasoningEffort, sessionKey);
    }
    updateServiceTier(sessionKey, serviceTier) {
        this.stmts.updateServiceTier.run(serviceTier, sessionKey);
    }
    updateVerbosity(sessionKey, verbosity) {
        this.stmts.updateVerbosity.run(verbosity, sessionKey);
    }
    updateTurns(sessionKey, turns) {
        this.stmts.updateTurns.run(turns, sessionKey);
    }
    updateSdkSessionId(sessionKey, sdkSessionId) {
        this.stmts.updateSdkSessionId.run(sdkSessionId, sessionKey);
    }
    delete(sessionKey) {
        this.stmts.delete.run(sessionKey);
    }
    toSessionRow(row) {
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
//# sourceMappingURL=session-database.js.map
