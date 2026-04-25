import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryDatabase } from '../database.js';
import { SchedulerJobStore } from '../scheduler-job-store.js';

describe('SchedulerJobStore', () => {
  let tmpDir: string;
  let db: MemoryDatabase;
  let store: SchedulerJobStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccbuddy-scheduler-job-store-'));
    db = new MemoryDatabase(join(tmpDir, 'test.db'));
    db.init();
    store = new SchedulerJobStore(db.raw());
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('tracks job definition, start, and successful completion state', () => {
    store.upsertJob({
      jobName: 'evening_briefing',
      type: 'prompt',
      cron: '0 23 * * *',
      timezone: 'America/Chicago',
      enabled: true,
      targetPlatform: 'discord',
      targetChannel: 'general',
      nextExpectedAt: 2_000,
      updatedAt: 1_000,
    });

    store.markStarted({
      jobName: 'evening_briefing',
      sessionId: 'scheduler:cron:evening_briefing:abc123',
      startedAt: 3_000,
      nextExpectedAt: 4_000,
    });
    store.markCompleted({
      jobName: 'evening_briefing',
      sessionId: 'scheduler:cron:evening_briefing:abc123',
      success: true,
      completedAt: 5_000,
      durationMs: 2_000,
      nextExpectedAt: 6_000,
    });

    expect(store.list()).toEqual([
      expect.objectContaining({
        jobName: 'evening_briefing',
        type: 'prompt',
        cron: '0 23 * * *',
        timezone: 'America/Chicago',
        enabled: true,
        targetPlatform: 'discord',
        targetChannel: 'general',
        lastStatus: 'succeeded',
        lastSessionId: 'scheduler:cron:evening_briefing:abc123',
        lastStartedAt: 3_000,
        lastCompletedAt: 5_000,
        lastSuccessAt: 5_000,
        lastDurationMs: 2_000,
        lastError: null,
        nextExpectedAt: 6_000,
      }),
    ]);
  });

  it('records failed and skipped states without losing job metadata', () => {
    store.upsertJob({
      jobName: 'service_watchdog',
      type: 'shell',
      cron: '*/10 * * * *',
      timezone: 'UTC',
      enabled: true,
      targetPlatform: 'discord',
      targetChannel: 'general',
      nextExpectedAt: 10_000,
      updatedAt: 1_000,
    });

    store.markCompleted({
      jobName: 'service_watchdog',
      sessionId: 'scheduler:cron:service_watchdog:def456',
      success: false,
      completedAt: 12_000,
      durationMs: 500,
      error: 'working directory is not usable',
      nextExpectedAt: 20_000,
    });
    store.markSkipped({
      jobName: 'service_watchdog',
      reason: 'previous run still in progress',
      skippedAt: 13_000,
      nextExpectedAt: 20_000,
    });

    expect(store.get('service_watchdog')).toEqual(
      expect.objectContaining({
        jobName: 'service_watchdog',
        type: 'shell',
        lastStatus: 'skipped',
        lastCompletedAt: 12_000,
        lastError: 'previous run still in progress',
        nextExpectedAt: 20_000,
      }),
    );
  });
});
