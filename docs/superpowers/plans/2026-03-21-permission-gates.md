# Permission Gates Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable permission gates that intercept dangerous tool calls and ask the user for approval via Discord buttons before executing.

**Architecture:** A `PermissionGateChecker` matches tool calls against configurable regex rules. The SdkBackend's `canUseTool` callback uses it to gate dangerous operations when `admin_skip_permissions` is `false`. Approval flows through the existing `requestUserInput` → Discord buttons infrastructure.

**Tech Stack:** TypeScript, vitest, Claude Code SDK

**Spec:** `docs/superpowers/specs/2026-03-21-permission-gates-design.md`

---

## Chunk 1: Core Types & PermissionGateChecker

### Task 1: Add PermissionGate types to config schema

**Files:**
- Modify: `packages/core/src/config/schema.ts:3-22` (AgentConfig interface)
- Modify: `packages/core/src/config/schema.ts:170-189` (DEFAULT_CONFIG agent section)

- [ ] **Step 1: Add type definitions**

In `packages/core/src/config/schema.ts`, add before `AgentConfig`:

```typescript
export interface PermissionGateRule {
  name: string;
  pattern: string;
  tool: string;
  description: string;
}

export interface PermissionGateConfig {
  enabled: boolean;
  timeout_ms: number;
  rules: PermissionGateRule[];
}
```

- [ ] **Step 2: Add `permission_gates` to `AgentConfig`**

```typescript
export interface AgentConfig {
  // ...existing fields (backend, model, etc.)
  user_input_timeout_ms: number;
  permission_gates: PermissionGateConfig;  // NEW — add after user_input_timeout_ms
}
```

- [ ] **Step 3: Add defaults to `DEFAULT_CONFIG`**

In the `agent` section of `DEFAULT_CONFIG`, add after `user_input_timeout_ms`:

```typescript
permission_gates: {
  enabled: true,
  timeout_ms: 300_000,
  rules: [
    { name: 'destructive-rm', pattern: 'rm\\s+-(r|rf|fr)\\s+(?!/tmp)', tool: 'Bash', description: 'Recursive delete on non-temp paths' },
    { name: 'destructive-git', pattern: 'git\\s+(reset\\s+--hard|checkout\\s+\\.|clean\\s+-f)', tool: 'Bash', description: 'Destructive git operations' },
    { name: 'local-config', pattern: 'config/local\\.yaml', tool: '*', description: 'Modify local config (contains secrets)' },
    { name: 'launchctl', pattern: 'launchctl', tool: 'Bash', description: 'LaunchAgent operations' },
    { name: 'npm-publish', pattern: 'npm\\s+publish', tool: 'Bash', description: 'Package publishing' },
  ],
},
```

- [ ] **Step 4: Export types from config barrel**

In `packages/core/src/config/index.ts`, add:

```typescript
export type { PermissionGateRule, PermissionGateConfig } from './schema.js';
```

- [ ] **Step 5: Build**

Run: `npm run build -w packages/core`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config/schema.ts packages/core/src/config/index.ts
git commit -m "feat(core): add PermissionGateConfig types and defaults"
```

### Task 2: Create PermissionGateChecker

**Files:**
- Create: `packages/agent/src/permission-gate.ts`
- Create: `packages/agent/src/__tests__/permission-gate.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/agent/src/__tests__/permission-gate.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { PermissionGateChecker } from '../permission-gate.js';
import type { PermissionGateRule } from '@ccbuddy/core';

const RULES: PermissionGateRule[] = [
  { name: 'destructive-rm', pattern: 'rm\\s+-(r|rf|fr)\\s+(?!/tmp)', tool: 'Bash', description: 'Recursive delete' },
  { name: 'destructive-git', pattern: 'git\\s+(reset\\s+--hard|checkout\\s+\\.|clean\\s+-f)', tool: 'Bash', description: 'Destructive git ops' },
  { name: 'local-config', pattern: 'config/local\\.yaml', tool: '*', description: 'Local config' },
  { name: 'launchctl', pattern: 'launchctl', tool: 'Bash', description: 'LaunchAgent ops' },
  { name: 'npm-publish', pattern: 'npm\\s+publish', tool: 'Bash', description: 'Package publishing' },
];

describe('PermissionGateChecker', () => {
  const checker = new PermissionGateChecker(RULES);

  it('matches Bash command against correct rule', () => {
    const result = checker.check('Bash', { command: 'rm -rf /home/user/project' });
    expect(result).not.toBeNull();
    expect(result!.name).toBe('destructive-rm');
  });

  it('matches destructive git operations', () => {
    expect(checker.check('Bash', { command: 'git reset --hard HEAD~3' })?.name).toBe('destructive-git');
    expect(checker.check('Bash', { command: 'git checkout .' })?.name).toBe('destructive-git');
    expect(checker.check('Bash', { command: 'git clean -fd' })?.name).toBe('destructive-git');
  });

  it('matches Write file_path against wildcard rule', () => {
    const result = checker.check('Write', { file_path: 'config/local.yaml', content: 'secrets' });
    expect(result).not.toBeNull();
    expect(result!.name).toBe('local-config');
  });

  it('matches Edit file_path against wildcard rule', () => {
    const result = checker.check('Edit', { file_path: 'config/local.yaml', old_string: 'a', new_string: 'b' });
    expect(result).not.toBeNull();
    expect(result!.name).toBe('local-config');
  });

  it('returns null when no rules match', () => {
    expect(checker.check('Bash', { command: 'ls -la' })).toBeNull();
    expect(checker.check('Bash', { command: 'git status' })).toBeNull();
    expect(checker.check('Write', { file_path: 'src/index.ts', content: 'code' })).toBeNull();
  });

  it('returns first matching rule when multiple match', () => {
    const result = checker.check('Bash', { command: 'rm -rf /home && git reset --hard' });
    expect(result!.name).toBe('destructive-rm');
  });

  it('does not match tool-specific rule against wrong tool', () => {
    // 'launchctl' rule is tool: 'Bash', should not match a Write tool
    expect(checker.check('Write', { file_path: 'launchctl-notes.txt', content: '' })).toBeNull();
  });

  it('wildcard tool matches any tool name', () => {
    // 'local-config' rule is tool: '*', matches any tool
    expect(checker.check('Bash', { command: 'cat config/local.yaml' })?.name).toBe('local-config');
    expect(checker.check('Read', { file_path: 'config/local.yaml' })?.name).toBe('local-config');
  });

  it('handles invalid regex gracefully', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badChecker = new PermissionGateChecker([
      { name: 'bad-regex', pattern: '[invalid(', tool: 'Bash', description: 'Bad pattern' },
      { name: 'good-rule', pattern: 'rm -rf', tool: 'Bash', description: 'Good pattern' },
    ]);
    // Bad regex is skipped, good rule still works
    expect(badChecker.check('Bash', { command: 'rm -rf /' })?.name).toBe('good-rule');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('matches rm -rf /tmp as non-gated (negative lookahead)', () => {
    expect(checker.check('Bash', { command: 'rm -rf /tmp/build' })).toBeNull();
  });

  it('constructs with empty rules', () => {
    const empty = new PermissionGateChecker([]);
    expect(empty.check('Bash', { command: 'rm -rf /' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/agent -- --run src/__tests__/permission-gate.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement PermissionGateChecker**

Create `packages/agent/src/permission-gate.ts`:

```typescript
import type { PermissionGateRule } from '@ccbuddy/core';

interface CompiledRule {
  rule: PermissionGateRule;
  regex: RegExp;
}

export class PermissionGateChecker {
  private readonly compiled: CompiledRule[];

  constructor(rules: PermissionGateRule[]) {
    this.compiled = [];
    for (const rule of rules) {
      try {
        this.compiled.push({ rule, regex: new RegExp(rule.pattern) });
      } catch {
        console.warn(`[PermissionGate] Skipping rule "${rule.name}" — invalid regex: ${rule.pattern}`);
      }
    }
  }

  check(toolName: string, input: Record<string, unknown>): PermissionGateRule | null {
    for (const { rule, regex } of this.compiled) {
      if (rule.tool !== '*' && rule.tool !== toolName) continue;

      const text = this.extractText(toolName, input);
      if (text && regex.test(text)) {
        return rule;
      }
    }
    return null;
  }

  private extractText(toolName: string, input: Record<string, unknown>): string | null {
    switch (toolName) {
      case 'Bash':
        return typeof input.command === 'string' ? input.command : null;
      case 'Write':
      case 'Edit':
      case 'Read':
        return typeof input.file_path === 'string' ? input.file_path : null;
      default:
        return JSON.stringify(input);
    }
  }
}
```

- [ ] **Step 4: Export from agent index**

In `packages/agent/src/index.ts`, add:

```typescript
export { PermissionGateChecker } from './permission-gate.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w packages/agent -- --run src/__tests__/permission-gate.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/permission-gate.ts packages/agent/src/__tests__/permission-gate.test.ts packages/agent/src/index.ts
git commit -m "feat(agent): add PermissionGateChecker with regex-based tool matching"
```

---

## Chunk 2: SdkBackend canUseTool Extension

### Task 3: Extend SdkBackend with permission gates

**Files:**
- Modify: `packages/agent/src/backends/sdk-backend.ts:6-8` (SdkBackendOptions)
- Modify: `packages/agent/src/backends/sdk-backend.ts:15-20` (constructor)
- Modify: `packages/agent/src/backends/sdk-backend.ts:53-92` (permission + canUseTool logic)
- Modify: `packages/agent/src/backends/__tests__/sdk-backend.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `packages/agent/src/backends/__tests__/sdk-backend.test.ts`:

```typescript
describe('permission gates', () => {
  const gateConfig = {
    enabled: true,
    timeout_ms: 300_000,
    rules: [
      { name: 'destructive-rm', pattern: 'rm\\s+-rf', tool: 'Bash', description: 'Recursive delete' },
    ],
  };

  it('gates blocked tool call via requestUserInput when skipPermissions is false', async () => {
    mockQuery.mockReturnValueOnce(
      makeAsyncGen({ type: 'result', subtype: 'success', result: 'done' }) as any,
    );
    const mockInput = vi.fn().mockResolvedValue({ 'question': 'Allow' });
    const backend = new SdkBackend({ skipPermissions: false, permissionGates: gateConfig });
    const request = makeRequest({ requestUserInput: mockInput });

    for await (const _ of backend.execute(request)) { /* drain */ }

    // Verify canUseTool was set in options
    const callArgs = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    const canUseTool = callArgs[0].options.canUseTool;
    expect(canUseTool).toBeDefined();

    // Simulate a gated tool call
    const result = await canUseTool('Bash', { command: 'rm -rf /home' }, { signal: new AbortController().signal });
    expect(mockInput).toHaveBeenCalled();
  });

  it('auto-allows non-matching tool calls', async () => {
    mockQuery.mockReturnValueOnce(
      makeAsyncGen({ type: 'result', subtype: 'success', result: 'done' }) as any,
    );
    const mockInput = vi.fn();
    const backend = new SdkBackend({ skipPermissions: false, permissionGates: gateConfig });
    const request = makeRequest({ requestUserInput: mockInput });

    for await (const _ of backend.execute(request)) { /* drain */ }

    const callArgs = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    const canUseTool = callArgs[0].options.canUseTool;
    const result = await canUseTool('Bash', { command: 'ls -la' }, { signal: new AbortController().signal });
    expect(result).toEqual({ behavior: 'allow' });
    expect(mockInput).not.toHaveBeenCalled();
  });

  it('skips gates when skipPermissions is true (bypass mode)', async () => {
    mockQuery.mockReturnValueOnce(
      makeAsyncGen({ type: 'result', subtype: 'success', result: 'done' }) as any,
    );
    const backend = new SdkBackend({ skipPermissions: true, permissionGates: gateConfig });
    const request = makeRequest();

    for await (const _ of backend.execute(request)) { /* drain */ }

    // In bypass mode, permissionMode is bypassPermissions — canUseTool only handles AskUserQuestion
    const callArgs = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    expect(callArgs[0].options.permissionMode).toBe('bypassPermissions');
  });

  it('denies when requestUserInput returns null (timeout)', async () => {
    mockQuery.mockReturnValueOnce(
      makeAsyncGen({ type: 'result', subtype: 'success', result: 'done' }) as any,
    );
    const mockInput = vi.fn().mockResolvedValue(null);
    const backend = new SdkBackend({ skipPermissions: false, permissionGates: gateConfig });
    const request = makeRequest({ requestUserInput: mockInput });

    for await (const _ of backend.execute(request)) { /* drain */ }

    const callArgs = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    const canUseTool = callArgs[0].options.canUseTool;
    const result = await canUseTool('Bash', { command: 'rm -rf /home' }, { signal: new AbortController().signal });
    expect(result.behavior).toBe('deny');
    expect(result.message).toContain('timed out');
  });

  it('allows when user approves', async () => {
    mockQuery.mockReturnValueOnce(
      makeAsyncGen({ type: 'result', subtype: 'success', result: 'done' }) as any,
    );
    const mockInput = vi.fn().mockResolvedValue({ 'approve': 'Allow' });
    const backend = new SdkBackend({ skipPermissions: false, permissionGates: gateConfig });
    const request = makeRequest({ requestUserInput: mockInput });

    for await (const _ of backend.execute(request)) { /* drain */ }

    const callArgs = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    const canUseTool = callArgs[0].options.canUseTool;
    const result = await canUseTool('Bash', { command: 'rm -rf /home' }, { signal: new AbortController().signal });
    expect(result.behavior).toBe('allow');
  });

  it('denies when user selects Deny', async () => {
    mockQuery.mockReturnValueOnce(
      makeAsyncGen({ type: 'result', subtype: 'success', result: 'done' }) as any,
    );
    const mockInput = vi.fn().mockResolvedValue({ 'approve': 'Deny' });
    const backend = new SdkBackend({ skipPermissions: false, permissionGates: gateConfig });
    const request = makeRequest({ requestUserInput: mockInput });

    for await (const _ of backend.execute(request)) { /* drain */ }

    const callArgs = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    const canUseTool = callArgs[0].options.canUseTool;
    const result = await canUseTool('Bash', { command: 'rm -rf /home' }, { signal: new AbortController().signal });
    expect(result.behavior).toBe('deny');
    expect(result.message).toContain('denied');
  });

  it('allows gated tools when requestUserInput is not available (system jobs)', async () => {
    mockQuery.mockReturnValueOnce(
      makeAsyncGen({ type: 'result', subtype: 'success', result: 'done' }) as any,
    );
    const backend = new SdkBackend({ skipPermissions: false, permissionGates: gateConfig });
    const request = makeRequest({ permissionLevel: 'system' });

    for await (const _ of backend.execute(request)) { /* drain */ }

    // System jobs bypass permissions entirely
    const callArgs = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    expect(callArgs[0].options.permissionMode).toBe('bypassPermissions');
  });

  it('still handles AskUserQuestion when gates are active', async () => {
    mockQuery.mockReturnValueOnce(
      makeAsyncGen({ type: 'result', subtype: 'success', result: 'done' }) as any,
    );
    const mockInput = vi.fn().mockResolvedValue({ 'What color?': 'Blue' });
    const backend = new SdkBackend({ skipPermissions: false, permissionGates: gateConfig });
    const request = makeRequest({ requestUserInput: mockInput });

    for await (const _ of backend.execute(request)) { /* drain */ }

    const callArgs = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    const canUseTool = callArgs[0].options.canUseTool;
    const result = await canUseTool('AskUserQuestion', { questions: [{ question: 'What color?' }] }, { signal: new AbortController().signal });
    expect(result.behavior).toBe('allow');
    expect(result.updatedInput.answers).toEqual({ 'What color?': 'Blue' });
  });

  it('skips gates when permission_gates.enabled is false', async () => {
    mockQuery.mockReturnValueOnce(
      makeAsyncGen({ type: 'result', subtype: 'success', result: 'done' }) as any,
    );
    const mockInput = vi.fn();
    const disabledConfig = { ...gateConfig, enabled: false };
    const backend = new SdkBackend({ skipPermissions: false, permissionGates: disabledConfig });
    const request = makeRequest({ requestUserInput: mockInput });

    for await (const _ of backend.execute(request)) { /* drain */ }

    const callArgs = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    const canUseTool = callArgs[0].options.canUseTool;
    const result = await canUseTool('Bash', { command: 'rm -rf /home' }, { signal: new AbortController().signal });
    expect(result).toEqual({ behavior: 'allow' });
    expect(mockInput).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/agent -- --run src/backends/__tests__/sdk-backend.test.ts`
Expected: FAIL — SdkBackendOptions doesn't accept permissionGates

- [ ] **Step 3: Implement the changes**

Modify `packages/agent/src/backends/sdk-backend.ts`:

**3a. Update SdkBackendOptions (line 6):**
```typescript
import type { PermissionGateConfig } from '@ccbuddy/core';
import { PermissionGateChecker } from '../permission-gate.js';

export interface SdkBackendOptions {
  skipPermissions?: boolean;
  permissionGates?: PermissionGateConfig;
}
```

**3b. Add checker to constructor (line 15):**
```typescript
export class SdkBackend implements AgentBackend {
  private options: SdkBackendOptions;
  private gateChecker: PermissionGateChecker | null;

  constructor(options: SdkBackendOptions = {}) {
    this.options = options;
    this.gateChecker = options.permissionGates?.rules
      ? new PermissionGateChecker(options.permissionGates.rules)
      : null;
  }
```

**3c. Rewrite the canUseTool block (lines 80-92):**

Replace the existing `canUseTool` setup with logic that handles both AskUserQuestion and permission gates:

```typescript
// canUseTool — handles AskUserQuestion + permission gates
if (request.requestUserInput) {
  const checker = this.gateChecker;
  const gatesEnabled = this.options.permissionGates?.enabled && !this.options.skipPermissions;
  const gateTimeoutMs = this.options.permissionGates?.timeout_ms ?? 300_000;

  options.canUseTool = async (toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal }) => {
    // AskUserQuestion — existing handler
    if (toolName === 'AskUserQuestion' && request.requestUserInput) {
      const answers = await request.requestUserInput(input.questions as any, opts.signal);
      if (!answers) {
        return { behavior: 'deny', message: 'User did not respond within the timeout period' };
      }
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }

    // Permission gates — check against rules
    if (gatesEnabled && checker) {
      const matched = checker.check(toolName, input);
      if (matched) {
        console.info(`[SdkBackend] Permission gate triggered: "${matched.name}" for tool ${toolName} — awaiting approval`);

        const preview = this.getCommandPreview(toolName, input);
        const answers = await request.requestUserInput!([{
          question: `Po wants to run:\n\`${preview}\``,
          header: `⚠️ ${matched.description}`,
          options: [
            { label: 'Allow', description: 'Execute this command' },
            { label: 'Deny', description: 'Block this command' },
          ],
          multiSelect: false,
        }], opts.signal);

        if (!answers) {
          console.info(`[SdkBackend] Permission gate timed out: "${matched.name}"`);
          return { behavior: 'deny', message: `Approval timed out for: ${matched.description}` };
        }

        const decision = Object.values(answers)[0];
        if (decision === 'Allow') {
          console.info(`[SdkBackend] Permission gate approved: "${matched.name}" by user`);
          return { behavior: 'allow' };
        } else {
          console.info(`[SdkBackend] Permission gate denied: "${matched.name}" by user`);
          return { behavior: 'deny', message: `User denied: ${matched.description}` };
        }
      }
    }

    return { behavior: 'allow' };
  };
}
```

**3d. Add helper method to the class:**

```typescript
private getCommandPreview(toolName: string, input: Record<string, unknown>): string {
  let preview: string;
  switch (toolName) {
    case 'Bash':
      preview = typeof input.command === 'string' ? input.command : JSON.stringify(input);
      break;
    case 'Write':
    case 'Edit':
      preview = typeof input.file_path === 'string' ? `${toolName} ${input.file_path}` : JSON.stringify(input);
      break;
    default:
      preview = `${toolName}: ${JSON.stringify(input)}`;
  }
  return preview.length > 200 ? preview.slice(0, 200) + '...' : preview;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/agent -- --run src/backends/__tests__/sdk-backend.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/backends/sdk-backend.ts packages/agent/src/backends/__tests__/sdk-backend.test.ts
git commit -m "feat(agent): extend canUseTool with permission gates"
```

---

## Chunk 3: Bootstrap Wiring, Config & Dashboard

### Task 4: Wire permission gates in bootstrap

**Files:**
- Modify: `packages/main/src/bootstrap.ts:356-359` (SdkBackend construction)

- [ ] **Step 1: Pass permissionGates to SdkBackend**

In `packages/main/src/bootstrap.ts`, change the SdkBackend construction from:

```typescript
agentService.setBackend(new SdkBackend({ skipPermissions: config.agent.admin_skip_permissions }));
```

To:

```typescript
agentService.setBackend(new SdkBackend({
  skipPermissions: config.agent.admin_skip_permissions,
  permissionGates: config.agent.permission_gates,
}));
```

- [ ] **Step 2: Build**

Run: `npm run build -w packages/main`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/main/src/bootstrap.ts
git commit -m "feat(main): wire permission gates config into SdkBackend"
```

### Task 5: Add permission_gates to config/default.yaml

**Files:**
- Modify: `config/default.yaml` (agent section)

- [ ] **Step 1: Add permission_gates section**

In `config/default.yaml`, add after `user_input_timeout_ms` in the agent section:

```yaml
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

- [ ] **Step 2: Commit**

```bash
git add config/default.yaml
git commit -m "config: add default permission gate rules"
```

### Task 6: Dashboard toggle for admin_skip_permissions

**Files:**
- Create: `packages/dashboard/client/src/components/PermissionGatesToggle.tsx`
- Modify: Dashboard page that contains ModelSelector (add the toggle nearby)

- [ ] **Step 1: Explore dashboard pages**

Run: `ls packages/dashboard/client/src/pages/` to find where ModelSelector is used.

- [ ] **Step 2: Create PermissionGatesToggle component**

Create `packages/dashboard/client/src/components/PermissionGatesToggle.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export function PermissionGatesToggle() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');

  useEffect(() => {
    api.getConfig().then(data => {
      // admin_skip_permissions: true means gates OFF
      setEnabled(!data.config.agent?.admin_skip_permissions);
      setLoading(false);
    });
  }, []);

  const handleToggle = async () => {
    const newValue = !enabled;
    setStatus('');
    try {
      // Flip: gates enabled = admin_skip_permissions false
      const config = (await api.getConfig()).config;
      config.agent = { ...config.agent, admin_skip_permissions: !newValue };
      await api.setConfig(config);
      setEnabled(newValue);
      setStatus('Applied — restart required');
      setTimeout(() => setStatus(''), 3000);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
  };

  if (loading) return null;

  return (
    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-gray-400">Permission Gates</div>
          <div className="text-xs text-gray-600 mt-1">
            {enabled ? 'Po asks before dangerous operations' : 'All operations auto-approved'}
          </div>
        </div>
        <button
          onClick={handleToggle}
          className={`relative w-11 h-6 rounded-full transition-colors ${enabled ? 'bg-green-600' : 'bg-gray-700'}`}
        >
          <span className={`block w-4 h-4 bg-white rounded-full transition-transform absolute top-1 ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>
      {status && (
        <div className={`text-xs mt-2 ${status.startsWith('Error') ? 'text-red-400' : 'text-yellow-400'}`}>{status}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add to the settings area**

In the page that contains `ModelSelector`, import and add `PermissionGatesToggle` next to it:

```tsx
import { PermissionGatesToggle } from '../components/PermissionGatesToggle';

// In the JSX, after <ModelSelector />:
<PermissionGatesToggle />
```

- [ ] **Step 4: Build**

Run: `npm run build -w packages/dashboard`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/client/src/components/PermissionGatesToggle.tsx packages/dashboard/client/src/pages/
git commit -m "feat(dashboard): add permission gates toggle switch"
```

---

## Chunk 4: Final Integration & Verification

### Task 7: Full build and test suite

- [ ] **Step 1: Build all packages**

Run: `npm run build`
Expected: PASS

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: PASS — all existing + new tests pass

- [ ] **Step 3: Manual smoke test**

1. Set `admin_skip_permissions: false` in `config/local.yaml`
2. Restart CCBuddy
3. Ask Po to run something destructive: "run `git reset --hard HEAD~1`"
4. Verify Discord buttons appear: [Allow] [Deny]
5. Click Deny — verify Po reports it couldn't execute
6. Ask again, click Allow — verify it executes
7. Ask Po to run `ls -la` — verify no gate prompt (auto-allowed)
8. Toggle the switch in dashboard back to OFF
9. Restart — verify gates no longer fire

- [ ] **Step 4: Commit if any fixes needed**

```bash
git add -A
git commit -m "chore: integration fixes for permission gates"
```
