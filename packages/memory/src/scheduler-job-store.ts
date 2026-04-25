import type Database from 'better-sqlite3';

export type SchedulerJobStatus = 'registered' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface SchedulerJobState {
  jobName: string;
  type: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  targetPlatform: string | null;
  targetChannel: string | null;
  lastStatus: SchedulerJobStatus | null;
  lastSessionId: string | null;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
  nextExpectedAt: number | null;
  updatedAt: number;
}

export interface UpsertSchedulerJobParams {
  jobName: string;
  type: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  targetPlatform?: string | null;
  targetChannel?: string | null;
  nextExpectedAt?: number | null;
  updatedAt?: number;
}

export interface MarkSchedulerJobStartedParams {
  jobName: string;
  sessionId: string;
  startedAt?: number;
  nextExpectedAt?: number | null;
}

export interface MarkSchedulerJobCompletedParams {
  jobName: string;
  sessionId: string;
  success: boolean;
  completedAt?: number;
  durationMs?: number | null;
  error?: string | null;
  nextExpectedAt?: number | null;
}

export interface MarkSchedulerJobSkippedParams {
  jobName: string;
  reason: string;
  skippedAt?: number;
  nextExpectedAt?: number | null;
}

export class SchedulerJobStore {
  constructor(private readonly db: Database.Database) {}

  upsertJob(params: UpsertSchedulerJobParams): void {
    const updatedAt = params.updatedAt ?? Date.now();
    this.db.prepare(`
      INSERT INTO scheduler_job_state (
        job_name, type, cron, timezone, enabled, target_platform, target_channel,
        last_status, next_expected_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'registered', ?, ?)
      ON CONFLICT(job_name) DO UPDATE SET
        type = excluded.type,
        cron = excluded.cron,
        timezone = excluded.timezone,
        enabled = excluded.enabled,
        target_platform = excluded.target_platform,
        target_channel = excluded.target_channel,
        next_expected_at = excluded.next_expected_at,
        updated_at = excluded.updated_at
    `).run(
      params.jobName,
      params.type,
      params.cron,
      params.timezone,
      params.enabled ? 1 : 0,
      params.targetPlatform ?? null,
      params.targetChannel ?? null,
      params.nextExpectedAt ?? null,
      updatedAt,
    );
  }

  markStarted(params: MarkSchedulerJobStartedParams): void {
    const startedAt = params.startedAt ?? Date.now();
    this.db.prepare(`
      UPDATE scheduler_job_state
      SET last_status = 'running',
          last_session_id = ?,
          last_started_at = ?,
          last_error = NULL,
          next_expected_at = ?,
          updated_at = ?
      WHERE job_name = ?
    `).run(
      params.sessionId,
      startedAt,
      params.nextExpectedAt ?? null,
      startedAt,
      params.jobName,
    );
  }

  markCompleted(params: MarkSchedulerJobCompletedParams): void {
    const completedAt = params.completedAt ?? Date.now();
    this.db.prepare(`
      UPDATE scheduler_job_state
      SET last_status = ?,
          last_session_id = ?,
          last_completed_at = ?,
          last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END,
          last_error = ?,
          last_duration_ms = ?,
          next_expected_at = ?,
          updated_at = ?
      WHERE job_name = ?
    `).run(
      params.success ? 'succeeded' : 'failed',
      params.sessionId,
      completedAt,
      params.success ? 1 : 0,
      completedAt,
      params.success ? null : params.error ?? null,
      params.durationMs ?? null,
      params.nextExpectedAt ?? null,
      completedAt,
      params.jobName,
    );
  }

  markSkipped(params: MarkSchedulerJobSkippedParams): void {
    const skippedAt = params.skippedAt ?? Date.now();
    this.db.prepare(`
      UPDATE scheduler_job_state
      SET last_status = 'skipped',
          last_error = ?,
          next_expected_at = ?,
          updated_at = ?
      WHERE job_name = ?
    `).run(
      params.reason,
      params.nextExpectedAt ?? null,
      skippedAt,
      params.jobName,
    );
  }

  get(jobName: string): SchedulerJobState | undefined {
    const row = this.db.prepare('SELECT * FROM scheduler_job_state WHERE job_name = ?').get(jobName);
    return row ? this.toState(row as Record<string, unknown>) : undefined;
  }

  list(): SchedulerJobState[] {
    const rows = this.db.prepare(`
      SELECT * FROM scheduler_job_state
      ORDER BY COALESCE(next_expected_at, 9223372036854775807), job_name
    `).all() as Record<string, unknown>[];
    return rows.map((row) => this.toState(row));
  }

  private toState(row: Record<string, unknown>): SchedulerJobState {
    return {
      jobName: row.job_name as string,
      type: row.type as string,
      cron: row.cron as string,
      timezone: row.timezone as string,
      enabled: Boolean(row.enabled),
      targetPlatform: row.target_platform as string | null,
      targetChannel: row.target_channel as string | null,
      lastStatus: row.last_status as SchedulerJobStatus | null,
      lastSessionId: row.last_session_id as string | null,
      lastStartedAt: row.last_started_at as number | null,
      lastCompletedAt: row.last_completed_at as number | null,
      lastSuccessAt: row.last_success_at as number | null,
      lastError: row.last_error as string | null,
      lastDurationMs: row.last_duration_ms as number | null,
      nextExpectedAt: row.next_expected_at as number | null,
      updatedAt: row.updated_at as number,
    };
  }
}
