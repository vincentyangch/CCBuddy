# GUI Dashboard Design

**Date:** 2026-03-20
**Status:** Approved

## Overview

A web-based admin dashboard for CCBuddy, built with Vite + React + Tailwind CSS. Served from Po's process via a Fastify server that exposes REST APIs and a WebSocket for real-time events. Accessible locally and via Tailscale with simple token authentication.

The dashboard provides five views: system status, live SDK sessions with Claude Code-style chat replay, historical conversation browser, real-time log viewer, and a tabbed config editor.

## Prerequisites

### Enhanced Agent Progress Events

The current `SdkBackend` only yields `complete` and `error` events — it does not emit intermediate events (thinking, tool use, assistant text chunks). The `AgentProgressEvent` type only carries `type: 'text' | 'tool_use'` with a flat `content: string`.

For the Claude Code-style chat replay in the Sessions detail view, the agent event pipeline must be enhanced **before** the dashboard can render rich session data:

1. **Extend `SdkBackend`** to yield intermediate events from the SDK stream:
   - `assistant` messages (text chunks)
   - `tool_use` events with tool name, input JSON, and output
   - `thinking` events with reasoning content
2. **Extend `AgentProgressEvent`** with structured fields:
   - `toolInput?: string`, `toolOutput?: string` for tool-use events
   - A new `thinking` event type with content
3. **Store progress events in SQLite** for historical replay (currently ephemeral — only emitted via event bus). Add an `agent_events` table alongside `messages`.

This enhancement is a separate implementation task that the dashboard depends on. Without it, the Sessions detail view will only show final user/assistant message pairs from the `messages` table — no thinking blocks or tool-use displays.

### MessageStore Pagination

The existing `MessageStore.search()` and `getByUser()` lack `offset`/`limit` pagination. The Conversations page requires paginated queries. Add pagination parameters to `MessageStore` before implementing the Conversations API route.

### Session Data Accessibility

`SessionManager` is private to `AgentService`. The dashboard needs structured session data. Add new getters to `AgentService`:

```typescript
// Expose combined session + SDK session data
getSessionInfo(): Array<{
  sessionKey: string;
  sdkSessionId?: string;
  status: 'active' | 'idle';
  lastActivity: number;
  isGroupChannel: boolean;
}>;
```

This requires `SessionStore` to expose a `getAll()` method and `AgentService` to correlate data from both stores.

## Architecture

```
Browser (React SPA)
  ↕ REST + WebSocket
Fastify Server (in-process, packages/dashboard)
  ↕ direct access
Po internals (event bus, AgentService, SessionStore, SQLite, config, logs)
```

- **Single process** — Fastify runs inside Po alongside the existing webhook server, on a separate port (default `18801`).
- **Static build** — React app compiled by Vite, output to `dist/`, served by Fastify as static files. In development, Vite dev server proxies API requests to Fastify.
- **Real-time** — WebSocket subscribes to Po's event bus and pushes events to connected browser clients.
- **Auth** — Simple token-based. Token stored in `CCBUDDY_DASHBOARD_TOKEN` env var (referenced via `config/local.yaml`). Browser sends it in `Authorization: Bearer <token>` header. On first visit, a login form prompts for the token; it's stored in `localStorage` for subsequent visits.

## Pages

### 1. Status (Landing Page)

Displays system health and operational overview:
- **Health gauges** — CPU, memory, disk usage percentages from heartbeat data
- **Module statuses** — process, database, agent: healthy/degraded/down indicators
- **Active sessions** — count and list from AgentService session info
- **Queue depth** — current request queue size from AgentService
- **Uptime** — derived from process start time

Initial data loaded via `GET /api/status` (reads `data/heartbeat-status.json`). Auto-refreshes via WebSocket `heartbeat.status` events.

### 2. Sessions

**List view** — table of active and recently active SDK sessions:
- Columns: session key, user, platform, channel type (DM/group), last activity, status (active/idle)
- Data source: `AgentService.getSessionInfo()` (combines SessionStore + SessionManager data)
- Auto-updates via WebSocket events

**Detail view** (click a session) — full chat history with Claude Code-style rendering:
- User messages and assistant responses from SQLite `messages` table filtered by `sessionId`
- **Collapsible thinking blocks** — expandable sections showing Claude's reasoning (from `agent_events` table, requires prerequisite)
- **Tool-use blocks** — tool name, input, output, with syntax highlighting for code (from `agent_events` table, requires prerequisite)
- **Streaming indicators** — show when a session is actively processing (from real-time `agent.progress` WebSocket events)

Without the agent progress enhancement prerequisite, this view renders user/assistant message pairs only — still useful, just without the rich intermediate detail.

The chat rendering components (ChatMessage, ThinkingBlock, ToolUseBlock) are the most complex UI in the dashboard and should be implemented as isolated, reusable React components.

### 3. Conversations

Historical message browser distinct from live Sessions:
- **Paginated table** — messages from SQLite `messages` table with `offset`/`limit` pagination
- **Filters** — user, platform, date range, search text (LIKE query on content)
- **Expandable rows** — click to see full message content and any attachment metadata
- Data source: MessageStore queries with pagination support (requires prerequisite)

Platform filtering requires a new query method on MessageStore (or a direct SQL query in the dashboard server) since the existing `search()` only filters by userId.

### 4. Logs

Real-time log viewer:
- **Three log sources** — `ccbuddy.stdout.log`, `ccbuddy.stderr.log`, `ccbuddy.log` (selectable tabs or dropdown)
- **Auto-scroll** — follows new lines, with a pause button to freeze scrolling
- **Filter** — by log level (info/warn/error) and search text
- **Line limit** — shows last N lines (configurable, default 500), loads more on scroll-up
- Data source: Initial load via `GET /api/logs` (reads from disk). Live updates via WebSocket log streaming (file watching with `chokidar` or similar).

### 5. Config

Tabbed editor for `config/local.yaml`. Each tab renders a form with appropriate input types.

**Tabs:**
| Tab | Config Section | Key Fields |
|-----|---------------|------------|
| General | root | `data_dir`, `log_level` |
| Agent | `agent` | `backend`, `max_concurrent_sessions`, `session_timeout_minutes`, `session_timeout_ms`, `rate_limits`, `admin_skip_permissions` |
| Users | `users` | User list with `name`, `role`, platform IDs (`discord_id`, `telegram_id`) |
| Platforms | `platforms` | Discord/Telegram: `enabled`, `token`, channel activation modes |
| Scheduler | `scheduler` | `timezone`, `jobs` (cron expressions, prompts, targets) |
| Memory | `memory` | `max_context_tokens`, `message_retention_days`, `consolidation_cron`, `backup_cron` |
| Media | `media` | `max_file_size_mb`, `voice_enabled`, `tts_max_chars` |
| Skills | `skills` | `generated_dir`, `sandbox_enabled`, `require_admin_approval_for_elevated` |
| Webhooks | `webhooks` | `enabled`, `port`, `endpoints` |
| Apple | `apple` | `enabled`, `helper_path`, `shortcuts_enabled` |

**Sensitive fields** (tokens, secrets) are masked in the UI and shown as `••••••` with a reveal toggle. They are only sent to the server when explicitly changed.

**Save flow:**
1. Client sends `PUT /api/config` with updated config
2. Server validates the config against `CCBuddyConfig` schema
3. Server backs up current `config/local.yaml` to `config/local.yaml.bak`
4. Server writes validated config to `config/local.yaml`
5. Server re-runs config loader and updates in-memory config
6. Server returns success with a list of changes that require restart (e.g., platform tokens, webhook port)
7. If validation fails, server returns `400` with error details — no file is written

**Restart-requiring changes** (UI displays a warning banner when these are modified):
- Platform tokens (`platforms.discord.token`, `platforms.telegram.token`)
- Webhook port (`webhooks.port`)
- Dashboard port (`dashboard.port`)
- Database path (`memory.db_path`)

## API Layer (Fastify)

### Authentication

All API routes (except `POST /api/auth`) require `Authorization: Bearer <token>` header. The token is compared against the value from the env var specified by `dashboard.auth_token_env`. Invalid or missing tokens return `401`.

### REST Endpoints

| Method | Path | Description | Data Source |
|--------|------|-------------|-------------|
| `POST` | `/api/auth` | Validate token | Config env var |
| `GET` | `/api/status` | Health + sessions + queue | `data/heartbeat-status.json`, AgentService |
| `GET` | `/api/sessions` | Active/idle sessions | `AgentService.getSessionInfo()` |
| `GET` | `/api/sessions/:key/messages` | Chat history for a session | SQLite `messages` table (+ `agent_events` when available) |
| `GET` | `/api/conversations` | Paginated message search | SQLite `messages` table |
| `GET` | `/api/logs` | Recent log lines | Log files on disk |
| `GET` | `/api/config` | Current config (secrets redacted) | Config loader |
| `PUT` | `/api/config` | Validate, backup, update local.yaml + reload | Config writer + loader |

**Query parameters for `/api/conversations`:**
- `user` — filter by userId
- `platform` — filter by platform
- `dateFrom`, `dateTo` — ISO date range
- `search` — LIKE search on content
- `page`, `pageSize` — pagination (default pageSize: 50)

**Query parameters for `/api/logs`:**
- `file` — `stdout` | `stderr` | `app` (default: `stdout`)
- `lines` — number of lines to return (default: 500)
- `level` — filter by log level

### WebSocket (`/ws`)

Authenticated via initial message after connection: client sends `{ "type": "auth", "token": "..." }` as the first message. Server validates and either continues (sends `{ "type": "auth.ok" }`) or closes the connection with `4001` status code. This avoids exposing the token in URL query strings.

The server subscribes to Po's event bus and forwards events to connected clients as JSON messages:

```json
{ "type": "heartbeat.status", "data": { ... } }
{ "type": "message.incoming", "data": { ... } }
{ "type": "agent.progress", "data": { ... } }
```

**Forwarded events:**
- `heartbeat.status` — system health updates
- `message.incoming` — new user messages
- `message.outgoing` — assistant responses
- `agent.progress` — thinking/tool-use events (for live session view)
- `alert.health` — module health alerts
- `session.conflict` — directory lock conflicts
- `scheduler.job.complete` — cron job completions

**Log streaming:** The WebSocket supports a `{ "type": "subscribe:logs", "file": "stdout" }` message from the client, which starts tailing the specified log file and streaming new lines as `{ "type": "log.line", "data": { "file": "stdout", "line": "..." } }` events. Send `{ "type": "unsubscribe:logs" }` to stop.

## Package Structure

```
packages/dashboard/
  src/
    server/
      index.ts           — DashboardServer class (Fastify setup, static serving)
      routes/
        auth.ts          — POST /api/auth
        status.ts        — GET /api/status
        sessions.ts      — GET /api/sessions, GET /api/sessions/:key/messages
        conversations.ts — GET /api/conversations
        logs.ts          — GET /api/logs
        config.ts        — GET/PUT /api/config (with validation + backup)
      websocket.ts       — WebSocket handler (event bus → clients, log tailing)
    client/
      main.tsx           — React app entry
      App.tsx            — Router, layout, auth guard
      pages/
        StatusPage.tsx
        SessionsPage.tsx
        SessionDetailPage.tsx
        ConversationsPage.tsx
        LogsPage.tsx
        ConfigPage.tsx
      components/
        ChatMessage.tsx       — renders user/assistant messages
        ThinkingBlock.tsx     — collapsible thinking section
        ToolUseBlock.tsx      — tool invocation display with syntax highlighting
        LogLine.tsx           — single log line with level coloring
        HealthGauge.tsx       — circular/bar gauge for CPU/mem/disk
        ConfigForm.tsx        — generic form renderer for config sections
        AuthGuard.tsx         — login gate component
      hooks/
        useWebSocket.ts      — WebSocket connection + reconnect logic
        useApi.ts            — REST fetch wrapper with auth header
      lib/
        api.ts               — typed API client
    index.ts               — exports DashboardServer class
  vite.config.ts           — Vite config (build output to dist/)
  tailwind.config.js
  tsconfig.json
  package.json
  dist/                    — build output (gitignored)
```

## Config Addition

```yaml
dashboard:
  enabled: true
  port: 18801
  host: "0.0.0.0"
  auth_token_env: "CCBUDDY_DASHBOARD_TOKEN"
```

Added to `DashboardConfig` in `packages/core/src/config/schema.ts` and `DEFAULT_CONFIG`.

## Bootstrap Wiring

In `packages/main/src/bootstrap.ts`:
1. Create `DashboardServer` with config, passing references to: event bus, AgentService, SessionStore, MessageStore, SummaryStore, ProfileStore, config object, log file paths
2. The dashboard opens its own read-only `MemoryDatabase` connection (separate from the write connection used by MessageStore) to avoid contention
3. Call `dashboardServer.start()` after gateway starts
4. Register `dashboardServer.stop()` in ShutdownHandler — must call `EventBus.subscribe()` disposables for cleanup

## Dependencies

**Server-side (packages/dashboard):**
- `fastify` — HTTP server
- `@fastify/static` — serve built React app
- `@fastify/websocket` — WebSocket support
- `@fastify/cors` — CORS for dev mode (Vite dev server on different port)
- `chokidar` — file watching for log streaming
- `js-yaml` — read/write config/local.yaml

**Client-side (Vite build):**
- `react`, `react-dom` — UI framework
- `react-router-dom` — client-side routing
- `tailwindcss` — utility CSS
- `prism-react-renderer` — syntax highlighting for code blocks in chat viewer

## What Doesn't Change

- **Event bus** — dashboard subscribes to events, does not publish
- **AgentService, SessionStore** — dashboard reads state, does not modify (new read-only getters added)
- **SQLite stores** — dashboard uses a separate read-only database connection
- **Webhook server** — continues running independently on its own port
- **Existing packages** — modifications limited to: `DashboardConfig` in core config schema, `getSessionInfo()` on AgentService, `getAll()` on SessionStore, pagination on MessageStore, wiring in bootstrap

## Security Considerations

- **Token auth** — simple but sufficient for a single-user tool on a private tailnet
- **WebSocket auth** — via initial message (not query string) to avoid token in logs/browser history
- **Config editing** — only writes to `config/local.yaml`, not `default.yaml`. Validates against schema before writing. Backs up previous file. Secrets are env var references (`${ENV_VAR}`), not plaintext.
- **Read-only SQLite** — dashboard opens its own read-only database connection
- **No agent invocation** — dashboard cannot trigger agent requests or execute commands
- **Host binding** — defaults to `0.0.0.0` for Tailscale access. If `CCBUDDY_DASHBOARD_TOKEN` is not set, the server refuses to start (fail-safe).

## Testing Strategy

- **Server unit tests:** Each route handler tested with mock dependencies (mock AgentService, mock MessageStore, etc.)
- **WebSocket tests:** Verify event forwarding, auth via initial message, auth rejection, log streaming
- **Config tests:** Validate config read/write roundtrip, secret redaction, schema validation rejection, backup creation, reload trigger
- **Client tests:** Component tests for ChatMessage, ThinkingBlock, ToolUseBlock rendering
- **Integration test:** Full server start, auth flow, fetch status, WebSocket connection
