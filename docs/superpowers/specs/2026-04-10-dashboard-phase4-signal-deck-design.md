# Dashboard Phase 4 Signal Deck Design

## Goal

Create a shared dashboard visual system and apply it incrementally without changing dashboard behavior. The dashboard should feel like a compact operator console for CCBuddy: fast to scan, durable for daily use, readable across operations, workspace, and settings surfaces.

This phase follows the Phase 2 and Phase 3 information architecture work:

- Settings owns agent controls and configuration edits.
- Operations contains Status, Runtime Sessions, and Logs.
- Workspace contains Chat and History.
- Admin contains Settings.

## Approved Direction

The approved visual direction is **Signal Deck** with both dark and light modes.

Signal Deck is an industrial utilitarian dashboard style:

- crisp structure
- strong section hierarchy
- visible health and status states
- compact spacing for operational density
- restrained accents instead of decorative effects

The dark and light modes must feel like the same product, not two unrelated themes.

### DFII

- Aesthetic Impact: 4
- Context Fit: 5
- Implementation Feasibility: 5
- Performance Safety: 4
- Consistency Risk: 3
- DFII: 15

The high score reflects that this is a focused style applied to an existing dashboard with simple primitives and no heavy animation or asset requirements.

## Design System

### Theme Behavior

The dashboard supports:

- system preference by default
- explicit theme selection persisted in `localStorage`
- dark mode
- light mode

Initial implementation should expose the theme switch in the dashboard shell, not inside Settings. This is a dashboard display preference, not CCBuddy runtime configuration.

### Tokens

Create CSS variables in `main.css` for:

- backgrounds
- panels
- borders
- text
- muted text
- accent
- success
- warning
- danger
- focus ring
- form surfaces

Use `[data-theme="dark"]` and `[data-theme="light"]` on the app shell or document root.

Dark mode should be the default Signal Deck mode. Light mode should preserve the same structure, contrast intent, and accent semantics with brighter surfaces.

### Typography

Use a local, dependency-free font stack in this phase.

- Display: Georgia or similar serif for strong page headings.
- Body: Avenir Next / Helvetica Neue fallback for readable UI text.
- Code and operational IDs: system monospace.

Do not add remote font dependencies in this phase.

### Shared UI Layer

Add small shared client primitives before restyling pages:

- `PageHeader`
  - domain label
  - title
  - description
  - optional actions
- `Panel`
  - standard bordered content surface
  - optional accent tone
- `StatusPill`
  - success, warning, danger, neutral
- `NavShell` or dashboard shell helpers
  - grouped sidebar
  - theme toggle
- form field conventions in CSS
  - text inputs
  - selects
  - checkboxes
  - buttons

Keep the primitives boring and local. Do not introduce a third-party component library.

## Page Rollout

Use an incremental rollout so each step is easy to verify.

### Slice 1: Shell and Status

Implement tokens, theme state, sidebar styling, and shared primitives. Apply them to:

- dashboard shell
- Status page

This proves operations cards, status pills, links, and theme toggle.

### Slice 2: Runtime Sessions and Logs

Apply the system to:

- Runtime Sessions
- Runtime Session detail
- Logs

This proves tables, dense operational records, log surfaces, and event replay.

### Slice 3: Workspace

Apply the system to:

- Chat
- Chat sidebar
- History

This proves conversation surfaces, message bubbles, filters, and selected chat state.

### Slice 4: Settings

Apply the system to:

- Settings page shell
- Settings grouped tabs
- generated config fields
- runtime model control
- permission gates control

This proves forms, save state, source badges, and mixed runtime/local semantics.

## Constraints

- Preserve routes and API behavior.
- Preserve `/config` compatibility route.
- Preserve dark dashboard usability.
- Keep border radius at 8px or less.
- Avoid gradient-orb decoration and generic AI/SaaS styling.
- Keep text legible and layout-stable on narrow screens.
- Do not make Phase 4 a full product restructuring.
- Avoid adding dependencies unless there is a clear build/runtime need.

## Accessibility

Minimum requirements:

- keyboard-accessible theme toggle
- visible focus state
- sufficient contrast in both modes
- semantic buttons and links
- no color-only status communication where a text label is already practical

## Testing And Verification

For each implementation slice:

- `npm run build -w @ccbuddy/dashboard`
- `npm run test -w @ccbuddy/dashboard`
- `git diff --check`

For the final Phase 4 branch:

- `npm test`

Manual verification:

- load dashboard in dark mode
- load dashboard in light mode
- switch mode and refresh
- check Status, Runtime Sessions, Chat, History, Logs, and Settings for readable text, stable layout, and preserved behavior

## Out Of Scope

- New dashboard APIs
- New runtime features
- Reworking chat/session/history data models
- Replacing Tailwind
- Adding screenshots to automated tests
- Operator README/runbook

## Open Decisions

None for the first implementation slice. The approved direction is Signal Deck with dark and light modes.
