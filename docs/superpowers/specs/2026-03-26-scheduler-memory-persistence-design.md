# Design: Scheduler Job Memory Persistence

**Date:** 2026-03-26
**Status:** Approved
**Author:** CCBuddy (Po)

---

## Problem

Scheduled jobs (morning/evening briefs, future cron jobs) are delivered to the user via Discord but never saved to the memory database. This means Po cannot recall what was sent in a previous brief, and future cron jobs with important output will also be unrecallable.

---

## Goals

- Store the output of every prompt-type and skill-type scheduled job in the memory database.
- Store both the trigger (as `role: 'user'`) and the response (as `role: 'assistant'`) to form a clean conversation pair.
- Make the feature opt-in via an optional callback so the scheduler package remains independently usable.

---

## Non-Goals

- Storing `internal` job output (memory consolidation, backup) — these are system operations with no user-facing content.
- Changing how briefs are delivered to Discord.
- Modifying the memory consolidation pipeline.

---

## Design

### Approach: Add `storeMessage` callback to `CronRunnerOptions`

Add an optional `storeMessage` callback to `CronRunnerOptions` (and by extension `SchedulerService`). Bootstrap passes its existing `messageStore.add` function. The `CronRunner` calls it after a job completes.

This is the minimal-change approach: no new events, no new infrastructure, no changes to the memory or gateway packages.

### Data Model

For each completed `prompt` or `skill` job, two messages are stored:

| Field | User message | Assistant message |
|---|---|---|
| `userId` | `job.user` | `job.user` |
| `sessionId` | `scheduler:cron:<jobName>:<timestamp>` | same |
| `platform` | `job.target.platform` | same |
| `role` | `'user'` | `'assistant'` |
| `content` | `[Scheduled: <jobName>]` | full response text |

The `sessionId` is the same one used for `assembleContext`, so memory consolidation and context retrieval naturally group these messages with their execution context.

### Files Changed

| File | Change |
|---|---|
| `packages/scheduler/src/cron-runner.ts` | Add optional `storeMessage` to `CronRunnerOptions`; call after prompt/skill job completes |
| `packages/scheduler/src/scheduler-service.ts` | Thread `storeMessage` through from `SchedulerServiceDeps` to `CronRunner` |
| `packages/scheduler/src/types.ts` | Add `storeMessage` to `SchedulerServiceDeps` if defined there |
| `packages/main/src/bootstrap.ts` | Pass `storeMessage: (p) => messageStore.add(p)` to `SchedulerService` |

### Interface Change

```typescript
// packages/scheduler/src/cron-runner.ts
export interface CronRunnerOptions {
  // ... existing fields ...
  storeMessage?: (params: {
    userId: string;
    sessionId: string;
    platform: string;
    content: string;
    role: 'user' | 'assistant';
  }) => void;
}
```

### Control Flow

```
executePromptJob / executeSkillJob
  → agent/skill runs
  → sendProactiveMessage(target, response)      // existing: delivers to Discord
  → storeMessage({ role: 'user',  content: '[Scheduled: <name>]', ... })  // NEW
  → storeMessage({ role: 'assistant', content: response, ... })            // NEW
  → publishComplete(job, true)
```

`storeMessage` is called only on success. On error, the error message is sent via `sendProactiveMessage` but not stored (error paths are typically noise, not recall-worthy content).

---

## Error Handling

- `storeMessage` is fire-and-forget — errors are caught and logged but do not affect job success/failure.
- If `storeMessage` is not provided (undefined), the code no-ops gracefully.

---

## Testing

- Update existing `cron-runner` unit tests to pass a mock `storeMessage` and assert it is called with the correct `user`/`assistant` pair after a successful job.
- Assert `storeMessage` is NOT called on error paths.
- No changes needed to integration or bootstrap tests.
