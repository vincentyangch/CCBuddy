# Request-Scoped Outbound Media Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate outbound media per request so concurrent requests cannot deliver each other's files, and make all outbound media writers use an explicit request-scoped directory instead of cwd-derived paths.

**Architecture:** Gateway will allocate one outbound directory per request and pass that directory through the internal agent request path. Bootstrap will inject the directory into the skills MCP server as `CCBUDDY_OUTBOUND_DIR`, and the skills runtime plus bundled media skills will require that env var instead of writing to a shared `data/outbound` path. Delivery will read only the current request directory and clean it up afterward.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Vitest, MCP stdio server, existing CCBuddy gateway/bootstrap wiring

---

## File Map

### Existing files to modify

- `packages/core/src/types/agent.ts`
  - Add an internal request field for the request-scoped outbound directory.
- `packages/gateway/src/gateway.ts`
  - Allocate request outbound directories, stop snapshot/diff delivery, and clean up request directories after delivery.
- `packages/gateway/src/__tests__/gateway.test.ts`
  - Add request-scoped delivery isolation and cleanup coverage.
- `packages/main/src/bootstrap.ts`
  - Inject `CCBUDDY_OUTBOUND_DIR` into the per-request skills MCP server env.
- `packages/main/src/__tests__/bootstrap.test.ts`
  - Verify bootstrap passes the request-scoped outbound directory through MCP env.
- `packages/skills/src/mcp-server.ts`
  - Make `send_file` require `CCBUDDY_OUTBOUND_DIR` and write into that directory only.
- `packages/skills/src/__tests__/mcp-server.test.ts`
  - Verify `send_file` uses the injected outbound dir and fails clearly when it is missing.
- `skills/bundled/generate-image.mjs`
  - Write generated media into `CCBUDDY_OUTBOUND_DIR` instead of `process.cwd()/data/outbound`.

### New files to create

- `packages/skills/src/__tests__/bundled-media.test.ts`
  - Directly exercise the bundled image skill's outbound path behavior.

## Task 1: Make Gateway Own Request-Scoped Outbound Directories

**Files:**
- Modify: `packages/core/src/types/agent.ts`
- Modify: `packages/gateway/src/gateway.ts`
- Modify: `packages/gateway/src/__tests__/gateway.test.ts`
- Test: `packages/gateway/src/__tests__/gateway.test.ts`

- [ ] **Step 1: Write the failing gateway tests**

Add two tests to `packages/gateway/src/__tests__/gateway.test.ts`:

```ts
it('creates a request-scoped outbound directory and passes it into executeAgentRequest', async () => {
  const outboundRoot = mkdtempSync(join(tmpdir(), 'gateway-outbound-'));
  const seenDirs: string[] = [];

  deps = createMockDeps({
    outboundMediaDir: outboundRoot,
    executeAgentRequest: vi.fn().mockImplementation(async function* (request: AgentRequest) {
      expect(request.outboundMediaDir).toBeDefined();
      expect(request.outboundMediaDir).toContain(outboundRoot);
      seenDirs.push(request.outboundMediaDir!);
      yield {
        type: 'complete',
        response: 'ok',
        sessionId: request.sessionId,
        userId: request.userId,
        channelId: request.channelId,
        platform: request.platform,
      } satisfies AgentEvent;
    }),
  });

  gateway = new Gateway(deps);
  gateway.registerAdapter(adapter);

  await adapter.simulateMessage(makeIncomingMsg());

  expect(seenDirs).toHaveLength(1);
  expect(existsSync(seenDirs[0])).toBe(false);
});

it('delivers outbound files only from the current request directory', async () => {
  const outboundRoot = mkdtempSync(join(tmpdir(), 'gateway-isolation-'));

  deps = createMockDeps({
    outboundMediaDir: outboundRoot,
    executeAgentRequest: vi.fn().mockImplementation(async function* (request: AgentRequest) {
      const filename = `${request.channelId}.txt`;
      writeFileSync(join(request.outboundMediaDir!, filename), request.channelId, 'utf8');
      yield {
        type: 'complete',
        response: `done:${request.channelId}`,
        sessionId: request.sessionId,
        userId: request.userId,
        channelId: request.channelId,
        platform: request.platform,
      } satisfies AgentEvent;
    }),
  });

  gateway = new Gateway(deps);
  gateway.registerAdapter(adapter);

  await Promise.all([
    adapter.simulateMessage(makeIncomingMsg({ channelId: 'ch-1', text: 'first' })),
    adapter.simulateMessage(makeIncomingMsg({ channelId: 'ch-2', text: 'second' })),
  ]);

  expect(adapter.sendFile).toHaveBeenCalledWith('ch-1', expect.any(Buffer), 'ch-1.txt');
  expect(adapter.sendFile).toHaveBeenCalledWith('ch-2', expect.any(Buffer), 'ch-2.txt');
  expect(adapter.sendFile).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the gateway test file to verify the new cases fail**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm test -w packages/gateway -- src/__tests__/gateway.test.ts
```

Expected: FAIL because `request.outboundMediaDir` is undefined and gateway still delivers from the shared outbound root.

- [ ] **Step 3: Add the internal request field and gateway helpers**

Update `packages/core/src/types/agent.ts` so `AgentRequest` can carry the request-scoped directory:

```ts
export interface AgentRequest {
  prompt: string;
  userId: string;
  sessionId: string;
  channelId: string;
  platform: string;
  model?: string;
  workingDirectory?: string;
  outboundMediaDir?: string;
  allowedTools?: string[];
  // ...
}
```

In `packages/gateway/src/gateway.ts`, replace the shared snapshot/diff logic with request-scoped helpers:

```ts
import { mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

private createRequestOutboundDir(sessionKey: string | undefined, channelId: string): string | undefined {
  const root = this.deps.outboundMediaDir;
  if (!root) return undefined;
  const requestId = `${sessionKey ?? channelId}-${randomUUID()}`;
  const dir = join(root, requestId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

private async deliverRequestOutboundMedia(adapter: PlatformAdapter, channelId: string, requestDir?: string): Promise<void> {
  if (!requestDir) return;

  let files: string[];
  try {
    files = readdirSync(requestDir).filter(f => !f.startsWith('.'));
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = join(requestDir, file);
    try {
      const data = readFileSync(filePath);
      const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(file);
      if (isImage) await adapter.sendImage(channelId, data, file);
      else await adapter.sendFile(channelId, data, file);
      unlinkSync(filePath);
    } catch (err) {
      console.warn(`[Gateway] Failed to deliver outbound media ${file}:`, (err as Error).message);
    }
  }

  try {
    rmSync(requestDir);
  } catch {
    console.warn(`[Gateway] Outbound request directory not empty after delivery: ${requestDir}`);
  }
}
```

Wire the request dir into `executeAndRoute()`:

```ts
const requestOutboundDir = this.createRequestOutboundDir(sessionKey, msg.channelId);
const requestWithOutbound = { ...request, outboundMediaDir: requestOutboundDir };

for await (const event of this.deps.executeAgentRequest(requestWithOutbound)) {
  // ...
  await this.deliverRequestOutboundMedia(adapter, msg.channelId, requestOutboundDir);
}
```

- [ ] **Step 4: Re-run the gateway tests**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm test -w packages/gateway -- src/__tests__/gateway.test.ts
```

Expected: PASS with the new outbound isolation tests green.

- [ ] **Step 5: Commit the gateway/request-context changes**

```bash
git add packages/core/src/types/agent.ts \
  packages/gateway/src/gateway.ts \
  packages/gateway/src/__tests__/gateway.test.ts
git commit -m "feat: scope outbound media to requests"
```

## Task 2: Inject Request Outbound Directories Into the Skills MCP Env

**Files:**
- Modify: `packages/main/src/bootstrap.ts`
- Modify: `packages/main/src/__tests__/bootstrap.test.ts`
- Test: `packages/main/src/__tests__/bootstrap.test.ts`

- [ ] **Step 1: Add the failing bootstrap test**

Extend `packages/main/src/__tests__/bootstrap.test.ts` with a test that invokes the gateway's injected `executeAgentRequest` dependency:

```ts
it('passes CCBUDDY_OUTBOUND_DIR into the skills MCP server env per request', async () => {
  await bootstrap('/config');

  const gatewayDeps = (mockGateway as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
    executeAgentRequest: (request: AgentRequest) => AsyncGenerator<unknown>;
  };

  const request = {
    prompt: 'hello',
    userId: 'alice',
    sessionId: 'alice-discord-ch1',
    channelId: 'ch1',
    platform: 'discord',
    permissionLevel: 'admin' as const,
    outboundMediaDir: '/tmp/ccbuddy-outbound/request-1',
  };

  for await (const _event of gatewayDeps.executeAgentRequest(request)) {}

  expect(fakeAgentServiceInstance.handleRequest).toHaveBeenCalledWith(expect.objectContaining({
    mcpServers: [
      expect.objectContaining({
        name: 'ccbuddy-skills',
        env: expect.objectContaining({
          CCBUDDY_OUTBOUND_DIR: '/tmp/ccbuddy-outbound/request-1',
        }),
      }),
      expect.any(Object),
    ],
  }));
});
```

- [ ] **Step 2: Ensure the mocked workspace packages used by `packages/main` tests have `dist/` entries**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm run build -w packages/agent
/opt/homebrew/opt/node@22/bin/npm run build -w packages/platforms/discord
/opt/homebrew/opt/node@22/bin/npm run build -w packages/dashboard
```

Expected: `packages/agent` and `packages/platforms/discord` build cleanly. `packages/dashboard` may do more work than this task needs, but it should leave `packages/dashboard/dist/index.js` present so the mocked bootstrap test resolves workspace package entries.

- [ ] **Step 3: Run the bootstrap test to verify it fails**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm test -w packages/main -- src/__tests__/bootstrap.test.ts
```

Expected: FAIL because `bootstrap.ts` does not yet inject `CCBUDDY_OUTBOUND_DIR` into the skills MCP server env.

- [ ] **Step 4: Pass the request-scoped outbound dir through bootstrap**

In `packages/main/src/bootstrap.ts`, when constructing the per-request MCP server object inside `executeAgentRequest`, merge the request-scoped outbound dir into the skills server env:

```ts
executeAgentRequest: (request) => {
  const mcpServer = {
    ...skillMcpServer,
    args: [
      ...skillMcpServer.args,
      '--session-key', request.sessionId,
      '--channel-key', `${request.platform}-${request.channelId}`,
    ],
    env: {
      ...skillMcpServer.env,
      ...(request.outboundMediaDir ? { CCBUDDY_OUTBOUND_DIR: request.outboundMediaDir } : {}),
    },
  };

  return agentService.handleRequest({
    ...request,
    mcpServers: [mcpServer, haMcpServer],
    systemPrompt: [identityPrompt, request.systemPrompt, skillNudge].filter(Boolean).join('\n\n'),
  });
},
```

- [ ] **Step 5: Re-run the bootstrap test**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm test -w packages/main -- src/__tests__/bootstrap.test.ts
```

Expected: PASS with the new env assertion green.

- [ ] **Step 6: Commit the bootstrap wiring**

```bash
git add packages/main/src/bootstrap.ts \
  packages/main/src/__tests__/bootstrap.test.ts
git commit -m "fix: pass request media dirs to skills runtime"
```

## Task 3: Make `send_file` and Bundled Media Skills Require `CCBUDDY_OUTBOUND_DIR`

**Files:**
- Modify: `packages/skills/src/mcp-server.ts`
- Modify: `packages/skills/src/__tests__/mcp-server.test.ts`
- Modify: `skills/bundled/generate-image.mjs`
- Create: `packages/skills/src/__tests__/bundled-media.test.ts`
- Test: `packages/skills/src/__tests__/mcp-server.test.ts`
- Test: `packages/skills/src/__tests__/bundled-media.test.ts`

- [ ] **Step 1: Write the failing MCP and bundled-skill tests**

Add two skills-side tests.

In `packages/skills/src/__tests__/mcp-server.test.ts`, add:

```ts
it('send_file copies files into CCBUDDY_OUTBOUND_DIR', async () => {
  const { registryPath, skillsDir, tmpDir } = makeTmpEnv();
  const sourcePath = join(tmpDir, 'report.txt');
  const outboundDir = join(tmpDir, 'outbound', 'request-1');
  mkdirSync(outboundDir, { recursive: true });
  writeFileSync(sourcePath, 'hello', 'utf8');

  const { client, transport } = await createClient(registryPath, skillsDir, ['--no-approval', '--no-git-commit'], {
    CCBUDDY_OUTBOUND_DIR: outboundDir,
  });

  try {
    const result = await client.callTool({
      name: 'send_file',
      arguments: { file_path: sourcePath },
    });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed.success).toBe(true);
    expect(readdirSync(outboundDir)).toHaveLength(1);
  } finally {
    await transport.close();
  }
});

it('send_file fails clearly when CCBUDDY_OUTBOUND_DIR is missing', async () => {
  const { registryPath, skillsDir, tmpDir } = makeTmpEnv();
  const sourcePath = join(tmpDir, 'report.txt');
  writeFileSync(sourcePath, 'hello', 'utf8');

  const { client, transport } = await createClient(registryPath, skillsDir, ['--no-approval', '--no-git-commit']);

  try {
    const result = await client.callTool({
      name: 'send_file',
      arguments: { file_path: sourcePath },
    });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('CCBUDDY_OUTBOUND_DIR');
  } finally {
    await transport.close();
  }
});
```

Create `packages/skills/src/__tests__/bundled-media.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('bundled generate-image skill', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bundled-media-'));
    mkdirSync(join(tmpDir, 'outbound'), { recursive: true });
    process.env.CCBUDDY_OUTBOUND_DIR = join(tmpDir, 'outbound');
    process.env.GEMINI_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.CCBUDDY_OUTBOUND_DIR;
    delete process.env.GEMINI_API_KEY;
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes generated media into CCBUDDY_OUTBOUND_DIR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{
          content: { parts: [{ inlineData: { data: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png' } }] },
        }],
      }),
    }));

    const mod = await import('../../../../skills/bundled/generate-image.mjs');
    await mod.default({ prompt: 'A red bird' });

    expect(readdirSync(join(tmpDir, 'outbound')).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run the two skills tests to verify they fail**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm test -w packages/skills -- src/__tests__/mcp-server.test.ts src/__tests__/bundled-media.test.ts
```

Expected: FAIL because `send_file` still writes to `process.cwd()/data/outbound` and the bundled image skill still derives its output path from `process.cwd()`.

- [ ] **Step 3: Update the skills runtime and bundled image skill**

In `packages/skills/src/mcp-server.ts`, replace the cwd-derived outbound path in `send_file`:

```ts
if (name === 'send_file') {
  const filePath = toolArgs.file_path as string;
  const outboundDir = process.env.CCBUDDY_OUTBOUND_DIR;
  if (!outboundDir) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: false, error: 'CCBUDDY_OUTBOUND_DIR is not set for this request' }),
      }],
    };
  }

  // existing cwd/path traversal checks stay
  mkdirSync(outboundDir, { recursive: true });
  const ext = extname(resolved) || '.bin';
  const outFilename = `${basename(resolved, ext)}-${randomUUID().slice(0, 8)}${ext}`;
  const outPath = pathJoin(outboundDir, outFilename);
  copyFileSync(resolved, outPath);
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `File queued for delivery: ${outFilename}` }) }] };
}
```

In `skills/bundled/generate-image.mjs`, replace the cwd-derived outbound path:

```js
const outDir = process.env.CCBUDDY_OUTBOUND_DIR;
if (!outDir) {
  throw new Error('CCBUDDY_OUTBOUND_DIR is not set for this request');
}

try { mkdirSync(outDir, { recursive: true }); } catch {}

const ext = imageMimeType === 'image/jpeg' ? 'jpg' : 'png';
const filename = `generated-${randomUUID().slice(0, 8)}.${ext}`;
const filePath = join(outDir, filename);
writeFileSync(filePath, Buffer.from(imageData, 'base64'));
```

Also update the MCP test helper so `createClient()` can pass env overrides into the spawned stdio transport:

```ts
async function createClient(
  registryPath: string,
  skillsDir: string,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath, '--registry', registryPath, '--skills-dir', skillsDir, ...extraArgs],
    env: { ...process.env, ...extraEnv },
  });
  // ...
}
```

- [ ] **Step 4: Refresh `packages/skills/dist` and re-run the skills tests**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm run build -w packages/skills
/opt/homebrew/opt/node@22/bin/npm test -w packages/skills -- src/__tests__/mcp-server.test.ts src/__tests__/bundled-media.test.ts
```

Expected:
- `mcp-server.test.ts` and `bundled-media.test.ts` PASS.
- The `packages/skills` build may still report the pre-existing `memory_get_briefs` TypeScript error in `packages/skills/src/mcp-server.ts`; if so, confirm that `packages/skills/dist/mcp-server.js` was still refreshed before evaluating the MCP test result.

- [ ] **Step 5: Commit the skills runtime changes**

```bash
git add packages/skills/src/mcp-server.ts \
  packages/skills/src/__tests__/mcp-server.test.ts \
  packages/skills/src/__tests__/bundled-media.test.ts \
  skills/bundled/generate-image.mjs
git commit -m "fix: use request-scoped outbound media dirs"
```

## Task 4: Run the End-to-End Regression Set

**Files:**
- Verify only; no new files

- [ ] **Step 1: Build the packages touched by this change**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm run build -w packages/core
/opt/homebrew/opt/node@22/bin/npm run build -w packages/gateway
/opt/homebrew/opt/node@22/bin/npm run build -w packages/agent
/opt/homebrew/opt/node@22/bin/npm run build -w packages/main
/opt/homebrew/opt/node@22/bin/npm run build -w packages/platforms/discord
```

Expected: PASS for all listed packages. Run the existing `packages/skills` build separately only if the MCP dist needs refreshing, since it currently has a known unrelated non-zero exit.

- [ ] **Step 2: Run the focused regression suite**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm test -w packages/gateway -- src/__tests__/gateway.test.ts
/opt/homebrew/opt/node@22/bin/npm test -w packages/agent -- src/__tests__/agent-service.test.ts src/__tests__/integration.test.ts
/opt/homebrew/opt/node@22/bin/npm test -w packages/main -- src/__tests__/bootstrap.test.ts
/opt/homebrew/opt/node@22/bin/npm test -w packages/skills -- src/__tests__/mcp-server.test.ts src/__tests__/bundled-media.test.ts
```

Expected: PASS across all targeted suites.

- [ ] **Step 3: Verify the diff is cleanly formatted**

Run:

```bash
git diff --check
git status --short
```

Expected:
- `git diff --check` prints nothing.
- `git status --short` shows only the intended outbound-media change files.

- [ ] **Step 4: Record the verification result without creating another commit**

Do not create a new commit in this task unless a verification failure forced a real code change. If verification is clean, stop here and hand the branch off with the existing Task 1, Task 2, and Task 3 commits.
