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
import type { ScheduledJob, PromptJob, SkillJob, ShellJob, InternalJob } from './types.js';

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
  systemWorkspaceRoot?: string;
  internalJobs?: Map<string, () => Promise<void>>;
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
  private readonly opts: CronRunnerOptions;

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

    const task = nodeCron.schedule(
      job.cron,
      () => {
        void this.executeJob(job);
      },
      { timezone: job.timezone ?? this.opts.timezone },
    );

    this.tasks.set(job.name, task);
    this.jobs.set(job.name, job);

    // Catch-up: fire immediately if the job was missed within the catchup window
    if (job.catchupWindowMinutes && job.catchupWindowMinutes > 0) {
      void this.checkAndCatchup(job);
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
      if (prev.toDate() >= windowStart) {
        console.log(
          `[Scheduler] Catch-up: running missed job "${job.name}" (was due at ${prev.toDate().toISOString()})`,
        );
        await this.executeJob(job);
      }
    } catch (err) {
      // Non-fatal — just skip catch-up if cron-parser fails
      console.warn(`[Scheduler] Catch-up check failed for "${job.name}":`, err);
    }
  }

  async executeJob(job: ScheduledJob): Promise<void> {
    if (job.running) {
      console.warn(`[Scheduler] Skipping "${job.name}" — previous run still in progress`);
      return;
    }

    job.running = true;
    try {
      if (job.type === 'internal') {
        await this.executeInternalJob(job);
      } else if (job.type === 'skill') {
        await this.executeSkillJob(job);
      } else if (job.type === 'shell') {
        await this.executeShellJob(job);
      } else {
        await this.executePromptJob(job);
      }
    } finally {
      job.running = false;
    }
  }

  stop(): void {
    for (const task of this.tasks.values()) {
      task.stop();
    }
    this.tasks.clear();
    this.jobs.clear();
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

  private async executePromptJob(job: PromptJob): Promise<void> {
    const sessionId = `scheduler:cron:${job.name}:${randomUUID().slice(0, 8)}`;
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
          await this.handleError(job, timedOut && timeoutError ? timeoutError : event.error);
          return;
        }
        if (event.type === 'complete') {
          if (!job.silent) {
            await this.opts.sendProactiveMessage(job.target, event.response);
            await this.storeJobMessages(job, sessionId, event.response);
          }
          await this.publishComplete(job, true);
          return;
        }
      }

      await this.handleError(job, timedOut && timeoutError ? timeoutError : 'agent ended without a result');
    } catch (err) {
      if (timedOut && timeoutError) {
        void generator.return?.(undefined);
        await this.handleError(job, timeoutError);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      await this.handleError(job, message);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async executeSkillJob(job: SkillJob): Promise<void> {
    if (!this.opts.runSkill) {
      await this.handleError(job, 'runSkill not configured');
      return;
    }

    const sessionId = `scheduler:cron:${job.name}:${randomUUID().slice(0, 8)}`;

    try {
      const result = await this.opts.runSkill(job.payload, {});
      if (!job.silent) {
        await this.opts.sendProactiveMessage(job.target, result);
        await this.storeJobMessages(job, sessionId, result);
      }
      await this.publishComplete(job, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.handleError(job, message);
    }
  }

  private async executeShellJob(job: ShellJob): Promise<void> {
    const sessionId = `scheduler:cron:${job.name}:${randomUUID().slice(0, 8)}`;
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
      await this.publishComplete(job, true);
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
      await this.handleError(job, message);
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

  private async handleError(job: PromptJob | SkillJob | ShellJob, error: string): Promise<void> {
    await this.opts.sendProactiveMessage(
      job.target,
      `Scheduled job "${job.name}" failed: ${error}`,
    );
    await this.publishComplete(job, false);
  }

  private async publishComplete(job: PromptJob | SkillJob | ShellJob, success: boolean): Promise<void> {
    await this.opts.eventBus.publish('scheduler.job.complete', {
      jobName: job.name,
      source: 'cron',
      success,
      target: job.target,
      timestamp: Date.now(),
    });
  }

  private async executeInternalJob(job: InternalJob): Promise<void> {
    const callback = this.opts.internalJobs?.get(job.name);
    if (!callback) {
      console.error(`[Scheduler] Internal job "${job.name}" has no registered callback`);
      await this.opts.eventBus.publish('scheduler.job.complete', {
        jobName: job.name,
        source: 'cron' as const,
        success: false,
        target: { platform: 'system', channel: 'internal' },
        timestamp: Date.now(),
      });
      return;
    }

    try {
      await callback();
      await this.opts.eventBus.publish('scheduler.job.complete', {
        jobName: job.name,
        source: 'cron' as const,
        success: true,
        target: { platform: 'system', channel: 'internal' },
        timestamp: Date.now(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Scheduler] Internal job "${job.name}" failed:`, message);
      await this.opts.eventBus.publish('scheduler.job.complete', {
        jobName: job.name,
        source: 'cron' as const,
        success: false,
        target: { platform: 'system', channel: 'internal' },
        timestamp: Date.now(),
      });
    }
  }
}
