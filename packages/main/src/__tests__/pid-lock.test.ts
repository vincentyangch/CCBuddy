import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquirePidLock, type PidLockProcessOps } from '../pid-lock.js';

function makeOps(overrides: Partial<{
  currentPid: number;
  startedAtMs: Record<number, number | null>;
  getStartedAtMs: (pid: number) => number | null;
  alivePids: Set<number>;
  onSignal: (pid: number, signal: NodeJS.Signals, alivePids: Set<number>) => void;
  onSleep: (ms: number, sleeps: number[]) => void;
}> = {}) {
  const alivePids = overrides.alivePids ?? new Set<number>();
  const startedAtMs = overrides.startedAtMs ?? {};
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const sleeps: number[] = [];

  const ops: PidLockProcessOps = {
    currentPid: overrides.currentPid ?? 5000,
    getStartedAtMs: overrides.getStartedAtMs ?? ((pid) => startedAtMs[pid] ?? null),
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
      if (overrides.onSleep) {
        overrides.onSleep(ms, sleeps);
      }
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

  it('does not throw when start-time lookup races with process exit', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pid-lock-'));
    tempDirs.push(dataDir);
    const lockPath = join(dataDir, 'ccbuddy.pid');
    writeFileSync(lockPath, JSON.stringify({ pid: 111, startedAtMs: 1000 }), 'utf8');

    const alivePids = new Set([111]);
    const { ops, signals } = makeOps({
      alivePids,
      getStartedAtMs: (pid) => {
        if (pid === 111) {
          alivePids.delete(pid);
          return null;
        }
        if (pid === 5000) {
          return 5000;
        }
        return null;
      },
    });

    expect(() => acquirePidLock(dataDir, ops)).not.toThrow();
    expect(signals).toEqual([]);
    expect(readLock(lockPath).pid).toBe(5000);
  });

  it('refuses to SIGKILL a PID after it is reused during the wait loop', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pid-lock-'));
    tempDirs.push(dataDir);
    const lockPath = join(dataDir, 'ccbuddy.pid');
    writeFileSync(lockPath, JSON.stringify({ pid: 111, startedAtMs: 1000 }), 'utf8');

    let reused = false;
    const { ops, signals, sleeps } = makeOps({
      alivePids: new Set([111]),
      getStartedAtMs: (pid) => {
        if (pid === 111) {
          return reused ? 2000 : 1000;
        }
        if (pid === 5000) {
          return 5000;
        }
        return null;
      },
      onSleep: () => {
        reused = true;
      },
    });

    expect(() => acquirePidLock(dataDir, ops)).toThrow('does not match the live process');
    expect(signals).toEqual([{ pid: 111, signal: 'SIGTERM' }]);
    expect(sleeps).toEqual([200]);
    expect(readLock(lockPath)).toEqual({ pid: 111, startedAtMs: 1000 });
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

  it('keeps a newer lock when an older releaser runs after reacquisition', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pid-lock-'));
    tempDirs.push(dataDir);
    const lockPath = join(dataDir, 'ccbuddy.pid');

    const { ops } = makeOps({
      startedAtMs: { 5000: 5000 },
    });

    const releaseFirst = acquirePidLock(dataDir, ops);
    const firstLock = readLock(lockPath);

    const releaseSecond = acquirePidLock(dataDir, ops);
    const secondLock = readLock(lockPath);
    expect(secondLock.instanceId).not.toBe(firstLock.instanceId);

    releaseFirst();

    expect(existsSync(lockPath)).toBe(true);
    expect(readLock(lockPath).instanceId).toBe(secondLock.instanceId);

    releaseSecond();
    expect(existsSync(lockPath)).toBe(false);
  });
});
