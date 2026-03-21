import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryDatabase } from '../database.js';
import { AgentEventStore } from '../agent-event-store.js';

describe('AgentEventStore', () => {
  let tmpDir: string;
  let db: MemoryDatabase;
  let store: AgentEventStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccbuddy-aes-test-'));
    db = new MemoryDatabase(join(tmpDir, 'test.db'));
    db.init();
    store = new AgentEventStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores and retrieves agent events by session', () => {
    store.add({
      userId: 'u1', sessionId: 's1', platform: 'discord',
      eventType: 'thinking', content: 'Let me think...', timestamp: 1000,
    });
    store.add({
      userId: 'u1', sessionId: 's1', platform: 'discord',
      eventType: 'text', content: 'Answer', timestamp: 2000,
    });

    const events = store.getBySession('s1');
    expect(events).toHaveLength(2);
    expect(events[0].eventType).toBe('thinking');
    expect(events[1].eventType).toBe('text');
  });

  it('stores tool_result with input and output', () => {
    store.add({
      userId: 'u1', sessionId: 's1', platform: 'discord',
      eventType: 'tool_result', content: 'Bash',
      toolInput: JSON.stringify({ command: 'ls' }),
      toolOutput: 'file1.txt\nfile2.txt',
      timestamp: 1000,
    });

    const events = store.getBySession('s1');
    expect(events).toHaveLength(1);
    expect(events[0].toolInput).toBe('{"command":"ls"}');
    expect(events[0].toolOutput).toBe('file1.txt\nfile2.txt');
  });

  it('paginates results', () => {
    for (let i = 0; i < 10; i++) {
      store.add({
        userId: 'u1', sessionId: 's1', platform: 'discord',
        eventType: 'text', content: `msg-${i}`, timestamp: 1000 + i,
      });
    }

    const page1 = store.getBySession('s1', { limit: 3, offset: 0 });
    expect(page1).toHaveLength(3);
    expect(page1[0].content).toBe('msg-0');

    const page2 = store.getBySession('s1', { limit: 3, offset: 3 });
    expect(page2).toHaveLength(3);
    expect(page2[0].content).toBe('msg-3');
  });

  it('returns empty array for unknown session', () => {
    expect(store.getBySession('nonexistent')).toEqual([]);
  });
});
