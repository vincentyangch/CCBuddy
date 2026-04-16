import Database from 'better-sqlite3';
export class MemoryDatabase {
    db;
    constructor(dbPath, opts) {
        this.db = new Database(dbPath, opts?.readonly ? { readonly: true } : undefined);
    }
    init() {
        // Enable WAL mode for better concurrent read performance
        this.db.pragma('journal_mode = WAL');
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        content TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        attachments TEXT,
        timestamp INTEGER NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_user_ts ON messages(user_id, timestamp);

      CREATE TABLE IF NOT EXISTS summary_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        source_ids TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_user ON summary_nodes(user_id);
      CREATE INDEX IF NOT EXISTS idx_summaries_depth ON summary_nodes(user_id, depth);

      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, key)
      );
      CREATE TABLE IF NOT EXISTS agent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        event_type TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_input TEXT,
        tool_output TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_events_session ON agent_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_agent_events_user_ts ON agent_events(user_id, timestamp);

      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY,
        sdk_session_id TEXT NOT NULL,
        user_id TEXT,
        platform TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        is_group_channel BOOLEAN NOT NULL DEFAULT 0,
        model TEXT,
        reasoning_effort TEXT,
        verbosity TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'archived')),
        created_at INTEGER NOT NULL,
        last_activity INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS workspaces (
        channel_key TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
        // Migrations — add consolidation columns if missing
        const messagesCols = this.db.pragma('table_info(messages)');
        if (!messagesCols.some(c => c.name === 'summarized_at')) {
            this.db.exec('ALTER TABLE messages ADD COLUMN summarized_at INTEGER');
        }
        const summaryCols = this.db.pragma('table_info(summary_nodes)');
        if (!summaryCols.some(c => c.name === 'condensed_at')) {
            this.db.exec('ALTER TABLE summary_nodes ADD COLUMN condensed_at INTEGER');
        }
        const sessionCols = this.db.pragma('table_info(sessions)');
        if (sessionCols.length > 0 && !sessionCols.some(c => c.name === 'turns')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN turns INTEGER NOT NULL DEFAULT 0');
        }
        if (sessionCols.length > 0 && !sessionCols.some(c => c.name === 'reasoning_effort')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT');
        }
        if (sessionCols.length > 0 && !sessionCols.some(c => c.name === 'verbosity')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN verbosity TEXT');
        }
    }
    raw() {
        return this.db;
    }
    async backup(destPath) {
        await this.db.backup(destPath);
    }
    close() {
        this.db.close();
    }
    transaction(fn) {
        return this.db.transaction(fn)();
    }
}
//# sourceMappingURL=database.js.map
