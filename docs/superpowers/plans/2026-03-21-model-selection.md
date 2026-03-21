# Model Selection & Dynamic Switching Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable model selection with Po's self-assessment auto-escalation, user-requested switching, and dashboard integration.

**Architecture:** Per-session model state stored in files (IPC bridge between MCP subprocess and main process). SessionStore caches the model. Gateway reads model before each query and injects it into AgentRequest. Both SDK and CLI backends pass the model through.

**Tech Stack:** TypeScript, vitest, Claude Code SDK, MCP SDK, Fastify, React

**Spec:** `docs/superpowers/specs/2026-03-21-model-selection-design.md`

**Spec deviations:**
- Session key passed to MCP server via `--session-key` CLI arg (not `CCBUDDY_SESSION_KEY` env var). CLI args are simpler since the MCP server spec is already cloned per-request with extended args.
- Model file utilities live in `packages/core` (not `packages/skills`) so both the MCP server and bootstrap can import them without duplication.

---

## Chunk 1: Core Types & Config

### Task 1: Add `model` to AgentConfig and DEFAULT_CONFIG

**Files:**
- Modify: `packages/core/src/config/schema.ts:3-21` (AgentConfig interface)
- Modify: `packages/core/src/config/schema.ts:168-186` (DEFAULT_CONFIG agent section)

- [ ] **Step 1: Add `model` field to `AgentConfig` interface**

In `packages/core/src/config/schema.ts`, add `model: string;` to `AgentConfig`:

```typescript
export interface AgentConfig {
  backend: 'sdk' | 'cli';
  model: string;  // NEW — default model alias or ID
  max_concurrent_sessions: number;
  // ...rest unchanged
}
```

- [ ] **Step 2: Add `model` to DEFAULT_CONFIG**

In the same file, add to the `agent` section of `DEFAULT_CONFIG`:

```typescript
agent: {
  backend: 'sdk',
  model: 'sonnet',  // NEW
  max_concurrent_sessions: 3,
  // ...rest unchanged
},
```

- [ ] **Step 3: Add `model` to `ScheduledJobConfig` interface**

In `packages/core/src/config/schema.ts:113-122`, add optional `model`:

```typescript
export interface ScheduledJobConfig {
  cron: string;
  prompt?: string;
  skill?: string;
  user: string;
  target?: MessageTarget;
  enabled?: boolean;
  permission_level?: 'admin' | 'system';
  timezone?: string;
  model?: string;  // NEW — override model for this job
}
```

- [ ] **Step 4: Build to verify no type errors**

Run: `npm run build -w packages/core`
Expected: PASS (may show downstream errors in other packages — those are expected and will be fixed in later tasks)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/schema.ts
git commit -m "feat(core): add model field to AgentConfig and ScheduledJobConfig"
```

### Task 2: Add `model` to `AgentRequest`

**Files:**
- Modify: `packages/core/src/types/agent.ts:9-36` (AgentRequest interface)

- [ ] **Step 1: Add `model` field to `AgentRequest`**

In `packages/core/src/types/agent.ts`, add after `platform`:

```typescript
export interface AgentRequest {
  prompt: string;
  userId: string;
  sessionId: string;
  channelId: string;
  platform: string;
  model?: string;  // NEW — model alias or ID for this request
  workingDirectory?: string;
  // ...rest unchanged
}
```

- [ ] **Step 2: Build core**

Run: `npm run build -w packages/core`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types/agent.ts
git commit -m "feat(core): add model field to AgentRequest"
```

### Task 3: Add model validation utility

**Files:**
- Create: `packages/core/src/config/model-validation.ts`
- Create: `packages/core/src/config/__tests__/model-validation.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/config/__tests__/model-validation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isValidModel, KNOWN_MODEL_ALIASES } from '../model-validation.js';

describe('isValidModel', () => {
  it('accepts known aliases', () => {
    for (const alias of KNOWN_MODEL_ALIASES) {
      expect(isValidModel(alias)).toBe(true);
    }
  });

  it('accepts full model IDs matching pattern', () => {
    expect(isValidModel('claude-sonnet-4-6')).toBe(true);
    expect(isValidModel('claude-opus-4-6')).toBe(true);
    expect(isValidModel('claude-haiku-4-5-20251001')).toBe(true);
  });

  it('rejects invalid values', () => {
    expect(isValidModel('')).toBe(false);
    expect(isValidModel('gpt-4')).toBe(false);
    expect(isValidModel('random-string')).toBe(false);
    expect(isValidModel('  sonnet  ')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w packages/core -- --run src/config/__tests__/model-validation.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `packages/core/src/config/model-validation.ts`:

```typescript
export const KNOWN_MODEL_ALIASES = [
  'sonnet', 'opus', 'haiku',
  'opus[1m]', 'sonnet[1m]',
  'opusplan', 'default',
] as const;

const MODEL_ID_PATTERN = /^claude-[a-z]+-[\w-]+$/;

export function isValidModel(value: string): boolean {
  if ((KNOWN_MODEL_ALIASES as readonly string[]).includes(value)) return true;
  return MODEL_ID_PATTERN.test(value);
}
```

- [ ] **Step 4: Export from config barrel and core index**

Add to `packages/core/src/config/index.ts`:

```typescript
export { isValidModel, KNOWN_MODEL_ALIASES } from './model-validation.js';
```

This is automatically re-exported by `packages/core/src/index.ts` via `export * from './config/index.js'`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w packages/core -- --run src/config/__tests__/model-validation.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config/model-validation.ts packages/core/src/config/__tests__/model-validation.test.ts packages/core/src/index.ts
git commit -m "feat(core): add model validation utility"
```

### Task 4: Add `model` to config/default.yaml

**Files:**
- Modify: `config/default.yaml:17-34` (agent section)

- [ ] **Step 1: Add model to agent section**

In `config/default.yaml`, add after `backend`:

```yaml
agent:
  backend: "sdk"
  model: "sonnet"  # default model — alias or full ID
  max_concurrent_sessions: 3
  # ...rest unchanged
```

- [ ] **Step 2: Commit**

```bash
git add config/default.yaml
git commit -m "config: add agent.model default"
```

---

## Chunk 2: Backend Model Passthrough

### Task 5: SdkBackend passes model to query()

**Files:**
- Modify: `packages/agent/src/backends/sdk-backend.ts:31-35`
- Modify: `packages/agent/src/backends/__tests__/sdk-backend.test.ts`

- [ ] **Step 1: Write failing test**

Add to `packages/agent/src/backends/__tests__/sdk-backend.test.ts`:

```typescript
it('passes model option to Claude Agent SDK', async () => {
  const backend = new SdkBackend();
  const request = {
    ...baseRequest,
    model: 'opus[1m]',
  };

  const events: AgentEvent[] = [];
  for await (const event of backend.execute(request)) {
    events.push(event);
  }

  expect(query).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({ model: 'opus[1m]' }),
    }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w packages/agent -- --run src/backends/__tests__/sdk-backend.test.ts`
Expected: FAIL — model not in options

- [ ] **Step 3: Add model to options in SdkBackend**

In `packages/agent/src/backends/sdk-backend.ts`, modify the options construction at line 31:

```typescript
const options: Record<string, any> = {
  allowedTools: request.allowedTools,
  cwd: request.workingDirectory,
  settingSources: ['user', 'project', 'local'],
};

if (request.model) {
  options.model = request.model;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w packages/agent -- --run src/backends/__tests__/sdk-backend.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/backends/sdk-backend.ts packages/agent/src/backends/__tests__/sdk-backend.test.ts
git commit -m "feat(agent): SdkBackend passes model to query()"
```

### Task 6: CliBackend passes --model flag

**Files:**
- Modify: `packages/agent/src/backends/cli-backend.ts:33-37`
- Modify: `packages/agent/src/backends/__tests__/cli-backend.test.ts`

- [ ] **Step 1: Write failing test**

Add to `packages/agent/src/backends/__tests__/cli-backend.test.ts`:

```typescript
it('passes --model flag when model is set', async () => {
  const backend = new CliBackend();
  const request = {
    ...baseRequest,
    model: 'opus[1m]',
  };

  const events: AgentEvent[] = [];
  for await (const event of backend.execute(request)) {
    events.push(event);
  }

  expect(spawn).toHaveBeenCalledWith(
    'claude',
    expect.arrayContaining(['--model', 'opus[1m]']),
    expect.anything(),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w packages/agent -- --run src/backends/__tests__/cli-backend.test.ts`
Expected: FAIL — --model not in args

- [ ] **Step 3: Add model flag to CliBackend**

In `packages/agent/src/backends/cli-backend.ts`, add after the working directory arg (line 39):

```typescript
if (request.workingDirectory) args.push('--cwd', request.workingDirectory);

if (request.model) {
  args.push('--model', request.model);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w packages/agent -- --run src/backends/__tests__/cli-backend.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/backends/cli-backend.ts packages/agent/src/backends/__tests__/cli-backend.test.ts
git commit -m "feat(agent): CliBackend passes --model flag"
```

---

## Chunk 3: SessionStore Model State

### Task 7: Add model field to SessionStore

**Files:**
- Modify: `packages/agent/src/session/session-store.ts`
- Create or modify: `packages/agent/src/session/__tests__/session-store.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests (to existing test file or create new one):

```typescript
import { describe, it, expect } from 'vitest';
import { SessionStore } from '../session-store.js';

describe('SessionStore model field', () => {
  it('returns null model for new sessions', () => {
    const store = new SessionStore(60_000);
    const session = store.getOrCreate('key1', false);
    const info = store.getAll();
    expect(info[0].model).toBeNull();
  });

  it('setModel updates model for existing session', () => {
    const store = new SessionStore(60_000);
    store.getOrCreate('key1', false);
    store.setModel('key1', 'opus[1m]');
    const info = store.getAll();
    expect(info[0].model).toBe('opus[1m]');
  });

  it('getModel returns null for unknown session', () => {
    const store = new SessionStore(60_000);
    expect(store.getModel('nonexistent')).toBeNull();
  });

  it('tick() clears model when session expires', () => {
    vi.useFakeTimers();
    const store = new SessionStore(60_000);
    store.getOrCreate('key1', false);
    store.setModel('key1', 'opus');

    vi.advanceTimersByTime(61_000);
    store.tick();
    expect(store.getModel('key1')).toBeNull();
    expect(store.getAll()).toHaveLength(0);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/agent -- --run src/session/__tests__/session-store.test.ts`
Expected: FAIL — setModel/getModel don't exist, model not in SessionInfo

- [ ] **Step 3: Implement model field**

Modify `packages/agent/src/session/session-store.ts`:

```typescript
interface SessionEntry {
  sdkSessionId: string;
  lastActivity: number;
  isGroupChannel: boolean;
  model: string | null;  // NEW
}

export interface SessionInfo {
  sessionKey: string;
  sdkSessionId: string;
  lastActivity: number;
  isGroupChannel: boolean;
  model: string | null;  // NEW
}
```

Add to `SessionStore` class:

```typescript
setModel(sessionKey: string, model: string): void {
  const entry = this.entries.get(sessionKey);
  if (entry) {
    entry.model = model;
  }
}

getModel(sessionKey: string): string | null {
  return this.entries.get(sessionKey)?.model ?? null;
}
```

Update `getOrCreate` to initialize `model: null`:

```typescript
const entry: SessionEntry = {
  sdkSessionId: randomUUID(),
  lastActivity: Date.now(),
  isGroupChannel,
  model: null,  // NEW
};
```

Update `getAll` to include model:

```typescript
getAll(): SessionInfo[] {
  return Array.from(this.entries.entries()).map(([key, entry]) => ({
    sessionKey: key,
    sdkSessionId: entry.sdkSessionId,
    lastActivity: entry.lastActivity,
    isGroupChannel: entry.isGroupChannel,
    model: entry.model,  // NEW
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/agent -- --run src/session/__tests__/session-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/session/session-store.ts packages/agent/src/session/__tests__/session-store.test.ts
git commit -m "feat(agent): add model field to SessionStore"
```

---

## Chunk 4: MCP Tools (switch_model & get_current_model)

### Task 8: Add model file utilities

**Files:**
- Create: `packages/core/src/config/model-file.ts`
- Create: `packages/core/src/config/__tests__/model-file.test.ts`

Note: This lives in `packages/core` (not `packages/skills`) so both the MCP server subprocess and bootstrap can import it without duplicating logic.

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/config/__tests__/model-file.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeModelFile, readModelFile } from '../../config/model-file.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('model-file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccbuddy-model-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes and reads a model file', () => {
    const filePath = join(dir, 'test-session.model');
    writeModelFile(filePath, 'opus[1m]');
    expect(readModelFile(filePath)).toBe('opus[1m]');
  });

  it('returns null when file does not exist', () => {
    expect(readModelFile(join(dir, 'nonexistent.model'))).toBeNull();
  });

  it('uses atomic write (tmp + rename)', () => {
    const filePath = join(dir, 'atomic-test.model');
    writeModelFile(filePath, 'sonnet');
    // The file should exist, and no .tmp file should remain
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(filePath + '.tmp')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/skills -- --run src/__tests__/model-file.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement model file utilities**

Create `packages/core/src/config/model-file.ts`:

```typescript
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export function writeModelFile(filePath: string, model: string): void {
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify({ model }), 'utf8');
  renameSync(tmpPath, filePath);
}

export function readModelFile(filePath: string): string | null {
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    return data.model ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Export from config barrel**

Add to `packages/core/src/config/index.ts`:

```typescript
export { writeModelFile, readModelFile } from './model-file.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w packages/core -- --run src/config/__tests__/model-file.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config/model-file.ts packages/core/src/config/__tests__/model-file.test.ts packages/core/src/config/index.ts
git commit -m "feat(core): add atomic model file read/write utilities"
```

### Task 9: Add switch_model and get_current_model MCP tools

**Files:**
- Modify: `packages/skills/src/mcp-server.ts:35-88` (parseArgs) and `184+` (ListTools, CallTool handlers)

- [ ] **Step 1: Add `--session-key` and `--data-dir` CLI args to parseArgs**

In `packages/skills/src/mcp-server.ts`, add to the `parseArgs` function return type and parsing:

```typescript
function parseArgs(argv: string[]): {
  // ...existing fields
  sessionKey: string;
  dataDir: string;
} {
  // ...existing vars
  let sessionKey = '';
  let dataDir = '';

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      // ...existing cases
      case '--session-key':
        sessionKey = argv[++i] ?? '';
        break;
      case '--data-dir':
        dataDir = argv[++i] ?? '';
        break;
    }
  }
  // ...existing validation
  return { /* ...existing, */ sessionKey, dataDir };
}
```

- [ ] **Step 2: Add switch_model and get_current_model to ListTools**

In the `ListToolsRequestSchema` handler, add after the existing static tools:

```typescript
// Model switching tools — only available when session-key is provided
if (args.sessionKey) {
  tools.push({
    name: 'switch_model',
    description: 'Switch the AI model for subsequent messages in this session. Use when the current task needs more capability (e.g., opus[1m] for complex work) or to switch back to the default for simpler tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Model alias (sonnet, opus, haiku, opus[1m], sonnet[1m], opusplan) or full model ID (e.g., claude-opus-4-6)',
        },
      },
      required: ['model'],
    },
  });

  tools.push({
    name: 'get_current_model',
    description: 'Get the model currently configured for this session.',
    inputSchema: { type: 'object', properties: {} },
  });
}
```

- [ ] **Step 3: Add switch_model and get_current_model to CallTool handler**

In the `CallToolRequestSchema` handler, add cases. Import `isValidModel` from `@ccbuddy/core` at the top of the file, and import `readModelFile`/`writeModelFile` from `@ccbuddy/core`. Use `join` (already imported as `pathJoin` in the existing code):

```typescript
import { isValidModel, readModelFile, writeModelFile } from '@ccbuddy/core';

// ... in CallTool handler:

case 'switch_model': {
  const { model } = input as { model: string };

  if (!isValidModel(model)) {
    return { content: [{ type: 'text', text: `Invalid model: "${model}". Use an alias (sonnet, opus, haiku, opus[1m], sonnet[1m], opusplan) or a full model ID (e.g., claude-opus-4-6).` }] };
  }

  const filePath = pathJoin(args.dataDir, 'sessions', `${args.sessionKey}.model`);
  mkdirSync(pathJoin(args.dataDir, 'sessions'), { recursive: true });
  writeModelFile(filePath, model);
  return { content: [{ type: 'text', text: `Model switched to ${model}. This takes effect on the next message.` }] };
}

case 'get_current_model': {
  const filePath = pathJoin(args.dataDir, 'sessions', `${args.sessionKey}.model`);
  const model = readModelFile(filePath);
  return { content: [{ type: 'text', text: model ? `Current model override: ${model}` : 'No model override — using config default.' }] };
}
```

- [ ] **Step 4: Build to verify**

Run: `npm run build -w packages/skills`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/mcp-server.ts
git commit -m "feat(skills): add switch_model and get_current_model MCP tools"
```

### Task 10: Pass session-key and data-dir to MCP server in bootstrap

**Files:**
- Modify: `packages/main/src/bootstrap.ts:184-196` (skillMcpServer spec)
- Modify: `packages/main/src/bootstrap.ts:229-235` (executeAgentRequest wrapper)

- [ ] **Step 1: Add --data-dir to MCP server args**

In `packages/main/src/bootstrap.ts`, add to `skillMcpServer.args`:

```typescript
const skillMcpServer = {
  name: 'ccbuddy-skills',
  command: process.execPath,
  args: [
    skillMcpServerPath,
    '--registry', resolve(registryPath),
    '--skills-dir', resolve(registryDir),
    ...(config.skills.require_admin_approval_for_elevated ? [] : ['--no-approval']),
    ...(config.skills.auto_git_commit ? [] : ['--no-git-commit']),
    '--memory-db', resolve(config.memory.db_path),
    '--heartbeat-status-file', resolve(join(config.data_dir, 'heartbeat-status.json')),
    '--data-dir', resolve(config.data_dir),  // NEW
  ],
};
```

- [ ] **Step 2: Pass session-key dynamically per request**

The `skillMcpServer` spec is built once at startup but shared across all requests. The session key varies per request. Modify the `executeAgentRequest` wrapper to clone the MCP server spec and add `--session-key`:

```typescript
executeAgentRequest: (request) => {
  // Clone MCP server spec with per-request session key for model switching
  const sessionKey = request.sessionId; // gateway sets this
  const mcpServer = {
    ...skillMcpServer,
    args: [...skillMcpServer.args, '--session-key', sessionKey],
  };

  return agentService.handleRequest({
    ...request,
    workingDirectory: request.workingDirectory,
    mcpServers: [mcpServer],
    systemPrompt: [identityPrompt, request.systemPrompt, skillNudge].filter(Boolean).join('\n\n'),
  });
},
```

- [ ] **Step 3: Build to verify**

Run: `npm run build -w packages/main`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/main/src/bootstrap.ts
git commit -m "feat(main): pass session-key and data-dir to MCP server per request"
```

---

## Chunk 5: Gateway Integration

### Task 11: Gateway reads model and injects into AgentRequest + system prompt

**Files:**
- Modify: `packages/gateway/src/gateway.ts:36-52` (GatewayDeps)
- Modify: `packages/gateway/src/gateway.ts:207-222` (AgentRequest construction)
- Modify: `packages/gateway/src/__tests__/` (gateway tests)

- [ ] **Step 1: Write failing tests**

Add tests to the gateway test file FIRST (TDD):

```typescript
it('injects model from readModelFile into AgentRequest', async () => {
  const capturedRequests: AgentRequest[] = [];
  const deps = makeDeps({
    defaultModel: 'sonnet',
    readModelFile: (key: string) => key.includes('testuser') ? 'opus[1m]' : null,
    executeAgentRequest: async function*(req: AgentRequest) {
      capturedRequests.push(req);
      yield { type: 'complete', response: 'ok', sessionId: req.sessionId, userId: req.userId, channelId: req.channelId, platform: req.platform } as AgentEvent;
    },
  });
  const gateway = new Gateway(deps);
  // Register adapter and simulate message from testuser
  // ...
  expect(capturedRequests[0].model).toBe('opus[1m]');
});

it('falls back to defaultModel when no model file exists', async () => {
  const capturedRequests: AgentRequest[] = [];
  const deps = makeDeps({
    defaultModel: 'sonnet',
    readModelFile: () => null,
    executeAgentRequest: async function*(req: AgentRequest) {
      capturedRequests.push(req);
      yield { type: 'complete', response: 'ok', sessionId: req.sessionId, userId: req.userId, channelId: req.channelId, platform: req.platform } as AgentEvent;
    },
  });
  const gateway = new Gateway(deps);
  // Register adapter and simulate message
  // ...
  expect(capturedRequests[0].model).toBe('sonnet');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/gateway`
Expected: FAIL — GatewayDeps doesn't have defaultModel/readModelFile

- [ ] **Step 3: Add model-related deps to GatewayDeps**

In `packages/gateway/src/gateway.ts`, add to `GatewayDeps`:

```typescript
export interface GatewayDeps {
  // ...existing fields
  defaultModel?: string;
  readModelFile?: (sessionKey: string) => string | null;
}
```

- [ ] **Step 4: Read model and inject into AgentRequest**

In `handleIncomingMessage`, after building the session key (around line 155), read the model:

```typescript
// 3d. Resolve model for this session
let sessionModel: string | undefined;
if (this.deps.readModelFile) {
  const fileModel = this.deps.readModelFile(sessionKey);
  if (fileModel) {
    sessionModel = fileModel;
    // Sync to session store cache
    if (this.deps.sessionStore) {
      this.deps.sessionStore.setModel(sessionKey, fileModel);
    }
  }
}
const effectiveModel = sessionModel ?? this.deps.defaultModel;
```

Then in the AgentRequest construction (line 207), add `model`:

```typescript
const request: AgentRequest = {
  prompt: msg.text,
  userId: user.name,
  sessionId,
  channelId: msg.channelId,
  platform: msg.platform,
  model: effectiveModel,  // NEW
  memoryContext,
  // ...rest unchanged
};
```

- [ ] **Step 3: Inject model awareness into system prompt**

The system prompt is injected in bootstrap.ts, not gateway.ts. However, the gateway knows the effective model. Add a `modelPrompt` field to the request's system prompt:

In `handleIncomingMessage`, build the model awareness prompt:

```typescript
// 3e. Build model awareness system prompt
if (effectiveModel) {
  const modelPrompt = `You are currently running on model: ${effectiveModel}.\n\nYou have access to \`switch_model\` and \`get_current_model\` tools.\n\nWhen to switch to a more powerful model (e.g., opus[1m]):\n- Multi-file refactors or architectural changes\n- Complex debugging requiring deep reasoning\n- Tasks involving unfamiliar or intricate code patterns\n- When you feel uncertain about your approach\n\nWhen to switch back to the default model (e.g., sonnet):\n- After completing the complex portion of work\n- For simple questions, status checks, casual conversation\n\nYou may also be asked by the user to switch models — just call switch_model.`;
  request.systemPrompt = modelPrompt;
}
```

Note: bootstrap.ts already prepends `identityPrompt` and appends `skillNudge` to `request.systemPrompt`, so this will be combined with those.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -w packages/gateway`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/gateway.ts packages/gateway/src/__tests__/
git commit -m "feat(gateway): read model from session file, inject into AgentRequest and system prompt"
```

### Task 12: Wire model into bootstrap Gateway deps

**Files:**
- Modify: `packages/main/src/bootstrap.ts:224+` (Gateway constructor)

- [ ] **Step 1: Add model deps to Gateway construction**

In `packages/main/src/bootstrap.ts`, add to the `new Gateway({...})` constructor:

```typescript
const gateway = new Gateway({
  // ...existing deps
  get defaultModel() { return config.agent.model; },  // NEW — getter so dashboard PUT updates take effect live
  readModelFile: (sessionKey: string) => {  // NEW
    const { readModelFile } = require('@ccbuddy/core');
    const filePath = join(resolve(config.data_dir), 'sessions', `${sessionKey}.model`);
    return readModelFile(filePath);
  },
  dataDir: resolve(config.data_dir),  // NEW
});
```

Import `readModelFile` from `@ccbuddy/core` at the top. Using a getter for `defaultModel` ensures that when the dashboard updates `config.agent.model` at runtime, the gateway picks up the change immediately without restart.

- [ ] **Step 2: Build to verify**

Run: `npm run build -w packages/main`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/main/src/bootstrap.ts
git commit -m "feat(main): wire model config and file reader into Gateway"
```

---

## Chunk 6: Scheduler & Event Bus

### Task 13: Scheduler passes job model to AgentRequest

**Files:**
- Modify: `packages/scheduler/src/types.ts:19-25` (PromptJob interface)
- Modify: `packages/scheduler/src/cron-runner.ts:10-18` (CronRunnerOptions interface)
- Modify: `packages/scheduler/src/cron-runner.ts:78-109` (executePromptJob)
- Modify: `packages/scheduler/src/__tests__/cron-runner.test.ts`
- Modify: `packages/main/src/bootstrap.ts` (CronRunner construction)

- [ ] **Step 1: Add `model` field to `PromptJob` and `SkillJob`**

In `packages/scheduler/src/types.ts`:

```typescript
export interface PromptJob extends BaseJob {
  type: 'prompt';
  payload: string;
  user: string;
  target: MessageTarget;
  permissionLevel: 'admin' | 'system';
  model?: string;  // NEW
}

export interface SkillJob extends BaseJob {
  type: 'skill';
  payload: string;
  user: string;
  target: MessageTarget;
  permissionLevel: 'admin' | 'system';
  model?: string;  // NEW
}
```

- [ ] **Step 2: Add `defaultModel` to `CronRunnerOptions`**

In `packages/scheduler/src/cron-runner.ts`:

```typescript
export interface CronRunnerOptions {
  eventBus: EventBus;
  executeAgentRequest: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
  sendProactiveMessage: (target: MessageTarget, text: string) => Promise<void>;
  assembleContext: (userId: string, sessionId: string) => string;
  runSkill?: (name: string, input: Record<string, unknown>) => Promise<string>;
  defaultModel?: string;  // NEW
}
```

- [ ] **Step 3: Write failing test**

Add to `packages/scheduler/src/__tests__/cron-runner.test.ts`:

```typescript
it('passes job model to AgentRequest', async () => {
  const capturedRequests: AgentRequest[] = [];
  const deps = createMockDeps({
    executeAgentRequest: async function*(req: AgentRequest) {
      capturedRequests.push(req);
      yield { type: 'complete', response: 'done', sessionId: req.sessionId, userId: req.userId, channelId: req.channelId, platform: req.platform } as AgentEvent;
    },
  });
  const runner = new CronRunner(deps);
  // Register a job with model override and trigger it
  // Assert capturedRequests[0].model === 'opus'
});

it('falls back to defaultModel when job has no model', async () => {
  const capturedRequests: AgentRequest[] = [];
  const deps = createMockDeps({
    defaultModel: 'sonnet',
    executeAgentRequest: async function*(req: AgentRequest) {
      capturedRequests.push(req);
      yield { type: 'complete', response: 'done', sessionId: req.sessionId, userId: req.userId, channelId: req.channelId, platform: req.platform } as AgentEvent;
    },
  });
  const runner = new CronRunner(deps);
  // Register a job without model and trigger it
  // Assert capturedRequests[0].model === 'sonnet'
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -w packages/scheduler`
Expected: FAIL

- [ ] **Step 5: Add model to executePromptJob**

In `packages/scheduler/src/cron-runner.ts`, modify the `AgentRequest` construction:

```typescript
const request: AgentRequest = {
  prompt: job.payload,
  userId: job.user,
  sessionId,
  channelId: job.target.channel,
  platform: job.target.platform,
  permissionLevel: job.permissionLevel,
  model: job.model ?? this.opts.defaultModel,  // NEW
  memoryContext,
};
```

- [ ] **Step 6: Wire defaultModel in bootstrap**

In `packages/main/src/bootstrap.ts`, when creating the CronRunner, add:

```typescript
const cronRunner = new CronRunner({
  // ...existing opts
  defaultModel: config.agent.model,  // NEW
});
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test -w packages/scheduler`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/scheduler/src/types.ts packages/scheduler/src/cron-runner.ts packages/scheduler/src/__tests__/cron-runner.test.ts packages/main/src/bootstrap.ts
git commit -m "feat(scheduler): pass job model or default to AgentRequest"
```

### Task 14: Emit session.model_changed event

**Files:**
- Modify: `packages/core/src/types/events.ts:102-114` (EventMap)
- Modify: `packages/gateway/src/gateway.ts` (model change detection in handleIncomingMessage)

- [ ] **Step 1: Add event type to EventMap**

In `packages/core/src/types/events.ts`, add the interface and EventMap entry:

```typescript
export interface SessionModelChangedEvent {
  sessionId: string;
  userId: string;
  platform: string;
  channelId: string;
  previousModel: string;
  newModel: string;
}

export interface EventMap {
  // ...existing entries
  'session.model_changed': SessionModelChangedEvent;
}
```

- [ ] **Step 2: Add model change detection to gateway**

In the gateway's model resolution code (from Task 11), replace the simple `setModel` with change detection:

```typescript
if (fileModel && this.deps.sessionStore) {
  const previousModel = this.deps.sessionStore.getModel(sessionKey);
  this.deps.sessionStore.setModel(sessionKey, fileModel);
  if (previousModel && previousModel !== fileModel) {
    void this.deps.eventBus.publish('session.model_changed', {
      sessionId,
      userId: user.name,
      platform: msg.platform,
      channelId: msg.channelId,
      previousModel,
      newModel: fileModel,
    });
  }
}
```

- [ ] **Step 3: Build and test**

Run: `npm run build && npm test -w packages/gateway`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types/events.ts packages/gateway/src/gateway.ts
git commit -m "feat(gateway): emit session.model_changed event on model switch"
```

---

## Chunk 7: Session Cleanup

### Task 15: Clean up model files on session expiry

**Files:**
- Modify: `packages/agent/src/session/session-store.ts:51-58` (tick method)

- [ ] **Step 1: Write failing test**

```typescript
it('calls onExpiry callback when session expires', () => {
  vi.useFakeTimers();
  const expired: string[] = [];
  const store = new SessionStore(60_000, { onExpiry: (key) => expired.push(key) });
  store.getOrCreate('key1', false);

  vi.advanceTimersByTime(61_000);
  store.tick();
  expect(expired).toEqual(['key1']);
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w packages/agent -- --run src/session/__tests__/session-store.test.ts`
Expected: FAIL

- [ ] **Step 3: Add onExpiry callback**

Modify `SessionStore` constructor to accept an options object with an optional `onExpiry` callback:

```typescript
interface SessionStoreOptions {
  onExpiry?: (sessionKey: string) => void;
}

export class SessionStore {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly timeoutMs: number;
  private readonly onExpiry?: (sessionKey: string) => void;

  constructor(timeoutMs: number, options?: SessionStoreOptions) {
    this.timeoutMs = timeoutMs;
    this.onExpiry = options?.onExpiry;
  }

  tick(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastActivity > this.timeoutMs) {
        this.entries.delete(key);
        this.onExpiry?.(key);
      }
    }
  }
  // ...rest unchanged
}
```

- [ ] **Step 4: Wire onExpiry in bootstrap to delete model files**

In `packages/main/src/bootstrap.ts`, when creating the SessionStore:

```typescript
const sessionStore = new SessionStore(config.agent.session_timeout_ms, {
  onExpiry: (sessionKey) => {
    const modelFile = join(resolve(config.data_dir), 'sessions', `${sessionKey}.model`);
    try { unlinkSync(modelFile); } catch { /* file may not exist */ }
  },
});
```

- [ ] **Step 5: Run tests**

Run: `npm test -w packages/agent -- --run src/session/__tests__/session-store.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/session/session-store.ts packages/agent/src/session/__tests__/session-store.test.ts packages/main/src/bootstrap.ts
git commit -m "feat(agent): clean up model files on session expiry via onExpiry callback"
```

---

## Chunk 8: Dashboard Integration

### Task 16: Dashboard API — model endpoints

**Files:**
- Modify: `packages/dashboard/src/server/index.ts:174-226` (setupRoutes)

- [ ] **Step 1: Add GET/PUT /api/config/model endpoints**

In `packages/dashboard/src/server/index.ts`, add to `setupRoutes()` before the closing brace:

```typescript
import { isValidModel } from '@ccbuddy/core';

// GET /api/config/model — current default model
this.app.get('/api/config/model', async () => {
  const runtimePath = join(this.deps.config.data_dir, 'runtime-config.json');
  let runtimeModel: string | null = null;
  try {
    const data = JSON.parse(readFileSync(runtimePath, 'utf8'));
    runtimeModel = data.model ?? null;
  } catch { /* no runtime override */ }

  return {
    model: runtimeModel ?? this.deps.config.agent.model,
    source: runtimeModel ? 'runtime_override' : 'config',
  };
});

// PUT /api/config/model — set runtime model override
this.app.put('/api/config/model', async (request, reply) => {
  const body = request.body as { model: string } | null;
  if (!body?.model) {
    return reply.status(400).send({ error: 'Missing model in request body' });
  }

  if (!isValidModel(body.model)) {
    return reply.status(400).send({ error: `Invalid model: "${body.model}"` });
  }

  const runtimePath = join(this.deps.config.data_dir, 'runtime-config.json');
  let runtimeConfig: Record<string, unknown> = {};
  try {
    runtimeConfig = JSON.parse(readFileSync(runtimePath, 'utf8'));
  } catch { /* no existing file */ }

  runtimeConfig.model = body.model;
  mkdirSync(this.deps.config.data_dir, { recursive: true });
  writeFileSync(runtimePath, JSON.stringify(runtimeConfig, null, 2), 'utf8');

  // Live-update config so gateway picks up the change immediately
  this.deps.config.agent.model = body.model;

  return { ok: true, model: body.model };
});
```

Note: Add `mkdirSync` to the existing `readFileSync, writeFileSync, copyFileSync` import from `node:fs`.

- [ ] **Step 2: Add model field to GET /api/sessions response**

The existing `GET /api/sessions` endpoint returns session info from `agentService.getSessionInfo()`. Since `SessionInfo` now includes `model`, this is automatic — just verify it's included.

- [ ] **Step 3: Build to verify**

Run: `npm run build -w packages/dashboard`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src/server/index.ts
git commit -m "feat(dashboard): add GET/PUT /api/config/model endpoints"
```

### Task 17: Dashboard client — model selector and session badges

**Files:**
- Modify: Dashboard React client components (exact paths depend on client structure)

- [ ] **Step 1: Explore the dashboard client structure**

Run: `ls packages/dashboard/src/client/` to find the component files.

- [ ] **Step 2: Add model selector to settings section**

Create or modify the settings component to include a dropdown for model selection:

```tsx
// Model selector component
const MODEL_OPTIONS = ['sonnet', 'opus', 'haiku', 'opus[1m]', 'sonnet[1m]', 'opusplan'];

function ModelSelector() {
  const [model, setModel] = useState('');
  const [source, setSource] = useState('');

  useEffect(() => {
    fetch('/api/config/model', { headers: authHeaders })
      .then(r => r.json())
      .then(data => { setModel(data.model); setSource(data.source); });
  }, []);

  const handleChange = async (newModel: string) => {
    await fetch('/api/config/model', {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: newModel }),
    });
    setModel(newModel);
    setSource('runtime_override');
  };

  return (
    <div>
      <label>Default Model</label>
      <select value={model} onChange={e => handleChange(e.target.value)}>
        {MODEL_OPTIONS.map(m => <option key={m} value={m}>{m}</option>)}
      </select>
      <span>{source === 'runtime_override' ? '(runtime override)' : '(from config)'}</span>
    </div>
  );
}
```

- [ ] **Step 3: Add model badge to sessions list**

In the sessions list component, display the model field from session info:

```tsx
{session.model && <span className="model-badge">{session.model}</span>}
```

- [ ] **Step 4: Build client**

Run: `npm run build -w packages/dashboard`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/client/
git commit -m "feat(dashboard): add model selector and session model badges"
```

---

## Chunk 9: Final Integration & Verification

### Task 18: Wire runtime model override into config loader

**Files:**
- Modify: `packages/main/src/bootstrap.ts` or `packages/core/src/config/loader.ts`

- [ ] **Step 1: Read runtime-config.json model override at startup**

In bootstrap, after loading config, check for a runtime override:

```typescript
// Apply runtime model override (from dashboard)
const runtimeConfigPath = join(resolve(config.data_dir), 'runtime-config.json');
try {
  const runtimeConfig = JSON.parse(readFileSync(runtimeConfigPath, 'utf8'));
  if (runtimeConfig.model && isValidModel(runtimeConfig.model)) {
    config.agent.model = runtimeConfig.model;
    console.log(`[Bootstrap] Runtime model override applied: ${runtimeConfig.model}`);
  }
} catch { /* no runtime config */ }
```

- [ ] **Step 2: Commit**

```bash
git add packages/main/src/bootstrap.ts
git commit -m "feat(main): apply runtime model override from dashboard on startup"
```

### Task 19: Full build and test suite

- [ ] **Step 1: Build all packages**

Run: `npm run build`
Expected: PASS — no type errors

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: PASS — all existing + new tests pass

- [ ] **Step 3: Manual smoke test**

1. Start CCBuddy: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist`
2. Send a message via Discord — Po should respond using `sonnet` (default)
3. Ask Po "what model are you using?" — Po should report `sonnet`
4. Ask Po "switch to opus[1m]" — Po should call `switch_model` and confirm
5. Send another message — should now run on `opus[1m]`
6. Check dashboard — session should show model badge `opus[1m]`
7. Change default model in dashboard to `opus` — verify new sessions use it
8. Wait for session timeout — verify model file is cleaned up

- [ ] **Step 4: Final commit if any adjustments needed**

```bash
git add -A
git commit -m "chore: integration fixes for model selection"
```
