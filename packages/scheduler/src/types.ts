import type {
  MessageTarget,
  EventBus,
  AgentRequest,
  AgentEvent,
  CCBuddyConfig,
  ReasoningEffort,
  Verbosity,
} from '@ccbuddy/core';

export interface BaseJob {
  name: string;
  cron: string;
  enabled: boolean;
  nextRun: number;
  lastRun?: number;
  running: boolean;
  timezone?: string;
  /** Fire at startup if the job was missed within this many minutes */
  catchupWindowMinutes?: number;
  /** Abort prompt jobs after this many milliseconds. */
  timeoutMs?: number;
}

export interface PromptJob extends BaseJob {
  type: 'prompt';
  payload: string;
  user: string;
  target: MessageTarget;
  permissionLevel: 'admin' | 'system';
  model?: string;
  reasoningEffort?: ReasoningEffort;
  verbosity?: Verbosity;
  silent?: boolean;
}

export interface SkillJob extends BaseJob {
  type: 'skill';
  payload: string;
  user: string;
  target: MessageTarget;
  permissionLevel: 'admin' | 'system';
  model?: string;
  reasoningEffort?: ReasoningEffort;
  verbosity?: Verbosity;
  silent?: boolean;
}

export interface ShellJob extends BaseJob {
  type: 'shell';
  payload: string;
  user: string;
  target: MessageTarget;
  permissionLevel: 'admin' | 'system';
  workingDirectory?: string;
  silent?: boolean;
}

export interface InternalJob extends BaseJob {
  type: 'internal';
}

export type ScheduledJob = PromptJob | SkillJob | ShellJob | InternalJob;

export type SchedulerRunSource = 'cron' | 'catchup' | 'manual' | 'heartbeat' | 'webhook';

export interface TriggerResult {
  source: SchedulerRunSource;
  name: string;
  response: string;
  target: MessageTarget;
  timestamp: number;
}

export interface SchedulerJobStateStore {
  upsertJob(params: {
    jobName: string;
    type: ScheduledJob['type'];
    cron: string;
    timezone: string;
    enabled: boolean;
    targetPlatform?: string | null;
    targetChannel?: string | null;
    nextExpectedAt?: number | null;
    updatedAt?: number;
  }): void | Promise<void>;
  markStarted(params: {
    jobName: string;
    sessionId: string;
    startedAt?: number;
    nextExpectedAt?: number | null;
  }): void | Promise<void>;
  markCompleted(params: {
    jobName: string;
    sessionId: string;
    success: boolean;
    completedAt?: number;
    durationMs?: number | null;
    error?: string | null;
    nextExpectedAt?: number | null;
  }): void | Promise<void>;
  markSkipped(params: {
    jobName: string;
    reason: string;
    skippedAt?: number;
    nextExpectedAt?: number | null;
  }): void | Promise<void>;
  get?(jobName: string): {
    lastSuccessAt?: number | null;
    nextExpectedAt?: number | null;
  } | undefined | Promise<{
    lastSuccessAt?: number | null;
    nextExpectedAt?: number | null;
  } | undefined>;
}

export interface HealthCheckResult {
  name: string;
  status: 'healthy' | 'degraded' | 'down';
  message?: string;
  durationMs: number;
}

export interface SchedulerDeps {
  config: CCBuddyConfig;
  eventBus: EventBus;
  defaultModel?: string;
  defaultReasoningEffort?: ReasoningEffort;
  defaultVerbosity?: Verbosity;
  executeAgentRequest: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
  abortAgentRequest?: (sessionId: string) => Promise<void>;
  sendProactiveMessage: (target: MessageTarget, text: string) => Promise<void>;
  runSkill?: (name: string, input: Record<string, unknown>) => Promise<string>;
  checkDatabase: () => Promise<boolean>;
  checkAgent: () => Promise<{ reachable: boolean; durationMs: number }>;
  assembleContext: (userId: string, sessionId: string) => string;
  internalJobs?: Map<string, () => Promise<void>>;
  jobStateStore?: SchedulerJobStateStore;
  storeMessage?: (params: {
    userId: string;
    sessionId: string;
    platform: string;
    content: string;
    role: 'user' | 'assistant';
  }) => void | Promise<void>;
}

export type { MessageTarget };
