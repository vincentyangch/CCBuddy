# Codex Backend Integration Design

**Date:** 2026-04-14
**Status:** Implemented (Phase 1-4 complete)
**Author:** CCBuddy development

## 1. Overview

This document specifies how to add OpenAI Codex as an alternative agent backend in CCBuddy, alongside the existing Claude SDK and Claude CLI backends. The goal is to implement `CodexSdkBackend` and `CodexCliBackend` that satisfy the existing `AgentBackend` interface, preserving all current features where Codex supports them and documenting gaps where it does not.

### Codex Platform Summary

| Component | Version | Notes |
|---|---|---|
| CLI | `@openai/codex` 0.120.0 | Interactive TUI + `codex exec --experimental-json` for NDJSON |
| TS SDK | `@openai/codex-sdk` 0.120.0 | Thin wrapper over CLI; spawns child process, parses NDJSON |
| Python SDK | `codex-app-server-sdk` 0.3.2 | JSON-RPC over stdio (not relevant for CCBuddy) |
| Core | Rust (`codex-rs/`) | Sandbox, exec policy, tool execution |

## 2. Feature Compatibility Matrix

| CCBuddy Feature | Claude SdkBackend | Claude CliBackend | Codex SDK | Codex CLI | Notes |
|---|---|---|---|---|---|
| **Streaming events** | Full (text, thinking, tool_use) | None (collect final) | Full (`runStreamed()` → `AsyncGenerator<ThreadEvent>`) | NDJSON via `codex exec --experimental-json` | Codex SDK streams `item.started`, `item.updated`, `item.completed`, `turn.completed` |
| **Session resumption** | `resume` / `sessionId` params | None | `codex.resumeThread(threadId)` | `codex exec ... resume <thread-id>` | Full parity — Codex threads persist in `~/.codex/sessions` |
| **Permission gates (canUseTool)** | SDK `canUseTool` callback | None | No callback hook | No callback hook | **Gap** — see §3.1 |
| **Interactive follow-ups (AskUserQuestion)** | Via `canUseTool` interception | None | No equivalent hook | No equivalent hook | **Gap** — see §3.2 |
| **MCP servers** | Native (stdio) | `--mcp-config` file | Native (stdio/SSE via `config.toml`) | `config.toml` | Full parity — Codex supports MCP natively |
| **Tool allow/deny** | `allowedTools` array | `--allowedTools` flag | Exec policy rules (`.rules` files) | Same | Different mechanism — see §3.3 |
| **Attachments (images)** | Full content blocks | Metadata-only | `{ type: "local_image", path }` | `--image <path>` | File-path-based; CCBuddy has in-memory `Buffer` — needs temp file |
| **Attachments (files/voice)** | Full content blocks | Metadata-only | Not supported | Not supported | **Gap** — image only |
| **System prompt** | `systemPrompt` param | `--system-prompt` flag | `AGENTS.md` file (max 32 KiB) | Same | Different mechanism — see §3.4 |
| **Memory context injection** | Prepend to prompt | Prepend to prompt | Prepend to prompt | Prepend to prompt | Same approach works |
| **Working directory** | `cwd` option | `--cwd` flag | `workingDirectory` in `ThreadOptions` | `--cd` flag | Full parity |
| **Environment variables** | `env` option | Inherited from process | `env` in `CodexOptions` | Inherited from process | SDK: explicit env replaces `process.env` entirely — see §3.5 |
| **Model selection** | `model` option | `--model` flag | `model` in `ThreadOptions` | `--model` flag | Full parity |
| **Abort/cancellation** | `AbortController` | `SIGTERM` | `AbortSignal` in `TurnOptions` | `SIGTERM` | Full parity |
| **Permission levels** | bypassPermissions / allowedTools / system prompt | Same via CLI flags | `ApprovalMode` + `SandboxMode` | Same via flags | Mapping required — see §3.6 |
| **Context compaction** | Handled externally by SessionStore + gateway | Same | Codex manages context internally per thread | Same | May need different compaction strategy — see §3.7 |
| **Model switching mid-session** | SessionStore.setModel() + next request uses it | Same | `model` param per `thread.run()` call | N/A | Works — can pass different model per turn |

## 3. Gaps and Mitigations

### 3.1 No `canUseTool` Callback

**Impact:** High — CCBuddy's permission gates (destructive command approval) depend on intercepting tool calls before execution and prompting the user.

**Codex alternative:** Codex has an exec policy engine with `.rules` files that classify commands as safe/dangerous and can require approval. However, this is a static rule system, not a runtime callback. There is no way to programmatically intercept a tool call, present a Discord button to the user, and return allow/deny.

**Mitigation options:**

1. **Pre-configured exec policy rules** — Translate CCBuddy's `PermissionGateRule[]` regex patterns into Codex `.rules` file format. This provides static gating but loses the interactive approval UX (Discord buttons). Dangerous commands would be blocked outright rather than gated.

2. **Approval mode `"on-request"`** — Codex's built-in approval mode prompts for confirmation, but this goes to the CLI's TUI, not to Discord. Since CCBuddy spawns Codex as a child process, there's no way to route these prompts.

3. **Accept the gap** — Run Codex sessions with a strict sandbox (`"read-only"` or `"workspace-write"`) and rely on Codex's built-in safety rather than interactive gates. This is the most practical option.

**Recommendation:** Option 3 for initial implementation. Use `SandboxMode: "workspace-write"` for admin/trusted users and `SandboxMode: "read-only"` for chat users. Document that Codex sessions do not support interactive permission approval.

### 3.2 No Interactive Follow-ups (AskUserQuestion)

**Impact:** Medium — Po cannot ask clarifying questions mid-task when running on Codex.

**Codex alternative:** None. Codex has no equivalent to Claude's `AskUserQuestion` tool or `canUseTool` hook for intercepting questions.

**Mitigation:** The Codex backend should ignore the `requestUserInput` callback. Tasks requiring mid-task clarification should fall back to Claude. The gateway could route requests to the appropriate backend based on whether the task is likely to need follow-ups (though this is hard to predict).

**Recommendation:** Accept the gap. Log a warning when `requestUserInput` is provided but unused.

### 3.3 Tool Allow/Deny Mechanism Difference

**Impact:** Low — Different mechanism, same outcome achievable.

CCBuddy passes `allowedTools: string[]` to Claude. Codex uses a different model:
- `ApprovalMode`: `"never"` (full auto), `"on-request"`, `"on-failure"`, `"untrusted"`
- `SandboxMode`: `"read-only"`, `"workspace-write"`, `"danger-full-access"`
- Exec policy `.rules` files for fine-grained command classification

**Mapping:**

| CCBuddy `permissionLevel` | Codex `ApprovalMode` | Codex `SandboxMode` |
|---|---|---|
| `admin` | `"never"` | `"danger-full-access"` |
| `system` | `"never"` | `"danger-full-access"` |
| `trusted` | `"never"` | `"workspace-write"` |
| `chat` | N/A | `"read-only"` + restricted prompt |

For `chat` users, additionally inject a text-only system restriction into the prompt (same as current Claude approach).

### 3.4 System Prompt Injection

**Impact:** Low — solvable with a workaround.

Codex does not accept an arbitrary `systemPrompt` string parameter. Instead, it reads `AGENTS.md` from the working directory (max 32 KiB).

**Mitigation:** Write a temporary `AGENTS.md` file in the working directory before starting the Codex session. Clean up after the session completes. If an `AGENTS.md` already exists, prepend CCBuddy's system prompt as a section and restore the original after.

**Alternative:** Prepend the system prompt to the user prompt (same as `memoryContext` injection). Less clean but avoids filesystem manipulation.

**Recommendation:** Prepend to user prompt for simplicity. The distinction between system prompt and user prompt matters less for Codex's execution model.

### 3.5 Environment Variables

**Impact:** Low — behavioral difference to handle.

When `CodexOptions.env` is provided, the Codex SDK does NOT inherit `process.env` — only the explicitly provided vars. This differs from Claude's SDK where `env` merges with `process.env`.

**Mitigation:** Always spread `process.env` into the Codex env: `env: { ...process.env, ...request.env }`.

### 3.6 Permission Level Mapping

See §3.3 for the mapping table. The key difference is that Codex doesn't have a granular `allowedTools` list — instead it uses sandbox modes and exec policy rules.

For `trusted` users with a specific `trusted_allowed_tools` list, the Codex backend cannot enforce the same granularity. The closest approximation is `workspace-write` sandbox mode, which allows file writes but restricts dangerous system operations.

### 3.7 Context Compaction

**Impact:** Medium — different compaction model.

CCBuddy's compaction logic archives the Claude SDK session and starts a fresh one with a summary. With Codex, threads are the equivalent of sessions. The same approach works: archive the thread ID, start a new thread with the summary prepended to the first prompt.

However, CCBuddy's turn-counting and compaction threshold logic (in gateway) would need to work with Codex's turn tracking. The Codex SDK's `Turn` object includes `usage` (token counts), which could inform compaction decisions.

## 4. Implementation Design

### 4.1 New Package Dependencies

```json
{
  "@openai/codex-sdk": "^0.120.0"
}
```

Add to `packages/agent/package.json`. The Codex CLI (`@openai/codex`) must be installed globally or available in `PATH` (the SDK spawns it as a child process).

### 4.2 CodexSdkBackend

```
packages/agent/src/backends/codex-sdk-backend.ts
```

Primary Codex backend using the official TS SDK. Implements full streaming, session resumption, MCP, and abort.

#### Constructor

```typescript
export interface CodexSdkBackendOptions {
  maxTurns?: number;
  codexPath?: string;        // Override path to codex binary
  apiKey?: string;            // OPENAI_API_KEY override
  networkAccess?: boolean;    // Default: true
}

export class CodexSdkBackend implements AgentBackend {
  private codex: Codex;
  private threads: Map<string, Thread>;          // sessionId → Thread
  private abortControllers: Map<string, AbortController>;

  constructor(options: CodexSdkBackendOptions = {}) { ... }
}
```

#### execute() Flow

```
1. Build CodexOptions:
   - env: { ...process.env, ...request.env }
   - codexPathOverride: options.codexPath

2. Resolve or create Thread:
   - If request.resumeSessionId → codex.resumeThread(resumeSessionId)
   - If request.sdkSessionId → codex.startThread({ threadId: sdkSessionId, ... })
   - Else → codex.startThread({ ... })

3. Build ThreadOptions:
   - workingDirectory: request.workingDirectory
   - model: request.model
   - approvalMode: map from request.permissionLevel (see §3.3)
   - sandboxMode: map from request.permissionLevel (see §3.3)
   - networkAccessEnabled: true (default)

4. Build input:
   - Prepend memoryContext + systemPrompt to prompt text
   - If image attachments → write to temp files, include as { type: "local_image", path }
   - Non-image attachments → metadata-only notes (same as CliBackend)

5. Call thread.runStreamed(input, { signal: abortController.signal }):
   - For each ThreadEvent:
     - item.started (type: "command_execution") → yield { type: 'tool_use', tool: 'Bash' }
     - item.started (type: "file_change") → yield { type: 'tool_use', tool: 'Edit' }
     - item.started (type: "mcp_tool_call") → yield { type: 'tool_use', tool: item.server + '/' + item.tool }
     - item.updated (text content) → yield { type: 'text', content }
     - item.completed (type: "command_execution") → yield { type: 'tool_result', tool, toolInput, toolOutput }
     - turn.completed → yield { type: 'complete', response: finalResponse, sdkSessionId: threadId }
     - error / turn.failed → yield { type: 'error', error: message }

6. Clean up temp image files
```

#### Event Mapping

| Codex ThreadEvent | CCBuddy AgentEvent |
|---|---|
| `thread.started` | (internal — capture threadId) |
| `item.started` (command_execution) | `{ type: 'tool_use', tool: 'Bash' }` |
| `item.started` (file_change) | `{ type: 'tool_use', tool: 'Edit' }` |
| `item.started` (mcp_tool_call) | `{ type: 'tool_use', tool: '<server>/<tool>' }` |
| `item.started` (web_search) | `{ type: 'tool_use', tool: 'WebSearch' }` |
| `item.updated` (text) | `{ type: 'text', content }` |
| `item.completed` (command_execution) | `{ type: 'tool_result', tool, toolInput, toolOutput }` |
| `turn.completed` | `{ type: 'complete', response, sdkSessionId: threadId }` |
| `turn.failed` | `{ type: 'error', error }` |
| `error` | `{ type: 'error', error }` |

Note: Codex does not emit a direct equivalent of `thinking` events. If the model used supports reasoning (o-series), the reasoning trace is not exposed through the SDK's event stream.

### 4.3 CodexCliBackend

```
packages/agent/src/backends/codex-cli-backend.ts
```

Fallback backend that spawns `codex exec --experimental-json` directly, similar to the existing `CliBackend` for Claude. Used when the SDK is unavailable or for simpler execution.

This is structurally identical to the existing `CliBackend` but replaces `claude` with `codex exec` and parses Codex NDJSON instead of Claude NDJSON. Session resumption is available via `codex exec ... resume <thread-id>`.

### 4.4 Configuration

Add to `packages/core/src/config/schema.ts`:

```typescript
export interface AgentConfig {
  // existing fields...
  backend: 'sdk' | 'cli' | 'codex-sdk' | 'codex-cli';
  codex?: {
    api_key_env?: string;         // Default: "OPENAI_API_KEY"
    codex_path?: string;          // Override codex binary path
    network_access?: boolean;     // Default: true
    default_sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  };
}
```

In `config/default.yaml`:

```yaml
agent:
  backend: sdk          # sdk | cli | codex-sdk | codex-cli
  codex:
    api_key_env: OPENAI_API_KEY
    network_access: true
    default_sandbox: workspace-write
```

### 4.5 Bootstrap Changes

In `packages/main/src/bootstrap.ts`, extend backend creation:

```typescript
// Existing:
const backend = new CliBackend();           // transitional CLI

// After platform adapters connect:
if (config.agent.backend === 'sdk') {
  agentService.setBackend(new SdkBackend({ ... }));
} else if (config.agent.backend === 'codex-sdk') {
  const { CodexSdkBackend } = await import('./backends/codex-sdk-backend.js');
  agentService.setBackend(new CodexSdkBackend({ ... }));
} else if (config.agent.backend === 'codex-cli') {
  const { CodexCliBackend } = await import('./backends/codex-cli-backend.js');
  agentService.setBackend(new CodexCliBackend());
}
// 'cli' keeps the CliBackend (existing behavior)
```

### 4.6 SessionStore Compatibility

The `SessionStore` currently stores `sdkSessionId` (a UUID). For Codex, this maps to the thread ID. No changes needed to `SessionStore` — the field name is a misnomer but the semantics are identical:

| Concept | Claude SDK | Codex SDK |
|---|---|---|
| Session identifier | SDK session UUID | Thread ID |
| Resume mechanism | `query({ resume: uuid })` | `codex.resumeThread(threadId)` |
| New session tag | `query({ sessionId: uuid })` | `codex.startThread({ threadId: uuid })` |
| Persistence | `~/.claude/` | `~/.codex/sessions/` |

### 4.7 MCP Server Configuration

Codex reads MCP server config from `config.toml`, not from runtime options. The SDK backend should write a temporary `config.toml` (or use the `config` option on `Codex` constructor) to inject CCBuddy's dynamic MCP servers (skills server, etc.).

```typescript
// In CodexSdkBackend.execute():
const codex = new Codex({
  config: {
    'mcp_servers.skills.type': 'stdio',
    'mcp_servers.skills.command': mcpServer.command,
    'mcp_servers.skills.args': mcpServer.args,
  },
});
```

If the config key format doesn't support this, fall back to writing a temp `config.toml` file and pointing `CODEX_HOME` to its directory.

### 4.8 Model Selection

Codex supports OpenAI models. The `switch_model` MCP tool and dashboard model selector would need awareness of which models are valid per backend:

- **Claude backends:** `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`, etc.
- **Codex backends:** `gpt-5`, `o3`, `o4-mini`, etc.

The model selector UI should filter available models based on the active backend.

## 5. Features That Cannot Be Replicated

### 5.1 Interactive Permission Gates (canUseTool)

**Status:** Not possible with Codex.

Codex has no runtime callback hook for intercepting tool calls. The exec policy engine is static and file-based. There is no way to present a Discord button asking "Allow this command?" and feed the response back into the running Codex session.

**User impact:** Admin users running Codex sessions will not get approval prompts for dangerous commands. Safety relies entirely on sandbox mode and exec policy rules. This changes the security model from "interactive approval" to "pre-configured policy."

### 5.2 Interactive Follow-ups (AskUserQuestion)

**Status:** Not possible with Codex.

Codex cannot ask clarifying questions mid-task and receive answers through a callback. There is no equivalent to Claude's `AskUserQuestion` tool.

**User impact:** Codex sessions are fire-and-forget per turn. If the task is ambiguous, the model will make its best guess rather than asking for clarification.

### 5.3 ~~Thinking/Reasoning Trace Streaming~~ (RESOLVED)

**Status:** Supported — initial analysis was incorrect.

The Codex SDK exposes `ReasoningItem` (`type: "reasoning"`, `text: string`) through `item.updated` events. `CodexSdkBackend` maps these to CCBuddy `thinking` events, enabling the 💭 Discord message feature for Codex sessions when using reasoning models (o-series).

### 5.4 Granular `allowedTools` List

**Status:** No direct equivalent.

Claude accepts `allowedTools: ['Bash', 'Read', 'Edit']` to restrict which tools the agent can use. Codex's tool control is coarser: sandbox modes + exec policy rules. You cannot say "allow Bash but not Write" in Codex.

**User impact:** The `trusted_allowed_tools` config cannot be enforced at the same granularity for Codex sessions. Trusted users get sandbox-level restrictions rather than per-tool restrictions.

### 5.5 Non-Image Attachments

**Status:** Not supported by Codex.

Codex supports local image paths but not arbitrary file or voice attachments as content blocks.

**User impact:** File and voice attachments sent to a Codex session will be described as metadata only (same as current `CliBackend` behavior).

## 6. Migration Path

### Phase 1: CodexSdkBackend (Core)

1. Add `@openai/codex-sdk` dependency
2. Implement `CodexSdkBackend` with streaming, session resumption, MCP, abort
3. Add `codex-sdk` / `codex-cli` backend options to config schema
4. Extend bootstrap to create Codex backends
5. Add tests mirroring existing backend test patterns

### Phase 2: Configuration & Dashboard

1. Add Codex config section to schema and default.yaml
2. Update dashboard model selector to show backend-appropriate models
3. Add backend indicator to session badges in dashboard
4. Update `switch_model` MCP tool to validate models against active backend

### Phase 3: Permission & Safety Adaptation

1. Implement permission level → sandbox mode mapping
2. Write default exec policy rules that mirror current permission gate patterns
3. Add temp `AGENTS.md` / prompt-prepend logic for system prompts
4. Handle image attachment temp-file lifecycle

### Phase 4: Documentation & Testing

1. Update CLAUDE.md with Codex backend documentation
2. Add integration tests with Codex CLI
3. Document feature gaps in operator runbook (README.md)
4. Add troubleshooting section for Codex-specific issues

## 7. Open Questions

1. **Mixed backends per session?** Should CCBuddy support routing some sessions to Claude and others to Codex based on channel/user config? This would require per-channel backend selection in the gateway.

2. **Compaction interop:** If a session starts on Claude and switches to Codex (or vice versa), the compaction summary would bridge two different backends. The summary text is backend-agnostic, so this should work, but testing is needed.

3. **MCP server lifecycle:** Codex's MCP config is file-based (`config.toml`). If multiple concurrent Codex sessions need different MCP servers, each needs its own config directory. This may require per-session temp directories.

4. **Exec policy rule generation:** Should CCBuddy auto-generate `.rules` files from `PermissionGateRule[]` patterns at startup? This would provide static safety equivalent to interactive gates.
