import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentRequest, MessageTarget, EventBus } from '@ccbuddy/core';
import type { PromptJob, SkillJob, InternalJob } from '../types.js';

const { mockSchedule, mockValidate } = vi.hoisted(() => ({
  mockSchedule: vi.fn(() => ({ stop: vi.fn() })),
  mockValidate: vi.fn(() => true),
}));

vi.mock('node-cron', () => ({
  default: {
    schedule: mockSchedule,
    validate: mockValidate,
  },
  schedule: mockSchedule,
  validate: mockValidate,
}));

import { CronRunner, type CronRunnerOptions } from '../cron-runner.js';

function createMockTarget(): MessageTarget {
  return { platform: 'discord', channel: 'general' };
}

function createMockJob(overrides: Partial<PromptJob> = {}): PromptJob {
  return {
    name: 'daily-report',
    cron: '0 9 * * *',
    type: 'prompt',
    payload: 'Give me a daily summary',
    user: 'user-123',
    target: createMockTarget(),
    permissionLevel: 'system',
    enabled: true,
    nextRun: Date.now() + 60_000,
    running: false,
    ...overrides,
  };
}

function createMockDeps(overrides: Partial<CronRunnerOptions> = {}): CronRunnerOptions {
  const completeEvent: AgentEvent = {
    type: 'complete',
    response: 'Here is your daily report.',
    sessionId: 'test-session',
    userId: 'user-123',
    channelId: 'general',
    platform: 'discord',
  };

  const executeAgentRequest = vi.fn(async function* (_req: AgentRequest): AsyncGenerator<AgentEvent> {
    yield completeEvent;
  });

  const sendProactiveMessage = vi.fn(async () => {});

  const runSkill = vi.fn(async () => 'skill-result-text');

  const eventBus: EventBus = {
    publish: vi.fn(async () => {}),
    subscribe: vi.fn(() => ({ dispose: vi.fn() })),
  };

  const assembleContext = vi.fn().mockReturnValue('Memory context for user');

  const storeMessage = vi.fn(async () => {});

  return {
    eventBus,
    executeAgentRequest,
    sendProactiveMessage,
    runSkill,
    assembleContext,
    timezone: 'UTC',
    storeMessage,
    ...overrides,
  };
}

describe('CronRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('registerJob', () => {
    it('registers a job with node-cron schedule()', () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job = createMockJob();

      runner.registerJob(job);

      expect(mockSchedule).toHaveBeenCalledWith(
        job.cron,
        expect.any(Function),
        expect.objectContaining({ timezone: 'UTC' }),
      );
    });

    it('skips disabled jobs', () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job = createMockJob({ enabled: false });

      runner.registerJob(job);

      expect(mockSchedule).not.toHaveBeenCalled();
    });
  });

  describe('executeJob — prompt', () => {
    it('builds AgentRequest with correct fields and sends response', async () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job = createMockJob();

      await runner.executeJob(job);

      // Verify executeAgentRequest was called with correct AgentRequest
      expect(deps.executeAgentRequest).toHaveBeenCalledTimes(1);
      const request: AgentRequest = (deps.executeAgentRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(request.prompt).toBe('Give me a daily summary');
      expect(request.userId).toBe('user-123');
      expect(request.sessionId).toMatch(/^scheduler:cron:daily-report:[a-f0-9]{8}$/);
      expect(request.channelId).toBe('general');
      expect(request.platform).toBe('discord');
      expect(request.permissionLevel).toBe('system');

      // Verify sendProactiveMessage was called with the response
      expect(deps.sendProactiveMessage).toHaveBeenCalledWith(
        job.target,
        'Here is your daily report.',
      );
    });

    it('logs prompt job diagnostics for Home Assistant watchdog probes', async () => {
      const originalToken = process.env.HOMEASSISTANT_TOKEN;
      process.env.HOMEASSISTANT_TOKEN = 'ha-token';
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        const deps = createMockDeps();
        const runner = new CronRunner(deps);
        const job = createMockJob({
          name: 'service_watchdog',
          payload: 'Run: `curl -s http://localhost:8123/api/ -H "Authorization: Bearer $HOMEASSISTANT_TOKEN"`',
        });

        await runner.executeJob(job);

        expect(logSpy).toHaveBeenCalledWith(
          '[Scheduler] Starting prompt job',
          expect.objectContaining({
            jobName: 'service_watchdog',
            sessionId: expect.stringMatching(/^scheduler:cron:service_watchdog:[a-f0-9]{8}$/),
            startedAt: expect.any(String),
            homeAssistantTokenPresent: true,
          }),
        );
      } finally {
        if (originalToken === undefined) {
          delete process.env.HOMEASSISTANT_TOKEN;
        } else {
          process.env.HOMEASSISTANT_TOKEN = originalToken;
        }
        logSpy.mockRestore();
      }
    });

    it('uses a stable workspace for repeated system prompt job runs', async () => {
      const systemWorkspaceRoot = mkdtempSync(join(tmpdir(), 'ccbuddy-scheduler-workspaces-'));
      const deps = createMockDeps({ systemWorkspaceRoot });
      const runner = new CronRunner(deps);
      const job = createMockJob({ name: 'daily report' });

      try {
        await runner.executeJob(job);
        await runner.executeJob(job);

        const calls = (deps.executeAgentRequest as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls[0][0].workingDirectory).toBe(join(systemWorkspaceRoot, 'daily-report'));
        expect(calls[1][0].workingDirectory).toBe(join(systemWorkspaceRoot, 'daily-report'));
        expect(existsSync(join(systemWorkspaceRoot, 'daily-report'))).toBe(true);
      } finally {
        rmSync(systemWorkspaceRoot, { recursive: true, force: true });
      }
    });

    it('aborts and fails prompt jobs that exceed the configured timeout', async () => {
      vi.useFakeTimers();

      const completeEvent: AgentEvent = {
        type: 'complete',
        response: 'too late',
        sessionId: 'test-session',
        userId: 'user-123',
        channelId: 'general',
        platform: 'discord',
      };
      const executeAgentRequest = vi.fn(async function* (): AsyncGenerator<AgentEvent> {
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield completeEvent;
      });
      const abortAgentRequest = vi.fn(async () => {});
      const deps = createMockDeps({
        executeAgentRequest,
        abortAgentRequest,
        defaultPromptJobTimeoutMs: 10,
      });
      const runner = new CronRunner(deps);
      const job = createMockJob();

      const run = runner.executeJob(job);
      await vi.advanceTimersByTimeAsync(11);
      await run;

      expect(abortAgentRequest).toHaveBeenCalledWith(
        expect.stringMatching(/^scheduler:cron:daily-report:[a-f0-9]{8}$/),
      );
      expect(deps.sendProactiveMessage).toHaveBeenCalledWith(
        job.target,
        expect.stringContaining('timed out after 10ms'),
      );
      expect(deps.eventBus.publish).toHaveBeenCalledWith(
        'scheduler.job.complete',
        expect.objectContaining({ jobName: 'daily-report', success: false }),
      );
      expect(job.running).toBe(false);
    });
  });

  describe('executeJob — storeMessage', () => {
    it('stores user trigger and assistant response for prompt job', async () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job = createMockJob();

      await runner.executeJob(job);

      expect(deps.storeMessage).toHaveBeenCalledTimes(2);

      const calls = (deps.storeMessage as ReturnType<typeof vi.fn>).mock.calls;

      expect(calls[0][0]).toMatchObject({
        userId: 'user-123',
        platform: 'discord',
        role: 'user',
        content: '[Scheduled: daily-report]',
      });
      expect(calls[0][0].sessionId).toMatch(/^scheduler:cron:daily-report:[a-f0-9]{8}$/);

      expect(calls[1][0]).toMatchObject({
        userId: 'user-123',
        platform: 'discord',
        role: 'assistant',
        content: 'Here is your daily report.',
      });

      expect(calls[0][0].sessionId).toBe(calls[1][0].sessionId);
    });

    it('stores user trigger and result for skill job', async () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job: SkillJob = {
        ...createMockJob(),
        type: 'skill',
        payload: 'check-health',
      };

      await runner.executeJob(job);

      expect(deps.storeMessage).toHaveBeenCalledTimes(2);

      const calls = (deps.storeMessage as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0]).toMatchObject({ role: 'user', content: '[Scheduled: daily-report]' });
      expect(calls[1][0]).toMatchObject({ role: 'assistant', content: 'skill-result-text' });
      expect(calls[0][0].sessionId).toMatch(/^scheduler:cron:daily-report:[a-f0-9]{8}$/);
      expect(calls[0][0].sessionId).toBe(calls[1][0].sessionId);
    });

    it('does NOT call storeMessage on error', async () => {
      const errorEvent: AgentEvent = {
        type: 'error',
        error: 'boom',
        sessionId: 'test-session',
        userId: 'user-123',
        channelId: 'general',
        platform: 'discord',
      };
      const executeAgentRequest = vi.fn(async function* (): AsyncGenerator<AgentEvent> {
        yield errorEvent;
      });
      const deps = createMockDeps({ executeAgentRequest });
      const runner = new CronRunner(deps);
      const job = createMockJob();

      await runner.executeJob(job);

      expect(deps.storeMessage).not.toHaveBeenCalled();
    });

    it('does NOT throw if storeMessage rejects', async () => {
      const storeMessage = vi.fn(async () => { throw new Error('DB down'); });
      const deps = createMockDeps({ storeMessage });
      const runner = new CronRunner(deps);
      const job = createMockJob();

      await expect(runner.executeJob(job)).resolves.not.toThrow();
      expect(deps.sendProactiveMessage).toHaveBeenCalledWith(
        job.target,
        'Here is your daily report.',
      );
    });

    it('works correctly when storeMessage is not provided', async () => {
      const deps = createMockDeps({ storeMessage: undefined });
      const runner = new CronRunner(deps);
      const job = createMockJob();

      await expect(runner.executeJob(job)).resolves.not.toThrow();
      expect(deps.sendProactiveMessage).toHaveBeenCalledWith(
        job.target,
        'Here is your daily report.',
      );
    });
  });

  describe('executeJob — model passthrough', () => {
    it('passes job.model to AgentRequest when set', async () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job = createMockJob({ model: 'opus' });

      await runner.executeJob(job);

      const request: AgentRequest = (deps.executeAgentRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(request.model).toBe('opus');
    });

    it('falls back to defaultModel when job has no model', async () => {
      const deps = createMockDeps({ defaultModel: 'sonnet' });
      const runner = new CronRunner(deps);
      const job = createMockJob();

      await runner.executeJob(job);

      const request: AgentRequest = (deps.executeAgentRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(request.model).toBe('sonnet');
    });

    it('sets model to undefined when neither job nor defaultModel is set', async () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job = createMockJob();

      await runner.executeJob(job);

      const request: AgentRequest = (deps.executeAgentRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(request.model).toBeUndefined();
    });

    it('passes job reasoning effort and verbosity to AgentRequest when set', async () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job = createMockJob({
        reasoningEffort: 'high',
        verbosity: 'low',
      } as Partial<PromptJob>);

      await runner.executeJob(job);

      const request: AgentRequest = (deps.executeAgentRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(request.reasoningEffort).toBe('high');
      expect(request.verbosity).toBe('low');
    });

    it('falls back to scheduler defaults for reasoning effort and verbosity', async () => {
      const deps = createMockDeps({
        defaultReasoningEffort: 'minimal',
        defaultVerbosity: 'high',
      } as Partial<CronRunnerOptions>);
      const runner = new CronRunner(deps);
      const job = createMockJob();

      await runner.executeJob(job);

      const request: AgentRequest = (deps.executeAgentRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(request.reasoningEffort).toBe('minimal');
      expect(request.verbosity).toBe('high');
    });
  });

  describe('executeJob — memory context', () => {
    it('executePromptJob includes memoryContext from assembleContext', async () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job = createMockJob();

      await runner.executeJob(job);

      expect(deps.assembleContext).toHaveBeenCalledWith(
        job.user,
        expect.stringMatching(/^scheduler:cron:daily-report:[a-f0-9]{8}$/),
      );

      const request = (deps.executeAgentRequest as any).mock.calls[0][0];
      expect(request.memoryContext).toBe('Memory context for user');
    });
  });

  describe('registerJob — per-job timezone', () => {
    it('uses per-job timezone when set', async () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job = createMockJob({ timezone: 'America/Chicago' });
      runner.registerJob(job);

      expect(mockSchedule).toHaveBeenCalledWith(
        job.cron,
        expect.any(Function),
        { timezone: 'America/Chicago' },
      );
    });

    it('falls back to global timezone when job has no timezone', async () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job = createMockJob();
      runner.registerJob(job);

      expect(mockSchedule).toHaveBeenCalledWith(
        job.cron,
        expect.any(Function),
        { timezone: 'UTC' },
      );
    });
  });

  describe('executeJob — skill', () => {
    it('calls runSkill instead of executeAgentRequest', async () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job: SkillJob = {
        ...createMockJob(),
        type: 'skill',
        payload: 'check-health',
      };

      await runner.executeJob(job);

      expect(deps.runSkill).toHaveBeenCalledWith('check-health', {});
      expect(deps.executeAgentRequest).not.toHaveBeenCalled();
      expect(deps.sendProactiveMessage).toHaveBeenCalledWith(
        job.target,
        'skill-result-text',
      );
    });
  });

  describe('executeJob — events', () => {
    it('publishes scheduler.job.complete event on success', async () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job = createMockJob();

      await runner.executeJob(job);

      expect(deps.eventBus.publish).toHaveBeenCalledWith(
        'scheduler.job.complete',
        expect.objectContaining({
          jobName: 'daily-report',
          source: 'cron',
          success: true,
          target: job.target,
          timestamp: expect.any(Number),
        }),
      );
    });
  });

  describe('executeJob — overlap prevention', () => {
    it('skips execution if job.running is true', async () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job = createMockJob({ running: true });

      await runner.executeJob(job);

      expect(deps.executeAgentRequest).not.toHaveBeenCalled();
      expect(deps.sendProactiveMessage).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('sends error alert and publishes failure event on agent error', async () => {
      const errorEvent: AgentEvent = {
        type: 'error',
        error: 'Agent failed to process',
        sessionId: 'test-session',
        userId: 'user-123',
        channelId: 'general',
        platform: 'discord',
      };

      const executeAgentRequest = vi.fn(async function* (): AsyncGenerator<AgentEvent> {
        yield errorEvent;
      });

      const deps = createMockDeps({ executeAgentRequest });
      const runner = new CronRunner(deps);
      const job = createMockJob();

      await runner.executeJob(job);

      // Should send error alert to target
      expect(deps.sendProactiveMessage).toHaveBeenCalledWith(
        job.target,
        expect.stringContaining('Agent failed to process'),
      );

      // Should publish failure event
      expect(deps.eventBus.publish).toHaveBeenCalledWith(
        'scheduler.job.complete',
        expect.objectContaining({
          jobName: 'daily-report',
          source: 'cron',
          success: false,
          target: job.target,
          timestamp: expect.any(Number),
        }),
      );
    });
  });

  describe('stop', () => {
    it('calls stop() on all registered cron tasks', () => {
      const mockTask = { stop: vi.fn() };
      mockSchedule.mockReturnValue(mockTask);

      const deps = createMockDeps();
      const runner = new CronRunner(deps);

      runner.registerJob(createMockJob({ name: 'job-a' }));
      runner.registerJob(createMockJob({ name: 'job-b' }));

      runner.stop();

      expect(mockTask.stop).toHaveBeenCalledTimes(2);
    });
  });

  describe('internal jobs', () => {
    it('executes internal job callback', async () => {
      const callback = vi.fn(async () => {});
      const internalJobs = new Map([['cleanup', callback]]);

      const deps = createMockDeps();
      const runner = new CronRunner({ ...deps, internalJobs });

      const job: InternalJob = {
        name: 'cleanup',
        cron: '0 3 * * *',
        type: 'internal',
        enabled: true,
        nextRun: 0,
        running: false,
      };

      runner.registerJob(job);
      await runner.executeJob(job);

      expect(callback).toHaveBeenCalledOnce();
      expect(deps.eventBus.publish).toHaveBeenCalledWith(
        'scheduler.job.complete',
        expect.objectContaining({ jobName: 'cleanup', success: true }),
      );
    });

    it('logs error when internal job callback is not registered', async () => {
      const deps = createMockDeps();
      const runner = new CronRunner({ ...deps, internalJobs: new Map() });

      const job: InternalJob = {
        name: 'missing',
        cron: '0 3 * * *',
        type: 'internal',
        enabled: true,
        nextRun: 0,
        running: false,
      };

      runner.registerJob(job);
      await runner.executeJob(job);

      expect(deps.eventBus.publish).toHaveBeenCalledWith(
        'scheduler.job.complete',
        expect.objectContaining({ jobName: 'missing', success: false }),
      );
    });
  });
});
