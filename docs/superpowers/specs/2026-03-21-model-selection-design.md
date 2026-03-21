# Model Selection & Dynamic Switching

**Date:** 2026-03-21
**Status:** Draft

## Overview

Add configurable model selection to CCBuddy with three layers: a config-driven default, Po's self-assessment for automatic escalation, and user-requested switching via natural language. The current model is always visible to both Po and the user.

## Requirements

1. **Default model** — configurable in `config/*.yaml` and the dashboard (e.g., `sonnet`)
2. **Auto-switch** — Po self-assesses task complexity and escalates to a more powerful model when needed
3. **User-requested switch** — user asks Po to switch (e.g., "switch to opus[1m]") and Po complies
4. **Model reporting** — Po can always tell the user which model it's currently using

## Design Decisions

### Why self-assessment over heuristic classification

Heuristic scoring (message length, code block count, keyword matching) is fragile — a short message like "refactor the entire auth system" scores low but is deeply complex. Po, running inside Claude Code, already understands the task context, the codebase, and what it's about to do. It is in the best position to judge complexity.

This eliminates the need for a separate classification engine, ML model, or heuristic tuning. A system prompt with guidelines is sufficient.

### Why file-based model state

The MCP skills server runs as a child process of each Claude Code SDK session. It cannot call into the main process's SessionStore directly. A small file on disk (`data/sessions/<key>.model`) is the simplest bridge. The gateway reads it synchronously before building each `AgentRequest`.

The **model file is the authoritative source** for per-session model overrides. The `SessionStore.model` field is a read-through cache — always populated by reading the file. If the file does not exist, there is no override (use config default). This avoids divergence between two sources of truth.

### Session key propagation to MCP subprocess

The MCP skills server subprocess needs to know which session it belongs to in order to read/write the correct model file. The session key is passed via the `CCBUDDY_SESSION_KEY` environment variable in the MCP server spec's `env` field, set per-request when the gateway builds the `AgentRequest`. The bootstrap wiring sets this dynamically for each `query()` call.

### Atomic file writes

Model file writes use atomic write semantics: write to a `.tmp` file, then `rename()` to the final path. This prevents the gateway from reading a corrupt or partial file if the MCP process crashes mid-write.

### One-message delay for auto-escalation

When Po decides to escalate, the switch takes effect on the **next** `query()` call, not the current one. This is acceptable because:
- For simple tasks that don't need escalation, running on a powerful model is harmless
- For complex tasks, Po does preliminary analysis on the current model and the heavy lifting happens on the next turn
- Restarting the current query with a new model would waste the partial run and add complexity

## Configuration

### Agent config

```yaml
# config/default.yaml
agent:
  model: "sonnet"                # default model for all queries
```

### Per-job model override

```yaml
# config/default.yaml
scheduler:
  jobs:
    morning_briefing:
      model: "opus"              # override for this specific job
    consolidation:
      model: "sonnet"
```

### Valid model values

Any value accepted by the Claude Code SDK/CLI `model` option:
- Aliases: `sonnet`, `opus`, `haiku`, `opus[1m]`, `sonnet[1m]`, `opusplan`
- Full IDs: `claude-sonnet-4-6`, `claude-opus-4-6`, etc.

### Model validation

Both the `switch_model` MCP tool and the `PUT /api/config/model` endpoint validate model values against a known-good list of aliases and ID patterns before accepting them. Invalid values return a clear error message without waiting for the SDK/CLI to reject them at query time.

The allowed list is maintained in `packages/core` and shared across all consumers:

```typescript
const KNOWN_MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'opus[1m]', 'sonnet[1m]', 'opusplan', 'default'];
const MODEL_ID_PATTERN = /^claude-[a-z]+-[\d-]+$/;
```

## Architecture

### Per-Session Model State

The `SessionStore` gains a `model` field:

```typescript
interface SessionEntry {
  sdkSessionId: string;
  model: string | null;    // null = use config default
  lastActivity: number;
}
```

When a session expires or resets, the model resets to the config default. The `SessionStore.tick()` cleanup must also delete orphaned `data/sessions/<key>.model` files for expired sessions.

### MCP Tools

The skills MCP server exposes two new tools:

#### `switch_model`

```typescript
{
  name: "switch_model",
  description: "Switch the model for subsequent messages in this session",
  inputSchema: {
    type: "object",
    properties: {
      model: {
        type: "string",
        description: "Model alias or ID (e.g., 'sonnet', 'opus[1m]', 'claude-opus-4-6')"
      }
    },
    required: ["model"]
  }
}
```

**Behavior:** Writes `{ "model": "<value>" }` to `data/sessions/<sessionKey>.model`. Returns confirmation text like "Model switched to opus[1m]. This takes effect on the next message."

#### `get_current_model`

```typescript
{
  name: "get_current_model",
  description: "Get the model currently configured for this session",
  inputSchema: {
    type: "object",
    properties: {}
  }
}
```

**Behavior:** Reads and returns the current model (from the model file, or config default if no override).

### System Prompt Injection

The gateway injects model awareness into Po's system prompt:

```
You are currently running on model: {{current_model}}.

You have access to `switch_model` and `get_current_model` tools.

When to switch to a more powerful model (e.g., opus[1m]):
- Multi-file refactors or architectural changes
- Complex debugging requiring deep reasoning
- Tasks involving unfamiliar or intricate code patterns
- When you feel uncertain about your approach

When to switch back to the default model (e.g., sonnet):
- After completing the complex portion of work
- For simple questions, status checks, casual conversation

You may also be asked by the user to switch models — just call switch_model.
```

### Data Flow

```
User message arrives
        |
        v
   Gateway.handleIncomingMessage()
        |
        +-- Look up session in SessionStore
        +-- Read session.model (or check model file at data/sessions/<key>.model)
        +-- Fall back to config.agent.model if null
        |
        v
   Build AgentRequest { ..., model: "sonnet" }
        |
        v
   SdkBackend.execute()
        +-- query({ prompt, options: { model: "sonnet", ... } })
        |
        |   During execution, Po may call:
        |   +-- switch_model({ model: "opus[1m]" })
        |   |     -> writes data/sessions/<key>.model
        |   +-- get_current_model()
        |         -> reads current model
        |
        v
   Response returned to user
        |
        v
   Next message arrives
        +-- Gateway reads updated model file -> "opus[1m]"
        +-- Syncs to SessionStore
        +-- AgentRequest { ..., model: "opus[1m]" }
```

Scheduler/system jobs skip the session lookup — they read `job.model` from scheduler config, falling back to `config.agent.model`.

### Event Bus Integration

When the gateway detects a model change (model file differs from SessionStore cache), it emits a `session.model_changed` event:

```typescript
eventBus.publish('session.model_changed', {
  sessionId,
  userId,
  platform,
  previousModel: string,
  newModel: string,
});
```

The dashboard WebSocket relays this event for real-time model badge updates.

### Backend Changes

#### SdkBackend

Pass `model` through to the SDK `query()` options:

```typescript
const options: Record<string, any> = {
  model: request.model,           // NEW
  allowedTools: request.allowedTools,
  cwd: request.workingDirectory,
  // ...existing options
};
```

#### CliBackend

Pass `--model` flag when present:

```typescript
if (request.model) {
  args.push('--model', request.model);
}
```

### Dashboard Integration

#### Global default model selector

- Located in a settings/config section of the dashboard
- Dropdown with model aliases (`sonnet`, `opus`, `opus[1m]`, `haiku`, etc.)
- Changes the runtime default via a new REST endpoint `PUT /api/config/model`
- Persisted to `data/runtime-config.json` (survives restarts, does not modify `config/*.yaml` files)
- Takes effect on new sessions immediately
- Dashboard UI indicates the override source (config file vs. runtime override)

#### Per-session model display

- Shows the active model next to each session entry in the sessions view
- Updates in real-time via the existing WebSocket connection
- Read-only — model switching for active sessions is done by talking to Po

### REST API

New/modified endpoints:

- `GET /api/config/model` — returns `{ model: string, source: "config" | "runtime_override" }`
- `PUT /api/config/model` — sets runtime model override `{ model: string }`
- `GET /api/sessions` — existing endpoint, response gains `model` field per session

## Files to Create or Modify

### Core (`packages/core`)
- `src/config/schema.ts` — add `model?: string` to `AgentConfig`, add `model?: string` to `ScheduledJobConfig`
- `src/config/defaults.ts` — add default model value
- `src/types/agent.ts` — add `model?: string` to `AgentRequest`

### Agent (`packages/agent`)
- `src/backends/sdk-backend.ts` — pass `model` to `query()` options
- `src/backends/cli-backend.ts` — pass `--model` flag
- `src/session/session-store.ts` — add `model` field to session entries

### Gateway (`packages/gateway`)
- `src/gateway.ts` — read model from session/config, inject into `AgentRequest` and system prompt, emit `session.model_changed` event

### Scheduler (`packages/scheduler`)
- `src/cron-runner.ts` — pass `job.model` (or config default) into `AgentRequest`

### Skills (`packages/skills`)
- MCP server gains `switch_model` and `get_current_model` tools
- Tools read/write `data/sessions/<sessionKey>.model` files using atomic writes
- Session key read from `CCBUDDY_SESSION_KEY` env var

### Main (`packages/main`)
- `src/bootstrap.ts` — pass `CCBUDDY_SESSION_KEY` env var to MCP server spec per-request

### Dashboard (`packages/dashboard`)
- API: new `GET/PUT /api/config/model` endpoints
- API: extend `GET /api/sessions` response with `model` field
- Client: model selector component in settings
- Client: model badge in sessions list

### Config
- `config/default.yaml` — add `agent.model: "sonnet"` default

## Testing

- Unit tests for model field propagation through `AgentRequest` → backends
- Unit tests for `switch_model` / `get_current_model` MCP tools (file read/write)
- Unit tests for gateway model resolution (session override > config default)
- Unit tests for session expiry resetting model to default
- Unit tests for model validation (known aliases, ID patterns, rejection of invalid values)
- Unit tests for atomic file write (corrupt/missing file handling)
- Unit tests for session expiry cleaning up model files
- Integration test: model file written by MCP tool is picked up by gateway on next request
- Integration test: concurrent model switches on the same session
- Dashboard API tests for `GET/PUT /api/config/model`
- Dashboard API tests for runtime override persistence across restart
