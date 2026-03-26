# Design: Scheduler Job Memory Persistence

**Date:** 2026-03-26
**Status:** Pending user review
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

Add an optional `storeMessage` callback to `CronRunnerOptions` and to `SchedulerDeps` (the existing type in `packages/scheduler/src/types.ts`). Bootstrap passes its existing `messageStore.add` function. The `CronRunner` calls it after a job completes successfully.

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

**Session ID note:** Each job execution generates a fresh `sessionId` via `scheduler:cron:<jobName>:<Date.now()>`. Each run is isolated in its own session — there is no cross-run grouping. This is intentional; memory consolidation treats each scheduled run as an independent session.

**Platform note:** `platform` is taken directly from `job.target.platform` (e.g. `'discord'`). Misconfigured jobs with non-standard platform values (e.g. `'system'`) will store messages with that platform string; this is harmless since storage is platform-agnostic.

### Skill Job Session ID

`executeSkillJob` does not currently generate a `sessionId`. For consistency, it must generate one the same way as `executePromptJob`:

```typescript
const sessionId = `scheduler:cron:${job.name}:${Date.now()}`;
```

This is created locally before calling `runSkill`, and used only for the two `storeMessage` calls.

### Files Changed

| File | Change |
|---|---|
| `packages/scheduler/src/cron-runner.ts` | Add optional `storeMessage` to `CronRunnerOptions`; call after prompt/skill job completes |
| `packages/scheduler/src/scheduler-service.ts` | Thread `storeMessage` through from `SchedulerDeps` to `CronRunner` |
| `packages/scheduler/src/types.ts` | Add optional `storeMessage` to `SchedulerDeps` |
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
  }) => void | Promise<void>;
}
```

The callback signature accepts both sync and async implementations. It intentionally omits the `attachments` field present in the gateway's `storeMessage` closure — scheduled job output never has attachments. The runner calls it with `await` inside a `try/catch` to safely handle both:

```typescript
if (this.opts.storeMessage) {
  try {
    await this.opts.storeMessage({ ... });
  } catch (err) {
    console.warn('[Scheduler] storeMessage failed:', err);
  }
}
```

Errors in `storeMessage` are logged but do not affect job success or delivery.

### Control Flow

**`executePromptJob`** (on `event.type === 'complete'` only):
```
sendProactiveMessage(target, event.response)
storeMessage({ role: 'user',      content: '[Scheduled: <name>]', ... })
storeMessage({ role: 'assistant', content: event.response, ... })
publishComplete(job, true)
```

If the generator ends without emitting `complete` or `error` (truncated stream), neither `storeMessage` nor `publishComplete` is called — this is a pre-existing gap, not introduced by this change.

**`executeSkillJob`** (on success):
```
const sessionId = `scheduler:cron:${job.name}:${Date.now()}`
result = await runSkill(...)
sendProactiveMessage(target, result)
storeMessage({ role: 'user',      content: '[Scheduled: <name>]', sessionId, ... })
storeMessage({ role: 'assistant', content: result, sessionId, ... })
publishComplete(job, true)
```

`storeMessage` is **not** called on error paths.

---

## Error Handling

- `storeMessage` is called with `await` inside a `try/catch`. Errors are logged as warnings and do not affect job delivery or the `success` flag.
- If `storeMessage` is not provided (undefined), the code no-ops gracefully.

---

## Testing

### `cron-runner` unit tests
- Pass a mock `storeMessage` spy to `CronRunnerOptions`.
- After a successful prompt job: assert spy called twice — once with `role: 'user'` and `content: '[Scheduled: <name>]'`, once with `role: 'assistant'` and the response text. Both calls must share the same `sessionId`.
- After a successful skill job: assert the same two-call pattern with a generated `sessionId`.
- After a failed job (error event): assert `storeMessage` is NOT called.
- Assert `storeMessage` errors are caught and do not throw from `executeJob`.

### `scheduler-service` unit tests
- Assert that `SchedulerDeps.storeMessage` is threaded through to `CronRunner` constructor.
- Verify that omitting `storeMessage` from `SchedulerDeps` does not throw (optional field).
