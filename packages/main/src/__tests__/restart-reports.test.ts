import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readRestartIntent,
  writeRestartIntent,
  clearRestartIntent,
  isRestartIntentFresh,
} from '../restart-reports.js';

describe('restart-reports', () => {
  it('writes and reads a requested restart intent', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'restart-intent-'));

    writeRestartIntent(dataDir, {
      kind: 'requested_restart',
      requestedAt: '2026-04-17T16:00:00.000Z',
      reportTarget: { platform: 'discord', channel: 'ch-123' },
      requestedBy: 'flyingchickens',
      sessionKey: 'flyingchickens-discord-ch-123',
    });

    expect(readRestartIntent(dataDir)).toEqual({
      kind: 'requested_restart',
      requestedAt: '2026-04-17T16:00:00.000Z',
      reportTarget: { platform: 'discord', channel: 'ch-123' },
      requestedBy: 'flyingchickens',
      sessionKey: 'flyingchickens-discord-ch-123',
    });
  });

  it('treats restart intent older than 15 minutes as stale', () => {
    expect(isRestartIntentFresh({
      kind: 'requested_restart',
      requestedAt: '2026-04-17T16:00:00.000Z',
      reportTarget: { platform: 'discord', channel: 'ch-123' },
    }, Date.parse('2026-04-17T16:16:00.000Z'))).toBe(false);
  });

  it('returns null for malformed marker files', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'restart-intent-'));
    writeFileSync(join(dataDir, 'restart-intent.json'), '{not-json', 'utf8');
    expect(readRestartIntent(dataDir)).toBeNull();
  });

  it('clears the restart marker', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'restart-intent-'));
    writeRestartIntent(dataDir, {
      kind: 'requested_restart',
      requestedAt: '2026-04-17T16:00:00.000Z',
      reportTarget: { platform: 'discord', channel: 'ch-123' },
    });
    clearRestartIntent(dataDir);
    expect(readRestartIntent(dataDir)).toBeNull();
  });
});
