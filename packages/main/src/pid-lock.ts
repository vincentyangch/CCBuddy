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
  instanceId: string | null;
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

function parseProcessStartTime(raw: string): number | null {
  const normalized = raw.trim().replace(/\s+/g, ' ');
  if (!normalized) return null;
  const startedAtMs = Date.parse(normalized);
  return Number.isNaN(startedAtMs) ? null : startedAtMs;
}

function parsePidLock(raw: string): ParsedPidLockRecord | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as Partial<PidLockRecord>;
    if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return {
        pid: parsed.pid,
        startedAtMs:
          typeof parsed.startedAtMs === 'number' && Number.isFinite(parsed.startedAtMs)
            ? parsed.startedAtMs
            : null,
        instanceId: typeof parsed.instanceId === 'string' && parsed.instanceId ? parsed.instanceId : null,
      };
    }
  } catch {
    // Fall through to legacy raw-PID parsing.
  }

  const legacyPid = Number.parseInt(trimmed, 10);
  if (Number.isInteger(legacyPid) && legacyPid > 0) {
    return {
      pid: legacyPid,
      startedAtMs: null,
      instanceId: null,
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

function unlinkPidLockBestEffort(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Best effort: another process may have already removed the lock.
  }
}

function readProcessStartTimeFromPs(pid: number): number | null {
  try {
    const raw = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...process.env,
        LANG: 'C',
        LC_ALL: 'C',
      },
    }).trim();
    return parseProcessStartTime(raw);
  } catch {
    return null;
  }
}

function createDefaultPidLockProcessOps(): PidLockProcessOps {
  return {
    currentPid: process.pid,
    getStartedAtMs: readProcessStartTimeFromPs,
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
      if (ms <= 0) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
  };
}

function assertLiveProcessMatchesLock(
  pid: number,
  expectedStartedAtMs: number,
  ops: PidLockProcessOps,
): boolean {
  if (!ops.isAlive(pid)) {
    return false;
  }

  const liveStartedAtMs = ops.getStartedAtMs(pid);
  if (liveStartedAtMs === null) {
    if (!ops.isAlive(pid)) {
      return false;
    }
    throw new Error(`Refusing to kill PID ${pid} because its start time could not be determined.`);
  }

  if (liveStartedAtMs !== expectedStartedAtMs) {
    throw new Error(`Refusing to kill PID ${pid} because lock metadata does not match the live process.`);
  }

  return true;
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

    if (!assertLiveProcessMatchesLock(existing.pid, existing.startedAtMs, ops)) {
      writePidLock(lockPath, currentRecord);
      return () => {
        const latest = readPidLock(lockPath);
        if (!latest) return;
        if (
          latest.pid === currentRecord.pid &&
          latest.startedAtMs === currentRecord.startedAtMs &&
          latest.instanceId === currentRecord.instanceId
        ) {
          unlinkPidLockBestEffort(lockPath);
        }
      };
    }

    ops.sendSignal(existing.pid, 'SIGTERM');
    for (let attempt = 0; attempt < TERMINATION_ATTEMPTS; attempt++) {
      if (!ops.isAlive(existing.pid)) break;
      if (!assertLiveProcessMatchesLock(existing.pid, existing.startedAtMs, ops)) {
        break;
      }
      ops.sleepMs(TERMINATION_SLEEP_MS);
    }
    if (ops.isAlive(existing.pid)) {
      assertLiveProcessMatchesLock(existing.pid, existing.startedAtMs, ops);
      ops.sendSignal(existing.pid, 'SIGKILL');
    }
  }

  writePidLock(lockPath, currentRecord);

  return () => {
    const latest = readPidLock(lockPath);
    if (!latest) return;
    if (
      latest.pid === currentRecord.pid &&
      latest.startedAtMs === currentRecord.startedAtMs &&
      latest.instanceId === currentRecord.instanceId
    ) {
      unlinkPidLockBestEffort(lockPath);
    }
  };
}
