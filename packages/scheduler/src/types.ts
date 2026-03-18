import type {
  MessageTarget,
  EventBus,
  AgentRequest,
  AgentEvent,
  CCBuddyConfig,
} from '@ccbuddy/core';

export interface ScheduledJob {
  name: string;
  cron: string;
  type: 'prompt' | 'skill';
  payload: string;
  user: string;
  target: MessageTarget;
  permissionLevel: 'admin' | 'system';
  enabled: boolean;
  nextRun: number;
  lastRun?: number;
  running: boolean;
}

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
  executeAgentRequest: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
  sendProactiveMessage: (target: MessageTarget, text: string) => Promise<void>;
  runSkill?: (name: string, input: Record<string, unknown>) => Promise<string>;
  checkDatabase: () => Promise<boolean>;
  checkAgent: () => Promise<{ reachable: boolean; durationMs: number }>;
}

export type { MessageTarget };
