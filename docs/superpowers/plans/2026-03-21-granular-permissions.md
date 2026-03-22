# Granular Permissions (Trusted Role) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `trusted` role between `admin` and `chat` that gets a configurable set of allowed tools with permission gates still active.

**Architecture:** Extend `UserRole` to include `'trusted'`, add `trusted_allowed_tools` config, pass the tool list to `SdkBackend` which sets `allowedTools` for trusted users. Gateway maps role directly to permission level. Permission gates remain active for trusted users.

**Tech Stack:** TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-03-21-granular-permissions-design.md`

---

## Chunk 1: Types + Config

### Task 1: Add trusted role and config

**Files:**
- Modify: `packages/core/src/types/user.ts`
- Modify: `packages/core/src/types/agent.ts`
- Modify: `packages/core/src/config/schema.ts`

- [ ] **Step 1: Add 'trusted' to UserRole**

In `packages/core/src/types/user.ts`, change line 1:

```typescript
export type UserRole = 'admin' | 'trusted' | 'chat' | 'system';
```

- [ ] **Step 2: Add 'trusted' to AgentRequest.permissionLevel**

In `packages/core/src/types/agent.ts`, update the `permissionLevel` type (line 21):

```typescript
  permissionLevel: 'admin' | 'trusted' | 'chat' | 'system';
```

- [ ] **Step 3: Add trusted_allowed_tools and trusted rate limit to config**

In `packages/core/src/config/schema.ts`:

Add to the `AgentConfig` interface (after `max_pause_ms`):

```typescript
  trusted_allowed_tools: string[];
```

Add `trusted` to the `rate_limits` object in the interface:

```typescript
  rate_limits: {
    admin: number;
    trusted: number;
    chat: number;
    system: number;
  };
```

Add defaults in `DEFAULT_CONFIG.agent` (after `max_pause_ms`):

```typescript
    trusted_allowed_tools: [
      'Read',
      'Glob',
      'Grep',
      'WebSearch',
      'WebFetch',
      'AskUserQuestion',
    ],
```

Add `trusted: 20` to `DEFAULT_CONFIG.agent.rate_limits`:

```typescript
    rate_limits: {
      admin: 30,
      trusted: 20,
      chat: 10,
      system: 20,
    },
```

- [ ] **Step 4: Build and verify**

Run: `npm run build -w packages/core`
Expected: Clean build

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types/user.ts packages/core/src/types/agent.ts packages/core/src/config/schema.ts
git commit -m "feat(core): add trusted role, trusted_allowed_tools config, and trusted rate limit"
```

---

## Chunk 2: SdkBackend + Gateway + Bootstrap

### Task 2: Handle trusted permission level in SdkBackend

**Files:**
- Modify: `packages/agent/src/backends/sdk-backend.ts`

- [ ] **Step 1: Add trustedAllowedTools to SdkBackendOptions**

In `packages/agent/src/backends/sdk-backend.ts`, update the `SdkBackendOptions` interface (line 7-10):

```typescript
export interface SdkBackendOptions {
  skipPermissions?: boolean;
  permissionGates?: PermissionGateConfig;
  trustedAllowedTools?: string[];
}
```

- [ ] **Step 2: Add trusted branch in execute()**

In the permission level switch block (lines 59-74), add after the `chat` block:

```typescript
      } else if (request.permissionLevel === 'trusted') {
        options.allowedTools = this.options.trustedAllowedTools ?? [];
        // Permission gates stay active — no bypass, no skip
      }
```

The full block should read:

```typescript
      if (request.permissionLevel === 'admin' && this.options.skipPermissions) {
        options.permissionMode = 'bypassPermissions';
        options.allowDangerouslySkipPermissions = true;
      } else if (request.permissionLevel === 'system') {
        options.permissionMode = 'bypassPermissions';
        options.allowDangerouslySkipPermissions = true;
      } else if (request.permissionLevel === 'trusted') {
        options.allowedTools = this.options.trustedAllowedTools ?? [];
      } else if (request.permissionLevel === 'chat') {
        options.allowedTools = [];
        const chatRestriction = 'IMPORTANT: You are in chat-only mode. Do NOT use any tools (no Bash, no file operations, no web searches). Only respond with text.';
        options.systemPrompt = options.systemPrompt
          ? `${options.systemPrompt}\n\n${chatRestriction}`
          : chatRestriction;
      }
```

- [ ] **Step 3: Build and run agent tests**

Run: `npm run build -w packages/agent && npm test -w packages/agent -- --run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/backends/sdk-backend.ts
git commit -m "feat(agent): handle trusted permission level with configurable allowed tools"
```

---

### Task 3: Update gateway role mapping

**Files:**
- Modify: `packages/gateway/src/gateway.ts`

- [ ] **Step 1: Map role directly to permissionLevel**

In `packages/gateway/src/gateway.ts`, find the `permissionLevel` assignment in the `AgentRequest` build (search for `permissionLevel:`). Currently:

```typescript
      permissionLevel: user.role === 'admin' ? 'admin' : 'chat',
```

Change to:

```typescript
      permissionLevel: user.role === 'admin' ? 'admin' : user.role === 'trusted' ? 'trusted' : 'chat',
```

This maps `admin` → `admin`, `trusted` → `trusted`, `chat` → `chat`. The `system` role is never assigned by gateway (only used internally).

- [ ] **Step 2: Build and run gateway tests**

Run: `npm run build -w packages/gateway && npm test -w packages/gateway -- --run`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): map trusted role to trusted permission level"
```

---

### Task 4: Wire trustedAllowedTools in bootstrap

**Files:**
- Modify: `packages/main/src/bootstrap.ts`

- [ ] **Step 1: Pass trustedAllowedTools to SdkBackend**

In `packages/main/src/bootstrap.ts`, find where `SdkBackend` is created (search for `new SdkBackend`). Currently:

```typescript
    agentService.setBackend(new SdkBackend({
      skipPermissions: config.agent.admin_skip_permissions,
      permissionGates: config.agent.permission_gates,
    }));
```

Add `trustedAllowedTools`:

```typescript
    agentService.setBackend(new SdkBackend({
      skipPermissions: config.agent.admin_skip_permissions,
      permissionGates: config.agent.permission_gates,
      trustedAllowedTools: config.agent.trusted_allowed_tools,
    }));
```

- [ ] **Step 2: Build and verify**

Run: `npm run build -w packages/main`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
git add packages/main/src/bootstrap.ts
git commit -m "feat(main): pass trustedAllowedTools config to SdkBackend"
```

---

## Chunk 3: Integration

### Task 5: Run full test suite and fix issues

- [ ] **Step 1: Build all packages**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Fix any failures**

Common issues:
- Config mocks in test files may need `trusted_allowed_tools` and `trusted` rate limit added
- Gateway tests may need updated expectations for permission level mapping
- Bootstrap test mocks may need `trustedAllowedTools` in SdkBackend options

- [ ] **Step 4: Commit fixes**

```bash
git add -A
git commit -m "fix: resolve test failures from trusted role integration"
```

---

### Task 6: Verify end-to-end

- [ ] **Step 1: Add a trusted user to config**

In `config/local.yaml`, add a user with `role: trusted`:

```yaml
users:
  friend:
    name: friend
    role: trusted
    discord_id: "THEIR_DISCORD_USER_ID"
```

- [ ] **Step 2: Restart CCBuddy**

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
```

- [ ] **Step 3: Test from the trusted user's Discord account**

1. Have the trusted user send a message to Po
2. Po should be able to use Read, Glob, Grep, WebSearch, WebFetch
3. Po should NOT be able to use Bash, Write, Edit (blocked by allowedTools)
4. If a permission gate triggers on an allowed tool, the user should see approval buttons
