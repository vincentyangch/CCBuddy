# PID Lock Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden CCBuddy startup so the PID lock can only terminate a proven prior CCBuddy process and always releases cleanly on bootstrap failure.

**Architecture:** Extract lock ownership, process-identity validation, and cleanup logic into a focused `pid-lock.ts` helper inside `packages/main`. Bootstrap will call that helper, while tests cover both the helper’s process-ownership rules and bootstrap’s stop/failure cleanup wiring. The lock file remains `data/ccbuddy.pid`, but it becomes structured JSON with `pid` and `startedAtMs` rather than a raw PID string.

**Tech Stack:** TypeScript, Node.js filesystem APIs, `child_process.execFileSync`, Vitest, existing `packages/main` bootstrap tests

---

## File Map

### Existing files to modify

- `packages/main/src/bootstrap.ts`
  - Remove the inline PID-lock implementation, use the helper module, and release the lock on bootstrap failure.
- `packages/main/src/__tests__/bootstrap.test.ts`
  - Mock the PID-lock helper and verify `stop()` plus bootstrap-failure cleanup release the lock.

### New files to create

- `packages/main/src/pid-lock.ts`
  - Own the structured lock record, lock-file parsing/writing, process start-time validation, and lock release rules.
- `packages/main/src/__tests__/pid-lock.test.ts`
  - Unit coverage for dead locks, matching live locks, mismatched live locks, legacy raw-PID locks, and safe release behavior.

### Execution note

- The repo is currently on `main`. Execute this plan in an isolated worktree or feature branch before touching production files.

## Task 1: Add a Testable PID Lock Helper

**Files:**
- Create: `packages/main/src/pid-lock.ts`
- Create: `packages/main/src/__tests__/pid-lock.test.ts`
- Test: `packages/main/src/__tests__/pid-lock.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Create `packages/main/src/__tests__/pid-lock.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquirePidLock, type PidLockProcessOps } from '../pid-lock.js';

function makeOps(overrides: Partial<{
  currentPid: number;
  startedAtMs: Record<number, number | null>;
  alivePids: Set<number>;
  onSignal: (pid: number, signal: NodeJS.Signals, alivePids: Set<number>) => void;
}> = {}) {
  const alivePids = overrides.alivePids ?? new Set<number>();
  const startedAtMs = overrides.startedAtMs ?? {};
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const sleeps: number[] = [];

  const ops: PidLockProcessOps = {
    currentPid: overrides.currentPid ?? 5000,
    getStartedAtMs: (pid) => startedAtMs[pid] ?? null,
    isAlive: (pid) => alivePids.has(pid),
    sendSignal: (pid, signal) => {
      signals.push({ pid, signal });
      if (overrides.onSignal) {
        overrides.onSignal(pid, signal, alivePids);
        return;
      }
      if (signal === 'SIGKILL') {
        alivePids.delete(pid);
      }
    },
    sleepMs: (ms) => {
      sleeps.push(ms);
    },
  };

  return { ops, alivePids, signals, sleeps };
}

function readLock(lockPath: string) {
  return JSON.parse(readFileSync(lockPath, 'utf8')) as {
    pid: number;
    startedAtMs: number;
    createdAt: string;
    instanceId: string;
  };
}

describe('acquirePidLock', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces a dead stale lock and writes structured metadata', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pid-lock-'));
    tempDirs.push(dataDir);
    const lockPath = join(dataDir, 'ccbuddy.pid');
    writeFileSync(lockPath, JSON.stringify({ pid: 111, startedAtMs: 1000 }), 'utf8');

    const { ops, signals } = makeOps({
      startedAtMs: { 5000: 5000 },
    });

    const release = acquirePidLock(dataDir, ops);

    expect(signals).toEqual([]);
    expect(readLock(lockPath).pid).toBe(5000);
    expect(readLock(lockPath).startedAtMs).toBe(5000);

    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('terminates a matching live process and escalates when it does not exit', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pid-lock-'));
    tempDirs.push(dataDir);
    const lockPath = join(dataDir, 'ccbuddy.pid');
    writeFileSync(lockPath, JSON.stringify({ pid: 111, startedAtMs: 1000 }), 'utf8');

    const { ops, signals, sleeps } = makeOps({
      alivePids: new Set([111]),
      startedAtMs: { 111: 1000, 5000: 5000 },
      onSignal: (pid, signal, alivePids) => {
        if (signal === 'SIGKILL') {
          alivePids.delete(pid);
        }
      },
    });

    acquirePidLock(dataDir, ops);

    expect(signals).toEqual([
      { pid: 111, signal: 'SIGTERM' },
      { pid: 111, signal: 'SIGKILL' },
    ]);
    expect(sleeps).toHaveLength(15);
    expect(readLock(lockPath).pid).toBe(5000);
  });

  it('refuses to kill a live process when the lock metadata start time does not match', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pid-lock-'));
    tempDirs.push(dataDir);
    const lockPath = join(dataDir, 'ccbuddy.pid');
    writeFileSync(lockPath, JSON.stringify({ pid: 111, startedAtMs: 1000 }), 'utf8');

    const { ops, signals } = makeOps({
      alivePids: new Set([111]),
      startedAtMs: { 111: 2000, 5000: 5000 },
    });

    expect(() => acquirePidLock(dataDir, ops)).toThrow('does not match the live process');
    expect(signals).toEqual([]);
  });

  it('fails closed on a legacy raw-PID lock if that PID is still alive', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pid-lock-'));
    tempDirs.push(dataDir);
    const lockPath = join(dataDir, 'ccbuddy.pid');
    writeFileSync(lockPath, '111\n', 'utf8');

    const { ops, signals } = makeOps({
      alivePids: new Set([111]),
      startedAtMs: { 111: 1000, 5000: 5000 },
    });

    expect(() => acquirePidLock(dataDir, ops)).toThrow('metadata is incomplete');
    expect(signals).toEqual([]);
  });

  it('release only unlinks the lock when it still belongs to the current process metadata', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pid-lock-'));
    tempDirs.push(dataDir);
    const lockPath = join(dataDir, 'ccbuddy.pid');

    const { ops } = makeOps({
      startedAtMs: { 5000: 5000 },
    });

    const release = acquirePidLock(dataDir, ops);
    writeFileSync(lockPath, JSON.stringify({ pid: 999, startedAtMs: 9999, createdAt: 'x', instanceId: 'y' }), 'utf8');

    release();

    expect(existsSync(lockPath)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new helper test file to verify it fails**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm test -w packages/main -- src/__tests__/pid-lock.test.ts
```

Expected: FAIL with module-not-found for `../pid-lock.js` or missing exported helper types/functions.

- [ ] **Step 3: Implement the PID lock helper with structured metadata**

Create `packages/main/src/pid-lock.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PidLockRecord {
  pid: number;
  startedAtMs: number;
  createdAt: string;
  instanceId: string;
}

type ParsedPidLockRecord = {
  pid: number;
  startedAtMs: number | null;
};

export interface PidLockProcessOps {
  currentPid: number;
  getStartedAtMs(pid: number): number | null;
  isAlive(pid: number): boolean;
  sendSignal(pid: number, signal: NodeJS.Signals): void;
  sleepMs(ms: number): void;
}

const TERMINATION_ATTEMPTS = 15;
const TERMINATION_SLEEP_MS = 200;

function parsePidLock(raw: string): ParsedPidLockRecord | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as Partial<PidLockRecord>;
    if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return {
        pid: parsed.pid,
        startedAtMs: typeof parsed.startedAtMs === 'number' && Number.isFinite(parsed.startedAtMs)
          ? parsed.startedAtMs
          : null,
      };
    }
  } catch {
    // Fall through to legacy raw-PID parsing
  }

  const legacyPid = Number.parseInt(trimmed, 10);
  if (Number.isInteger(legacyPid) && legacyPid > 0) {
    return {
      pid: legacyPid,
      startedAtMs: null,
    };
  }

  return null;
}

function readPidLock(lockPath: string): ParsedPidLockRecord | null {
  if (!existsSync(lockPath)) return null;
  try {
    return parsePidLock(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function writePidLock(lockPath: string, record: PidLockRecord): void {
  const tmpPath = `${lockPath}.${record.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(record), 'utf8');
  renameSync(tmpPath, lockPath);
}

function createDefaultPidLockProcessOps(): PidLockProcessOps {
  return {
    currentPid: process.pid,
    getStartedAtMs(pid) {
      try {
        const raw = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (!raw) return null;
        const startedAtMs = Date.parse(raw.replace(/\s+/g, ' '));
        return Number.isNaN(startedAtMs) ? null : startedAtMs;
      } catch {
        return null;
      }
    },
    isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    sendSignal(pid, signal) {
      process.kill(pid, signal);
    },
    sleepMs(ms) {
      execFileSync('sleep', [String(ms / 1000)], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    },
  };
}

export function acquirePidLock(
  dataDir: string,
  ops: PidLockProcessOps = createDefaultPidLockProcessOps(),
): () => void {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, 'ccbuddy.pid');
  const currentStartedAtMs = ops.getStartedAtMs(ops.currentPid);
  if (currentStartedAtMs === null) {
    throw new Error(`Unable to determine start time for current process ${ops.currentPid}`);
  }

  const currentRecord: PidLockRecord = {
    pid: ops.currentPid,
    startedAtMs: currentStartedAtMs,
    createdAt: new Date().toISOString(),
    instanceId: randomUUID(),
  };

  const existing = readPidLock(lockPath);
  if (existing && existing.pid !== currentRecord.pid && ops.isAlive(existing.pid)) {
    if (existing.startedAtMs === null) {
      throw new Error(`Refusing to kill PID ${existing.pid} because lock metadata is incomplete.`);
    }

    const liveStartedAtMs = ops.getStartedAtMs(existing.pid);
    if (liveStartedAtMs === null) {
      throw new Error(`Refusing to kill PID ${existing.pid} because its start time could not be determined.`);
    }
    if (liveStartedAtMs !== existing.startedAtMs) {
      throw new Error(`Refusing to kill PID ${existing.pid} because lock metadata does not match the live process.`);
    }

    ops.sendSignal(existing.pid, 'SIGTERM');
    for (let attempt = 0; attempt < TERMINATION_ATTEMPTS; attempt++) {
      if (!ops.isAlive(existing.pid)) break;
      ops.sleepMs(TERMINATION_SLEEP_MS);
    }
    if (ops.isAlive(existing.pid)) {
      ops.sendSignal(existing.pid, 'SIGKILL');
    }
  }

  writePidLock(lockPath, currentRecord);

  return () => {
    const latest = readPidLock(lockPath);
    if (!latest) return;
    if (latest.pid === currentRecord.pid && latest.startedAtMs === currentRecord.startedAtMs) {
      unlinkSync(lockPath);
    }
  };
}
```

- [ ] **Step 4: Re-run the helper tests**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm test -w packages/main -- src/__tests__/pid-lock.test.ts
```

Expected: PASS with the new helper tests green.

- [ ] **Step 5: Commit the helper groundwork**

```bash
git add packages/main/src/pid-lock.ts \
  packages/main/src/__tests__/pid-lock.test.ts
git commit -m "refactor: add pid lock helper"
```

## Task 2: Wire the Helper Into Bootstrap and Fix Failure Cleanup

**Files:**
- Modify: `packages/main/src/bootstrap.ts`
- Modify: `packages/main/src/__tests__/bootstrap.test.ts`
- Test: `packages/main/src/__tests__/bootstrap.test.ts`

- [ ] **Step 1: Add failing bootstrap tests for lock release wiring**

Update `packages/main/src/__tests__/bootstrap.test.ts` to mock the helper and assert both stop-path and failure-path cleanup:

```ts
const mockAcquirePidLock = vi.fn();

vi.mock('../pid-lock.js', () => ({
  acquirePidLock: (...args: unknown[]) => mockAcquirePidLock(...args),
}));
```

In `beforeEach()`, set a default lock releaser:

```ts
mockAcquirePidLock.mockReturnValue(vi.fn());
```

Add these tests:

```ts
it('stop() releases the pid lock after shutdown', async () => {
  const releasePidLock = vi.fn();
  mockAcquirePidLock.mockReturnValue(releasePidLock);

  const { stop } = await bootstrap('/config');
  await stop();

  expect(releasePidLock).toHaveBeenCalledTimes(1);
});

it('releases the pid lock when bootstrap fails after acquisition', async () => {
  const releasePidLock = vi.fn();
  mockAcquirePidLock.mockReturnValue(releasePidLock);

  const schedulerService = {
    start: vi.fn().mockRejectedValue(new Error('scheduler boom')),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  mockSchedulerService.mockReturnValue(schedulerService);

  await expect(bootstrap('/config')).rejects.toThrow('scheduler boom');
  expect(releasePidLock).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the bootstrap test file to verify the new cases fail**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm test -w packages/main -- src/__tests__/bootstrap.test.ts
```

Expected: FAIL because `bootstrap.ts` still uses the inline lock function and the catch path still leaks the acquired lock on startup failure.

- [ ] **Step 3: Replace the inline lock function with the helper and release on catch**

Update `packages/main/src/bootstrap.ts`:

```ts
import { join, dirname } from 'node:path';
import { writeFileSync, renameSync, readFileSync, unlinkSync, existsSync, mkdirSync, openSync, closeSync, constants as fsConstants } from 'node:fs';
import { acquirePidLock } from './pid-lock.js';
```

Remove the old inline `acquirePidLock()` function entirely.

Then wire the helper through bootstrap with catch-path cleanup:

```ts
export async function bootstrap(configDir?: string): Promise<BootstrapResult> {
  let tickInterval: ReturnType<typeof setInterval> | undefined;
  let releasePidLock: (() => void) | undefined;

  try {
    const resolvedConfigDir = configDir ?? join(process.cwd(), 'config');
    const config = loadConfig(resolvedConfigDir);

    // runtime config override ...

    releasePidLock = acquirePidLock(config.data_dir);

    // existing bootstrap body continues unchanged

    return {
      stop: async () => {
        if (tickInterval) clearInterval(tickInterval);
        await shutdownHandler.execute();
        releasePidLock?.();
        releasePidLock = undefined;
      },
    };
  } catch (err) {
    if (tickInterval) clearInterval(tickInterval);
    releasePidLock?.();
    releasePidLock = undefined;
    throw err;
  }
}
```

- [ ] **Step 4: Re-run the bootstrap tests**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm test -w packages/main -- src/__tests__/bootstrap.test.ts
```

Expected: PASS with the new PID-lock cleanup assertions green.

- [ ] **Step 5: Commit the bootstrap integration**

```bash
git add packages/main/src/bootstrap.ts \
  packages/main/src/__tests__/bootstrap.test.ts
git commit -m "fix: harden bootstrap pid lock cleanup"
```

## Task 3: Run the Final Verification Set

**Files:**
- Verify only; no new files

- [ ] **Step 1: Build `packages/main` with the new helper module**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm run build -w packages/main
```

Expected: PASS.

- [ ] **Step 2: Run the focused PID-lock regression tests**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm test -w packages/main -- src/__tests__/pid-lock.test.ts src/__tests__/bootstrap.test.ts
```

Expected: PASS across both files.

- [ ] **Step 3: Verify diff hygiene**

Run:

```bash
git diff --check
git status --short
```

Expected:
- `git diff --check` prints nothing
- `git status --short` shows only the intended PID-lock change files

- [ ] **Step 4: Stop here unless verification forced follow-up edits**

If verification is clean, do not create another commit in this task. Hand the branch off with the Task 1 and Task 2 commits.
