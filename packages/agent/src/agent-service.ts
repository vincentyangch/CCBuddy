import { resolve as resolvePath } from 'node:path';
import type { AgentBackend, AgentRequest, AgentEvent, AgentEventBase, EventBus } from '@ccbuddy/core';
import { RateLimiter } from './session/rate-limiter.js';
import { PriorityQueue } from './session/priority-queue.js';
import { SessionManager } from './session/session-manager.js';
import type { Session } from './session/session-manager.js';
import type { QueuePriority } from './session/priority-queue.js';
import { DirectoryLock } from './session/directory-lock.js';

const REQUIRED_RATE_LIMIT_ROLES = ['admin', 'trusted', 'chat', 'system'] as const;

function validateRateLimits(rateLimits: Record<string, number>): void {
  const missingRoles = REQUIRED_RATE_LIMIT_ROLES.filter((role) => rateLimits[role] === undefined);
  if (missingRoles.length > 0) {
    throw new Error(`Missing rate limits for required roles: ${missingRoles.join(', ')}`);
  }
}

export interface AgentServiceOptions {
  backend: AgentBackend;
  eventBus?: EventBus;
  maxConcurrent: number;
  rateLimits: Record<string, number>;
  queueMaxDepth: number;
  queueTimeoutSeconds: number;
  sessionTimeoutMinutes: number;
  sessionCleanupHours: number;
  sessionStore?: import('./session/session-store.js').SessionStore;
}

interface QueuedRequest {
  request: AgentRequest;
  resolve: (value: void) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AgentService {
  private backend: AgentBackend;
  private readonly eventBus?: EventBus;
  private readonly rateLimiter: RateLimiter;
  private readonly queue: PriorityQueue<QueuedRequest>;
  private readonly sessionManager: SessionManager;
  private readonly maxConcurrent: number;
  private readonly queueTimeoutSeconds: number;
  private activeConcurrent = 0;
  private readonly sessionStore?: import('./session/session-store.js').SessionStore;
  private readonly directoryLock = new DirectoryLock();
  /** Track which directory each session holds a lock on, so abort() can release it. */
  private readonly sessionDirectories = new Map<string, string>();
  private readonly directoryQueue = new Map<string, Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>>();

  constructor(options: AgentServiceOptions) {
    validateRateLimits(options.rateLimits);
    this.backend = options.backend;
    this.eventBus = options.eventBus;
    this.maxConcurrent = options.maxConcurrent;
    this.queueTimeoutSeconds = options.queueTimeoutSeconds;
    this.rateLimiter = new RateLimiter(options.rateLimits);
    this.queue = new PriorityQueue<QueuedRequest>(options.queueMaxDepth);
    this.sessionManager = new SessionManager({
      timeoutMinutes: options.sessionTimeoutMinutes,
      cleanupHours: options.sessionCleanupHours,
    });
    this.sessionStore = options.sessionStore;
  }

  setBackend(backend: AgentBackend): void {
    this.backend.destroy?.();
    this.backend = backend;
  }

  async *handleRequest(request: AgentRequest): AsyncGenerator<AgentEvent> {
    const base: AgentEventBase = {
      sessionId: request.sessionId,
      userId: request.userId,
      channelId: request.channelId,
      platform: request.platform,
    };

    // Check rate limit
    if (!this.rateLimiter.tryAcquire(request.userId, request.permissionLevel)) {
      yield { ...base, type: 'error', error: 'rate limit exceeded' };
      return;
    }

    let hasExecutionSlot = false;
    let hasDirectoryLock = false;
    try {
      // Check concurrency before taking a directory lock. A request waiting for a
      // global slot should not make its workspace look busy.
      hasExecutionSlot = await this.acquireExecutionSlot(request);
      if (!hasExecutionSlot) {
        yield { ...base, type: 'error', error: 'server busy' };
        return;
      }

      // Directory lock — wait if another request is using the same or nested directory.
      if (request.workingDirectory) {
        const lockResult = this.directoryLock.acquire(
          request.workingDirectory, request.sessionId, request.userId,
        );
        if (!lockResult.acquired) {
          const lockAgeMs = lockResult.heldBy?.acquiredAt
            ? Date.now() - lockResult.heldBy.acquiredAt
            : undefined;
          console.warn('[AgentService] Directory busy; queueing request', {
            sessionId: request.sessionId,
            workingDirectory: request.workingDirectory,
            conflictingSessionId: lockResult.heldBy?.sessionId,
            conflictingUserId: lockResult.heldBy?.userId,
            lockAgeMs,
          });

          if (this.eventBus) {
            void this.eventBus.publish('session.conflict', {
              userId: request.userId,
              sessionId: request.sessionId,
              channelId: request.channelId,
              platform: request.platform,
              workingDirectory: request.workingDirectory,
              conflictingSessionId: lockResult.heldBy?.sessionId,
              conflictingUserId: lockResult.heldBy?.userId,
              lockAgeMs,
            });
          }

          const acquired = await this.waitForDirectoryLock(request);
          if (!acquired) {
            yield { ...base, type: 'error', error: 'directory busy — request timed out' };
            return;
          }
        }
        hasDirectoryLock = true;
        this.sessionDirectories.set(request.sessionId, request.workingDirectory);
      }

      // Track session
      this.sessionManager.getOrCreate(request.sessionId);

      // Execute backend and yield events
      for await (const event of this.backend.execute(request)) {
        // Publish progress events to the event bus
        if (this.eventBus !== undefined) {
          if (event.type === 'text' || event.type === 'tool_use' || event.type === 'thinking') {
            void this.eventBus.publish('agent.progress', {
              userId: event.userId,
              sessionId: event.sessionId,
              channelId: event.channelId,
              platform: event.platform,
              type: event.type,
              content: event.type === 'tool_use' ? event.tool : event.content,
            });
          } else if (event.type === 'tool_result') {
            void this.eventBus.publish('agent.progress', {
              userId: event.userId,
              sessionId: event.sessionId,
              channelId: event.channelId,
              platform: event.platform,
              type: 'tool_result',
              content: event.tool,
              toolInput: event.toolInput,
              toolOutput: event.toolOutput,
            });
          }
        }
        yield event;
      }
    } finally {
      // Release directory lock and drain directory queue
      if (hasDirectoryLock && request.workingDirectory) {
        this.directoryLock.release(request.workingDirectory, request.sessionId);
        this.sessionDirectories.delete(request.sessionId);
        this.drainDirectoryQueues();
      }
      if (hasExecutionSlot) {
        this.activeConcurrent -= 1;
        this.drainQueue();
      }
    }
  }

  private async acquireExecutionSlot(request: AgentRequest): Promise<boolean> {
    if (this.activeConcurrent < this.maxConcurrent) {
      this.activeConcurrent += 1;
      return true;
    }

    return this.tryEnqueue(request);
  }

  private tryEnqueue(request: AgentRequest): Promise<boolean> {
    return new Promise<boolean>((outerResolve) => {
      // Placeholder so TypeScript accepts the forward reference
      const queued = {} as QueuedRequest;

      queued.request = request;
      queued.resolve = () => {
        clearTimeout(queued.timer);
        outerResolve(true);
      };
      queued.reject = () => outerResolve(false);

      const priority = request.permissionLevel as QueuePriority;
      const enqueued = this.queue.enqueue(queued, priority);
      if (!enqueued) {
        outerResolve(false);
        return;
      }

      // Set a timeout to remove from queue if not processed in time
      queued.timer = setTimeout(() => {
        // Remove this specific item from the queue so it doesn't linger
        this.queue.remove(queued);
        queued.reject(new Error('queue timeout'));
      }, this.queueTimeoutSeconds * 1000);
    });
  }

  private waitForDirectoryLock(request: AgentRequest): Promise<boolean> {
    return new Promise<boolean>((promiseResolve) => {
      const dir = resolvePath(request.workingDirectory!);
      const entry = {
        resolve: () => {
          clearTimeout(entry.timer);
          const result = this.directoryLock.acquire(dir, request.sessionId, request.userId);
          promiseResolve(result.acquired);
        },
        reject: () => promiseResolve(false),
        timer: setTimeout(() => {
          const queue = this.directoryQueue.get(dir);
          if (queue) {
            const idx = queue.indexOf(entry);
            if (idx !== -1) queue.splice(idx, 1);
            if (queue.length === 0) this.directoryQueue.delete(dir);
          }
          promiseResolve(false);
        }, this.queueTimeoutSeconds * 1000),
      };

      if (!this.directoryQueue.has(dir)) {
        this.directoryQueue.set(dir, []);
      }
      this.directoryQueue.get(dir)!.push(entry);
    });
  }

  private drainDirectoryQueues(): void {
    for (const [dir, queue] of Array.from(this.directoryQueue.entries())) {
      if (queue.length === 0) {
        this.directoryQueue.delete(dir);
        continue;
      }
      if (this.directoryLock.isLocked(dir)) continue;

      const next = queue.shift()!;
      if (queue.length === 0) this.directoryQueue.delete(dir);

      clearTimeout(next.timer);
      next.resolve();
    }
  }

  private drainQueue(): void {
    while (this.activeConcurrent < this.maxConcurrent) {
      const next = this.queue.dequeue();
      if (next === undefined) break;
      clearTimeout(next.timer);
      this.activeConcurrent += 1;
      next.resolve();
    }
  }

  async abort(sessionId: string): Promise<void> {
    await this.backend.abort(sessionId);
    this.sessionManager.remove(sessionId);
    // Release directory lock so subsequent requests aren't permanently blocked
    const dir = this.sessionDirectories.get(sessionId);
    if (dir) {
      this.directoryLock.release(dir, sessionId);
      this.sessionDirectories.delete(sessionId);
      this.drainDirectoryQueues();
    }
  }

  tick(): void {
    this.sessionManager.tick();
    this.rateLimiter.cleanup();
  }

  getActiveSessions(): Session[] {
    return this.sessionManager.getActiveSessions();
  }

  getSessionInfo(): import('./session/session-store.js').SessionInfo[] {
    return this.sessionStore?.getAll() ?? [];
  }

  get queueSize(): number {
    return this.queue.size;
  }
}
