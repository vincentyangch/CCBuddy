# Multi-Directory Workspaces Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Map Discord channels to project directories so Po runs Claude Code in the right codebase for each conversation.

**Architecture:** `WorkspaceStore` (SQLite) persists channel→directory mappings. MCP tools (`set_workspace`, `get_workspace`, `remove_workspace`) let users configure mappings via chat. Gateway resolves the workspace before building `AgentRequest`. Unmapped channels fall back to `default_working_directory`.

**Tech Stack:** TypeScript, better-sqlite3, Vitest

**Spec:** `docs/superpowers/specs/2026-03-21-multi-directory-workspaces-design.md`

---

## Chunk 1: WorkspaceStore + Table

### Task 1: Add workspaces table and WorkspaceStore

**Files:**
- Modify: `packages/memory/src/database.ts` (add table)
- Create: `packages/memory/src/workspace-store.ts`
- Create: `packages/memory/src/__tests__/workspace-store.test.ts`
- Modify: `packages/memory/src/index.ts` (export)

- [ ] **Step 1: Write the tests**

Create `packages/memory/src/__tests__/workspace-store.test.ts`:

```typescript
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
    store.remove('nonexistent'); // should not throw
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/memory -- --run`
Expected: FAIL — `workspace-store.ts` does not exist

- [ ] **Step 3: Add workspaces table to MemoryDatabase.init()**

In `packages/memory/src/database.ts`, add inside the `db.exec()` block, after the sessions indexes:

```sql
      CREATE TABLE IF NOT EXISTS workspaces (
        channel_key TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
```

- [ ] **Step 4: Implement WorkspaceStore**

Create `packages/memory/src/workspace-store.ts`:

```typescript
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
```

- [ ] **Step 5: Export from memory index**

Add to `packages/memory/src/index.ts`:

```typescript
export { WorkspaceStore } from './workspace-store.js';
```

- [ ] **Step 6: Build and run tests**

Run: `npm run build -w packages/core -w packages/memory && npm test -w packages/memory -- --run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add packages/memory/src/database.ts packages/memory/src/workspace-store.ts packages/memory/src/__tests__/workspace-store.test.ts packages/memory/src/index.ts
git commit -m "feat(memory): add workspaces table and WorkspaceStore"
```

---

## Chunk 2: Gateway + Bootstrap

### Task 2: Gateway workspace resolution

**Files:**
- Modify: `packages/gateway/src/gateway.ts:36-54` (GatewayDeps)
- Modify: `packages/gateway/src/gateway.ts:228-245` (AgentRequest building)

- [ ] **Step 1: Add workspace deps to GatewayDeps**

In `packages/gateway/src/gateway.ts`, add to the `GatewayDeps` interface:

```typescript
  getWorkspace?: (channelKey: string) => string | null;
  defaultWorkingDirectory?: string;
```

- [ ] **Step 2: Resolve workspace when building AgentRequest**

In `handleIncomingMessage`, before building the `AgentRequest` (around line 228), add:

```typescript
    // 6b. Resolve working directory for this channel
    const channelKey = `${msg.platform}-${msg.channelId}`;
    const workingDirectory = this.deps.getWorkspace?.(channelKey) ?? this.deps.defaultWorkingDirectory;
```

Then in the `AgentRequest` object (line 229), add `workingDirectory`:

```typescript
    const request: AgentRequest = {
      prompt: msg.text,
      userId: user.name,
      sessionId,
      channelId: msg.channelId,
      platform: msg.platform,
      model: effectiveModel,
      memoryContext,
      workingDirectory,
      // ... rest unchanged
    };
```

- [ ] **Step 3: Build and run gateway tests**

Run: `npm run build -w packages/gateway && npm test -w packages/gateway -- --run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): resolve per-channel workspace for AgentRequest"
```

---

### Task 3: Bootstrap wiring + channel-key MCP arg

**Files:**
- Modify: `packages/main/src/bootstrap.ts`

- [ ] **Step 1: Add WorkspaceStore import and creation**

Add `WorkspaceStore` to the `@ccbuddy/memory` import. After the other store creations (around line 138), add:

```typescript
  const workspaceStore = new WorkspaceStore(database.raw());
```

- [ ] **Step 2: Wire workspace into gateway deps**

In the `Gateway` constructor call (around line 242), add:

```typescript
    getWorkspace: (channelKey) => workspaceStore.get(channelKey),
    defaultWorkingDirectory: config.agent.default_working_directory,
```

- [ ] **Step 3: Add --channel-key to MCP server args**

In the `executeAgentRequest` closure (around line 248-251), the MCP server args are built per-request. Currently:

```typescript
        args: [...skillMcpServer.args, '--session-key', request.sessionId],
```

Change to also include the channel key:

```typescript
        args: [
          ...skillMcpServer.args,
          '--session-key', request.sessionId,
          '--channel-key', `${request.platform}-${request.channelId}`,
        ],
```

- [ ] **Step 4: Build and verify**

Run: `npm run build -w packages/main`
Expected: Clean build

- [ ] **Step 5: Commit**

```bash
git add packages/main/src/bootstrap.ts
git commit -m "feat(main): wire WorkspaceStore into gateway and pass --channel-key to MCP"
```

---

## Chunk 3: MCP Tools

### Task 4: Add workspace MCP tools

**Files:**
- Modify: `packages/skills/src/mcp-server.ts` (parseArgs, tool defs, tool handlers)

- [ ] **Step 1: Add --channel-key to parseArgs**

In `packages/skills/src/mcp-server.ts`, update the `parseArgs` function:

Add `channelKey: string` to the return type (line 45 area).
Add `let channelKey = '';` to the variable declarations.
Add to the switch statement:

```typescript
      case '--channel-key':
        channelKey = argv[++i] ?? '';
        break;
```

Add `channelKey` to the return object.

- [ ] **Step 2: Create WorkspaceStore in MCP server**

Near the existing `sessionDb` initialization (where `profileDatabase` is created), add:

```typescript
    let workspaceStore: WorkspaceStore | undefined;
    if (args.memoryDbPath) {
      workspaceStore = new WorkspaceStore(profileDatabase!.raw());
    }
```

Add the import:
```typescript
import { MemoryDatabase, MessageStore, SummaryStore, RetrievalTools, ProfileStore, SessionDatabase, WorkspaceStore } from '@ccbuddy/memory';
```

- [ ] **Step 3: Add tool definitions**

After the notification tools (or after session tools), add inside the `if (args.channelKey)` block — actually, workspace tools should be available when `workspaceStore` exists AND `channelKey` is provided:

```typescript
    if (workspaceStore && args.channelKey) {
      tools.push({
        name: 'set_workspace',
        description: 'Map the current channel to a working directory. Future messages in this channel will use that directory for Claude Code. The directory must exist.',
        inputSchema: {
          type: 'object',
          properties: {
            directory: { type: 'string', description: 'Absolute path to the project directory (~ is expanded to home dir)' },
          },
          required: ['directory'],
        },
      });
      tools.push({
        name: 'get_workspace',
        description: 'Show the working directory mapped to the current channel, or indicate if using the default.',
        inputSchema: { type: 'object', properties: {} },
      });
      tools.push({
        name: 'remove_workspace',
        description: 'Remove the workspace mapping for the current channel. Future messages will use the default working directory.',
        inputSchema: { type: 'object', properties: {} },
      });
    }
```

- [ ] **Step 4: Add tool handlers**

Add before the unknown tool section:

```typescript
    // ── set_workspace ──────────────────────────────────────────────────
    if (workspaceStore && name === 'set_workspace') {
      let dir = toolArgs.directory as string;
      // Expand ~ to home directory
      if (dir.startsWith('~')) {
        dir = dir.replace(/^~/, process.env.HOME ?? '');
      }
      // Validate directory exists
      const { existsSync, statSync } = await import('node:fs');
      if (!existsSync(dir)) {
        return { content: [{ type: 'text', text: `Directory does not exist: ${dir}` }] };
      }
      try {
        if (!statSync(dir).isDirectory()) {
          return { content: [{ type: 'text', text: `Path is not a directory: ${dir}` }] };
        }
      } catch {
        return { content: [{ type: 'text', text: `Cannot access path: ${dir}` }] };
      }
      workspaceStore.set(args.channelKey, dir);
      return { content: [{ type: 'text', text: `Workspace set to ${dir} for this channel. Future messages will use this directory.` }] };
    }

    // ── get_workspace ──────────────────────────────────────────────────
    if (workspaceStore && name === 'get_workspace') {
      const dir = workspaceStore.get(args.channelKey);
      return {
        content: [{
          type: 'text',
          text: dir
            ? `This channel is mapped to: ${dir}`
            : 'No workspace mapped — using default working directory.',
        }],
      };
    }

    // ── remove_workspace ───────────────────────────────────────────────
    if (workspaceStore && name === 'remove_workspace') {
      workspaceStore.remove(args.channelKey);
      return { content: [{ type: 'text', text: 'Workspace mapping removed. This channel will use the default working directory.' }] };
    }
```

- [ ] **Step 5: Build and run tests**

Run: `npm run build && npm test -w packages/skills -- --run`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add packages/skills/src/mcp-server.ts
git commit -m "feat(skills): add set_workspace, get_workspace, remove_workspace MCP tools"
```

---

## Chunk 4: Integration

### Task 5: Run full test suite and fix issues

- [ ] **Step 1: Build all packages**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Fix any failures**

Common issues:
- Bootstrap test mock may need `WorkspaceStore` added to `@ccbuddy/memory` mock
- Skills test may need `workspaces` table in test DB setup
- Gateway test mocks may need `getWorkspace`/`defaultWorkingDirectory` added

- [ ] **Step 4: Commit fixes**

```bash
git add -A
git commit -m "fix: resolve test failures from workspace integration"
```

---

### Task 6: Verify end-to-end

- [ ] **Step 1: Restart CCBuddy and verify table creation**

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
sqlite3 data/memory.sqlite ".schema workspaces"
```

- [ ] **Step 2: Test in Discord**

1. In a channel, tell Po: "Set the workspace for this channel to ~/Documents/Projects/SomeProject"
2. Po should call `set_workspace` and confirm
3. Tell Po: "What workspace is this channel using?"
4. Po should call `get_workspace` and show the path
5. Send a coding task — Po should work in the mapped directory
6. Tell Po: "Remove the workspace for this channel"
7. Po should call `remove_workspace` and confirm
