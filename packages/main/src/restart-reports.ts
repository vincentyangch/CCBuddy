import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RestartIntent {
  kind: 'requested_restart';
  requestedAt: string;
  reportTarget: { platform: string; channel: string };
  requestedBy?: string;
  sessionKey?: string;
}

const RESTART_INTENT_FILE = 'restart-intent.json';
const RESTART_INTENT_MAX_AGE_MS = 15 * 60_000;

export function restartIntentPath(dataDir: string): string {
  return join(dataDir, RESTART_INTENT_FILE);
}

export function readRestartIntent(dataDir: string): RestartIntent | null {
  const filePath = restartIntentPath(dataDir);
  if (!existsSync(filePath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<RestartIntent>;
    if (
      parsed.kind === 'requested_restart' &&
      typeof parsed.requestedAt === 'string' &&
      typeof parsed.reportTarget?.platform === 'string' &&
      typeof parsed.reportTarget?.channel === 'string'
    ) {
      return {
        kind: 'requested_restart',
        requestedAt: parsed.requestedAt,
        reportTarget: parsed.reportTarget,
        requestedBy: parsed.requestedBy,
        sessionKey: parsed.sessionKey,
      };
    }
  } catch {
    return null;
  }

  return null;
}

export function writeRestartIntent(dataDir: string, intent: RestartIntent): void {
  mkdirSync(dataDir, { recursive: true });
  const filePath = restartIntentPath(dataDir);
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(intent), 'utf8');
  renameSync(tmpPath, filePath);
}

export function clearRestartIntent(dataDir: string): void {
  try {
    unlinkSync(restartIntentPath(dataDir));
  } catch {
    // best effort
  }
}

export function isRestartIntentFresh(intent: RestartIntent, nowMs = Date.now()): boolean {
  const requestedAtMs = Date.parse(intent.requestedAt);
  return Number.isFinite(requestedAtMs) && (nowMs - requestedAtMs) <= RESTART_INTENT_MAX_AGE_MS;
}
