# Permission Gates — Dangerous Operation Approval

**Date:** 2026-03-21
**Status:** Draft

## Overview

Add configurable permission gates that intercept dangerous tool calls (destructive git ops, recursive deletes, config modifications, etc.) and ask the admin user for approval via Discord buttons before executing. Uses the existing `canUseTool` SDK callback and `requestUserInput` infrastructure — no new IPC or UI mechanisms.

## Requirements

1. **Hard gate** — configurable blocklist of dangerous patterns that are intercepted before execution
2. **Approval via Discord buttons** — reuse the existing AskUserQuestion/interactive follow-up flow
3. **Deny on timeout** — if user doesn't respond within the timeout, deny the tool call and let Po continue
4. **Configurable rules** — editable in config and dashboard without code changes
5. **Dashboard toggle** — switch between bypass-all (current behavior) and gated mode
6. **Soft guidance** — user provides ad-hoc instructions via prompt (no system needed)

## Design Decisions

### Why `canUseTool` callback

The Claude Code SDK's `canUseTool` hook is called *before* tool execution and can return `allow` or `deny`. This is the only enforcement point that can actually prevent execution. Gateway-level interception is too late (events are informational), and MCP-based approaches rely on model compliance.

### `bypassPermissions` vs `canUseTool` — the toggle

The SDK's `canUseTool` callback is **not invoked** when `permissionMode: 'bypassPermissions'` is active — the bypass auto-approves at step 3 of the SDK permission evaluation flow, before `canUseTool` at step 5.

Therefore, permission gates require switching admin users from `bypassPermissions` to `permissionMode: 'default'` with `canUseTool` as the sole permission authority. The `canUseTool` callback auto-allows all non-gated tools (same net effect as bypass, negligible latency overhead) and prompts for gated ones.

The existing `admin_skip_permissions` config toggle controls this:
- **`true`** (default) → `bypassPermissions` as today. No gates, no prompts. All tools auto-allowed.
- **`false`** → `permissionMode: 'default'` + `canUseTool` handles everything. Gates are active, non-gated tools auto-allowed.

The dashboard exposes this as a toggle switch. The `permission_gates.rules` config only matters when `admin_skip_permissions` is `false`.

### Why not CLI backend support

The CLI backend spawns `claude` as a subprocess with `--dangerously-skip-permissions`. There is no `canUseTool` equivalent for the CLI. Since the project uses SDK backend by default, this is acceptable. If CLI backend is ever used by an admin user, it falls back to the existing behavior (all tools allowed).

### Why reuse requestUserInput

The `requestUserInput` callback already handles Discord buttons with timeout, text fallback for unsupported adapters, and per-user routing. Using it for permission approval means zero new plumbing.

### Regex matching is best-effort

The regex-based pattern matching is an advisory safety net, not a security boundary. Patterns may miss creative variations (e.g., `rm --recursive` vs `rm -rf`, commands with variable expansion). This is acceptable — the goal is catching common dangerous commands, not building a security sandbox.

## Configuration

### Schema

```typescript
export interface PermissionGateRule {
  name: string;          // identifier for logging and audit
  pattern: string;       // regex matched against tool input
  tool: string;          // tool name to match: "Bash", "Write", "Edit", or "*" for all
  description: string;   // shown to user in approval prompt
}

export interface PermissionGateConfig {
  enabled: boolean;
  timeout_ms: number;    // approval timeout (default: 300000 = 5 min)
  rules: PermissionGateRule[];
}
```

Added to `AgentConfig`:
```typescript
export interface AgentConfig {
  // ...existing fields
  permission_gates: PermissionGateConfig;
}
```

### Default rules

```yaml
agent:
  permission_gates:
    enabled: true
    timeout_ms: 300000
    rules:
      - name: "destructive-rm"
        pattern: "rm\\s+-(r|rf|fr)\\s+(?!/tmp)"
        tool: "Bash"
        description: "Recursive delete on non-temp paths"
      - name: "destructive-git"
        pattern: "git\\s+(reset\\s+--hard|checkout\\s+\\.|clean\\s+-f)"
        tool: "Bash"
        description: "Destructive git operations"
      - name: "local-config"
        pattern: "config/local\\.yaml"
        tool: "*"
        description: "Modify local config (contains secrets)"
      - name: "launchctl"
        pattern: "launchctl"
        tool: "Bash"
        description: "LaunchAgent operations"
      - name: "npm-publish"
        pattern: "npm\\s+publish"
        tool: "Bash"
        description: "Package publishing"
```

Note: The wildcard tool match (`*`) uses `JSON.stringify(input)` which may produce false positives if the pattern appears in unrelated fields. This is acceptable for advisory safety nets.

## Architecture

### PermissionGateChecker

A stateless utility class in `packages/agent/src/permission-gate.ts`:

```typescript
class PermissionGateChecker {
  constructor(rules: PermissionGateRule[]);

  check(toolName: string, input: Record<string, unknown>): PermissionGateRule | null;
}
```

**Pattern matching logic by tool:**
- `Bash` — match pattern against `input.command` (string)
- `Write` — match pattern against `input.file_path` (string)
- `Edit` — match pattern against `input.file_path` (string)
- `*` (wildcard) — match pattern against `JSON.stringify(input)`

Returns the first matching rule, or `null` if no match. Invalid regex patterns are skipped with a console warning (never crash).

### canUseTool — Permission Mode Logic

The SdkBackend's permission handling changes based on `skipPermissions`:

**When `skipPermissions: true` (gates OFF):**
```
options.permissionMode = 'bypassPermissions';
options.allowDangerouslySkipPermissions = true;
// canUseTool only handles AskUserQuestion (existing behavior)
```

**When `skipPermissions: false` (gates ON):**
```
// No bypassPermissions — SDK uses 'default' mode
// canUseTool handles ALL permission decisions:

canUseTool(toolName, input, { signal }):
  1. If toolName === 'AskUserQuestion' → handle as before (existing logic)
  2. If permission_gates.enabled && checker.check(toolName, input) matches:
     → ask for approval via requestUserInput
  3. Otherwise → { behavior: 'allow' }  (auto-approve, same effect as bypass)
```

The `canUseTool` callback is always installed when `requestUserInput` is available (regardless of `skipPermissions`), but it only acts as a permission gate when `skipPermissions` is `false`.

**Approval prompt format:**
```typescript
{
  question: `Po wants to run:\n\`${commandPreview}\``,
  header: `⚠️ ${matchedRule.description}`,
  options: [
    { label: 'Allow', description: 'Execute this command' },
    { label: 'Deny', description: 'Block this command' },
  ],
  multiSelect: false,
}
```

Where `commandPreview` is:
- For Bash: the `command` value (truncated to 200 chars if needed)
- For Write/Edit: the `file_path` value
- For wildcard matches: the tool name + first 200 chars of stringified input

**Approval result handling:**
- User selects "Allow" → `{ behavior: 'allow' }`
- User selects "Deny" → `{ behavior: 'deny', message: 'User denied: <description>' }`
- Timeout (no response) → `{ behavior: 'deny', message: 'Approval timed out for: <description>' }`
- `requestUserInput` not available (system/scheduler jobs) → `{ behavior: 'allow' }` (these already bypass permissions via `permissionLevel: 'system'`)
- The `signal` (AbortSignal) from the SDK is forwarded to `requestUserInput` for cancellation if the overall query is aborted.

### SdkBackendOptions

```typescript
export interface SdkBackendOptions {
  skipPermissions?: boolean;
  permissionGates?: PermissionGateConfig;  // NEW
}
```

The checker is created once in the constructor and reused for all requests.

### Audit Logging

Permission gate decisions are logged at `info` level:

```
[SdkBackend] Permission gate triggered: "destructive-git" for tool Bash — awaiting approval
[SdkBackend] Permission gate approved: "destructive-git" by user
[SdkBackend] Permission gate denied: "destructive-git" by user
[SdkBackend] Permission gate timed out: "destructive-git"
```

### Data Flow

```
Tool call arrives via SDK
        |
        v
   canUseTool(toolName, input, { signal })
        |
        +-- AskUserQuestion? → existing handler
        |
        +-- skipPermissions: true? → { behavior: 'allow' }
        |   (bypass mode — gates inactive)
        |
        +-- PermissionGateChecker.check(toolName, input)
        |       |
        |       +-- No match → { behavior: 'allow' }
        |       |
        |       +-- Match found
        |               |
        |               v
        |       requestUserInput available?
        |               |
        |               +-- No (system job) → { behavior: 'allow' }
        |               |
        |               +-- Yes → present approval via Discord buttons
        |                       |
        |                       +-- "Allow" → { behavior: 'allow' }
        |                       +-- "Deny"  → { behavior: 'deny' }
        |                       +-- Timeout → { behavior: 'deny' }
        |
        v
   SDK executes or skips the tool
```

## Dashboard Integration

The dashboard exposes the `admin_skip_permissions` toggle:

- **Toggle switch** labeled "Permission Gates" (or "Require approval for dangerous operations")
- When ON: `admin_skip_permissions: false` → gates active
- When OFF: `admin_skip_permissions: true` → bypass all (current behavior)
- The rules list is editable via the existing config editor (`GET/PUT /api/config`)

No new API endpoints needed — the existing config endpoints cover `agent.admin_skip_permissions` and `agent.permission_gates`.

## Files to Create or Modify

### Agent (`packages/agent`)
- `src/permission-gate.ts` — `PermissionGateChecker` class
- `src/__tests__/permission-gate.test.ts` — unit tests for pattern matching
- `src/backends/sdk-backend.ts` — extend `canUseTool` callback with gate logic, change permission mode logic
- `src/backends/__tests__/sdk-backend.test.ts` — tests for gate integration
- `src/index.ts` — export `PermissionGateChecker`

### Core (`packages/core`)
- `src/config/schema.ts` — add `PermissionGateRule`, `PermissionGateConfig` types; add `permission_gates` to `AgentConfig`; add defaults to `DEFAULT_CONFIG`
- `src/config/index.ts` — export new types

### Main (`packages/main`)
- `src/bootstrap.ts` — pass `config.agent.permission_gates` to `SdkBackend`

### Config
- `config/default.yaml` — add `permission_gates` section with default rules

### Dashboard (`packages/dashboard`)
- Client: add toggle switch for `admin_skip_permissions` in settings section

## Testing

- Unit tests for `PermissionGateChecker`:
  - Matches Bash command against correct rule
  - Matches Write/Edit file_path against wildcard rule
  - Returns null when no rules match
  - Handles multiple rules (returns first match)
  - Handles invalid regex gracefully (skip rule, don't crash)
  - Case sensitivity in patterns
- Unit tests for SdkBackend canUseTool extension:
  - When `skipPermissions: true`: gated tool is auto-allowed (bypass mode)
  - When `skipPermissions: false`: blocked tool call triggers requestUserInput
  - Approved call returns allow
  - Denied call returns deny with message
  - Timeout returns deny with message
  - Non-matching tool call is allowed without prompt
  - AskUserQuestion still works as before (no regression)
  - No gates when requestUserInput is not available (system jobs)
  - Gates disabled when `permission_gates.enabled: false`
  - AbortSignal forwarded to requestUserInput
- Integration: permission gates config loads correctly from YAML
