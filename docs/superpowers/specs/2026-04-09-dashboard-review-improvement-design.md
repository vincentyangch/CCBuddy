# Dashboard Review and Improvement Design

**Date:** 2026-04-09
**Status:** Draft
**Author:** flyingchickens + Codex

## 1. Overview

CCBuddy's dashboard currently works as a collection of useful internal tools, but it does not yet behave like a coherent product. The navigation treats monitoring, chat, logs, sessions, and config editing as peers, the settings experience mirrors raw config structure instead of operator intent, and the visual design does not establish a strong product center or usable hierarchy.

This design reframes the dashboard as a settings-first personal control center for CCBuddy:

1. safe and understandable configuration comes first
2. operations and monitoring become a clearly secondary workspace
3. conversations and chat remain available, but no longer define the product architecture

This design also resolves the existing config-flattening bug by separating editable persisted config from effective resolved config.

## 2. Review Summary

### 2.1 Current Strengths

The dashboard already provides meaningful building blocks:

1. auth and API boundaries exist
2. status, sessions, logs, and chat all have working foundations
3. the server API is small enough to evolve without a platform rewrite
4. React routing is already in place, so information architecture can be reorganized without changing the deployment model

### 2.2 Current Problems

The main problems are product-level, not just styling-level.

#### A. The dashboard has no dominant job

Today [App.tsx](/Users/flyingchickens/Projects/CCBuddy/.worktrees/dashboard-review-plan/packages/dashboard/client/src/App.tsx) gives equal weight to:

- `Status`
- `Chat`
- `Sessions`
- `Conversations`
- `Logs`
- `Config`

That makes the shell feel like an internal toolbox rather than a deliberate control surface.

#### B. Settings are shaped around config keys, not operator goals

[ConfigPage.tsx](/Users/flyingchickens/Projects/CCBuddy/.worktrees/dashboard-review-plan/packages/dashboard/client/src/pages/ConfigPage.tsx) recursively renders the config object and groups it by technical sections such as:

- `Agent`
- `Memory`
- `Skills`
- `Webhooks`
- `Apple`

This exposes implementation structure instead of helping an operator answer:

- what is this setting for?
- where is this value coming from?
- is this safe to change here?
- will this change persist or is it only a runtime override?

#### C. Config editing is currently unsafe

[server/index.ts](/Users/flyingchickens/Projects/CCBuddy/.worktrees/dashboard-review-plan/packages/dashboard/src/server/index.ts) currently:

1. serves the live resolved config through `GET /api/config`
2. restores only redacted platform tokens from in-memory config on `PUT /api/config`
3. writes the resulting object directly to `config/local.yaml`

That means `${ENV_VAR}` placeholders can be flattened into literal plaintext values on save.

#### D. The visual design lacks hierarchy and intention

The current shell and pages are functional, but generic:

1. [main.css](/Users/flyingchickens/Projects/CCBuddy/.worktrees/dashboard-review-plan/packages/dashboard/client/src/main.css) contains no dashboard design system beyond Tailwind import
2. page-level styling is improvised route by route
3. the left rail and content pane establish almost no product-specific identity
4. status, settings, and workspace surfaces all use similar visual weight regardless of priority

#### E. Workspace pages overlap conceptually

The current routes blur together:

- [ChatPage.tsx](/Users/flyingchickens/Projects/CCBuddy/.worktrees/dashboard-review-plan/packages/dashboard/client/src/pages/ChatPage.tsx) is a live interaction surface
- [SessionsPage.tsx](/Users/flyingchickens/Projects/CCBuddy/.worktrees/dashboard-review-plan/packages/dashboard/client/src/pages/SessionsPage.tsx) is runtime session management
- [ConversationsPage.tsx](/Users/flyingchickens/Projects/CCBuddy/.worktrees/dashboard-review-plan/packages/dashboard/client/src/pages/ConversationsPage.tsx) is a raw searchable message browser
- [LogsPage.tsx](/Users/flyingchickens/Projects/CCBuddy/.worktrees/dashboard-review-plan/packages/dashboard/client/src/pages/LogsPage.tsx) is a developer-facing log tail

They are individually useful, but the architecture does not clearly explain how they differ or which one should be used for what.

## 3. Product Direction

The dashboard should be a **settings-first personal admin console** for CCBuddy.

This is not primarily:

1. a generic operations panel
2. a developer log viewer
3. a chat-first workspace

It is primarily:

1. the place where you understand how CCBuddy is configured
2. the place where you safely change persistent behavior
3. the place where you verify runtime state after changes

Monitoring, chat, sessions, and logs remain important, but they support that core job instead of competing with it.

## 4. Goals

1. Make settings the dominant and most understandable part of the dashboard.
2. Fix the config editing model so `${ENV_VAR}` placeholders are preserved safely.
3. Separate editable persisted config from effective runtime config.
4. Reorganize navigation around operator goals rather than internal config sections.
5. Improve visual hierarchy, identity, and readability across the dashboard.
6. Clarify the roles of Operations and Workspace views.
7. Create a foundation that can later grow into richer config provenance UX without redesigning the backend again.

## 5. Non-Goals

1. This design does not replace the dashboard framework or move away from Fastify + React.
2. This design does not require a full design system or component library migration before useful progress can happen.
3. This design does not aim to make the dashboard multi-tenant or role-heavy.
4. This design does not redesign the chat protocol itself.
5. This design does not attempt a full “settings product” with arbitrarily complex per-field provenance controls in the first implementation pass.

## 6. Information Architecture

### 6.1 Top-Level Structure

The dashboard should be reorganized into three top-level areas:

1. `Settings`
2. `Operations`
3. `Workspace`

`Settings` should be the default landing area.

### 6.2 Settings

`Settings` becomes the product center.

Instead of mirroring raw config sections, it should be organized by operator intent:

1. `Identity & Access`
2. `Models & Agent Behavior`
3. `Platforms & Channels`
4. `Memory & Retention`
5. `Automation & Scheduler`
6. `Media & Voice`
7. `Advanced`

Each settings section should:

1. explain what the settings control
2. distinguish editable values from derived/effective values
3. indicate value source where relevant
4. make unsafe or restart-sensitive changes explicit

### 6.3 Operations

`Operations` becomes the operational support area.

Recommended subsections:

1. `Health`
   - heartbeat/modules/system metrics
   - runtime model and queue state
2. `Sessions`
   - active/paused/archived session management
   - runtime status by channel or user
3. `Logs`
   - technical inspection and incident debugging

This area should answer:

- is CCBuddy healthy?
- what is active right now?
- what just happened technically?

### 6.4 Workspace

`Workspace` becomes the interaction and review area.

Recommended subsections:

1. `Chat`
   - live conversation with CCBuddy
2. `Conversation History`
   - search and review of past messages

This removes the current conceptual overlap between `Sessions` and `Conversations`.

## 7. Config Model

This is the most important architectural change.

### 7.1 Split Config Concepts

The dashboard should distinguish three views of configuration:

1. **Editable Local Config**
   - the persisted `config/local.yaml` representation
   - this is the only config model the settings editor may write
2. **Effective Config**
   - the resolved runtime view after defaults, env expansion, and runtime overrides
   - read-only in the dashboard
3. **Field Source Metadata**
   - indicates whether an effective value comes from:
     - default
     - local config
     - environment variable
     - runtime override

### 7.2 Why This Split

This solves the current secret-handling problem at the right layer.

If the editor only operates on persisted local config:

1. `${ENV_VAR}` placeholders remain intact naturally
2. local edits do not round-trip through resolved plaintext values
3. the UI can explain value provenance without writing unsafe data back to disk

### 7.3 API Direction

Recommended server endpoints:

1. `GET /api/settings/local`
   - returns editable local config representation
2. `PUT /api/settings/local`
   - validates and writes persisted local config only
3. `GET /api/settings/effective`
   - returns read-only resolved config
4. `GET /api/settings/meta`
   - returns field metadata such as source, restart requirement, secrecy, and documentation hints

The existing `/api/config` shape should eventually be replaced or demoted to an advanced/debug API rather than remain the primary editor contract.

## 8. Settings UX Model

### 8.1 Default Experience

The default settings experience should not be a recursive object renderer.

Instead, each section should use:

1. a section summary
2. grouped setting cards or forms
3. clear labels and short explanatory text
4. per-field source/status badges where useful

### 8.2 Field States

Each field should be able to communicate at least:

1. current effective value
2. current editable local value, if any
3. source badge
   - `local`
   - `env`
   - `default`
   - `runtime override`
4. whether change requires restart, reload, or applies immediately

### 8.3 Secrets

Secret-like fields should never silently round-trip through plaintext resolved values.

Recommended behavior:

1. if a secret is controlled by `${ENV_VAR}`, show that it is env-backed
2. do not expose the resolved secret value by default
3. if the user wants to replace it with a literal local value, require explicit action
4. if the user leaves it untouched, preserve the existing placeholder

### 8.4 Advanced Editing

There should still be an `Advanced` area for expert-level editing, but it should be clearly separate from the guided settings UX.

This area may expose:

1. raw `local.yaml` editing
2. effective config inspection
3. diagnostics/provenance views

It should not be the default path for ordinary configuration changes.

## 9. Operations UX

### 9.1 Health

The current status page should evolve into a proper `Health` view.

It should include:

1. high-signal summary cards
2. current model/runtime state
3. queue depth and agent reachability
4. module health with severity emphasis
5. recent operational anomalies or alerts

Controls like model override and permission gates should move into `Settings`, not remain embedded in the health view.

### 9.2 Sessions

The sessions page should become an operational queue/session management tool, not just a table.

It should answer:

1. what is active now?
2. what is stalled or archived?
3. which model is each session using?
4. which channel/user is affected?

### 9.3 Logs

Logs should remain technical and secondary.

The goal is not to make logs beautiful, but to make them clearly separate from health status and easier to filter when needed.

## 10. Workspace UX

### 10.1 Chat

The live chat surface remains useful, but should be visually and product-wise subordinate to the admin console.

It should feel like:

1. a convenient embedded interaction tool
2. not the central identity of the dashboard

### 10.2 Conversation History

The raw message browser should become a clearer history/review surface rather than a peer to sessions.

That means:

1. better distinction between session-level records and message-level records
2. clearer history/search semantics
3. less overlap with live chat navigation

## 11. Visual Direction

The redesign should move away from the current generic dark-panel look.

### 11.1 Desired Feel

The interface should feel:

1. deliberate
2. personal
3. technical but understandable
4. settings-first rather than “developer leftovers”

### 11.2 Shell

The shell should establish stronger hierarchy than the current simple left rail:

1. a more intentional primary navigation
2. a stronger page header pattern
3. visible relationship between section, subsection, and current state

### 11.3 Design System Layer

Instead of relying on ad hoc route-local styling, create a small dashboard design layer with:

1. page templates
2. surface styles
3. typography scale
4. spacing rhythm
5. color tokens
6. status semantics

This does not require a heavy component system. It does require a shared visual grammar.

### 11.4 Page Composition

Each major page should use a consistent rhythm:

1. page heading and context
2. high-signal summary or controls
3. main working area
4. secondary diagnostics/details

That alone will make the dashboard feel significantly more intentional.

## 12. Backend Changes

The dashboard server should evolve from its current “directly expose config object” model.

Recommended backend changes:

1. add local/effective/meta settings endpoints
2. add a persisted-config loader for `config/local.yaml`
3. preserve placeholders and comments where feasible, or at minimum preserve placeholder values even if comment fidelity is lost
4. validate writes against config schema before persisting
5. annotate fields with metadata useful to the UI:
   - secret or not
   - restart required
   - source type
   - section/category

## 13. Frontend Changes

Recommended frontend work:

1. replace `ConfigPage` with a settings shell and intent-based subsections
2. move model override and permission gating into the settings domain
3. refactor navigation so `Settings` is first-class and default
4. introduce a small shared CSS/system layer
5. simplify route overlap in workspace and operations

## 14. Phased Implementation Strategy

This should be treated as a coordinated multi-phase project.

### Phase 1: Safe Config Foundation

1. introduce local/effective/meta settings APIs
2. stop writing resolved config back to `local.yaml`
3. preserve `${ENV_VAR}` placeholders correctly
4. add backend tests for placeholder round-tripping

This phase resolves the current safety bug and creates the foundation for the rest.

### Phase 2: Settings Information Architecture

1. replace the current recursive config page
2. introduce settings sections by operator intent
3. move existing stray controls into settings
4. add source and restart-status cues

### Phase 3: Operations and Workspace Clarification

1. split health, sessions, logs, chat, and history into cleaner roles
2. remove conceptual overlap between sessions and conversations
3. improve page-specific summaries and actions

### Phase 4: Visual Redesign

1. redesign the shell
2. create shared page/surface styles
3. improve typography, hierarchy, and visual identity

### Phase 5: Advanced Settings and Provenance Enhancements

1. add richer field-source display
2. add advanced/raw config tools
3. optionally evolve toward more explicit provenance controls

## 15. Testing

Recommended testing additions:

1. server tests for:
   - editable local config loading
   - effective config read-only output
   - placeholder preservation on save
   - secret redaction behavior
2. client tests for:
   - settings navigation and section rendering
   - save behavior for editable local config
   - source badge and restart-status rendering
3. integration tests for:
   - env-backed secret remains `${ENV_VAR}` after dashboard save
   - explicit local override replaces placeholder only when intended

## 16. Recommendation

Implement this as a **settings-first admin console redesign**, beginning with the config-model split.

That means:

1. do not start with pure visual polish
2. do not keep `/api/config` as the primary editing contract
3. fix the config model first, then rebuild settings UX on top of it

This is the smallest path that meaningfully improves:

1. safety
2. clarity
3. product coherence
4. visual quality

without overcommitting to a much larger provenance-heavy UX before the foundations are sound.
