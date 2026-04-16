import type Database from 'better-sqlite3';
import type { SessionRow, SessionStatus, SessionQueryFilters, SessionPersistence } from '@ccbuddy/core';
export declare class SessionDatabase implements SessionPersistence {
    private db;
    private stmts;
    constructor(db: Database.Database);
    private prepareStatements;
    upsert(row: SessionRow): void;
    getByKey(sessionKey: string): SessionRow | null;
    getAll(filters?: SessionQueryFilters): SessionRow[];
    updateStatus(sessionKey: string, status: SessionStatus): void;
    updateLastActivity(sessionKey: string, timestamp: number): void;
    updateModel(sessionKey: string, model: string | null): void;
    updateTurns(sessionKey: string, turns: number): void;
    updateSdkSessionId(sessionKey: string, sdkSessionId: string): void;
    delete(sessionKey: string): void;
    private toSessionRow;
}
//# sourceMappingURL=session-database.d.ts.map