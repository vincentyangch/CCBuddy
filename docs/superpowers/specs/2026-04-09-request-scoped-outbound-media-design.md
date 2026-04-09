# Request-Scoped Outbound Media Design

**Date:** 2026-04-09
**Status:** Draft
**Author:** flyingchickens + Codex

## 1. Overview

CCBuddy currently routes outbound media through a shared filesystem queue under the configured outbound media root. The gateway snapshots that shared directory before a request runs and later delivers every file that appears after execution. This is not request-scoped, so concurrent requests can deliver files to the wrong channel.

This design replaces the shared outbound queue model with request-scoped outbound directories. Each request gets its own outbound directory, that directory is passed into the skills runtime explicitly, and gateway delivers media only from that directory.

## 2. Goals

1. Prevent one request from delivering another request's outbound files.
2. Remove reliance on shared-directory snapshots and filename diffing.
3. Keep the `send_file` MCP tool contract unchanged for skills and users.
4. Make outbound file ownership structural and easy to reason about.
5. Eliminate cwd-derived outbound paths for request-generated media.

## 3. Non-Goals

1. This design does not replace filesystem-based outbound delivery with direct in-memory media streaming.
2. This design does not change the user-facing `send_file` tool schema.
3. This design does not redesign platform adapter media APIs.
4. This design does not add a general-purpose persistent retry queue for failed media delivery.

## 4. Current Problem

Today the gateway and skills runtime disagree on how outbound media is owned and where it lives:

1. Gateway snapshots one shared outbound directory before request execution.
2. Skills write files into a shared outbound directory.
3. Gateway later delivers all "new" files from that shared directory.

That causes two concrete issues:

1. Concurrent requests can observe and deliver each other's files.
2. Some skills derive the outbound path from `process.cwd()` instead of the configured data directory, so delivery depends on subprocess cwd and can silently write to the wrong location.

This is a boundary problem. Media ownership is currently inferred from timing and shared state instead of being attached explicitly to the request that created it.

## 5. Chosen Approach

Use request-scoped outbound directories under the configured outbound media root.

Example layout:

```text
<configured-outbound-root>/
  <request-id-1>/
    image-a.png
  <request-id-2>/
    report.pdf
```

Each request gets a unique outbound directory. The gateway creates it before execution, passes it into the runtime, and delivers only from that directory after execution.

## 6. Directory Contract

### 6.1 Outbound Root

The configured outbound root remains:

```text
<config.data_dir>/outbound
```

This is still the top-level media area managed by the application.

### 6.2 Request Directory

For each request, gateway allocates a unique child directory beneath the outbound root.

Requirements:

1. The directory name must be unique per request.
2. It must be stable for the lifetime of that request.
3. It does not need to be human-friendly.

An implementation may derive the directory name from session id plus a nonce, or use a generated request UUID.

## 7. Runtime Contract

Gateway and runtime components will use an internal environment contract:

```text
CCBUDDY_OUTBOUND_DIR=<absolute request-scoped outbound directory>
```

Rules:

1. `CCBUDDY_OUTBOUND_DIR` is required for outbound file delivery through the skills runtime.
2. Skills that produce outbound files must write only into that directory.
3. Code must not fall back to `process.cwd()/data/outbound`.
4. The runtime contract is internal only; no MCP schema changes are required.

## 8. Data Flow

### 8.1 Request Execution

For each incoming request:

1. Gateway creates the request-scoped outbound directory.
2. Gateway includes that directory in the request execution context.
3. Bootstrap/backend pass it through to the skills runtime as `CCBUDDY_OUTBOUND_DIR`.
4. During execution, `send_file` and bundled media-producing skills write files into that directory.

### 8.2 Delivery

After the request completes:

1. Gateway reads only the current request's outbound directory.
2. Gateway sends those files to the originating channel.
3. Successfully delivered files are deleted.
4. Gateway attempts to remove the request directory if it is empty.

This eliminates the shared snapshot/diff behavior entirely.

## 9. Component Changes

### 9.1 Gateway

Gateway will:

1. Stop snapshotting the shared outbound root before request execution.
2. Create one outbound directory per request.
3. Deliver only from that request directory.
4. Clean up delivered files and empty request directories.

Gateway should continue best-effort delivery semantics:

1. If one file fails to send, log the failure and continue with the others.
2. If cleanup cannot fully remove the request directory, log it and leave remaining files for inspection.

### 9.2 Bootstrap / Backend

Bootstrap/backend will:

1. Accept the request-scoped outbound directory from gateway/request context.
2. Pass it into the skills runtime environment as `CCBUDDY_OUTBOUND_DIR`.
3. Preserve existing tool wiring and user-facing behavior.

### 9.3 Skills Runtime

The skills runtime will:

1. Use `CCBUDDY_OUTBOUND_DIR` for `send_file`.
2. Use the same directory for bundled media-producing skills such as image generation.
3. Fail clearly if outbound delivery is requested but `CCBUDDY_OUTBOUND_DIR` is missing.

This is safer than falling back to cwd-derived paths, because the fallback is part of the current bug surface.

## 10. Failure Behavior

### 10.1 Missing Outbound Directory Contract

If `CCBUDDY_OUTBOUND_DIR` is missing:

1. `send_file` must return a clear error.
2. Bundled media-producing skills must throw or return a clear failure.
3. The system must not silently write to a guessed directory.

### 10.2 Partial Delivery Failure

If a file fails to send:

1. Gateway logs the failure.
2. Gateway continues attempting other files in the request directory.
3. Successfully delivered files may still be removed.
4. The request directory may remain if failed files are left behind.

### 10.3 Cleanup Failure

If the request directory cannot be removed:

1. Gateway logs the cleanup issue.
2. Remaining files are left in place.
3. Cleanup failure must not be reported as a successful full cleanup.

## 11. Compatibility

This change is intentionally internal.

Unchanged:

1. `send_file` MCP tool name and input schema.
2. Platform adapter media APIs.
3. User-facing behavior when outbound file delivery succeeds.

Changed:

1. The internal runtime now requires `CCBUDDY_OUTBOUND_DIR` for outbound file delivery.
2. Gateway delivery is request-scoped rather than shared-queue based.

## 12. Testing

Add regression coverage at three levels.

### 12.1 Gateway Isolation Test

Simulate two requests that each produce outbound files in separate request directories.

Verify:

1. Each channel receives only its own file.
2. One request does not deliver the other request's file.

### 12.2 Skills Runtime Outbound Path Test

Test `send_file` with `CCBUDDY_OUTBOUND_DIR`.

Verify:

1. The copied file lands in the configured request directory.
2. The tool fails clearly when `CCBUDDY_OUTBOUND_DIR` is missing.

### 12.3 Bundled Media Skill Test

Test the bundled image skill path behavior.

Verify:

1. It writes to `CCBUDDY_OUTBOUND_DIR`.
2. It does not derive the outbound path from `process.cwd()/data/outbound`.

## 13. Migration

No persisted data migration is required.

This is a runtime behavior change:

1. shared outbound scanning is removed
2. request-scoped outbound directories become the new execution model
3. cwd-derived outbound writes are removed

## 14. Recommendation

Implement the request-scoped directory model rather than tagging files inside one shared directory.

Reasoning:

1. isolation is structural, not convention-based
2. ownership is easier to test and reason about
3. cleanup is simpler
4. it closes both the cross-request delivery bug and the cwd-path mismatch class of bugs with one model
