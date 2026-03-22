# Multi-Directory Workspaces

**Date:** 2026-03-21
**Status:** Approved

## Problem

Po always runs Claude Code in a single working directory (`default_working_directory` from config). Users who work on multiple projects need the ability to map different Discord channels to different project directories, so Po has the right codebase context for each conversation.

## Goals

1. Map Discord channels to project directories via chat ("connect this channel to ~/Projects/MyApp")
2. Mappings persist across restarts (SQLite)
3. Unmapped channels fall back to `default_working_directory`
4. Validate directory exists before saving

## Non-Goals

- Per-user working directories (workspace is per-channel, shared by all users in that channel)
- Automatic project detection
- Dashboard UI for workspace management

## Data Model

New table in `MemoryDatabase`:

```sql
CREATE TABLE IF NOT EXISTS workspaces (
  channel_key TEXT PRIMARY KEY,
  directory TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

`channel_key` format: `"{platform}-{channelId}"` — same pattern as session keys for group channels.

## Component Design

### WorkspaceStore (new — `@ccbuddy/memory`)

**File:** `packages/memory/src/workspace-store.ts`

Thin SQLite CRUD layer:

```typescript
class WorkspaceStore {
  constructor(db: BetterSqlite3.Database)
  set(channelKey: string, directory: string): void
  get(channelKey: string): string | null
  remove(channelKey: string): void
  getAll(): Array<{ channel_key: string; directory: string; created_at: number }>
}
```

Table creation registered in `MemoryDatabase.init()`.

### MCP Tools

Three tools, all gated behind `args.sessionKey` (channel key derived from session key):

**`set_workspace`**
```typescript
{
  name: 'set_workspace',
  description: 'Map the current channel to a working directory. Future messages in this channel will use that directory for Claude Code. The directory must exist.',
  inputSchema: {
    type: 'object',
    properties: {
      directory: { type: 'string', description: 'Absolute path to the project directory' }
    },
    required: ['directory']
  }
}
```

Implementation:
1. Resolve `~` to home directory
2. Validate path exists via `existsSync` — reject if not
3. Derive channel key from session key (strip user prefix for DM keys to get the channel-level key)
4. Write to WorkspaceStore
5. Return confirmation with the resolved path

**`get_workspace`**
```typescript
{
  name: 'get_workspace',
  description: 'Show the working directory mapped to the current channel, or indicate if using the default.',
  inputSchema: { type: 'object', properties: {} }
}
```

**`remove_workspace`**
```typescript
{
  name: 'remove_workspace',
  description: 'Remove the workspace mapping for the current channel. Future messages will use the default working directory.',
  inputSchema: { type: 'object', properties: {} }
}
```

### Channel Key Derivation in MCP Server

The MCP server receives `--session-key` which is either:
- Group: `{platform}-{channelId}` (e.g., `discord-123456`)
- DM: `{userName}-{platform}-{channelId}` (e.g., `dad-discord-789`)

For workspace mapping, we want the channel-level key (without user prefix) so all users in a channel share the same workspace. For DM keys, the channel is unique per user anyway, so both formats work. The simplest approach: use the session key as-is for workspace lookup, since group channels already have the right format and DM channels are inherently per-user.

However, the gateway needs to look up by `{platform}-{channelId}` (it doesn't have the user prefix at lookup time). So:
- **MCP tools** store using `{platform}-{channelId}` format (derived by parsing the session key)
- **Gateway** looks up using `{platform}-{channelId}` (which it can construct directly)

To extract the channel key from a session key in the MCP server:
- If the session key matches the pattern `{platform}-{channelId}` (no user prefix), use as-is
- If it has a user prefix (`{user}-{platform}-{channelId}`), strip the first segment

A simpler approach: pass `--channel-key` as a separate CLI arg to the MCP server alongside `--session-key`. The gateway already has `platform` and `channelId` when constructing the MCP server args.

### Gateway Changes

**File:** `packages/gateway/src/gateway.ts`

Add to `GatewayDeps`:
```typescript
  getWorkspace?: (channelKey: string) => string | null;
  defaultWorkingDirectory?: string;
```

In `handleIncomingMessage`, after computing `sessionKey`, before building the `AgentRequest`:

```typescript
const channelKey = `${msg.platform}-${msg.channelId}`;
const workingDirectory = this.deps.getWorkspace?.(channelKey) ?? this.deps.defaultWorkingDirectory;
```

Pass `workingDirectory` into the `AgentRequest` object.

### Bootstrap Wiring

```typescript
const workspaceStore = new WorkspaceStore(database.raw());

// Gateway deps
getWorkspace: (channelKey) => workspaceStore.get(channelKey),
defaultWorkingDirectory: config.agent.default_working_directory,

// MCP server args — add --channel-key
`--channel-key`, `${msg.platform}-${msg.channelId}`,
```

### MCP Server Args

Add `--channel-key` to `parseArgs()` in the MCP server. The workspace tools use this to store/lookup the channel-level mapping. This is cleaner than parsing the session key.

## What Stays the Same

- `DirectoryLock` — already serializes per-directory access
- SDK/CLI backends — already accept `workingDirectory` in AgentRequest
- `default_working_directory` config — unchanged, used as fallback
- Session key computation — unchanged
- Scheduler jobs — continue using their own `target` config, not workspace mappings

## Testing

- **WorkspaceStore:** CRUD operations, getAll, upsert idempotency
- **MCP tools:** set validates directory exists, get returns current/default, remove clears mapping
- **Gateway:** workspace lookup applied to AgentRequest, fallback to default
- **Integration:** set workspace in channel → next message uses that directory
