export interface MessageTarget {
  platform: string;
  channel: string;
}

export interface Disposable {
  dispose(): void;
}

export interface IncomingMessageEvent {
  userId: string;
  sessionId: string;
  channelId: string;
  platform: string;
  text: string;
  attachments: import('./agent.js').Attachment[];
  isMention: boolean;
  replyToMessageId?: string;
  timestamp: number;
}

export interface OutgoingMessageEvent {
  userId: string;
  sessionId: string;
  channelId: string;
  platform: string;
  text: string;
  attachments?: import('./agent.js').Attachment[];
}

export interface SessionConflictEvent {
  userId: string;
  sessionId: string;
  channelId: string;
  platform: string;
  workingDirectory: string;
  conflictingPid?: number;
  conflictingSessionId?: string;
}

export interface HealthAlertEvent {
  module: string;
  status: 'degraded' | 'down' | 'recovered';
  message: string;
  timestamp: number;
}

export interface HeartbeatStatusEvent {
  modules: Record<string, 'healthy' | 'degraded' | 'down'>;
  system: {
    cpuPercent: number;
    memoryPercent: number;
    diskPercent: number;
  };
  timestamp: number;
}

export interface WebhookEvent {
  handler: string;
  userId: string;
  payload: unknown;
  promptTemplate: string;
  timestamp: number;
}

export interface AgentProgressEvent {
  userId: string;
  sessionId: string;
  channelId: string;
  platform: string;
  type: 'text' | 'tool_use' | 'thinking' | 'tool_result';
  content: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
}

export interface SchedulerJobCompleteEvent {
  jobName: string;
  source: 'cron' | 'catchup' | 'manual' | 'heartbeat' | 'webhook';
  success: boolean;
  target: MessageTarget;
  timestamp: number;
}

export interface ConsolidationStats {
  userId: string;
  messagesChunked: number;
  leafNodesCreated: number;
  condensedNodesCreated: number;
  messagesPruned: number;
}

export interface BackupCompleteEvent {
  path: string;
}

export interface BackupIntegrityFailedEvent {
  path: string;
  error: string;
}

export interface SessionModelChangedEvent {
  sessionId: string;
  userId: string;
  platform: string;
  channelId: string;
  previousModel: string;
  newModel: string;
}

export interface AgentErrorEvent {
  userId: string;
  platform: string;
  channelId: string;
  error: string;
  timestamp: number;
}

export interface SessionStartedEvent {
  userId: string;
  platform: string;
  channelId: string;
  sessionKey: string;
  timestamp: number;
}

export interface EventMap {
  'message.incoming': IncomingMessageEvent;
  'message.outgoing': OutgoingMessageEvent;
  'session.conflict': SessionConflictEvent;
  'alert.health': HealthAlertEvent;
  'heartbeat.status': HeartbeatStatusEvent;
  'webhook.received': WebhookEvent;
  'agent.progress': AgentProgressEvent;
  'scheduler.job.complete': SchedulerJobCompleteEvent;
  'consolidation.complete': ConsolidationStats;
  'backup.complete': BackupCompleteEvent;
  'backup.integrity_failed': BackupIntegrityFailedEvent;
  'session.model_changed': SessionModelChangedEvent;
  'agent.error': AgentErrorEvent;
  'session.started': SessionStartedEvent;
}

export interface EventBus {
  publish<K extends keyof EventMap>(event: K, payload: EventMap[K]): Promise<void>;
  subscribe<K extends keyof EventMap>(
    event: K,
    handler: (payload: EventMap[K]) => void,
  ): Disposable;
}
