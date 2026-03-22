import type Database from 'better-sqlite3';

interface WorkspaceRow {
  channel_key: string;
  directory: string;
  created_at: number;
}

export class WorkspaceStore {
  private stmts: {
    set: Database.Statement;
    get: Database.Statement;
    remove: Database.Statement;
    getAll: Database.Statement;
  };

  constructor(db: Database.Database) {
    this.stmts = {
      set: db.prepare(`
        INSERT INTO workspaces (channel_key, directory, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(channel_key) DO UPDATE SET directory = excluded.directory
      `),
      get: db.prepare('SELECT directory FROM workspaces WHERE channel_key = ?'),
      remove: db.prepare('DELETE FROM workspaces WHERE channel_key = ?'),
      getAll: db.prepare('SELECT * FROM workspaces ORDER BY created_at DESC'),
    };
  }

  set(channelKey: string, directory: string): void {
    this.stmts.set.run(channelKey, directory, Date.now());
  }

  get(channelKey: string): string | null {
    const row = this.stmts.get.get(channelKey) as { directory: string } | undefined;
    return row?.directory ?? null;
  }

  remove(channelKey: string): void {
    this.stmts.remove.run(channelKey);
  }

  getAll(): WorkspaceRow[] {
    return this.stmts.getAll.all() as WorkspaceRow[];
  }
}
