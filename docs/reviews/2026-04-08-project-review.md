# CCBuddy Project Review

**Date:** 2026-04-08
**Reviewer:** Codex
**Scope:** Repo-wide document and code review of the current checkout. No fixes applied in this pass.

## Baseline

- Reviewed architecture and project documentation, especially `CLAUDE.md` and the design specs under `docs/superpowers/specs/`.
- Ran the full repo test suite with `npm test`.
- Observed one environment-specific failure in the scheduler package: webhook tests could not bind localhost ports under the sandbox (`listen EPERM` on `127.0.0.1:*`).
- Re-ran `npm test -w packages/scheduler` outside the sandbox. That passed cleanly: `6` test files, `70` tests passed.
- The worktree was already dirty before this review. Findings below describe the current checkout, not necessarily a clean baseline branch.

## Overall Impression

The project is unusually well documented for a personal tool. `CLAUDE.md` is strong, the package boundaries are easy to follow, and the monorepo structure is coherent. The main concerns are not architectural direction; they are runtime correctness issues around session wiring, filesystem/output routing, startup behavior, and operational safety.

## Findings

### 1. High: `trusted` users are effectively broken

**Why it matters**

The gateway maps `trusted` users into `permissionLevel: 'trusted'`, but bootstrap does not provide a `trusted` rate limit to `AgentService`. The rate limiter denies unknown roles by default. That means trusted-user requests can fail immediately as rate-limited even though the role is explicitly supported elsewhere.

**Evidence**

- `packages/gateway/src/gateway.ts`
  - Gateway maps `trusted` users to `permissionLevel: 'trusted'`.
- `packages/main/src/bootstrap.ts`
  - `AgentService` receives rate limits for `admin`, `chat`, and `system`, but not `trusted`.
- `packages/agent/src/session/rate-limiter.ts`
  - Unknown roles are denied by default.

**Impact**

- Trusted-user flows are likely unusable in production.
- This is easy to miss if tests only cover `admin` and `chat`.

**Suggested fix**

- Pass `trusted: config.agent.rate_limits.trusted` into `AgentService`.
- Add tests covering trusted-user request admission and tool allowlist behavior.

### 2. High: outbound media delivery is not request-scoped

**Why it matters**

Generated files are delivered through a shared outbound directory. Each request snapshots directory contents before execution, then later sends every newly seen file from that global directory. With multiple concurrent sessions, one request can send another request's files to the wrong channel.

**Evidence**

- `packages/gateway/src/gateway.ts`
  - `snapshotOutboundDir()` records a pre-execution listing.
  - `deliverOutboundMedia()` sends all files not present in that snapshot.
- `packages/main/src/bootstrap.ts`
  - Gateway concurrency is allowed through `max_concurrent_sessions`.

**Impact**

- Cross-channel data leakage.
- Wrong file delivery under load or overlapping jobs.
- Difficult-to-reproduce bugs because the race depends on timing.

**Suggested fix**

- Scope outbound media by request/session/channel, not by global directory diffing.
- Use per-request temp directories or include a request/session token in filenames and filter on that token.
- Add a concurrency test that creates overlapping requests with different generated files.

### 3. High: outbound media path handling is inconsistent

**Why it matters**

Different parts of the system disagree on where outbound media should be written. The gateway watches `config.data_dir/outbound`, but the MCP server and bundled image skill write to `process.cwd()/data/outbound`. Bootstrap already passes `--data-dir` into the MCP server, but that value is not used for `send_file`.

**Evidence**

- `packages/main/src/bootstrap.ts`
  - Gateway watches `join(config.data_dir, 'outbound')`.
  - MCP server receives `--data-dir`.
- `packages/skills/src/mcp-server.ts`
  - `send_file` writes to `pathJoin(process.cwd(), 'data', 'outbound')`.
- `skills/bundled/generate-image.mjs`
  - Generated images are written to `join(process.cwd(), 'data', 'outbound')`.

**Impact**

- File delivery may silently fail if subprocess cwd differs from repo root.
- Output can land in the wrong directory.
- Behavior becomes environment-dependent and brittle.

**Suggested fix**

- Treat the outbound directory as a single configured path derived from `--data-dir`.
- Thread that path through all MCP tools and bundled skills.
- Add tests that verify delivery when cwd and data dir differ.

### 4. High: PID lock handling can kill the wrong process

**Why it matters**

Startup reads a PID from disk and kills that process if it exists. PID reuse means that the same PID may now belong to an unrelated process. There is no validation that the process is actually CCBuddy before sending `SIGTERM` and `SIGKILL`.

There is also incomplete cleanup on bootstrap failure: if startup fails after acquiring the lock, the catch path clears the interval but does not release the PID lock.

**Evidence**

- `packages/main/src/bootstrap.ts`
  - `acquirePidLock()` trusts the PID file and kills the process if `kill(pid, 0)` succeeds.
  - Bootstrap failure path does not call `releasePidLock()`.

**Impact**

- Possibility of killing an unrelated process on the same host.
- Stale locks after failed startup.
- Hard-to-debug operational failures on restart.

**Suggested fix**

- Store more identity in the lock file than just PID, such as start time, executable path, or command line fingerprint.
- Validate the existing process before killing it.
- Ensure the failure path releases the lock if this instance acquired it.

### 5. Medium: dashboard config editing can flatten secrets into plaintext

**Why it matters**

The dashboard serves the resolved in-memory config, then writes edits back to `config/local.yaml`. If the config originally relied on `${ENV_VAR}` placeholders, a dashboard save can persist resolved values to disk instead of preserving placeholders.

Platform tokens are reinserted from the current in-memory config when the UI sends back redacted values, which further increases the chance that a save writes concrete secrets into `local.yaml`.

**Evidence**

- `packages/dashboard/src/server/index.ts`
  - `/api/config` returns a deep-cloned live config with only platform tokens redacted.
  - `/api/config` `PUT` writes the incoming object directly back to YAML.
  - Redacted tokens are restored from the live config object before writing.

**Impact**

- Secret-handling regression.
- Drift between intended env-based config and persisted local overrides.
- Operators can accidentally materialize secrets on disk.

**Suggested fix**

- Separate "effective config view" from "editable persisted config".
- Preserve placeholders when possible instead of round-tripping through the resolved object.
- Consider blocking edits to sensitive fields from the dashboard unless explicitly intended.

### 6. Medium: startup can process messages with the CLI backend before the SDK backend is installed

**Why it matters**

Bootstrap intentionally starts with `CliBackend`, starts adapters, and only later swaps to `SdkBackend` after platform connections are established. If messages arrive during that window, they may be processed by the CLI backend even when config says SDK.

The CLI backend explicitly does not support attachments and only includes attachment metadata in the prompt.

**Evidence**

- `packages/main/src/bootstrap.ts`
  - Initial backend is `new CliBackend()`.
  - `gateway.start()` happens before `agentService.setBackend(new SdkBackend(...))`.
- `packages/agent/src/backends/cli-backend.ts`
  - Logs that attachments are not supported in CLI mode.

**Impact**

- Inconsistent behavior during startup.
- Attachment handling may silently degrade for early messages.
- Hard-to-reproduce startup race conditions.

**Suggested fix**

- Prevent message processing until the final backend is installed.
- Or queue inbound messages until backend initialization is complete.
- Add a startup-readiness test that simulates a message arriving before backend swap.

## Additional Suggestions

- Add a conventional top-level `README` or operator runbook. The internal docs are good, but onboarding still depends on knowing to begin with `CLAUDE.md`.
- Add regression coverage for:
  - trusted-user admission
  - concurrent outbound media delivery
  - dashboard config round-trips with `${ENV_VAR}` placeholders
  - startup/backend readiness with `backend: sdk`

## Test Context

### Repo-wide test run

- Command: `npm test`
- Result: mostly passed, but `@ccbuddy/scheduler` failed in the sandbox due localhost bind permission errors in webhook tests.

### Scheduler rerun

- Command: `npm test -w packages/scheduler`
- Result: passed when run outside the sandbox.
- Final observed status: `6` test files passed, `70` tests passed.

## Deferred Work

These findings were recorded only. No fixes were implemented in this review pass.
