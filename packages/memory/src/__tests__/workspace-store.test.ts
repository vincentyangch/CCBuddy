import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDatabase } from '../database.js';
import { WorkspaceStore } from '../workspace-store.js';

describe('WorkspaceStore', () => {
  let db: MemoryDatabase;
  let store: WorkspaceStore;

  beforeEach(() => {
    db = new MemoryDatabase(':memory:');
    db.init();
    store = new WorkspaceStore(db.raw());
  });

  it('get returns null for unknown key', () => {
    expect(store.get('discord-123')).toBeNull();
  });

  it('set + get round-trips', () => {
    store.set('discord-123', '/home/user/project');
    expect(store.get('discord-123')).toBe('/home/user/project');
  });

  it('set overwrites existing mapping', () => {
    store.set('discord-123', '/path/a');
    store.set('discord-123', '/path/b');
    expect(store.get('discord-123')).toBe('/path/b');
  });

  it('remove clears the mapping', () => {
    store.set('discord-123', '/path/a');
    store.remove('discord-123');
    expect(store.get('discord-123')).toBeNull();
  });

  it('remove is no-op for unknown key', () => {
    store.remove('nonexistent');
  });

  it('getAll returns all mappings', () => {
    store.set('discord-1', '/path/a');
    store.set('discord-2', '/path/b');
    const all = store.getAll();
    expect(all).toHaveLength(2);
    expect(all.map(w => w.channel_key).sort()).toEqual(['discord-1', 'discord-2']);
  });

  it('getAll returns empty array when none set', () => {
    expect(store.getAll()).toEqual([]);
  });
});
