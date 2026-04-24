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

export interface InternalJob extends BaseJob {
  type: 'internal';
}

export type ScheduledJob = PromptJob | SkillJob | InternalJob;

export interface TriggerResult {
  source: 'cron' | 'heartbeat' | 'webhook';
  name: string;
  response: string;
  target: MessageTarget;
  timestamp: number;
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
  storeMessage?: (params: {
    userId: string;
    sessionId: string;
    platform: string;
    content: string;
    role: 'user' | 'assistant';
  }) => void | Promise<void>;
}

export type { MessageTarget };
