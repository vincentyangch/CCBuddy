# Dashboard Prerequisites Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the backend for the GUI dashboard by enhancing agent progress events, adding MessageStore pagination, and exposing session data through new getters.

**Architecture:** Three independent changes: (1) SdkBackend yields rich intermediate events (assistant text, tool use, thinking) from the SDK stream and a new `agent_events` SQLite table stores them for historical replay; (2) MessageStore gets paginated query methods; (3) SessionStore exposes `getAll()` and AgentService exposes `getSessionInfo()`.

**Tech Stack:** TypeScript, vitest, Claude Agent SDK, better-sqlite3

---

## Chunk 1: Enhanced Agent Progress Events

### Task 1: Extend AgentEvent and AgentProgressEvent types

**Files:**
- Modify: `packages/core/src/types/agent.ts`
- Modify: `packages/core/src/types/events.ts`

- [ ] **Step 1: Add new AgentEvent branches for thinking and tool_use**

In `packages/core/src/types/agent.ts`, add two new branches to the `AgentEvent` union (after the `tool_use` branch at line 33):

```typescript
  | AgentEventBase & { type: 'thinking'; content: string }
  | AgentEventBase & { type: 'tool_result'; tool: string; toolInput: Record<string, unknown>; toolOutput: string }
```

- [ ] **Step 2: Extend AgentProgressEvent**

In `packages/core/src/types/events.ts`, update `AgentProgressEvent` (lines 66-73) from:

```typescript
export interface AgentProgressEvent {
  userId: string;
  sessionId: string;
  channelId: string;
  platform: string;
  type: 'text' | 'tool_use';
  content: string;
}
```

to:

```typescript
export interface AgentProgressEvent {
  userId: string;
  sessionId: string;
  channelId: string;
  platform: string;
  type: 'text' | 'tool_use' | 'thinking' | 'tool_result';
  content: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
}
```

- [ ] **Step 3: Run type tests**

Run: `npx vitest run packages/core/src/types/__tests__/types.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types/agent.ts packages/core/src/types/events.ts
git commit -m "feat(core): extend agent event types for thinking and tool_result"
```

---

### Task 2: Update SdkBackend to yield intermediate events (TDD)

**Files:**
- Modify: `packages/agent/src/backends/sdk-backend.ts`
- Modify: `packages/agent/src/__tests__/sdk-backend.test.ts`

The SDK `query()` returns an `AsyncGenerator<SDKMessage>`. Currently, the backend only looks at `msg.type === 'result'` and discards everything else. We need to also yield events for:
- `msg.type === 'assistant'` → extract content blocks (text, thinking, tool_use) from `msg.message.content`
- `msg.type === 'tool_use_summary'` → tool execution summary

The SDK types we'll see:
- `SDKAssistantMessage`: `{ type: 'assistant', message: BetaMessage }` where `BetaMessage.content` is an array of `{ type: 'text', text: string }`, `{ type: 'thinking', thinking: string }`, or `{ type: 'tool_use', id: string, name: string, input: object }` blocks
- `SDKToolUseSummaryMessage`: `{ type: 'tool_use_summary', summary: string }`

- [ ] **Step 1: Write failing tests for intermediate event yielding**

Add these tests to `packages/agent/src/__tests__/sdk-backend.test.ts` inside the `describe('SdkBackend', ...)` block:

```typescript
  it('yields thinking events from assistant messages', async () => {
    async function* thinkingGenerator() {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Let me think about this...' },
            { type: 'text', text: 'Here is my answer.' },
          ],
        },
      };
      yield { type: 'result', subtype: 'success', result: 'Here is my answer.' };
    }
    mockQuery.mockReturnValue(thinkingGenerator());

    const backend = new SdkBackend();
    const events = [];
    for await (const event of backend.execute(makeRequest())) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThanOrEqual(3);
    const thinking = events.find(e => e.type === 'thinking');
    expect(thinking).toBeDefined();
    if (thinking && thinking.type === 'thinking') {
      expect(thinking.content).toBe('Let me think about this...');
    }
    const text = events.find(e => e.type === 'text');
    expect(text).toBeDefined();
    if (text && text.type === 'text') {
      expect(text.content).toBe('Here is my answer.');
    }
    const complete = events.find(e => e.type === 'complete');
    expect(complete).toBeDefined();
  });

  it('yields tool_use and tool_result events', async () => {
    async function* toolGenerator() {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      };
      yield { type: 'result', subtype: 'success', result: 'Done!' };
    }
    mockQuery.mockReturnValue(toolGenerator());

    const backend = new SdkBackend();
    const events = [];
    for await (const event of backend.execute(makeRequest())) {
      events.push(event);
    }

    const toolUse = events.find(e => e.type === 'tool_use');
    expect(toolUse).toBeDefined();
    if (toolUse && toolUse.type === 'tool_use') {
      expect(toolUse.tool).toBe('Bash');
    }
  });

  it('does not break when assistant message has no thinking blocks', async () => {
    async function* plainGenerator() {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Simple answer.' },
          ],
        },
      };
      yield { type: 'result', subtype: 'success', result: 'Simple answer.' };
    }
    mockQuery.mockReturnValue(plainGenerator());

    const backend = new SdkBackend();
    const events = [];
    for await (const event of backend.execute(makeRequest())) {
      events.push(event);
    }

    const thinking = events.find(e => e.type === 'thinking');
    expect(thinking).toBeUndefined();
    const complete = events.find(e => e.type === 'complete');
    expect(complete).toBeDefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/agent/src/__tests__/sdk-backend.test.ts`
Expected: FAIL — no `thinking`, `text`, or `tool_use` events yielded

- [ ] **Step 3: Update SdkBackend to yield intermediate events**

In `packages/agent/src/backends/sdk-backend.ts`, update the `for await` loop (lines 106-115) from:

```typescript
      let responseText = '';
      for await (const msg of result) {
        if (msg.type === 'result') {
          if ((msg as any).subtype === 'success') {
            responseText = (msg as any).result ?? '';
          } else {
            const errors: string[] = (msg as any).errors ?? [];
            throw new Error(errors.join('; ') || `Query ended with subtype: ${(msg as any).subtype}`);
          }
        }
      }
```

to:

```typescript
      let responseText = '';
      for await (const msg of result) {
        if (msg.type === 'assistant') {
          // Extract content blocks from assistant messages
          const content = (msg as any).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'thinking' && block.thinking) {
                yield { ...base, type: 'thinking' as const, content: block.thinking };
              } else if (block.type === 'text' && block.text) {
                yield { ...base, type: 'text' as const, content: block.text };
              } else if (block.type === 'tool_use') {
                yield { ...base, type: 'tool_use' as const, tool: block.name ?? block.id };
              }
            }
          }
        } else if (msg.type === 'result') {
          if ((msg as any).subtype === 'success') {
            responseText = (msg as any).result ?? '';
          } else {
            const errors: string[] = (msg as any).errors ?? [];
            throw new Error(errors.join('; ') || `Query ended with subtype: ${(msg as any).subtype}`);
          }
        }
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/agent/src/__tests__/sdk-backend.test.ts`
Expected: PASS (all existing + new tests)

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/backends/sdk-backend.ts packages/agent/src/__tests__/sdk-backend.test.ts
git commit -m "feat(agent): yield thinking, text, and tool_use events from SDK stream"
```

---

### Task 3: Update AgentService to publish new event types

**Files:**
- Modify: `packages/agent/src/agent-service.ts`
- Modify: `packages/agent/src/__tests__/agent-service.test.ts`

Currently, `AgentService.handleRequest()` only publishes `agent.progress` for `text` and `tool_use` events. It needs to also handle `thinking` and `tool_result`.

- [ ] **Step 1: Update the event publishing block in AgentService**

In `packages/agent/src/agent-service.ts`, update the progress event publishing (lines 120-132) from:

```typescript
      for await (const event of this.backend.execute(request)) {
        // Publish progress events to the event bus
        if (this.eventBus !== undefined && (event.type === 'text' || event.type === 'tool_use')) {
          const progressPayload = {
            userId: event.userId,
            sessionId: event.sessionId,
            channelId: event.channelId,
            platform: event.platform,
            type: event.type as 'text' | 'tool_use',
            content: event.type === 'text' ? event.content : event.tool,
          };
          void this.eventBus.publish('agent.progress', progressPayload);
        }
        yield event;
      }
```

to:

```typescript
      for await (const event of this.backend.execute(request)) {
        // Publish progress events to the event bus
        if (this.eventBus !== undefined) {
          if (event.type === 'text' || event.type === 'tool_use' || event.type === 'thinking') {
            const progressPayload: import('@ccbuddy/core').AgentProgressEvent = {
              userId: event.userId,
              sessionId: event.sessionId,
              channelId: event.channelId,
              platform: event.platform,
              type: event.type,
              content: event.type === 'tool_use' ? event.tool : event.content,
            };
            void this.eventBus.publish('agent.progress', progressPayload);
          } else if (event.type === 'tool_result') {
            const progressPayload: import('@ccbuddy/core').AgentProgressEvent = {
              userId: event.userId,
              sessionId: event.sessionId,
              channelId: event.channelId,
              platform: event.platform,
              type: 'tool_result',
              content: event.tool,
              toolInput: event.toolInput,
              toolOutput: event.toolOutput,
            };
            void this.eventBus.publish('agent.progress', progressPayload);
          }
        }
        yield event;
      }
```

- [ ] **Step 2: Run agent service tests**

Run: `npx vitest run packages/agent/src/__tests__/agent-service.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/agent-service.ts
git commit -m "feat(agent): publish thinking and tool_result progress events"
```

---

### Task 4: Add agent_events SQLite table for historical replay (TDD)

**Files:**
- Modify: `packages/memory/src/database.ts`
- Create: `packages/memory/src/agent-event-store.ts`
- Create: `packages/memory/src/__tests__/agent-event-store.test.ts`
- Modify: `packages/memory/src/index.ts`

- [ ] **Step 1: Add agent_events table to database schema**

In `packages/memory/src/database.ts`, add after the `summary_nodes` table creation (after the `user_profiles` table block):

```sql
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
```

- [ ] **Step 2: Write failing tests for AgentEventStore**

Create `packages/memory/src/__tests__/agent-event-store.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/memory/src/__tests__/agent-event-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement AgentEventStore**

Create `packages/memory/src/agent-event-store.ts`:

```typescript
import { MemoryDatabase } from './database.js';

export interface StoredAgentEvent {
  id: number;
  userId: string;
  sessionId: string;
  platform: string;
  eventType: string;
  content: string;
  toolInput: string | null;
  toolOutput: string | null;
  timestamp: number;
}

export interface AddAgentEventParams {
  userId: string;
  sessionId: string;
  platform: string;
  eventType: string;
  content: string;
  toolInput?: string;
  toolOutput?: string;
  timestamp?: number;
}

export class AgentEventStore {
  private db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.db = db;
  }

  add(params: AddAgentEventParams): number {
    const timestamp = params.timestamp ?? Date.now();
    const result = this.db.raw().prepare(`
      INSERT INTO agent_events (user_id, session_id, platform, event_type, content, tool_input, tool_output, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.userId,
      params.sessionId,
      params.platform,
      params.eventType,
      params.content,
      params.toolInput ?? null,
      params.toolOutput ?? null,
      timestamp,
    );
    return result.lastInsertRowid as number;
  }

  getBySession(sessionId: string, pagination?: { limit: number; offset: number }): StoredAgentEvent[] {
    if (pagination) {
      const rows = this.db.raw().prepare(`
        SELECT * FROM agent_events WHERE session_id = ?
        ORDER BY timestamp ASC, id ASC
        LIMIT ? OFFSET ?
      `).all(sessionId, pagination.limit, pagination.offset);
      return rows.map((r: any) => this.toEvent(r));
    }
    const rows = this.db.raw().prepare(`
      SELECT * FROM agent_events WHERE session_id = ?
      ORDER BY timestamp ASC, id ASC
    `).all(sessionId);
    return rows.map((r: any) => this.toEvent(r));
  }

  private toEvent(row: any): StoredAgentEvent {
    return {
      id: row.id,
      userId: row.user_id,
      sessionId: row.session_id,
      platform: row.platform,
      eventType: row.event_type,
      content: row.content,
      toolInput: row.tool_input,
      toolOutput: row.tool_output,
      timestamp: row.timestamp,
    };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/memory/src/__tests__/agent-event-store.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 6: Export from memory package**

In `packages/memory/src/index.ts`, add:

```typescript
export { AgentEventStore, type StoredAgentEvent, type AddAgentEventParams } from './agent-event-store.js';
```

- [ ] **Step 7: Run full memory test suite**

Run: `npx vitest run packages/memory`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/memory/src/database.ts packages/memory/src/agent-event-store.ts packages/memory/src/__tests__/agent-event-store.test.ts packages/memory/src/index.ts
git commit -m "feat(memory): add agent_events table and AgentEventStore for historical replay"
```

---

### Task 5: Wire agent event storage in gateway

**Files:**
- Modify: `packages/gateway/src/gateway.ts`
- Modify: `packages/main/src/bootstrap.ts`

The gateway needs to subscribe to `agent.progress` events and store them in the `AgentEventStore`. This is simpler than modifying the gateway's message handling pipeline — just add a subscription.

- [ ] **Step 1: Add agentEventStore to GatewayDeps**

In `packages/gateway/src/gateway.ts`, add to the `GatewayDeps` interface:

```typescript
  storeAgentEvent?: (params: { userId: string; sessionId: string; platform: string; eventType: string; content: string; toolInput?: string; toolOutput?: string }) => void;
```

- [ ] **Step 2: Subscribe to agent.progress in Gateway constructor**

In the `Gateway` constructor, after the existing `session.conflict` subscription, add:

```typescript
    // Store agent progress events for dashboard historical replay
    if (deps.storeAgentEvent) {
      deps.eventBus.subscribe('agent.progress', (event) => {
        deps.storeAgentEvent!({
          userId: event.userId,
          sessionId: event.sessionId,
          platform: event.platform,
          eventType: event.type,
          content: event.content,
          toolInput: event.toolInput ? JSON.stringify(event.toolInput) : undefined,
          toolOutput: event.toolOutput,
        });
      });
    }
```

- [ ] **Step 3: Wire in bootstrap**

In `packages/main/src/bootstrap.ts`, create an `AgentEventStore` and pass `storeAgentEvent` to the gateway deps. After the `messageStore` creation, add:

```typescript
  const agentEventStore = new AgentEventStore(database);
```

Add to the `new Gateway({...})` deps object:

```typescript
    storeAgentEvent: (params) => {
      agentEventStore.add({
        ...params,
        timestamp: Date.now(),
      });
    },
```

Add `AgentEventStore` to the `@ccbuddy/memory` import.

- [ ] **Step 4: Build all packages**

Run: `npm run build`
Expected: All packages compile cleanly

- [ ] **Step 5: Run full test suite**

Run: `npm run test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/gateway.ts packages/main/src/bootstrap.ts
git commit -m "feat: wire agent event storage for dashboard historical replay"
```

---

## Chunk 2: MessageStore Pagination + Session Data

### Task 6: Add paginated query to MessageStore (TDD)

**Files:**
- Modify: `packages/memory/src/message-store.ts`
- Modify: `packages/memory/src/__tests__/message-store.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `packages/memory/src/__tests__/message-store.test.ts`, inside the main `describe` block:

```typescript
  describe('query() — paginated search', () => {
    beforeEach(() => {
      for (let i = 0; i < 20; i++) {
        store.add({
          userId: i < 10 ? 'u1' : 'u2',
          sessionId: 's1',
          platform: i % 2 === 0 ? 'discord' : 'telegram',
          content: `message-${i}`,
          role: i % 3 === 0 ? 'user' : 'assistant',
          timestamp: 1000 + i,
        });
      }
    });

    it('returns paginated results', () => {
      const page1 = store.query({ page: 1, pageSize: 5 });
      expect(page1.messages).toHaveLength(5);
      expect(page1.total).toBe(20);
      expect(page1.messages[0].content).toBe('message-0');
    });

    it('returns second page', () => {
      const page2 = store.query({ page: 2, pageSize: 5 });
      expect(page2.messages).toHaveLength(5);
      expect(page2.messages[0].content).toBe('message-5');
    });

    it('filters by userId', () => {
      const result = store.query({ user: 'u1', page: 1, pageSize: 50 });
      expect(result.total).toBe(10);
      expect(result.messages.every(m => m.userId === 'u1')).toBe(true);
    });

    it('filters by platform', () => {
      const result = store.query({ platform: 'discord', page: 1, pageSize: 50 });
      expect(result.total).toBe(10);
      expect(result.messages.every(m => m.platform === 'discord')).toBe(true);
    });

    it('filters by date range', () => {
      const result = store.query({ dateFrom: 1005, dateTo: 1010, page: 1, pageSize: 50 });
      expect(result.total).toBe(6);
    });

    it('filters by search text', () => {
      const result = store.query({ search: 'message-1', page: 1, pageSize: 50 });
      // matches: message-1, message-10..message-19
      expect(result.total).toBe(11);
    });

    it('combines multiple filters', () => {
      const result = store.query({ user: 'u1', platform: 'discord', page: 1, pageSize: 50 });
      expect(result.total).toBe(5); // u1 (0-9), discord (even) = 0,2,4,6,8
    });

    it('returns empty for out-of-range page', () => {
      const result = store.query({ page: 100, pageSize: 5 });
      expect(result.messages).toHaveLength(0);
      expect(result.total).toBe(20);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/memory/src/__tests__/message-store.test.ts`
Expected: FAIL — `store.query` is not a function

- [ ] **Step 3: Implement the query method**

In `packages/memory/src/message-store.ts`, add this interface before the class:

```typescript
export interface MessageQueryParams {
  user?: string;
  platform?: string;
  dateFrom?: number;
  dateTo?: number;
  search?: string;
  page: number;
  pageSize: number;
}

export interface MessageQueryResult {
  messages: StoredMessage[];
  total: number;
  page: number;
  pageSize: number;
}
```

Add this method to the `MessageStore` class:

```typescript
  query(params: MessageQueryParams): MessageQueryResult {
    const conditions: string[] = [];
    const values: (string | number)[] = [];

    if (params.user) {
      conditions.push('user_id = ?');
      values.push(params.user);
    }
    if (params.platform) {
      conditions.push('platform = ?');
      values.push(params.platform);
    }
    if (params.dateFrom !== undefined) {
      conditions.push('timestamp >= ?');
      values.push(params.dateFrom);
    }
    if (params.dateTo !== undefined) {
      conditions.push('timestamp <= ?');
      values.push(params.dateTo);
    }
    if (params.search) {
      const escaped = params.search.replace(/[%_\\]/g, '\\$&');
      conditions.push("content LIKE ? ESCAPE '\\'");
      values.push(`%${escaped}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db.raw().prepare(
      `SELECT COUNT(*) as count FROM messages ${where}`
    ).get(...values) as { count: number };

    const offset = (params.page - 1) * params.pageSize;
    const rows = this.db.raw().prepare(
      `SELECT * FROM messages ${where} ORDER BY timestamp ASC, id ASC LIMIT ? OFFSET ?`
    ).all(...values, params.pageSize, offset);

    return {
      messages: rows.map((r: any) => this.toMessage(r)),
      total: countRow.count,
      page: params.page,
      pageSize: params.pageSize,
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/memory/src/__tests__/message-store.test.ts`
Expected: PASS (all existing + new tests)

- [ ] **Step 5: Export new types from memory package**

In `packages/memory/src/index.ts`, update the MessageStore export to include the new types:

```typescript
export { MessageStore, type StoredMessage, type AddMessageParams, type MessageQueryParams, type MessageQueryResult } from './message-store.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/memory/src/message-store.ts packages/memory/src/__tests__/message-store.test.ts packages/memory/src/index.ts
git commit -m "feat(memory): add paginated query() to MessageStore"
```

---

### Task 7: Add SessionStore.getAll() (TDD)

**Files:**
- Modify: `packages/agent/src/session/session-store.ts`
- Modify: `packages/agent/src/session/__tests__/session-store.test.ts`

- [ ] **Step 1: Write failing test**

Add to `packages/agent/src/session/__tests__/session-store.test.ts`:

```typescript
  it('getAll returns all active sessions', () => {
    const store = new SessionStore(3_600_000);
    store.getOrCreate('dad-discord-ch1', false);
    store.getOrCreate('discord-ch2', true);

    const all = store.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].sessionKey).toBe('dad-discord-ch1');
    expect(all[0].isGroupChannel).toBe(false);
    expect(all[1].sessionKey).toBe('discord-ch2');
    expect(all[1].isGroupChannel).toBe(true);
  });

  it('getAll returns empty array when no sessions', () => {
    const store = new SessionStore(3_600_000);
    expect(store.getAll()).toEqual([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/agent/src/session/__tests__/session-store.test.ts`
Expected: FAIL — `store.getAll is not a function`

- [ ] **Step 3: Implement getAll**

In `packages/agent/src/session/session-store.ts`, export the `SessionEntry` interface (add `sessionKey`):

```typescript
export interface SessionInfo {
  sessionKey: string;
  sdkSessionId: string;
  lastActivity: number;
  isGroupChannel: boolean;
}
```

Add this method to the `SessionStore` class:

```typescript
  getAll(): SessionInfo[] {
    return Array.from(this.entries.entries()).map(([key, entry]) => ({
      sessionKey: key,
      sdkSessionId: entry.sdkSessionId,
      lastActivity: entry.lastActivity,
      isGroupChannel: entry.isGroupChannel,
    }));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/agent/src/session/__tests__/session-store.test.ts`
Expected: PASS (all 9 tests)

- [ ] **Step 5: Export SessionInfo type**

In `packages/agent/src/session/index.ts`, update:

```typescript
export { SessionStore, type SessionInfo } from './session-store.js';
```

In `packages/agent/src/index.ts`, update to include `SessionInfo`:

```typescript
export { RateLimiter, PriorityQueue, SessionManager, SessionStore, type SessionInfo } from './session/index.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/session/session-store.ts packages/agent/src/session/__tests__/session-store.test.ts packages/agent/src/session/index.ts packages/agent/src/index.ts
git commit -m "feat(agent): add SessionStore.getAll() for dashboard session listing"
```

---

### Task 8: Add AgentService.getSessionInfo() (TDD)

**Files:**
- Modify: `packages/agent/src/agent-service.ts`
- Modify: `packages/agent/src/__tests__/agent-service.test.ts`

- [ ] **Step 1: Write failing test**

Add to `packages/agent/src/__tests__/agent-service.test.ts`. First, check if a `SessionStore` is already available in the test setup. If not, import it and create one. Add:

```typescript
  it('getSessionInfo returns combined session data', async () => {
    // The AgentService needs a sessionStore reference for this
    const sessionStore = new SessionStore(3_600_000);
    const service = new AgentService({
      ...defaultOptions,
      sessionStore,
    });

    // Create a session via the store
    sessionStore.getOrCreate('dad-discord-ch1', false);

    const info = service.getSessionInfo();
    expect(info).toHaveLength(1);
    expect(info[0].sessionKey).toBe('dad-discord-ch1');
    expect(info[0].sdkSessionId).toBeDefined();
  });

  it('getSessionInfo returns empty when no sessions', () => {
    const sessionStore = new SessionStore(3_600_000);
    const service = new AgentService({
      ...defaultOptions,
      sessionStore,
    });

    expect(service.getSessionInfo()).toEqual([]);
  });
```

Import `SessionStore` at the top of the test file if not already imported.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/agent/src/__tests__/agent-service.test.ts`
Expected: FAIL — `sessionStore` not a valid option / `getSessionInfo` not a function

- [ ] **Step 3: Add sessionStore option and getSessionInfo method**

In `packages/agent/src/agent-service.ts`, add to `AgentServiceOptions`:

```typescript
  sessionStore?: import('./session/session-store.js').SessionStore;
```

Add a private field and update the constructor:

```typescript
  private readonly sessionStore?: import('./session/session-store.js').SessionStore;
```

In the constructor body:

```typescript
    this.sessionStore = options.sessionStore;
```

Add the method:

```typescript
  getSessionInfo(): import('./session/session-store.js').SessionInfo[] {
    return this.sessionStore?.getAll() ?? [];
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/agent/src/__tests__/agent-service.test.ts`
Expected: PASS

- [ ] **Step 5: Wire sessionStore into AgentService in bootstrap**

In `packages/main/src/bootstrap.ts`, pass `sessionStore` when creating `AgentService`:

```typescript
  const agentService = new AgentService({
    // ... existing options ...
    sessionStore,
  });
```

Note: `sessionStore` is created after `agentService` currently. Move `sessionStore` creation to before `agentService` creation.

- [ ] **Step 6: Build and run full test suite**

Run: `npm run build && npm run test`
Expected: All packages compile, all tests pass

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/agent-service.ts packages/agent/src/__tests__/agent-service.test.ts packages/main/src/bootstrap.ts
git commit -m "feat(agent): add AgentService.getSessionInfo() for dashboard"
```
