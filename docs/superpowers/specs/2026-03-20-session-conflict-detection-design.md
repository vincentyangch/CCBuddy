# Session Conflict Detection Design

## Overview

Prevent concurrent agent sessions from writing to the same working directory simultaneously. When a second request targets a directory already in use by another session, it's queued automatically and the user is notified. Scheduled jobs (briefings, consolidation) bypass conflict detection since they don't use working directories.

## Conflict Detection Logic

Detection happens in `AgentService.handleRequest()`, **before** the existing concurrency check.

### DirectoryLock

New class in `packages/agent/src/session/directory-lock.ts`:

```typescript
class DirectoryLock {
  private locks: Map<string, { sessionId: string; userId: string }>;

  acquire(dir: string, sessionId: string, userId: string): { acquired: boolean; heldBy?: { sessionId: string; userId: string } }
  release(dir: string, sessionId: string): void
  isLocked(dir: string, excludeSessionId?: string): boolean
}
```

- Paths normalized via `path.resolve()` for consistent comparison
- Parent/child conflict detection: check `normalizedA === normalizedB` or `normalizedA.startsWith(normalizedB + path.sep)` or `normalizedB.startsWith(normalizedA + path.sep)` — prevents `/projects` from falsely conflicting with `/project`
- Same session re-acquiring the same directory succeeds (idempotent — it's the same conversation continuing)
- Release by wrong session ID is a no-op (safety guard)

### Request Flow

Order of checks: **directory lock → concurrency queue → backend execution**.

1. Request arrives at `AgentService.handleRequest()`
2. If `request.workingDirectory` is set:
   a. Try `directoryLock.acquire(workingDir, sessionId, userId)`
   b. If acquired: proceed to concurrency check and backend execution. Release lock in `finally` block after execution completes.
   c. If not acquired: publish `session.conflict` event, suspend the caller via a promise-based queue (see Wait Queue). When the promise resolves (lock released), re-enter the normal flow from the concurrency check onward.
3. If `request.workingDirectory` is not set (scheduled jobs, system tasks): skip lock, proceed directly to concurrency check.

**Key:** The directory lock is acquired before the concurrency queue. This prevents holding a directory lock while a request sits idle in the concurrency queue. When a directory-queued request is unblocked, it enters the concurrency check normally.

### Wait Queue

Promise-based queue mirroring the existing `PriorityQueue` pattern in AgentService. Each queued entry is a `{ request, resolve, reject }` tuple:

```typescript
interface DirectoryQueueEntry {
  request: AgentRequest;
  resolve: () => void;
  reject: (err: Error) => void;
}
```

`Map<string, DirectoryQueueEntry[]>` keyed by normalized directory path. FIFO order.

When a caller hits a directory conflict, `handleRequest()` creates a Promise and awaits it. The caller's async generator suspends — it does not return. When the lock is released, the next entry's `resolve()` is called, the generator resumes, and events flow back through the same pipeline.

**Timeout:** Same `queueTimeoutSeconds` as the existing concurrency queue. On timeout, reject the promise and notify the user that the directory is still busy.

### Notification

On conflict detection, publish `session.conflict` event via EventBus:

```typescript
eventBus.publish('session.conflict', {
  userId: request.userId,
  sessionId: request.sessionId,
  channelId: request.channelId,
  platform: request.platform,
  workingDirectory: request.workingDirectory,
  conflictingPid: 0,
});
```

**Gateway subscription:** Wire in `Gateway` constructor. Subscribe to `session.conflict`, resolve the platform adapter from the event's `platform` field via `this.adapters`, send notification to the user's channel. Log the conflict event.

### SessionConflictEvent type update

Make `conflictingPid` optional since we track session-level conflicts, not PIDs:

```typescript
export interface SessionConflictEvent {
  userId: string;
  sessionId: string;
  channelId: string;
  platform: string;
  workingDirectory: string;
  conflictingPid?: number;
  conflictingSessionId?: string;
}
```

## What Does NOT Conflict

- Requests without `workingDirectory` (scheduled jobs, briefings, consolidation, backup)
- Same session ID re-using the same directory (continuation of same conversation)
- Different directories (each user/channel gets its own lock)

## Testing Strategy

### DirectoryLock (unit)
- Acquire/release basic flow
- Same session re-acquires same directory (idempotent)
- Different session blocked on same directory
- Parent/child path conflicts detected (`/project` vs `/project/src`)
- `/projects` does NOT conflict with `/project` (path separator guard)
- Release unblocks subsequent acquire
- Release by wrong session ID is a no-op

### AgentService integration (unit)
- Request with working dir acquires lock, releases on completion
- Second request to same dir is queued (promise suspends), not rejected
- Queued request executes after first completes (promise resolves)
- Request without working dir skips lock entirely
- `session.conflict` event published when queued
- Error in first request still releases lock (finally block)
- Timeout on directory queue rejects with error

### Gateway (unit)
- Subscribes to `session.conflict` event in constructor
- Sends notification message to correct platform/channel
- Logs conflict event
