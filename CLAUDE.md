# CCBuddy

CCBuddy is a personal AI assistant running on a Mac Mini, accessible via Discord (and future platforms). It uses Claude Code (unmodified) as its brain — every task routes through CC's SDK.

## Architecture

Monorepo (`npm workspaces` + `turbo`). All modules communicate via an in-process event bus — no module directly imports another.

```
packages/
  core/        — shared types, config loader, UserManager, event bus, media utils
  agent/       — AgentService + backends (SdkBackend, CliBackend)
  gateway/     — message routing, activation logic, chunker
  memory/      — SQLite-backed message/summary/profile stores, context assembler, consolidation
  scheduler/   — cron-based jobs (briefings, consolidation, backups, heartbeat)
  orchestrator/— ShutdownHandler
  skills/      — SkillRegistry, MCP server for dynamic skills
  apple/       — Apple Calendar integration via swift-helper
  platforms/
    discord/   — Discord.js adapter
    telegram/  — Telegram adapter
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
- `2026-03-20-session-conflict-detection-design.md` — directory locking
- `2026-03-20-voice-messages-design.md` — voice transcription and TTS
