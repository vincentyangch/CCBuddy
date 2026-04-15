# CCBuddy

CCBuddy is a personal AI assistant running on a Mac Mini, accessible via Discord (and future platforms). It uses Claude Code (unmodified) as its brain — every task routes through CC's SDK.

## Architecture

Monorepo (`npm workspaces` + `turbo`). All modules communicate via an in-process event bus — no module directly imports another.

```
packages/
  core/        — shared types, config loader, UserManager, event bus, media utils
  agent/       — AgentService + backends (SdkBackend, CliBackend, CodexSdkBackend, CodexCliBackend)
  gateway/     — message routing, activation logic, chunker
  memory/      — SQLite-backed message/summary/profile stores, context assembler, consolidation
  scheduler/   — cron-based jobs (briefings, consolidation, backups, heartbeat)
  orchestrator/— ShutdownHandler
  skills/      — SkillRegistry, MCP server for dynamic skills
  apple/       — Apple integrations (Calendar, Reminders, Notes, Shortcuts) via swift-bridge + jxa-bridge
  platforms/
    discord/   — Discord.js adapter
    telegram/  — Telegram adapter
  dashboard/   — Fastify API server + React client for GUI dashboard
  main/        — bootstrap (wires everything together)
```

## Key Files

- `bin/start.mjs` — LaunchAgent entrypoint
- `packages/main/src/bootstrap.ts` — application wiring, PID lock, startup sequence
- `packages/gateway/src/gateway.ts` — message handling pipeline
- `packages/gateway/src/activation.ts` — channel activation mode logic
- `packages/agent/src/backends/sdk-backend.ts` — Claude Code SDK integration
- `packages/core/src/config/schema.ts` — all config types + defaults
- `config/default.yaml` — default configuration
- `config/local.yaml` — user overrides (gitignored, contains secrets via `${ENV_VAR}`)

## Config

Config loads in order: DEFAULT_CONFIG → `config/default.yaml` → `config/local.yaml` → env placeholders → `CCBUDDY_*` env overrides. See `packages/core/src/config/loader.ts`.

## Runtime

- Managed by macOS `launchd` via `~/Library/LaunchAgents/com.ccbuddy.agent.plist`
- PID lockfile at `data/ccbuddy.pid` prevents duplicate instances (see `acquirePidLock` in bootstrap)
- Logs: `data/ccbuddy.stdout.log`, `data/ccbuddy.stderr.log`, `data/ccbuddy.log`
- SDK backend must be imported AFTER Discord.js connects (side-effect conflict — see bootstrap comment)
- `better-sqlite3` native module must match the Node.js version in the plist

## Important Patterns

- **Activation modes:** Channels can be `mode: "all"` (respond to everything) or `mode: "mention"` (require @mention). Unconfigured channels default to mention-only. DMs always respond.
- **User identity:** Users mapped via `*_id` fields in config (e.g., `discord_id`). UserManager builds O(1) lookup index.
- **Skills:** Dynamic MCP tools. Generated skills live in `skills/generated/`. The skill MCP server runs as a subprocess of each Claude agent session.
- **Memory:** LCM-inspired DAG summarization. Messages stored in SQLite, condensed nightly. Context assembled per-user per-session.
- **Conversation continuity:** SDK sessions are resumed via `query({ resume: uuid })`. SessionStore maps session keys to SDK UUIDs with configurable idle timeout (default 1 hour). DMs use per-user keys; group channels share one key.
- **Dashboard:** Fastify server (port 18801) + React SPA. Token auth via `CCBUDDY_DASHBOARD_TOKEN` env var. REST API + WebSocket for real-time events. Enable with `dashboard.enabled: true` in config.
- **Interactive follow-ups:** Po can ask clarifying questions mid-task via the SDK's `AskUserQuestion` tool. Questions appear as Discord buttons (with "Other" for free-text). Configurable timeout (default 5 min) via `agent.user_input_timeout_ms`.
- **Streaming responses:** Thinking (💭) and response (💬) stream into separate Discord messages with independent char budgets. Tool use (🔧) indicators appear in the thinking message. Falls back to wait-for-complete when adapter lacks `editMessage` or for voice responses.
- **Model selection:** Configurable default model (`agent.model`). Po can switch models mid-session via `switch_model` MCP tool. Per-session model state stored in `sessions` DB table. Dashboard has model selector + per-session badges. Runtime override persisted to `data/runtime-config.json`.
- **Permission gates:** Configurable regex rules intercept dangerous tool calls (rm -rf, destructive git, local config, launchctl, npm publish). When `admin_skip_permissions: false`, the SDK's `canUseTool` callback gates matched tools via Discord/webchat approval buttons. Dashboard has toggle switch.
- **Granular permissions:** Three user roles: `admin` (all tools), `trusted` (configurable safe set via `trusted_allowed_tools`), `chat` (no tools). Permission gates still apply for trusted users.
- **Web chat:** Dashboard `/chat` route provides browser-based chat with Po. `WebChatAdapter` implements `PlatformAdapter` in the dashboard package. Supports text, images, files, voice, streaming, thinking/tool_use visibility, and session management (new/delete/history).
- **Session persistence:** Sessions persist to SQLite `sessions` table. Survive restarts via `hydrate()`. Explicit pause/resume via `pause_session` MCP tool. Dashboard shows active/paused/archived sessions with filters and delete.
- **Notification preferences:** `NotificationService` sends proactive alerts (health, memory, errors, new sessions) via Discord DM or configured channel. Per-user preferences (config defaults + ProfileStore overrides). Quiet hours with queuing. MCP tools: `notification_get`, `notification_set`, `notification_mute`.
- **Multi-directory workspaces:** Per-channel working directory via `set_workspace` MCP tool. Stored in `workspaces` SQLite table. Gateway resolves workspace before building AgentRequest, falls back to `default_working_directory`.
- **Context compaction:** Proactive compaction at configurable turn threshold (default 50). Summarizes conversation, archives old SDK session, starts fresh with summary as context. Reactive fallback catches SDK context overflow errors. User sees "*(conversation compacted — continuing)*".
- **Codex backend:** Alternative agent backend using OpenAI Codex (`@openai/codex-sdk`). Configure via `agent.backend: "codex-sdk"` or `"codex-cli"`. Supports streaming, session resumption (threads), MCP, reasoning traces, image attachments, and sandbox-based permissions. Does NOT support interactive permission gates (`canUseTool`), AskUserQuestion, or granular `allowedTools`. Codex config under `agent.codex` in config. Model selector auto-filters to backend-appropriate models. See design doc `2026-04-14-codex-backend-design.md`.

## Commands

```bash
npm run build          # Build all packages
npm run test           # Run all tests (vitest)
npm test -w packages/X # Run tests for specific package
npm run build -w packages/main  # Build specific package
```

## Restart CCBuddy

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
```

Do NOT use `launchctl stop` — it doesn't re-read plist changes.

## Design Docs

Full specifications live in `docs/superpowers/specs/`:
- `2026-03-16-ccbuddy-design.md` — master design spec (architecture, all modules)
- `2026-03-17-scheduler-design.md` — scheduler and cron jobs
- `2026-03-17-self-evolving-skills-design.md` — dynamic skill creation
- `2026-03-19-morning-briefings-design.md` — morning/evening briefings
- `2026-03-19-media-handling-design.md` — attachment processing
- `2026-03-19-memory-consolidation-backup-design.md` — memory lifecycle
- `2026-03-19-evening-briefing-design.md` — evening briefing format
- `2026-03-19-apple-calendar-design.md` — Apple Calendar integration
- `2026-03-20-conversation-continuity-design.md` — session resumption and continuity
- `2026-03-20-gui-dashboard-design.md` — GUI dashboard architecture
- `2026-03-20-interactive-followups-design.md` — mid-task clarifying questions
- `2026-03-20-session-conflict-detection-design.md` — directory locking
- `2026-03-20-streaming-responses-design.md` — streaming thinking/response messages
- `2026-03-20-voice-messages-design.md` — voice transcription and TTS
- `2026-03-21-context-compaction-design.md` — automatic context compaction
- `2026-03-21-dashboard-webchat-design.md` — browser-based web chat
- `2026-03-21-granular-permissions-design.md` — trusted role with tool allowlist
- `2026-03-21-model-selection-design.md` — runtime model switching
- `2026-03-21-multi-directory-workspaces-design.md` — per-channel working directories
- `2026-03-21-notification-preferences-design.md` — proactive notifications with preferences
- `2026-03-21-permission-gates-design.md` — dangerous tool call gating
- `2026-03-21-session-history-persistence-design.md` — session persistence and pause/resume
- `2026-03-26-scheduler-memory-persistence-design.md` — scheduler state persistence
- `2026-04-08-local-skills-state-design.md` — local skill state management
- `2026-04-09-dashboard-review-improvement-design.md` — dashboard review improvements
- `2026-04-09-pid-lock-safety-design.md` — PID lock safety improvements
- `2026-04-09-request-scoped-outbound-media-design.md` — request-scoped outbound media
- `2026-04-10-dashboard-phase4-signal-deck-design.md` — signal deck phase 4 dashboard redesign
- `2026-04-14-codex-backend-design.md` — Codex backend integration (feature matrix, gaps, implementation)
