import nodeCron, { type ScheduledTask } from 'node-cron';
import { CronExpressionParser } from 'cron-parser';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EventBus,
  AgentRequest,
  AgentEvent,
  MessageTarget,
} from '@ccbuddy/core';
import type { ScheduledJob, PromptJob, SkillJob, ShellJob, InternalJob, SchedulerRunSource } from './types.js';

interface ShellJobError extends Error {
  code?: number | string | null;
  signal?: string | null;
  killed?: boolean;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

export interface CronRunnerOptions {
  eventBus: EventBus;
  executeAgentRequest: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
  abortAgentRequest?: (sessionId: string) => Promise<void>;
  sendProactiveMessage: (target: MessageTarget, text: string) => Promise<void>;
  runSkill?: (name: string, input: Record<string, unknown>) => Promise<string>;
  assembleContext: (userId: string, sessionId: string) => string;
  timezone: string;
  defaultModel?: string;
  defaultReasoningEffort?: AgentRequest['reasoningEffort'];
  defaultVerbosity?: AgentRequest['verbosity'];
  defaultPromptJobTimeoutMs?: number;
  catchupCheckIntervalMs?: number;
  systemWorkspaceRoot?: string;
  internalJobs?: Map<string, () => Promise<void>>;
  jobStateStore?: import('./types.js').SchedulerJobStateStore;
  storeMessage?: (params: {
    userId: string;
    sessionId: string;
    platform: string;
    content: string;
    role: 'user' | 'assistant';
  }) => void | Promise<void>;
}

export class CronRunner {
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly handledScheduleTimes = new Set<string>();
  private readonly opts: CronRunnerOptions;
  private catchupMonitor: ReturnType<typeof setInterval> | null = null;

  constructor(opts: CronRunnerOptions) {
    this.opts = opts;
  }

  private getSystemJobWorkingDirectory(job: PromptJob): string | undefined {
    if (job.permissionLevel !== 'system' || !this.opts.systemWorkspaceRoot) return undefined;

    const safeName = job.name
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      || 'job';
    const workingDirectory = join(this.opts.systemWorkspaceRoot, safeName);
    mkdirSync(workingDirectory, { recursive: true });
    return workingDirectory;
  }

  private getPromptJobTimeoutMs(job: PromptJob): number | undefined {
    return job.timeoutMs ?? this.opts.defaultPromptJobTimeoutMs;
  }

  registerJob(job: ScheduledJob): void {
    if (!job.enabled) return;

    if (!nodeCron.validate(job.cron)) {
      console.error(`[Scheduler] Invalid cron expression '${job.cron}' for job '${job.name}' — skipping`);
      return;
    }

    // Stop previous task if re-registering same job name
    const existing = this.tasks.get(job.name);
    if (existing) existing.stop();

    void this.recordJobDefinition(job);
    this.logJobLifecycle('registered', job, {
      nextExpectedAt: this.getNextExpectedAt(job),
    });

    const task = nodeCron.schedule(
      job.cron,
      (scheduledAt?: Date | string) => {
        void this.executeJob(job, {
          source: 'cron',
          scheduledAt: scheduledAt instanceof Date ? scheduledAt : undefined,
        });
      },
      { timezone: job.timezone ?? this.opts.timezone },
    );

    this.tasks.set(job.name, task);
    this.jobs.set(job.name, job);

    // Catch-up: fire immediately if the job was missed within the catchup window
    if (job.catchupWindowMinutes && job.catchupWindowMinutes > 0) {
      void this.checkAndCatchup(job);
      this.ensureCatchupMonitor();
    }
  }

  private ensureCatchupMonitor(): void {
    if (this.catchupMonitor) return;
    const intervalMs = this.opts.catchupCheckIntervalMs ?? 5 * 60 * 1000;
    if (intervalMs <= 0) return;

    this.catchupMonitor = setInterval(() => {
      void this.runCatchupChecks();
    }, intervalMs);
    this.catchupMonitor.unref?.();
  }

  private async runCatchupChecks(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.catchupWindowMinutes && job.catchupWindowMinutes > 0) {
        await this.checkAndCatchup(job);
      }
    }
  }

  private async checkAndCatchup(job: ScheduledJob): Promise<void> {
    if (job.type === 'internal') return;
    try {
      const tz = job.timezone ?? this.opts.timezone;
      const now = new Date();
      const windowMs = (job.catchupWindowMinutes ?? 0) * 60 * 1000;
      const windowStart = new Date(now.getTime() - windowMs);

      const interval = CronExpressionParser.parse(job.cron, {
        currentDate: now,
        tz,
      });

      // Get previous scheduled occurrence
      const prev = interval.prev();
      const prevDate = prev.toDate();
      if (prevDate >= windowStart && !this.hasHandledSchedule(job, prevDate)) {
        console.log(
          `[Scheduler] Catch-up: running missed job "${job.name}" (was due at ${prevDate.toISOString()})`,
        );
        await this.executeJob(job, { source: 'catchup', scheduledAt: prevDate });
      }
    } catch (err) {
      // Non-fatal — just skip catch-up if cron-parser fails
      console.warn(`[Scheduler] Catch-up check failed for "${job.name}":`, err);
    }
  }

  async executeJob(
    job: ScheduledJob,
    trigger: { source?: SchedulerRunSource; scheduledAt?: Date } = {},
  ): Promise<boolean> {
    if (job.running) {
      console.warn(`[Scheduler] Skipping "${job.name}" — previous run still in progress`);
      this.logJobLifecycle('skipped', job, {
        source: trigger.source ?? 'cron',
        reason: 'previous run still in progress',
      });
      await this.recordJobSkipped(job, 'previous run still in progress');
      return false;
    }

    const source = trigger.source ?? 'cron';
    const sessionId = `scheduler:cron:${job.name}:${randomUUID().slice(0, 8)}`;
    const startedAt = Date.now();
    this.markScheduleHandled(job, trigger.scheduledAt);
    job.running = true;
    job.lastRun = startedAt;
    this.logJobLifecycle('started', job, { source, sessionId, startedAt });
    await this.recordJobStarted(job, sessionId, startedAt);
    try {
      if (job.type === 'internal') {
        await this.executeInternalJob(job, sessionId, startedAt, source);
      } else if (job.type === 'skill') {
        await this.executeSkillJob(job, sessionId, startedAt, source);
      } else if (job.type === 'shell') {
        await this.executeShellJob(job, sessionId, startedAt, source);
      } else {
        await this.executePromptJob(job, sessionId, startedAt, source);
      }
      return true;
    } finally {
      job.running = false;
    }
  }

  stop(): void {
    for (const task of this.tasks.values()) {
      task.stop();
    }
    if (this.catchupMonitor) {
      clearInterval(this.catchupMonitor);
      this.catchupMonitor = null;
    }
    this.tasks.clear();
    this.jobs.clear();
  }

  async runJobNow(jobName: string): Promise<{ jobName: string; accepted: boolean }> {
    const job = this.jobs.get(jobName);
    if (!job) {
      throw new Error(`Scheduled job not found: ${jobName}`);
    }
    const accepted = await this.executeJob(job, { source: 'manual' });
    return { jobName, accepted };
  }

  private async storeJobMessages(
    job: PromptJob | SkillJob | ShellJob,
    sessionId: string,
    response: string,
  ): Promise<void> {
    if (!this.opts.storeMessage) return;
    try {
      await this.opts.storeMessage({
        userId: job.user,
        sessionId,
        platform: job.target.platform,
        content: `[Scheduled: ${job.name}]`,
        role: 'user',
      });
      await this.opts.storeMessage({
        userId: job.user,
        sessionId,
        platform: job.target.platform,
        content: response,
        role: 'assistant',
      });
    } catch (err) {
      console.warn('[Scheduler] storeMessage failed:', err);
    }
  }

  private logPromptJobDiagnostics(job: PromptJob, sessionId: string): void {
    const usesHomeAssistantProbe = job.payload.includes('localhost:8123/api/')
      || job.payload.includes('HOMEASSISTANT_TOKEN');

    if (!usesHomeAssistantProbe) return;

    console.log('[Scheduler] Starting prompt job', {
      jobName: job.name,
      sessionId,
      startedAt: new Date().toISOString(),
      homeAssistantTokenPresent: Boolean(process.env.HOMEASSISTANT_TOKEN),
    });
  }

  private async executePromptJob(
    job: PromptJob,
    sessionId: string,
    startedAt: number,
    source: SchedulerRunSource,
  ): Promise<void> {
    const memoryContext = this.opts.assembleContext(job.user, sessionId);
    this.logPromptJobDiagnostics(job, sessionId);

    const request: AgentRequest = {
      prompt: job.payload,
      userId: job.user,
      sessionId,
      channelId: job.target.channel,
      platform: job.target.platform,
      permissionLevel: job.permissionLevel,
      memoryContext,
      model: job.model ?? this.opts.defaultModel,
      reasoningEffort: job.reasoningEffort ?? this.opts.defaultReasoningEffort,
      verbosity: job.verbosity ?? this.opts.defaultVerbosity,
      // System jobs use scheduler-owned stable workspaces to avoid HOME locks
      // without polluting Codex's per-project trust config on every invocation.
      workingDirectory: this.getSystemJobWorkingDirectory(job),
    };

    const generator = this.opts.executeAgentRequest(request);
    const timeoutMs = this.getPromptJobTimeoutMs(job);
    const timeoutError = timeoutMs !== undefined && timeoutMs > 0
      ? `timed out after ${timeoutMs}ms`
      : undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutPromise = timeoutError
      ? new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          void this.opts.abortAgentRequest?.(sessionId).catch((err) => {
            console.warn(`[Scheduler] abort failed for "${job.name}":`, err);
          });
          reject(new Error(timeoutError));
        }, timeoutMs);
      })
      : undefined;

    try {
      const iterator = generator[Symbol.asyncIterator]();
      for (;;) {
        const result = timeoutPromise
          ? await Promise.race([iterator.next(), timeoutPromise])
          : await iterator.next();
        if (result.done) break;

        const event = result.value;
        if (event.type === 'error') {
          await this.handleError(job, timedOut && timeoutError ? timeoutError : event.error, sessionId, startedAt, source);
          return;
        }
        if (event.type === 'complete') {
          if (!job.silent) {
            await this.opts.sendProactiveMessage(job.target, event.response);
            await this.storeJobMessages(job, sessionId, event.response);
          }
          await this.publishComplete(job, true, sessionId, startedAt, source);
          return;
        }
      }

      await this.handleError(job, timedOut && timeoutError ? timeoutError : 'agent ended without a result', sessionId, startedAt, source);
    } catch (err) {
      if (timedOut && timeoutError) {
        void generator.return?.(undefined);
        await this.handleError(job, timeoutError, sessionId, startedAt, source);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      await this.handleError(job, message, sessionId, startedAt, source);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async executeSkillJob(
    job: SkillJob,
    sessionId: string,
    startedAt: number,
    source: SchedulerRunSource,
  ): Promise<void> {
    if (!this.opts.runSkill) {
      await this.handleError(job, 'runSkill not configured', sessionId, startedAt, source);
      return;
    }

    try {
      const result = await this.opts.runSkill(job.payload, {});
      if (!job.silent) {
        await this.opts.sendProactiveMessage(job.target, result);
        await this.storeJobMessages(job, sessionId, result);
      }
      await this.publishComplete(job, true, sessionId, startedAt, source);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.handleError(job, message, sessionId, startedAt, source);
    }
  }

  private async executeShellJob(
    job: ShellJob,
    sessionId: string,
    startedAt: number,
    source: SchedulerRunSource,
  ): Promise<void> {
    console.log('[Scheduler] Starting shell job', {
      jobName: job.name,
      sessionId,
      startedAt: new Date().toISOString(),
    });

    try {
      const { stdout, stderr } = await this.runShellCommand(job);
      console.log('[Scheduler] Shell command exited', {
        jobName: job.name,
        sessionId,
        exitedAt: new Date().toISOString(),
      });
      const response = this.formatShellOutput(stdout, stderr);
      if (!job.silent) {
        await this.opts.sendProactiveMessage(job.target, response);
        await this.storeJobMessages(job, sessionId, response);
      }
      await this.publishComplete(job, true, sessionId, startedAt, source);
      console.log('[Scheduler] Shell job completed', {
        jobName: job.name,
        sessionId,
        completedAt: new Date().toISOString(),
      });
    } catch (err) {
      const message = this.formatShellError(err, job.timeoutMs);
      console.error('[Scheduler] Shell job failed', {
        jobName: job.name,
        sessionId,
        error: message,
      });
      await this.handleError(job, message, sessionId, startedAt, source);
    }
  }

  private async runShellCommand(job: ShellJob): Promise<{ stdout: string; stderr: string }> {
    if (job.workingDirectory) {
      try {
        const stat = statSync(job.workingDirectory);
        if (!stat.isDirectory()) {
          throw new Error('not a directory');
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`working directory is not usable: ${job.workingDirectory} (${reason})`);
      }
    }

    const captureDir = mkdtempSync(join(tmpdir(), 'ccbuddy-shell-'));
    const stdoutPath = join(captureDir, 'stdout.log');
    const stderrPath = join(captureDir, 'stderr.log');
    const stdoutFd = openSync(stdoutPath, 'w');
    const stderrFd = openSync(stderrPath, 'w');
    let stdout = '';
    let stderr = '';
    let result: ReturnType<typeof spawnSync>;

    try {
      result = spawnSync('/bin/zsh', ['-lc', job.payload], {
        cwd: job.workingDirectory,
        env: process.env,
        encoding: 'utf8',
        timeout: job.timeoutMs && job.timeoutMs > 0 ? job.timeoutMs : undefined,
        stdio: ['ignore', stdoutFd, stderrFd],
      });
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
      try { stdout = readFileSync(stdoutPath, 'utf8'); } catch { stdout = ''; }
      try { stderr = readFileSync(stderrPath, 'utf8'); } catch { stderr = ''; }
      rmSync(captureDir, { recursive: true, force: true });
    }

    if (result.error) {
      const err = result.error as ShellJobError;
      err.stdout = stdout;
      err.stderr = stderr;
      if (err.message.includes('ETIMEDOUT')) {
        err.killed = true;
      }
      throw err;
    }

    if (result.status !== 0) {
      const err = new Error(`shell exited with ${result.signal ?? result.status}`) as ShellJobError;
      err.code = result.status;
      err.signal = result.signal;
      err.stdout = stdout;
      err.stderr = stderr;
      throw err;
    }

    return { stdout, stderr };
  }

  private formatShellOutput(stdout: string | Buffer, stderr: string | Buffer): string {
    const out = stdout.toString().trim();
    const err = stderr.toString().trim();
    if (out && err) return `${out}\n\nstderr:\n${err}`;
    if (out) return out;
    if (err) return `stderr:\n${err}`;
    return 'Shell job completed.';
  }

  private formatShellError(err: unknown, timeoutMs?: number): string {
    const shellErr = err as ShellJobError;
    if (shellErr.killed && timeoutMs && timeoutMs > 0) {
      return `timed out after ${timeoutMs}ms`;
    }

    const stderr = shellErr.stderr?.toString().trim();
    const stdout = shellErr.stdout?.toString().trim();
    const detail = stderr || stdout || shellErr.message || String(err);
    const code = shellErr.signal ?? shellErr.code;
    return code === undefined || code === null
      ? detail
      : `shell exited with ${code}: ${detail}`;
  }

  private async handleError(
    job: PromptJob | SkillJob | ShellJob,
    error: string,
    sessionId: string,
    startedAt: number,
    source: SchedulerRunSource,
  ): Promise<void> {
    await this.opts.sendProactiveMessage(
      job.target,
      `Scheduled job "${job.name}" failed: ${error}`,
    );
    await this.publishComplete(job, false, sessionId, startedAt, source, error);
  }

  private async publishComplete(
    job: PromptJob | SkillJob | ShellJob,
    success: boolean,
    sessionId: string,
    startedAt: number,
    source: SchedulerRunSource,
    error?: string,
  ): Promise<void> {
    const completedAt = Date.now();
    const durationMs = completedAt - startedAt;
    this.logJobLifecycle(success ? 'completed' : 'failed', job, {
      source,
      sessionId,
      completedAt,
      durationMs,
      ...(error ? { error } : {}),
    });
    await this.recordJobCompleted(job, sessionId, success, completedAt, durationMs, error);
    await this.opts.eventBus.publish('scheduler.job.complete', {
      jobName: job.name,
      source,
      success,
      target: job.target,
      timestamp: Date.now(),
    });
  }

  private async executeInternalJob(
    job: InternalJob,
    sessionId: string,
    startedAt: number,
    source: SchedulerRunSource,
  ): Promise<void> {
    const callback = this.opts.internalJobs?.get(job.name);
    if (!callback) {
      console.error(`[Scheduler] Internal job "${job.name}" has no registered callback`);
      await this.publishInternalComplete(job, false, sessionId, startedAt, source, 'missing callback');
      return;
    }

    try {
      await callback();
      await this.publishInternalComplete(job, true, sessionId, startedAt, source);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Scheduler] Internal job "${job.name}" failed:`, message);
      await this.publishInternalComplete(job, false, sessionId, startedAt, source, message);
    }
  }

  private async publishInternalComplete(
    job: InternalJob,
    success: boolean,
    sessionId: string,
    startedAt: number,
    source: SchedulerRunSource,
    error?: string,
  ): Promise<void> {
    const completedAt = Date.now();
    const durationMs = completedAt - startedAt;
    this.logJobLifecycle(success ? 'completed' : 'failed', job, {
      source,
      sessionId,
      completedAt,
      durationMs,
      ...(error ? { error } : {}),
    });
    await this.recordJobCompleted(job, sessionId, success, completedAt, durationMs, error);
    if (!success && error === 'missing callback') {
      await this.opts.eventBus.publish('scheduler.job.complete', {
        jobName: job.name,
        source,
        success: false,
        target: { platform: 'system', channel: 'internal' },
        timestamp: Date.now(),
      });
      return;
    }
    await this.opts.eventBus.publish('scheduler.job.complete', {
      jobName: job.name,
      source,
      success,
      target: { platform: 'system', channel: 'internal' },
      timestamp: Date.now(),
    });
  }

  private getJobTimezone(job: ScheduledJob): string {
    return job.timezone ?? this.opts.timezone;
  }

  private getNextExpectedAt(job: ScheduledJob, from = new Date()): number | null {
    try {
      return CronExpressionParser.parse(job.cron, {
        currentDate: from,
        tz: this.getJobTimezone(job),
      }).next().toDate().getTime();
    } catch {
      return null;
    }
  }

  private handledKey(job: ScheduledJob, scheduledAt: Date): string {
    return `${job.name}:${scheduledAt.getTime()}`;
  }

  private hasHandledSchedule(job: ScheduledJob, scheduledAt: Date): boolean {
    return this.handledScheduleTimes.has(this.handledKey(job, scheduledAt));
  }

  private markScheduleHandled(job: ScheduledJob, scheduledAt?: Date): void {
    if (!scheduledAt) return;
    this.handledScheduleTimes.add(this.handledKey(job, scheduledAt));
  }

  private logJobLifecycle(
    status: 'registered' | 'started' | 'completed' | 'failed' | 'skipped',
    job: ScheduledJob,
    details: Record<string, unknown> = {},
  ): void {
    const payload = {
      jobName: job.name,
      type: job.type,
      cron: job.cron,
      timezone: this.getJobTimezone(job),
      ...details,
    };
    const serialized = JSON.stringify(payload);
    if (status === 'failed') {
      console.error(`[Scheduler] Job ${status} ${serialized}`);
    } else if (status === 'skipped') {
      console.warn(`[Scheduler] Job ${status} ${serialized}`);
    } else {
      console.log(`[Scheduler] Job ${status} ${serialized}`);
    }
  }

  private async recordJobDefinition(job: ScheduledJob): Promise<void> {
    try {
      const target = job.type === 'internal' ? undefined : job.target;
      await this.opts.jobStateStore?.upsertJob({
        jobName: job.name,
        type: job.type,
        cron: job.cron,
        timezone: this.getJobTimezone(job),
        enabled: job.enabled,
        targetPlatform: target?.platform ?? null,
        targetChannel: target?.channel ?? null,
        nextExpectedAt: this.getNextExpectedAt(job),
        updatedAt: Date.now(),
      });
    } catch (err) {
      console.warn('[Scheduler] job state upsert failed:', err);
    }
  }

  private async recordJobStarted(job: ScheduledJob, sessionId: string, startedAt: number): Promise<void> {
    try {
      await this.opts.jobStateStore?.markStarted({
        jobName: job.name,
        sessionId,
        startedAt,
        nextExpectedAt: this.getNextExpectedAt(job),
      });
    } catch (err) {
      console.warn('[Scheduler] job state start update failed:', err);
    }
  }

  private async recordJobCompleted(
    job: ScheduledJob,
    sessionId: string,
    success: boolean,
    completedAt: number,
    durationMs: number,
    error?: string,
  ): Promise<void> {
    try {
      await this.opts.jobStateStore?.markCompleted({
        jobName: job.name,
        sessionId,
        success,
        completedAt,
        durationMs,
        error,
        nextExpectedAt: this.getNextExpectedAt(job),
      });
    } catch (err) {
      console.warn('[Scheduler] job state completion update failed:', err);
    }
  }

  private async recordJobSkipped(job: ScheduledJob, reason: string): Promise<void> {
    try {
      await this.opts.jobStateStore?.markSkipped({
        jobName: job.name,
        reason,
        skippedAt: Date.now(),
        nextExpectedAt: this.getNextExpectedAt(job),
      });
    } catch (err) {
      console.warn('[Scheduler] job state skip update failed:', err);
    }
  }
}
