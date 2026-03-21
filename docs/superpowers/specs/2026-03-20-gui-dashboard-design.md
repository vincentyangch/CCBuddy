# GUI Dashboard Design

**Date:** 2026-03-20
**Status:** Approved

## Overview

A web-based admin dashboard for CCBuddy, built with Vite + React + Tailwind CSS. Served from Po's process via a Fastify server that exposes REST APIs and a WebSocket for real-time events. Accessible locally and via Tailscale with simple token authentication.

The dashboard provides five views: system status, live SDK sessions with Claude Code-style chat replay, historical conversation browser, real-time log viewer, and a tabbed config editor.

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
- **Active sessions** — count from SessionManager, with session keys listed
- **Queue depth** — current request queue size from AgentService
- **Uptime** — derived from process start time

Auto-refreshes via WebSocket `heartbeat.status` events (every 60s from heartbeat, or on-demand poll).

### 2. Sessions

**List view** — table of active and recently active SDK sessions:
- Columns: session key, user, platform, channel type (DM/group), last activity, status (active/idle/expired)
- Data source: SessionStore (active sessions) + SessionManager (lifecycle state)
- Auto-updates via WebSocket events

**Detail view** (click a session) — full chat history with Claude Code-style rendering:
- User messages and assistant responses
- **Collapsible thinking blocks** — expandable sections showing Claude's reasoning
- **Tool-use blocks** — tool name, input, output, with syntax highlighting for code
- **Streaming indicators** — show when a session is actively processing
- Data source: SQLite `messages` table filtered by `sessionId`, plus real-time `agent.progress` events via WebSocket for active sessions

The chat rendering components (ChatMessage, ThinkingBlock, ToolUseBlock) are the most complex UI in the dashboard and should be implemented as isolated, reusable React components.

### 3. Conversations

Historical message browser distinct from live Sessions:
- **Paginated table** — messages from SQLite `messages` table
- **Filters** — user, platform, date range, search text (LIKE query)
- **Expandable rows** — click to see full message content and any attachment metadata
- Data source: MessageStore queries (`getByUser`, `getByTimeRange`, `search`)

### 4. Logs

Real-time log viewer:
- **Three log sources** — `ccbuddy.stdout.log`, `ccbuddy.stderr.log`, `ccbuddy.log` (selectable tabs or dropdown)
- **Auto-scroll** — follows new lines, with a pause button to freeze scrolling
- **Filter** — by log level (info/warn/error) and search text
- **Line limit** — shows last N lines (configurable, default 500), loads more on scroll-up
- Data source: Server reads log files and streams new lines via WebSocket; initial load via REST endpoint

### 5. Config

Tabbed editor for `config/local.yaml`. Each tab renders a form with appropriate input types. Save writes the full config back to `config/local.yaml` and triggers a config reload in Po's process.

**Tabs:**
| Tab | Config Section | Key Fields |
|-----|---------------|------------|
| General | root | `data_dir`, `log_level` |
| Agent | `agent` | `backend`, `max_concurrent_sessions`, `session_timeout_ms`, `rate_limits`, `admin_skip_permissions` |
| Users | `users` | User list with `name`, `role`, platform IDs (`discord_id`, `telegram_id`) |
| Platforms | `platforms` | Discord/Telegram: `enabled`, `token`, channel activation modes |
| Scheduler | `scheduler` | `timezone`, `jobs` (cron expressions, prompts, targets) |
| Memory | `memory` | `max_context_tokens`, `message_retention_days`, `consolidation_cron`, `backup_cron` |
| Media | `media` | `max_file_size_mb`, `voice_enabled`, `tts_max_chars` |
| Skills | `skills` | `generated_dir`, `sandbox_enabled`, `require_admin_approval_for_elevated` |
| Webhooks | `webhooks` | `enabled`, `port`, `endpoints` |
| Apple | `apple` | `enabled`, `helper_path`, `shortcuts_enabled` |

**Sensitive fields** (tokens, secrets) are masked in the UI and shown as `••••••` with a reveal toggle. They are only sent to the server when explicitly changed.

**Config reload**: After saving, the server re-runs the config loader and updates in-memory config. Services that cache config values at startup (e.g., rate limits) will pick up changes on their next tick cycle. Some changes (e.g., platform tokens) require a full restart — the UI will indicate this.

## API Layer (Fastify)

### Authentication

All API routes (except `POST /api/auth`) require `Authorization: Bearer <token>` header. The token is compared against the value from the env var specified by `dashboard.auth_token_env`. Invalid or missing tokens return `401`.

### REST Endpoints

| Method | Path | Description | Data Source |
|--------|------|-------------|-------------|
| `POST` | `/api/auth` | Validate token | Config env var |
| `GET` | `/api/status` | Health + sessions + queue | heartbeat JSON, AgentService, SessionStore |
| `GET` | `/api/sessions` | Active SDK sessions | SessionStore, SessionManager |
| `GET` | `/api/sessions/:key/messages` | Chat history for a session | SQLite `messages` table |
| `GET` | `/api/conversations` | Paginated message search | SQLite `messages` table |
| `GET` | `/api/logs` | Recent log lines | Log files on disk |
| `GET` | `/api/config` | Current config (secrets redacted) | Config loader |
| `PUT` | `/api/config` | Update local.yaml + reload | Config writer + loader |

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

Authenticated via token in the initial connection query string (`?token=...`).

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

**Log streaming:** The WebSocket also supports a `subscribe:logs` message from the client, which starts tailing a log file and streaming new lines as `{ "type": "log.line", "data": { "file": "stdout", "line": "..." } }` events.

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
        config.ts        — GET/PUT /api/config
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
2. Call `dashboardServer.start()` after gateway starts
3. Register `dashboardServer.stop()` in ShutdownHandler

## Dependencies

**Server-side (packages/dashboard):**
- `fastify` — HTTP server
- `@fastify/static` — serve built React app
- `@fastify/websocket` — WebSocket support
- `@fastify/cors` — CORS for dev mode (Vite dev server on different port)
- `tail` (or `chokidar`) — file watching for log streaming
- `js-yaml` — read/write config/local.yaml

**Client-side (Vite build):**
- `react`, `react-dom` — UI framework
- `react-router-dom` — client-side routing
- `tailwindcss` — utility CSS
- A syntax highlighter (e.g., `prism-react-renderer`) — for code blocks in chat viewer

## What Doesn't Change

- **Event bus** — dashboard subscribes to events, does not publish
- **AgentService, SessionStore** — dashboard reads state, does not modify
- **SQLite stores** — dashboard opens a read-only connection
- **Webhook server** — continues running independently on its own port
- **Existing packages** — no modifications except adding `DashboardConfig` to core config schema and wiring in bootstrap

## Security Considerations

- **Token auth** — simple but sufficient for a single-user tool on a private tailnet
- **Config editing** — only writes to `config/local.yaml`, not `default.yaml`. Secrets are env var references (`${ENV_VAR}`), not plaintext.
- **Read-only SQLite** — dashboard opens the database in read-only mode
- **No agent invocation** — dashboard cannot trigger agent requests or execute commands
- **Host binding** — defaults to `0.0.0.0` for Tailscale access. If `CCBUDDY_DASHBOARD_TOKEN` is not set, the server refuses to start (fail-safe).

## Testing Strategy

- **Server unit tests:** Each route handler tested with mock dependencies (mock AgentService, mock MessageStore, etc.)
- **WebSocket tests:** Verify event forwarding, auth rejection, log streaming
- **Config tests:** Validate config read/write roundtrip, secret redaction, reload trigger
- **Client tests:** Component tests for ChatMessage, ThinkingBlock, ToolUseBlock rendering
- **Integration test:** Full server start, auth flow, fetch status, WebSocket connection
