import Database from 'better-sqlite3';
export declare class MemoryDatabase {
    private db;
    constructor(dbPath: string, opts?: {
        readonly?: boolean;
    });
    init(): void;
    raw(): Database.Database;
    backup(destPath: string): Promise<void>;
    close(): void;
    transaction<T>(fn: () => T): T;
}
//# sourceMappingURL=database.d.ts.map