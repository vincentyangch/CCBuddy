# Granular Permissions (Trusted Role)

**Date:** 2026-03-21
**Status:** Approved

## Problem

CCBuddy has a binary permission model: `admin` users get all tools, `chat` users get none. There's no middle ground for friends or family who should be able to interact with Po meaningfully (read files, search code, browse the web) without having access to destructive operations (write files, run arbitrary bash commands, git push).

## Goals

1. A `trusted` role between `admin` and `chat` with a configurable set of allowed tools
2. Permission gates still apply for trusted users (dangerous patterns caught)
3. Simple config — one list of tool names in `agent.trusted_allowed_tools`

## Non-Goals

- Per-user tool lists (all trusted users share the same set)
- Runtime tool permission changes via chat (config-only)
- Audit logging of tool usage per user
- Changing `admin` or `chat` behavior

## Role Hierarchy

| Role | Tools | Permission Gates | Bypass Permissions |
|------|-------|------------------|--------------------|
| `admin` | All | Yes (unless `admin_skip_permissions: true`) | Configurable |
| `trusted` | Predefined safe set | Yes, always | Never |
| `chat` | None | N/A | N/A |
| `system` | All | No | Always bypass (unattended) |

## Config Changes

Add to `AgentConfig` in `packages/core/src/config/schema.ts`:

```typescript
  trusted_allowed_tools: string[];
```

Default value in `DEFAULT_CONFIG`:

```yaml
agent:
  trusted_allowed_tools:
    - Read
    - Glob
    - Grep
    - WebSearch
    - WebFetch
    - AskUserQuestion
```

These are Claude SDK tool names. The list is intentionally conservative — read-only operations plus web access. Users can expand it in `config/local.yaml` (e.g., add `Bash` for a power user you trust more).

## Component Changes

### 1. User types (`@ccbuddy/core`)

**File:** `packages/core/src/types/user.ts`

Extend `UserRole` to include `'trusted'`:

```typescript
export type UserRole = 'admin' | 'trusted' | 'chat';
```

### 2. Config schema (`@ccbuddy/core`)

**File:** `packages/core/src/config/schema.ts`

Add `trusted_allowed_tools: string[]` to `AgentConfig` interface and defaults.

### 3. Gateway (`@ccbuddy/gateway`)

**File:** `packages/gateway/src/gateway.ts`

Update the permission level mapping (currently line 239):

```typescript
// Before:
permissionLevel: user.role === 'admin' ? 'admin' : 'chat',

// After:
permissionLevel: user.role,
```

Since `UserRole` is now `'admin' | 'trusted' | 'chat'`, the role maps directly to the permission level. The `AgentRequest.permissionLevel` type also needs updating to include `'trusted'`.

### 4. SdkBackend (`@ccbuddy/agent`)

**File:** `packages/agent/src/backends/sdk-backend.ts`

Add a new branch in `execute()` for `permissionLevel === 'trusted'`:

```typescript
if (request.permissionLevel === 'trusted') {
  options.allowedTools = this.options.trustedAllowedTools ?? [];
  // Permission gates stay active — no bypass, no skip
}
```

The `SdkBackendOptions` interface needs a new field:

```typescript
trustedAllowedTools?: string[];
```

Passed from config at bootstrap.

### 5. Bootstrap wiring (`@ccbuddy/main`)

**File:** `packages/main/src/bootstrap.ts`

Pass `trustedAllowedTools` when creating the SdkBackend:

```typescript
new SdkBackend({
  skipPermissions: config.agent.admin_skip_permissions,
  permissionGates: config.agent.permission_gates,
  trustedAllowedTools: config.agent.trusted_allowed_tools,
})
```

### 6. Rate limiter

The existing rate limiter uses `permissionLevel` as a key. Currently defaults are `{ admin: 30, chat: 10, system: 20 }`. Add a `trusted` rate:

```typescript
rate_limits: {
  admin: number;
  trusted: number;
  chat: number;
  system: number;
};
```

Default: `trusted: 20` (between admin and chat).

## What Stays the Same

- `admin` behavior unchanged — all tools, optional bypass
- `chat` behavior unchanged — no tools, text-only
- `system` behavior unchanged — unattended bypass
- Permission gate rules unchanged — same patterns apply to all roles
- `admin_skip_permissions` toggle unchanged
- `canUseTool` approval flow unchanged (trusted users get the same Discord button prompts as admin when a gate triggers)

## Testing

- **SdkBackend:** trusted user gets `allowedTools` from config, no bypass mode, gates still active
- **Gateway:** trusted role maps to `'trusted'` permission level
- **Config:** `trusted_allowed_tools` parsed and defaults applied
- **Integration:** trusted user can Read but not Write; gate still triggers if pattern matches within allowed tools
