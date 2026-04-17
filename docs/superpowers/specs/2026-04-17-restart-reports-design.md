# Restart Reports Design

**Date:** 2026-04-17
**Status:** Draft
**Author:** flyingchickens + Codex

## 1. Overview

CCBuddy can already restart itself, but the current `restart_gateway` flow only sends a pre-restart acknowledgement. Once the process exits, the conversation goes silent. After the new process comes up, there is no confirmation that startup completed successfully, no distinction between a requested restart and an unprompted startup, and no post-boot DM to the owner.

This design adds explicit startup reporting in two cases:

1. **Requested restart**
   The original channel that requested the restart receives a success confirmation after the new process is fully ready to send messages.
2. **Unprompted startup**
   The owner receives a DM on startup even when there was no explicit restart request, such as launchd recovery or machine reboot.

The design uses a small durable marker file in `data_dir` rather than prompt text. Prompt files like `BOOT.md` are not sufficient because startup happens before any agent request exists.

## 2. Goals

1. After a requested restart, send a success report back to the same platform/channel that asked for the restart.
2. On every startup, DM the owner with a startup confirmation.
3. Distinguish requested restart startup from unprompted startup in the DM wording.
4. Only send success reports after adapters are actually ready to deliver messages.
5. Keep the implementation local to restart/startup plumbing without redesigning general notification architecture.
6. Persist enough state to survive process exit and machine reboot.

## 3. Non-Goals

1. This design does not introduce a general lifecycle event framework for all process transitions.
2. This design does not infer the exact root cause of unprompted startup beyond “no pending requested restart”.
3. This design does not add dashboard UI for restart history.
4. This design does not redesign `NotificationService` preference routing for all notification types.

## 4. Current Problem

Today `packages/skills/src/mcp-server.ts` handles `restart_gateway` by:

1. reading the gateway PID from `data_dir/ccbuddy.pid`
2. sending `SIGUSR1`
3. returning a text acknowledgement before the process exits

That acknowledgement is only “restart signal sent”, not “restart succeeded”.

On the new process side, `packages/main/src/bootstrap.ts`:

1. starts adapters and services
2. creates `sendProactiveMessage`
3. starts the scheduler and notification service
4. returns control to the running gateway

There is no startup hook that checks whether:

1. a restart was explicitly requested and needs channel confirmation
2. the owner should receive a boot DM

## 5. Chosen Approach

Use a durable marker file plus a startup reporting hook in bootstrap.

### 5.1 Why This Approach

This is the smallest design that satisfies both required behaviors:

1. the process that receives `restart_gateway` can persist intent before dying
2. the next process can read that intent and report success after startup is genuinely ready
3. unprompted startups can still produce a DM even when no prior request exists

This avoids coupling restart lifecycle behavior to session storage or memory retrieval.

### 5.2 Alternatives Considered

1. **Session database handoff**
   Store pending restart acknowledgements in SQLite and load them on startup. This is more structured, but it couples process lifecycle to session persistence for a one-shot operational signal.
2. **General lifecycle events**
   Publish startup/shutdown/restart events and route them through `NotificationService`. Cleaner long-term, but broader than needed for this feature.

## 6. Marker File Contract

### 6.1 Path

Use a dedicated file under `config.data_dir`:

```text
<config.data_dir>/restart-intent.json
```

### 6.2 Shape

The file should contain:

```json
{
  "kind": "requested_restart",
  "requestedAt": "2026-04-17T16:00:00.000Z",
  "reportTarget": {
    "platform": "discord",
    "channel": "1477704699766640733"
  },
  "requestedBy": "flyingchickens",
  "sessionKey": "flyingchickens-discord-1477704699766640733"
}
```

Required fields:

1. `kind`
2. `requestedAt`
3. `reportTarget.platform`
4. `reportTarget.channel`

Optional fields:

1. `requestedBy`
2. `sessionKey`

`sessionKey` is stored only for diagnostics; the restart confirmation itself is routed by `reportTarget`.

### 6.3 Lifetime

The marker is one-shot and should be deleted after the requested-restart channel report has been sent successfully or intentionally suppressed as stale.

### 6.4 Staleness Window

Requested-restart channel confirmations should be treated as stale after **15 minutes**.

If startup occurs after the staleness window:

1. do not send the old channel confirmation
2. still send the owner DM
3. phrase the DM as delayed startup after a previously requested restart

This prevents a very old restart request from producing a confusing message in an outdated conversation.

## 7. Requested Restart Flow

### 7.1 On Tool Execution

When `restart_gateway` is called:

1. validate and parse the gateway PID lockfile as today
2. persist `restart-intent.json` atomically
3. send `SIGUSR1`
4. return the existing “restart signal sent” response immediately

Persisting the marker must happen **before** the signal is sent.

### 7.2 On Next Bootstrap

After adapters are connected and `sendProactiveMessage` is available:

1. read `restart-intent.json` if present
2. if fresh, send `Restart complete` to `reportTarget`
3. delete the marker after successful same-channel delivery
4. also send the owner DM for startup reporting

If the same-channel delivery fails:

1. log the failure
2. still send the owner DM so the restart is not silent
3. delete the marker so future startups do not repeat the stale channel confirmation

This intentionally favors bounded behavior over repeated retries across every future startup.

## 8. Unprompted Startup Flow

If bootstrap reaches the reporting hook and **no** `restart-intent.json` exists:

1. do not send any same-channel message
2. send the owner a DM stating that CCBuddy started without a pending restart request

This covers:

1. machine reboot
2. launchd recovery
3. manual `launchctl bootstrap` / `kickstart`
4. crash recovery where no restart was requested through the tool

The DM should not claim to know whether the cause was a crash, reboot, or manual operator action. It should only distinguish:

1. `requested restart`
2. `startup without pending restart request`

## 9. Delivery Timing

Startup reports must be sent only after adapters are ready.

Specifically, the reporting hook should run after:

1. the gateway is constructed
2. platform adapters are registered and connected
3. `sendProactiveMessage` has been created

It does **not** need to wait for the scheduler to emit its first tick, but it must wait until outbound messaging is operational.

## 10. Message Content

### 10.1 Requested Restart Channel Report

Use a short success message:

```text
Restart complete.
```

### 10.2 Owner DM for Requested Restart

Use wording like:

```text
CCBuddy startup complete after requested restart.
```

### 10.3 Owner DM for Unprompted Startup

Use wording like:

```text
CCBuddy startup complete. No pending restart request was found.
```

The DM should stay concise and avoid guessing why startup happened.

## 11. Owner DM Resolution

The owner DM target should use the existing admin-user resolution path already available in bootstrap and `NotificationService`:

1. find the admin/owner user from config
2. resolve that user’s platform ID
3. resolve the DM channel via the adapter
4. send the startup DM there

If DM resolution fails:

1. log the failure
2. do not fail bootstrap

## 12. Atomicity and File Handling

Marker writes should use the same safe write style already used elsewhere in bootstrap:

1. write JSON to a temp file
2. rename into place atomically

Marker cleanup should be best effort:

1. missing file is fine
2. malformed file should be logged and removed
3. malformed marker should not block startup

## 13. File Impact

Expected code changes:

1. `packages/skills/src/mcp-server.ts`
   - write `restart-intent.json` before sending `SIGUSR1`
2. `packages/main/src/bootstrap.ts`
   - add startup report processing after adapters are ready
   - add helper(s) for owner DM resolution and marker consumption
3. tests in:
   - `packages/skills/src/__tests__/mcp-server.test.ts`
   - `packages/main/src/__tests__/bootstrap.test.ts`

## 14. Test Plan

### 14.1 Skills-side Tests

1. `restart_gateway` writes a marker file before signaling the PID
2. the marker contains the original platform/channel target
3. malformed lockfiles still fail cleanly

### 14.2 Bootstrap-side Tests

1. fresh marker sends same-channel confirmation after startup
2. fresh marker also sends the owner DM
3. missing marker sends only the owner DM
4. stale marker suppresses same-channel confirmation but still sends the owner DM
5. DM resolution failure does not fail bootstrap
6. malformed marker does not fail bootstrap

## 15. Why BOOT.md Is Not the Right Mechanism

This project does not have a `BOOT.md` startup execution mechanism. More importantly, startup confirmation is not an agent-prompt problem:

1. process boot happens before any user request exists
2. system prompts only affect agent request handling
3. message delivery after boot requires explicit code once adapters are live

So this feature must be implemented in startup/restart code, not in prompt text.
