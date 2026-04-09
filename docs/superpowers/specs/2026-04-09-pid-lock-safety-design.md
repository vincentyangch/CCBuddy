# PID Lock Safety Design

**Date:** 2026-04-09
**Status:** Draft
**Author:** flyingchickens + Codex

## 1. Overview

CCBuddy currently uses a PID lock file to ensure only one process instance owns the runtime at a time. On startup, if a lock file exists and the recorded PID is still alive, bootstrap assumes that process is a stale CCBuddy instance and kills it.

That assumption is unsafe. PIDs are reusable, so a lock file that only stores a numeric PID can point to an unrelated process that later inherited the same PID. The current startup path can therefore send `SIGTERM` and `SIGKILL` to the wrong process.

This design keeps the existing lock-file model, but makes it safe by storing structured metadata and validating the live process identity before sending any signals.

## 2. Goals

1. Prevent CCBuddy from killing unrelated processes due to PID reuse.
2. Preserve the existing operational model where a new CCBuddy instance can replace an older matching CCBuddy instance.
3. Ensure bootstrap failure does not leave a stale lock behind.
4. Keep the lock file implementation simple and local to bootstrap.
5. Make lock behavior unit-testable without depending on real system processes.

## 3. Non-Goals

1. This design does not replace the lock file with a database-backed coordinator.
2. This design does not introduce distributed locking or multi-host coordination.
3. This design does not redesign process supervision outside bootstrap.
4. This design does not change user-facing CLI or dashboard behavior.

## 4. Current Problem

Today `packages/main/src/bootstrap.ts`:

1. reads `data/ccbuddy.pid`
2. parses a raw PID
3. checks whether that PID is alive
4. kills it if it is
5. writes the current PID into the same lock path

That creates two concrete issues:

1. **Wrong-process risk**
   If the recorded PID was recycled by the OS, bootstrap can kill an unrelated process.

2. **Stale-lock risk on bootstrap failure**
   If bootstrap throws after acquiring the lock, the catch path does not release it, so startup can leave behind a stale lock file.

The current lock file has too little identity data to safely distinguish:

- the old CCBuddy process we mean to replace
- a different process that happens to own the same PID now

## 5. Chosen Approach

Keep the lock file, but store structured metadata and validate the live process start time before killing anything.

The lock file will become a small JSON document rather than a raw PID string.

Example:

```json
{
  "pid": 12345,
  "startedAtMs": 1760000000000,
  "createdAt": "2026-04-09T18:00:00.000Z",
  "instanceId": "d8d9479c-3d5c-4f7c-a2f7-9a12ec0a0e63"
}
```

Startup will only send signals if:

1. the lock file parses successfully
2. the recorded PID is alive
3. the live process start time matches `startedAtMs`

If the PID is alive but the start time does not match, bootstrap must fail closed and refuse to kill it.

## 6. Lock File Contract

### 6.1 Lock Path

The canonical lock file remains:

```text
<config.data_dir>/ccbuddy.pid
```

The filename stays the same to avoid changing operator expectations.

### 6.2 Lock File Format

The lock file should contain:

1. `pid`
   numeric process ID
2. `startedAtMs`
   process start time expressed as milliseconds since epoch
3. `createdAt`
   ISO timestamp for diagnostics
4. `instanceId`
   unique identifier for logging and debugging

Minimum required fields for lock ownership decisions:

1. `pid`
2. `startedAtMs`

If required ownership fields are missing or invalid, the file must not authorize killing a live process.

## 7. Process Identity Validation

### 7.1 Why Start Time

PID reuse is the core failure mode. Process start time closes that gap because:

1. a recycled PID will have a different start time
2. start time is stable for the lifetime of a process
3. it is much less ambiguous than matching only command line text

### 7.2 Validation Rule

Given an existing lock:

1. read the lock metadata
2. check whether `pid` is alive
3. if not alive, treat the lock as stale
4. if alive, query the live process start time
5. compare live start time to `startedAtMs`

Outcomes:

1. **match**
   This is the same process that created the lock; bootstrap may terminate it
2. **mismatch**
   Refuse to kill and abort startup with a clear error
3. **cannot determine start time**
   Fail closed and abort startup rather than guessing

## 8. Startup Flow

### 8.1 No Existing Lock

If no lock exists:

1. gather current process metadata
2. write the lock via temp file + rename
3. continue bootstrap

### 8.2 Existing Stale Lock

If the lock exists but the recorded PID is dead:

1. treat the lock as stale
2. overwrite it with current process metadata
3. continue bootstrap

### 8.3 Existing Matching Live Lock

If the lock exists, the PID is alive, and the start time matches:

1. log that bootstrap is replacing an older matching CCBuddy process
2. send `SIGTERM`
3. wait for graceful exit up to the current timeout window
4. if still alive, send `SIGKILL`
5. replace the lock with the current process metadata

### 8.4 Existing Mismatched Live Lock

If the lock exists, the PID is alive, and the start time does not match:

1. do not send `SIGTERM`
2. do not send `SIGKILL`
3. abort startup with a clear error explaining why

Example failure text:

```text
Refusing to kill PID 12345 because lock metadata does not match the live process.
```

## 9. Cleanup Rules

### 9.1 Normal Shutdown

`bootstrap().stop()` should release the lock only if:

1. the lock file still parses
2. it still points to the current process metadata

This avoids deleting a newer instance’s lock.

### 9.2 Bootstrap Failure

If bootstrap throws after acquiring the lock:

1. clear any created intervals as today
2. release the lock before rethrowing

This fixes the stale-lock leak in the current catch path.

### 9.3 Malformed Lock During Cleanup

If the lock file is malformed during cleanup:

1. do not unlink blindly
2. log or ignore safely
3. leave the file in place rather than risking deletion of another instance’s lock

## 10. Atomicity and File Writes

The current temp-write + rename pattern is correct and should remain.

Write flow:

1. write metadata JSON to a temp path
2. rename over the canonical lock path

This preserves atomic replacement and avoids half-written locks.

## 11. Failure Behavior

### 11.1 Malformed Existing Lock

If the existing lock file cannot be parsed:

1. do not treat it as authorization to kill a live process
2. fail closed if the PID appears alive and identity cannot be proven
3. if the file is plainly unusable and no live process can be confirmed, overwrite it as stale

### 11.2 Live Process With Mismatched Metadata

If PID is alive but metadata does not match:

1. startup must fail
2. no signals are sent
3. the error must explain that the process could not be safely identified as the old CCBuddy instance

### 11.3 Start Time Lookup Failure

If bootstrap cannot obtain the live process start time for an alive PID:

1. startup must fail closed
2. bootstrap must not guess based only on PID

## 12. Component Changes

### 12.1 Bootstrap

`packages/main/src/bootstrap.ts` will need:

1. a structured lock metadata type
2. lock file read/write helpers
3. a small process-inspection helper that returns the live start time for a PID
4. a signal helper for graceful termination polling
5. catch-path cleanup that releases the lock on bootstrap failure

### 12.2 Test Seams

To keep the behavior testable, bootstrap should isolate:

1. reading lock metadata
2. writing lock metadata
3. reading live process start time
4. sending signals
5. waiting/polling

These do not need to become public APIs. They only need to be factored enough that unit tests can mock them.

## 13. Testing

Add targeted bootstrap tests covering:

### 13.1 Dead PID Lock

Verify:

1. stale dead-PID lock is replaced
2. startup succeeds

### 13.2 Matching Live Process

Verify:

1. startup sends `SIGTERM`
2. waits for graceful exit
3. escalates to `SIGKILL` only if still alive

### 13.3 Mismatched Live Process

Verify:

1. startup throws
2. no `SIGTERM` or `SIGKILL` is sent

### 13.4 Bootstrap Failure After Lock Acquisition

Verify:

1. failure path releases the lock
2. stale lock is not left behind

## 14. Migration

No explicit migration step is required.

Behavior for an old raw-PID lock file:

1. it is treated as legacy / incomplete metadata
2. it must not authorize killing a live process
3. once bootstrap acquires a new lock successfully, the file is rewritten in the new JSON format

## 15. Recommendation

Implement the structured lock-file design with start-time validation rather than command-line fingerprint matching or a larger lock-system rewrite.

Reasoning:

1. it directly fixes PID reuse risk
2. it preserves current operator behavior
3. it is small enough to implement and test locally
4. it also fixes the stale-lock cleanup gap in the same change
