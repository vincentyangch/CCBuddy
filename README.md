# CCBuddy

CCBuddy is a personal AI assistant that runs continuously on a Mac Mini and is reachable through Discord and the built-in dashboard.

This file is the top-level operator runbook. For architecture and implementation detail, see [CLAUDE.md](/Users/flyingchickens/Projects/CCBuddy/CLAUDE.md).

## What Lives Here

- `bin/start.mjs`
  LaunchAgent/manual entrypoint.
- `config/default.yaml`
  Default configuration.
- `config/local.yaml`
  Local overrides and `${ENV_VAR}` references.
- `data/`
  Runtime logs, PID file, heartbeat status, runtime model override, database files.
- `packages/`
  Monorepo packages for agent, gateway, memory, dashboard, scheduler, platforms, and supporting modules.

## Requirements

- Node.js `>=22 <23`
- npm `10.x`
- `claude` CLI available in `PATH`
- macOS `launchd` for the managed production run path

Optional, depending on enabled features:

- `OPENAI_API_KEY`
  Required when `media.voice_enabled: true`
- `CCBUDDY_DASHBOARD_TOKEN`
  Required when `dashboard.enabled: true`
- `DISCORD_BOT_TOKEN`
  Required when Discord is enabled
- `TELEGRAM_BOT_TOKEN`
  Required when Telegram is enabled
- `HOMEASSISTANT_URL` and `HOMEASSISTANT_TOKEN`
  Required when the Home Assistant MCP integration is in use

## Quick Start

Install dependencies:

```bash
npm install
```

Build everything:

```bash
npm run build
```

Start manually from the repo root:

```bash
node bin/start.mjs
```

Manual start uses the built `packages/main/dist/bootstrap.js`, so build first.

## Normal Runtime

CCBuddy is normally managed by macOS `launchd` through:

```text
~/Library/LaunchAgents/com.ccbuddy.agent.plist
```

The LaunchAgent should point at this repo, the intended Node 22 binary, and the required environment variables.

## Restarting CCBuddy

Use these commands when you want launchd to fully re-read the plist or restart the service cleanly:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
```

Do **not** use:

```bash
launchctl stop com.ccbuddy.agent
```

`stop` does not reload plist changes.

## Dashboard

Dashboard defaults in [config/default.yaml](/Users/flyingchickens/Projects/CCBuddy/config/default.yaml):

- `dashboard.enabled: false`
- `dashboard.host: "127.0.0.1"`
- `dashboard.port: 18801`
- `dashboard.auth_token_env: "CCBUDDY_DASHBOARD_TOKEN"`

Local overrides usually live in [config/local.yaml](/Users/flyingchickens/Projects/CCBuddy/config/local.yaml).

If the dashboard is enabled, the backend is served by the main CCBuddy process. The React client used during development can be started separately:

```bash
npm run dev:client -w @ccbuddy/dashboard
```

The dev server expects the backend on `http://localhost:18801` and proxies `/api` and `/ws` there.

### Theme

The dashboard supports:

- system theme
- explicit dark mode
- explicit light mode

The current dashboard theme preference is persisted in browser local storage under:

```text
dashboard_theme
```

If the dashboard theme seems stuck or wrong, clear that key in the browser.

## Common Commands

Build all packages:

```bash
npm run build
```

Run all tests:

```bash
npm test
```

Run a package build:

```bash
npm run build -w @ccbuddy/dashboard
```

Run a package test suite:

```bash
npm run test -w @ccbuddy/dashboard
```

## Smoke Test

Memory consolidation and backup smoke test:

```bash
npx tsx scripts/smoke-test-consolidation.ts
```

What it does:

1. copies the live SQLite memory database into a temp directory
2. verifies backup creation and integrity
3. seeds test messages
4. runs real consolidation through the Claude path
5. checks backup rotation

Notes:

- it requires the live memory database to exist
- it calls the real `claude` CLI
- it leaves a temp directory behind and prints the cleanup path at the end

## Data And Logs

Important runtime files under [data/](/Users/flyingchickens/Projects/CCBuddy/data):

- `ccbuddy.log`
  App-level log written by `bin/start.mjs`
- `ccbuddy.stdout.log`
  Process stdout
- `ccbuddy.stderr.log`
  Process stderr
- `ccbuddy.pid`
  PID lock file
- `heartbeat-status.json`
  Latest heartbeat snapshot
- `runtime-config.json`
  Runtime model override written by the dashboard/model selection flow
- `memory.sqlite`
  Main SQLite memory database

Useful tails:

```bash
tail -f data/ccbuddy.log
tail -f data/ccbuddy.stdout.log
tail -f data/ccbuddy.stderr.log
```

## Configuration Notes

Config resolution order:

1. built-in defaults
2. `config/default.yaml`
3. `config/local.yaml`
4. environment placeholder expansion like `${ENV_VAR}`
5. `CCBUDDY_*` environment overrides

Use [config/local.yaml](/Users/flyingchickens/Projects/CCBuddy/config/local.yaml) for machine-specific settings. Keep secrets in environment variables referenced from YAML, not plain text.

## Operations Checklist

When changing runtime behavior:

1. edit config or code
2. rebuild if code changed:
   ```bash
   npm run build
   ```
3. restart with `bootout` + `bootstrap`
4. tail logs
5. confirm heartbeat is healthy
6. if dashboard is enabled, confirm login and UI behavior

## Troubleshooting

### Dashboard says unauthorized

Check that the env var named by `dashboard.auth_token_env` is set in the environment of the running process. By default that is:

```text
CCBUDDY_DASHBOARD_TOKEN
```

If the dashboard backend starts without it, it will fail startup.

### Voice is enabled but voice features do not work

Check:

```text
OPENAI_API_KEY
```

When `media.voice_enabled: true` and `OPENAI_API_KEY` is missing, bootstrap disables or rejects voice functionality depending on the path.

### `better-sqlite3` native module mismatch

If Node version changes and the native module ABI is wrong, rebuild:

```bash
npm rebuild better-sqlite3
```

`bin/start.mjs` also attempts this automatically on startup when it detects a module-version mismatch.

### Duplicate instance or startup blocked

CCBuddy uses a PID lock at:

```text
data/ccbuddy.pid
```

Bootstrap now handles PID lock cleanup more safely than before, but if the process crashes hard you should inspect:

- `data/ccbuddy.pid`
- `data/ccbuddy.log`
- `data/ccbuddy.stderr.log`

Do not blindly delete files unless you have confirmed there is no active CCBuddy process.

### Dashboard works in dark mode but some page looks wrong in light mode

The dashboard visual system now supports both modes, but the fastest sanity check is:

1. refresh the browser
2. toggle between dark/light/system
3. clear the `dashboard_theme` local-storage key
4. confirm the backend is running and the latest frontend bundle is loaded

If needed, rebuild and restart:

```bash
npm run build
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
```

### Claude path problems

Several flows depend on the `claude` CLI being callable by the running environment:

- smoke test
- some heartbeat checks
- CLI fallback paths

Check:

```bash
claude --version
```

If that fails under launchd but works in your shell, fix the LaunchAgent `PATH`.

## References

- [CLAUDE.md](/Users/flyingchickens/Projects/CCBuddy/CLAUDE.md)
- [config/default.yaml](/Users/flyingchickens/Projects/CCBuddy/config/default.yaml)
- [config/local.yaml](/Users/flyingchickens/Projects/CCBuddy/config/local.yaml)
- [bin/start.mjs](/Users/flyingchickens/Projects/CCBuddy/bin/start.mjs)
- [scripts/smoke-test-consolidation.ts](/Users/flyingchickens/Projects/CCBuddy/scripts/smoke-test-consolidation.ts)
