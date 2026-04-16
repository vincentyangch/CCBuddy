import nodeCron, { type ScheduledTask } from 'node-cron';
import { CronExpressionParser } from 'cron-parser';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  EventBus,
  AgentRequest,
  AgentEvent,
  MessageTarget,
} from '@ccbuddy/core';
import type { ScheduledJob, PromptJob, SkillJob, InternalJob } from './types.js';

export interface CronRunnerOptions {
  eventBus: EventBus;
  executeAgentRequest: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
  sendProactiveMessage: (target: MessageTarget, text: string) => Promise<void>;
  runSkill?: (name: string, input: Record<string, unknown>) => Promise<string>;
  assembleContext: (userId: string, sessionId: string) => string;
  timezone: string;
  defaultModel?: string;
  defaultReasoningEffort?: AgentRequest['reasoningEffort'];
  defaultVerbosity?: AgentRequest['verbosity'];
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
    job: PromptJob | SkillJob,
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

  private async executePromptJob(job: PromptJob): Promise<void> {
    const sessionId = `scheduler:cron:${job.name}:${randomUUID().slice(0, 8)}`;
    const memoryContext = this.opts.assembleContext(job.user, sessionId);

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
      // System jobs use a unique temp dir per invocation to avoid directory lock
      // conflicts with interactive sessions (which may also use HOME)
      workingDirectory: job.permissionLevel === 'system'
        ? mkdtempSync(join(tmpdir(), `ccbuddy-cron-${job.name}-`))
        : undefined,
    };

    const generator = this.opts.executeAgentRequest(request);
    try {
      for await (const event of generator) {
        if (event.type === 'error') {
          await this.handleError(job, event.error);
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.handleError(job, message);
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

  private async handleError(job: PromptJob | SkillJob, error: string): Promise<void> {
    await this.opts.sendProactiveMessage(
      job.target,
      `Scheduled job "${job.name}" failed: ${error}`,
    );
    await this.publishComplete(job, false);
  }

  private async publishComplete(job: PromptJob | SkillJob, success: boolean): Promise<void> {
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
