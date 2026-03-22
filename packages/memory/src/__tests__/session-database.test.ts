import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDatabase } from '../database.js';
import { SessionDatabase } from '../session-database.js';
import type { SessionRow } from '@ccbuddy/core';

function makeRow(overrides?: Partial<SessionRow>): SessionRow {
  return {
    session_key: 'dad-discord-ch1',
    sdk_session_id: 'uuid-1234',
    user_id: 'dad',
    platform: 'discord',
    channel_id: 'ch1',
    is_group_channel: false,
    model: null,
    turns: 0,
    status: 'active',
    created_at: 1000,
    last_activity: 1000,
    ...overrides,
  };
}

describe('SessionDatabase', () => {
  let db: MemoryDatabase;
  let sessionDb: SessionDatabase;

  beforeEach(() => {
    db = new MemoryDatabase(':memory:');
    db.init();
    sessionDb = new SessionDatabase(db.raw());
  });

  it('upsert + getByKey round-trips a row', () => {
    const row = makeRow();
    sessionDb.upsert(row);
    const result = sessionDb.getByKey('dad-discord-ch1');
    expect(result).toEqual(row);
  });

  it('getByKey returns null for unknown key', () => {
    expect(sessionDb.getByKey('nonexistent')).toBeNull();
  });

  it('upsert overwrites existing row', () => {
    sessionDb.upsert(makeRow());
    sessionDb.upsert(makeRow({ model: 'opus', last_activity: 2000 }));
    const result = sessionDb.getByKey('dad-discord-ch1');
    expect(result!.model).toBe('opus');
    expect(result!.last_activity).toBe(2000);
  });

  it('getAll returns all rows sorted by last_activity desc', () => {
    sessionDb.upsert(makeRow({ session_key: 'a', last_activity: 100 }));
    sessionDb.upsert(makeRow({ session_key: 'b', last_activity: 300 }));
    sessionDb.upsert(makeRow({ session_key: 'c', last_activity: 200 }));
    const all = sessionDb.getAll();
    expect(all.map(r => r.session_key)).toEqual(['b', 'c', 'a']);
  });

  it('getAll filters by status', () => {
    sessionDb.upsert(makeRow({ session_key: 'a', status: 'active' }));
    sessionDb.upsert(makeRow({ session_key: 'b', status: 'archived' }));
    const active = sessionDb.getAll({ status: 'active' });
    expect(active).toHaveLength(1);
    expect(active[0].session_key).toBe('a');
  });

  it('getAll filters by platform', () => {
    sessionDb.upsert(makeRow({ session_key: 'a', platform: 'discord' }));
    sessionDb.upsert(makeRow({ session_key: 'b', platform: 'telegram' }));
    const discord = sessionDb.getAll({ platform: 'discord' });
    expect(discord).toHaveLength(1);
    expect(discord[0].session_key).toBe('a');
  });

  it('updateStatus changes status', () => {
    sessionDb.upsert(makeRow());
    sessionDb.updateStatus('dad-discord-ch1', 'paused');
    expect(sessionDb.getByKey('dad-discord-ch1')!.status).toBe('paused');
  });

  it('updateLastActivity changes timestamp', () => {
    sessionDb.upsert(makeRow());
    sessionDb.updateLastActivity('dad-discord-ch1', 9999);
    expect(sessionDb.getByKey('dad-discord-ch1')!.last_activity).toBe(9999);
  });

  it('updateModel changes model', () => {
    sessionDb.upsert(makeRow());
    sessionDb.updateModel('dad-discord-ch1', 'opus[1m]');
    expect(sessionDb.getByKey('dad-discord-ch1')!.model).toBe('opus[1m]');
  });

  it('updateModel sets null', () => {
    sessionDb.upsert(makeRow({ model: 'opus' }));
    sessionDb.updateModel('dad-discord-ch1', null);
    expect(sessionDb.getByKey('dad-discord-ch1')!.model).toBeNull();
  });

  it('delete removes the row', () => {
    sessionDb.upsert(makeRow());
    sessionDb.delete('dad-discord-ch1');
    expect(sessionDb.getByKey('dad-discord-ch1')).toBeNull();
  });

  it('delete is no-op for unknown key', () => {
    sessionDb.delete('nonexistent'); // should not throw
  });
});
