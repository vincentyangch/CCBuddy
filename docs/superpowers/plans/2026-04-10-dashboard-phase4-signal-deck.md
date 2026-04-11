# Dashboard Phase 4 Signal Deck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved Signal Deck dashboard visual system with dark/light modes and apply it incrementally across the dashboard.

**Architecture:** Add a small token-based design layer in the dashboard client, then migrate pages from direct Tailwind color classes to shared Signal Deck primitives. Theme state lives client-side only and persists in `localStorage`; no server API changes are needed.

**Tech Stack:** React 19, React Router 7, Vite 6, Tailwind CSS 4, TypeScript, Vitest for pure client theme tests plus existing server tests.

---

## File Structure

Create:

- `packages/dashboard/client/src/lib/theme.ts`
  - Pure theme helpers for `system`, `dark`, and `light` modes.
  - No React dependencies.
- `packages/dashboard/client/src/lib/theme.test.ts`
  - Unit tests for theme helpers.
- `packages/dashboard/client/src/components/ThemeProvider.tsx`
  - React context provider that applies `data-theme` and persists explicit theme choice.
- `packages/dashboard/client/src/components/ui.tsx`
  - Shared Signal Deck primitives: `PageHeader`, `Panel`, `StatusPill`, `ThemeToggle`, `Button`.

Modify:

- `packages/dashboard/vitest.config.ts`
  - Include the pure client theme tests.
- `packages/dashboard/client/src/main.css`
  - Add Signal Deck tokens and reusable component classes.
- `packages/dashboard/client/src/main.tsx`
  - Wrap `App` in `ThemeProvider`.
- `packages/dashboard/client/src/App.tsx`
  - Apply shell classes and theme toggle.
- `packages/dashboard/client/src/pages/StatusPage.tsx`
  - First page migrated to shared primitives.
- `packages/dashboard/client/src/pages/SessionsPage.tsx`
  - Migrate runtime sessions table and filters.
- `packages/dashboard/client/src/pages/SessionDetailPage.tsx`
  - Migrate runtime event replay containers.
- `packages/dashboard/client/src/pages/LogsPage.tsx`
  - Migrate log shell, tabs, input, and log surface.
- `packages/dashboard/client/src/pages/ChatPage.tsx`
  - Migrate workspace chat layout and message surfaces.
- `packages/dashboard/client/src/components/ChatSidebar.tsx`
  - Migrate chat list and selected states.
- `packages/dashboard/client/src/components/ChatInput.tsx`
  - Migrate input/action controls.
- `packages/dashboard/client/src/components/ChatMessage.tsx`
  - Migrate replay bubbles.
- `packages/dashboard/client/src/components/ThinkingBlock.tsx`
  - Migrate collapsible thinking block.
- `packages/dashboard/client/src/components/ToolUseBlock.tsx`
  - Migrate tool-use block.
- `packages/dashboard/client/src/pages/ConversationsPage.tsx`
  - Migrate History filters and message cards.
- `packages/dashboard/client/src/pages/ConfigPage.tsx`
  - Migrate settings shell, groups, generated fields, and source badges.
- `packages/dashboard/client/src/components/ModelSelector.tsx`
  - Migrate runtime model control.
- `packages/dashboard/client/src/components/AuthGuard.tsx`
  - Migrate login screen.

---

## Task 1: Theme Helpers And Theme Provider

**Files:**
- Create: `packages/dashboard/client/src/lib/theme.ts`
- Create: `packages/dashboard/client/src/lib/theme.test.ts`
- Modify: `packages/dashboard/vitest.config.ts`
- Create: `packages/dashboard/client/src/components/ThemeProvider.tsx`
- Modify: `packages/dashboard/client/src/main.tsx`

- [ ] **Step 1: Write failing theme helper tests**

Create `packages/dashboard/client/src/lib/theme.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveTheme, nextTheme, type ThemePreference } from './theme';

describe('dashboard theme helpers', () => {
  it('uses system preference when preference is system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('uses explicit dark and light preferences', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('cycles through dark, light, and system', () => {
    const order: ThemePreference[] = ['dark', 'light', 'system'];
    expect(order.map(nextTheme)).toEqual(['light', 'system', 'dark']);
  });
});
```

- [ ] **Step 2: Include pure client tests in dashboard Vitest config**

Modify `packages/dashboard/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/__tests__/**/*.test.ts',
      'client/src/**/*.test.ts',
    ],
  },
});
```

- [ ] **Step 3: Run tests and verify the new test fails**

Run:

```bash
npm run test -w @ccbuddy/dashboard -- client/src/lib/theme.test.ts
```

Expected: FAIL because `./theme` does not exist.

- [ ] **Step 4: Implement pure theme helpers**

Create `packages/dashboard/client/src/lib/theme.ts`:

```ts
export type ThemePreference = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'dashboard_theme';

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'system' || value === 'dark' || value === 'light';
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') {
    return systemPrefersDark ? 'dark' : 'light';
  }
  return preference;
}

export function nextTheme(preference: ThemePreference): ThemePreference {
  if (preference === 'dark') return 'light';
  if (preference === 'light') return 'system';
  return 'dark';
}

export function themeLabel(preference: ThemePreference): string {
  if (preference === 'dark') return 'Dark';
  if (preference === 'light') return 'Light';
  return 'System';
}
```

- [ ] **Step 5: Run theme helper tests and verify they pass**

Run:

```bash
npm run test -w @ccbuddy/dashboard -- client/src/lib/theme.test.ts
```

Expected: PASS.

- [ ] **Step 6: Implement ThemeProvider**

Create `packages/dashboard/client/src/components/ThemeProvider.tsx`:

```tsx
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  isThemePreference,
  nextTheme,
  resolveTheme,
  themeLabel,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from '../lib/theme';

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  label: string;
  cycleTheme: () => void;
  setTheme: (theme: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isThemePreference(stored) ? stored : 'system';
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(readStoredTheme);
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  const resolvedTheme = resolveTheme(preference, prefersDark);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => setPrefersDark(query.matches);
    handleChange();
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  }, [preference, resolvedTheme]);

  const value = useMemo<ThemeContextValue>(() => ({
    preference,
    resolvedTheme,
    label: themeLabel(preference),
    cycleTheme: () => setPreference(current => nextTheme(current)),
    setTheme: setPreference,
  }), [preference, resolvedTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return value;
}
```

- [ ] **Step 7: Wrap App with ThemeProvider**

Modify `packages/dashboard/client/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ThemeProvider } from './components/ThemeProvider';
import './main.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
```

- [ ] **Step 8: Verify dashboard build**

Run:

```bash
npm run build -w @ccbuddy/dashboard
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/dashboard/vitest.config.ts \
  packages/dashboard/client/src/lib/theme.ts \
  packages/dashboard/client/src/lib/theme.test.ts \
  packages/dashboard/client/src/components/ThemeProvider.tsx \
  packages/dashboard/client/src/main.tsx
git commit -m "feat(dashboard): add signal deck theme provider"
```

---

## Task 2: Signal Deck Tokens And Shared Primitives

**Files:**
- Modify: `packages/dashboard/client/src/main.css`
- Create: `packages/dashboard/client/src/components/ui.tsx`

- [ ] **Step 1: Add Signal Deck CSS tokens and reusable classes**

Replace `packages/dashboard/client/src/main.css` with:

```css
@import "tailwindcss";

:root {
  font-family: "Avenir Next", "Helvetica Neue", Arial, sans-serif;
  letter-spacing: 0;
  color-scheme: dark;
  --sd-bg: #10110f;
  --sd-bg-grid: rgba(255, 255, 255, 0.035);
  --sd-panel: #151812;
  --sd-panel-raised: #191d15;
  --sd-border: #30362b;
  --sd-border-strong: #47503f;
  --sd-text: #f7f9f2;
  --sd-muted: #a7aea0;
  --sd-subtle: #687060;
  --sd-accent: #8bdc5a;
  --sd-accent-ink: #102008;
  --sd-success: #8bdc5a;
  --sd-warning: #e5c452;
  --sd-danger: #ff5d57;
  --sd-info: #56d6c9;
  --sd-focus: #c7f28f;
  --sd-input: #11140f;
  --sd-radius: 8px;
}

:root[data-theme="light"] {
  color-scheme: light;
  --sd-bg: #f4f6f1;
  --sd-bg-grid: rgba(17, 19, 16, 0.08);
  --sd-panel: #ffffff;
  --sd-panel-raised: #fbfcf7;
  --sd-border: #cbd2c3;
  --sd-border-strong: #77836e;
  --sd-text: #151713;
  --sd-muted: #50584a;
  --sd-subtle: #7b8473;
  --sd-accent: #2f6418;
  --sd-accent-ink: #f4f8ed;
  --sd-success: #2f6418;
  --sd-warning: #9b7414;
  --sd-danger: #b73835;
  --sd-info: #24756c;
  --sd-focus: #2f6418;
  --sd-input: #ffffff;
}

body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
  background:
    linear-gradient(90deg, var(--sd-bg-grid) 1px, transparent 1px),
    linear-gradient(var(--sd-bg-grid) 1px, transparent 1px),
    var(--sd-bg);
  background-size: 34px 34px;
  color: var(--sd-text);
}

button,
input,
textarea,
select {
  font: inherit;
}

button:focus-visible,
a:focus-visible,
input:focus-visible,
textarea:focus-visible,
select:focus-visible {
  outline: 2px solid var(--sd-focus);
  outline-offset: 2px;
}

.sd-shell {
  min-height: 100vh;
  display: flex;
  background: transparent;
  color: var(--sd-text);
}

.sd-sidebar {
  width: 13.5rem;
  border-right: 1px solid var(--sd-border);
  background: color-mix(in srgb, var(--sd-panel) 92%, transparent);
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: .25rem;
}

.sd-main {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 1.5rem;
}

.sd-panel {
  border: 1px solid var(--sd-border);
  border-radius: var(--sd-radius);
  background: var(--sd-panel);
}

.sd-panel-accent {
  border-top: 5px solid var(--sd-accent);
}

.sd-input {
  border: 1px solid var(--sd-border);
  border-radius: var(--sd-radius);
  background: var(--sd-input);
  color: var(--sd-text);
}

.sd-button {
  border-radius: var(--sd-radius);
  background: var(--sd-accent);
  color: var(--sd-accent-ink);
  font-weight: 600;
}

.sd-button-secondary {
  border: 1px solid var(--sd-border);
  border-radius: var(--sd-radius);
  background: var(--sd-panel-raised);
  color: var(--sd-muted);
}
```

- [ ] **Step 2: Add shared primitives**

Create `packages/dashboard/client/src/components/ui.tsx`:

```tsx
import { useTheme } from './ThemeProvider';

export function PageHeader({
  domain,
  title,
  description,
  actions,
}: {
  domain: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-[color:var(--sd-subtle)]">{domain}</div>
        <h2 className="mt-1 font-serif text-3xl font-bold leading-tight text-[color:var(--sd-text)]">{title}</h2>
        {description && <p className="mt-1 text-sm text-[color:var(--sd-muted)]">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </div>
  );
}

export function Panel({
  children,
  className = '',
  accent = false,
}: {
  children: React.ReactNode;
  className?: string;
  accent?: boolean;
}) {
  return (
    <div className={`sd-panel ${accent ? 'sd-panel-accent' : ''} ${className}`}>
      {children}
    </div>
  );
}

export function StatusPill({
  tone,
  children,
}: {
  tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info';
  children: React.ReactNode;
}) {
  const color = {
    success: 'var(--sd-success)',
    warning: 'var(--sd-warning)',
    danger: 'var(--sd-danger)',
    neutral: 'var(--sd-subtle)',
    info: 'var(--sd-info)',
  }[tone];

  return (
    <span
      className="inline-flex items-center rounded-[var(--sd-radius)] border px-2 py-0.5 text-xs font-medium"
      style={{ borderColor: color, color }}
    >
      {children}
    </span>
  );
}

export function ThemeToggle() {
  const { label, cycleTheme, resolvedTheme } = useTheme();
  return (
    <button
      type="button"
      onClick={cycleTheme}
      className="sd-button-secondary px-3 py-2 text-xs uppercase tracking-wide hover:text-[color:var(--sd-text)]"
      title={`Theme: ${label}`}
    >
      {resolvedTheme === 'dark' ? 'Dark' : 'Light'} · {label}
    </button>
  );
}

export function Button({
  children,
  variant = 'primary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary';
}) {
  return (
    <button
      {...props}
      className={`${variant === 'primary' ? 'sd-button' : 'sd-button-secondary'} ${className}`}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 3: Verify dashboard build**

Run:

```bash
npm run build -w @ccbuddy/dashboard
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/client/src/main.css packages/dashboard/client/src/components/ui.tsx
git commit -m "feat(dashboard): add signal deck design primitives"
```

---

## Task 3: Shell And Status Page

**Files:**
- Modify: `packages/dashboard/client/src/App.tsx`
- Modify: `packages/dashboard/client/src/pages/StatusPage.tsx`

- [ ] **Step 1: Update dashboard shell and nav**

Modify `packages/dashboard/client/src/App.tsx` to import `ThemeToggle`:

```tsx
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { AuthGuard } from './components/AuthGuard';
import { ThemeToggle } from './components/ui';
```

Replace `Layout` with:

```tsx
function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="sd-shell">
      <nav className="sd-sidebar">
        <h1 className="mb-5 border border-[color:var(--sd-border)] px-3 py-3 font-mono text-sm font-bold text-[color:var(--sd-accent)]">
          CCBuddy
        </h1>
        {navGroups.map(group => (
          <div key={group.label} className="mb-3">
            <div className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-[color:var(--sd-subtle)]">
              {group.label}
            </div>
            <div className="flex flex-col gap-1">
              {group.items.map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    `rounded-[var(--sd-radius)] px-3 py-2 text-sm ${isActive ? 'bg-[color:var(--sd-accent)] text-[color:var(--sd-accent-ink)]' : 'text-[color:var(--sd-muted)] hover:bg-[color:var(--sd-panel-raised)] hover:text-[color:var(--sd-text)]'}`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
        <div className="mt-auto flex flex-col gap-2">
          <ThemeToggle />
          <button
            onClick={() => { localStorage.removeItem('dashboard_token'); window.location.reload(); }}
            className="sd-button-secondary px-3 py-2 text-left text-sm hover:text-[color:var(--sd-danger)]"
          >
            Sign Out
          </button>
        </div>
      </nav>
      <main className="sd-main">{children}</main>
    </div>
  );
}
```

- [ ] **Step 2: Update Status page imports**

Modify `packages/dashboard/client/src/pages/StatusPage.tsx` imports:

```tsx
import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { PageHeader, Panel, StatusPill } from '../components/ui';
```

- [ ] **Step 3: Update Status components**

Replace `Gauge` and `StatusBadge` with:

```tsx
function Gauge({ label, value }: { label: string; value: number }) {
  const tone = value > 80 ? 'danger' : value > 60 ? 'warning' : 'info';
  const color = tone === 'danger'
    ? 'var(--sd-danger)'
    : tone === 'warning'
      ? 'var(--sd-warning)'
      : 'var(--sd-info)';

  return (
    <Panel accent className="p-4">
      <div className="mb-2 text-sm text-[color:var(--sd-muted)]">{label}</div>
      <div className="mb-2 text-3xl font-bold">{Math.round(value)}%</div>
      <div className="h-2 w-full overflow-hidden rounded-[var(--sd-radius)] bg-[color:var(--sd-input)]">
        <div className="h-full rounded-[var(--sd-radius)] transition-all" style={{ width: `${Math.min(value, 100)}%`, background: color }} />
      </div>
    </Panel>
  );
}

function moduleTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'healthy') return 'success';
  if (status === 'degraded') return 'warning';
  if (status === 'down') return 'danger';
  return 'neutral';
}
```

- [ ] **Step 4: Update Status page JSX**

In the return block, replace the top header and panel wrappers with:

```tsx
<div>
  <PageHeader
    domain="Operations"
    title="System Status"
    description="Runtime health, queue depth, active runtime sessions, and uptime."
  />
  {sys && (
    <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Gauge label="CPU" value={sys.cpuPercent} />
      <Gauge label="Memory" value={sys.memoryPercent} />
      <Gauge label="Disk" value={sys.diskPercent} />
    </div>
  )}
  <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
    <Panel className="p-4">
      <div className="mb-3 text-sm text-[color:var(--sd-muted)]">Modules</div>
      <div className="space-y-2">
        {Object.entries(mods).map(([name, status]) => (
          <div key={name} className="flex items-center gap-2 text-sm">
            <span className="capitalize">{name}</span>
            <span className="ml-auto">
              <StatusPill tone={moduleTone(status)}>{status}</StatusPill>
            </span>
          </div>
        ))}
      </div>
    </Panel>
    <Panel className="p-4">
      <div className="mb-3 text-sm text-[color:var(--sd-muted)]">Overview</div>
      <div className="space-y-1 text-sm">
        <div>Runtime Sessions: <span className="font-medium text-[color:var(--sd-text)]">{data.sessions.length}</span></div>
        <div>Queue Depth: <span className="font-medium text-[color:var(--sd-text)]">{data.queueSize}</span></div>
        <div>Uptime: <span className="font-medium text-[color:var(--sd-text)]">{upH}h {upM}m</span></div>
      </div>
      <Link to="/sessions" className="mt-3 inline-block text-sm text-[color:var(--sd-accent)] hover:underline">
        Open runtime sessions
      </Link>
    </Panel>
  </div>
</div>
```

- [ ] **Step 5: Verify dashboard build and tests**

Run:

```bash
npm run build -w @ccbuddy/dashboard
npm run test -w @ccbuddy/dashboard
git diff --check
```

Expected: all PASS.

- [ ] **Step 6: Manual visual check**

Run:

```bash
cd packages/dashboard/client
npm run dev -- --host 127.0.0.1
```

Open the Vite URL, authenticate if needed, and check:

- sidebar groups use Signal Deck styling
- theme toggle cycles Dark, Light, System
- refresh preserves explicit theme selection
- Status page remains readable in dark and light mode

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard/client/src/App.tsx packages/dashboard/client/src/pages/StatusPage.tsx
git commit -m "feat(dashboard): apply signal deck shell and status page"
```

---

## Task 4: Operations Pages

**Files:**
- Modify: `packages/dashboard/client/src/pages/SessionsPage.tsx`
- Modify: `packages/dashboard/client/src/pages/SessionDetailPage.tsx`
- Modify: `packages/dashboard/client/src/pages/LogsPage.tsx`
- Modify: `packages/dashboard/client/src/components/ChatMessage.tsx`
- Modify: `packages/dashboard/client/src/components/ThinkingBlock.tsx`
- Modify: `packages/dashboard/client/src/components/ToolUseBlock.tsx`

- [ ] **Step 1: Migrate Runtime Sessions page**

Update `packages/dashboard/client/src/pages/SessionsPage.tsx`:

- Import `PageHeader`, `Panel`, and `StatusPill`.
- Replace the existing header with `PageHeader`.
- Wrap the filter buttons and table in `Panel`.
- Use `StatusPill` for status values.
- Replace hard-coded `bg-gray-*`, `text-gray-*`, and `text-blue-*` color classes with token classes using `var(--sd-*)`.

Core status tone helper:

```tsx
function statusTone(status: string): 'success' | 'warning' | 'neutral' {
  if (status === 'active') return 'success';
  if (status === 'paused') return 'warning';
  return 'neutral';
}
```

Filter button active state:

```tsx
className={`rounded-[var(--sd-radius)] px-3 py-1 text-sm ${
  filter === f
    ? 'bg-[color:var(--sd-accent)] text-[color:var(--sd-accent-ink)]'
    : 'sd-button-secondary'
}`}
```

- [ ] **Step 2: Migrate Session Detail page**

Update `packages/dashboard/client/src/pages/SessionDetailPage.tsx`:

- Import `PageHeader` and `Panel`.
- Keep the back link.
- Use `PageHeader` with domain `Operations`, title `Runtime Session`, and description set to the decoded runtime key.
- Wrap replay events in a `Panel`.

Top of return should follow this shape:

```tsx
<div>
  <Link to="/sessions" className="mb-4 inline-block text-sm text-[color:var(--sd-accent)] hover:underline">
    &larr; Back to Runtime Sessions
  </Link>
  <PageHeader
    domain="Operations"
    title="Runtime Session"
    description={decodeURIComponent(key ?? '')}
  />
  <Panel className="max-w-3xl p-4">
    {/* existing event rendering */}
  </Panel>
</div>
```

- [ ] **Step 3: Migrate replay blocks**

Update:

- `packages/dashboard/client/src/components/ChatMessage.tsx`
- `packages/dashboard/client/src/components/ThinkingBlock.tsx`
- `packages/dashboard/client/src/components/ToolUseBlock.tsx`

Use `Panel` and token classes. `ChatMessage` should keep different user/assistant accents:

```tsx
import { Panel } from './ui';

export function ChatMessage({ role, content }: { role: string; content: string }) {
  const isUser = role === 'user';
  return (
    <Panel accent={isUser} className="my-3 p-3">
      <div className="mb-1 text-xs font-medium text-[color:var(--sd-muted)]">{isUser ? 'User' : 'Assistant'}</div>
      <div className="whitespace-pre-wrap text-sm">{content}</div>
    </Panel>
  );
}
```

- [ ] **Step 4: Migrate Logs page**

Update `packages/dashboard/client/src/pages/LogsPage.tsx`:

- Import `PageHeader`, `Panel`, and `Button`.
- Use `PageHeader` with log file buttons in `actions`.
- Put the log output inside `Panel`.
- Use `.sd-input` for filter input.
- Keep auto-scroll behavior unchanged.

- [ ] **Step 5: Verify operations pages**

Run:

```bash
npm run build -w @ccbuddy/dashboard
npm run test -w @ccbuddy/dashboard
git diff --check
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/client/src/pages/SessionsPage.tsx \
  packages/dashboard/client/src/pages/SessionDetailPage.tsx \
  packages/dashboard/client/src/pages/LogsPage.tsx \
  packages/dashboard/client/src/components/ChatMessage.tsx \
  packages/dashboard/client/src/components/ThinkingBlock.tsx \
  packages/dashboard/client/src/components/ToolUseBlock.tsx
git commit -m "feat(dashboard): apply signal deck operations pages"
```

---

## Task 5: Workspace Pages

**Files:**
- Modify: `packages/dashboard/client/src/App.tsx`
- Modify: `packages/dashboard/client/src/pages/ChatPage.tsx`
- Modify: `packages/dashboard/client/src/components/ChatSidebar.tsx`
- Modify: `packages/dashboard/client/src/components/ChatInput.tsx`
- Modify: `packages/dashboard/client/src/pages/ConversationsPage.tsx`

- [ ] **Step 0: Mark Workspace routes as migrated**

Update the migrated route guard in `packages/dashboard/client/src/App.tsx` so these routes no longer receive `sd-main-legacy`:

- `/chat`
- `/conversations`

Use the same normalized `pathname` value introduced by the Operations migration.

- [ ] **Step 1: Migrate Chat shell**

Update `packages/dashboard/client/src/pages/ChatPage.tsx`:

- Replace outer `-m-6` layout with token-based full-height layout.
- Use `Panel` for thinking/tool message containers.
- Use token classes for message bubbles:
  - user: accent border and subtle accent background
  - assistant: panel background
- Keep websocket behavior, message rendering, and markdown unchanged.

Header shape:

```tsx
<div className="border-b border-[color:var(--sd-border)] px-4 py-3">
  <div className="flex items-center justify-between">
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-[color:var(--sd-subtle)]">Workspace</div>
      <div className="text-sm font-medium">Chat with Po</div>
    </div>
    <StatusPill tone={connected ? 'success' : 'danger'}>
      {connected ? 'Connected' : 'Disconnected'}
    </StatusPill>
  </div>
</div>
```

- [ ] **Step 2: Migrate ChatSidebar**

Update `packages/dashboard/client/src/components/ChatSidebar.tsx`:

- Replace `bg-gray-900 border-gray-800` with `sd-panel`-compatible classes.
- Use `Button` for New Chat.
- Use token selected state for recent chats.
- Keep `onSelectSession`, `onDeleteSession`, and grouping logic unchanged.

- [ ] **Step 3: Migrate ChatInput**

Update `packages/dashboard/client/src/components/ChatInput.tsx`:

- Use `.sd-input` for textarea.
- Use `Button` or tokenized buttons for attach, record, send.
- Keep keyboard send, file selection, and voice recording unchanged.
- Preserve recording pulse with a danger tone.

- [ ] **Step 4: Migrate History page**

Update `packages/dashboard/client/src/pages/ConversationsPage.tsx`:

- Import `PageHeader` and `Panel`.
- Use `PageHeader` for Workspace / History.
- Use `.sd-input` for filters.
- Wrap message rows in `Panel`.
- Keep `sessionId` filtering and query-param sync unchanged.

- [ ] **Step 5: Verify workspace pages**

Run:

```bash
npm run build -w @ccbuddy/dashboard
npm run test -w @ccbuddy/dashboard
git diff --check
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/client/src/App.tsx \
  packages/dashboard/client/src/pages/ChatPage.tsx \
  packages/dashboard/client/src/components/ChatSidebar.tsx \
  packages/dashboard/client/src/components/ChatInput.tsx \
  packages/dashboard/client/src/pages/ConversationsPage.tsx
git commit -m "feat(dashboard): apply signal deck workspace pages"
```

---

## Task 6: Settings And Auth

**Files:**
- Modify: `packages/dashboard/client/src/App.tsx`
- Modify: `packages/dashboard/client/src/pages/ConfigPage.tsx`
- Modify: `packages/dashboard/client/src/components/ModelSelector.tsx`
- Modify: `packages/dashboard/client/src/components/AuthGuard.tsx`

- [ ] **Step 0: Mark Settings routes as migrated**

Update the migrated route guard in `packages/dashboard/client/src/App.tsx` so these routes no longer receive `sd-main-legacy`:

- `/settings`
- `/config`

Use the same normalized `pathname` value introduced by the Operations migration.

- [ ] **Step 1: Migrate Settings page shell**

Update `packages/dashboard/client/src/pages/ConfigPage.tsx`:

- Import `PageHeader`, `Panel`, `Button`, and `StatusPill`.
- Replace the header with `PageHeader`.
- Keep Save button in `actions`.
- Use `Panel` for settings group nav cards and generated settings field container.
- Use `.sd-input` for generated text and number fields.
- Convert source badges to `StatusPill` tones:
  - local: info
  - env: success
  - default: neutral
  - effective_only: neutral
  - runtime_override: warning

- [ ] **Step 2: Migrate PermissionGatesControl**

Inside `ConfigPage.tsx`, update `PermissionGatesControl`:

- Wrap with `Panel`.
- Keep source badge.
- Use tokenized toggle colors:
  - enabled track: `var(--sd-success)`
  - disabled track: `var(--sd-border-strong)`
- Preserve `Save local settings to persist. Restart required.`

- [ ] **Step 3: Migrate ModelSelector**

Update `packages/dashboard/client/src/components/ModelSelector.tsx`:

- Import `Panel` and `StatusPill`.
- Wrap content with `Panel`.
- Use `.sd-input` for select.
- Use `StatusPill tone="warning"` when `source === 'runtime_override'`.
- Use `StatusPill tone="neutral"` for config default.
- Preserve runtime API behavior.

- [ ] **Step 4: Migrate AuthGuard**

Update `packages/dashboard/client/src/components/AuthGuard.tsx`:

- Use Signal Deck tokens for login screen.
- Keep auth behavior unchanged.
- Login form uses `Panel`, `.sd-input`, and `.sd-button`.
- Heading remains `CCBuddy Dashboard`.

- [ ] **Step 5: Verify settings and auth build**

Run:

```bash
npm run build -w @ccbuddy/dashboard
npm run test -w @ccbuddy/dashboard
git diff --check
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/client/src/App.tsx \
  packages/dashboard/client/src/pages/ConfigPage.tsx \
  packages/dashboard/client/src/components/ModelSelector.tsx \
  packages/dashboard/client/src/components/AuthGuard.tsx
git commit -m "feat(dashboard): apply signal deck settings and auth"
```

---

## Task 7: Final Phase 4 Verification

**Files:**
- Review all dashboard client files touched in Tasks 1-6.

- [ ] **Step 1: Run final dashboard verification**

Run:

```bash
npm run build -w @ccbuddy/dashboard
npm run test -w @ccbuddy/dashboard
git diff --check
```

Expected: all PASS.

- [ ] **Step 2: Run full repo verification**

Run:

```bash
npm test
```

Expected: Turbo summary shows `24 successful, 24 total`.

- [ ] **Step 3: Manual theme verification**

Start the client:

```bash
cd packages/dashboard/client
npm run dev -- --host 127.0.0.1
```

Verify:

- Dark mode loads and all pages are readable.
- Light mode loads and all pages are readable.
- Theme toggle cycles Dark -> Light -> System -> Dark.
- Explicit theme survives refresh.
- Status, Runtime Sessions, Logs, Chat, History, and Settings preserve behavior.
- `/config` still loads Settings.

- [ ] **Step 4: Commit any final corrections**

If Step 3 required code changes, run:

```bash
npm run build -w @ccbuddy/dashboard
npm run test -w @ccbuddy/dashboard
git diff --check
git add packages/dashboard/client
git commit -m "fix(dashboard): polish signal deck visual system"
```

If Step 3 required no code changes, do not create an empty commit.

---

## Self-Review

Spec coverage:

- Signal Deck visual direction: Tasks 2-6.
- Dark and light modes: Task 1 and Task 7.
- Shared design-system layer: Task 2.
- Shell and Status first slice: Task 3.
- Operations rollout: Task 4.
- Workspace rollout: Task 5.
- Settings rollout: Task 6.
- Verification plan: Tasks 1-7.

Placeholder scan:

- No red-flag planning markers remain in this plan.

Type consistency:

- Theme types are defined in Task 1 and used consistently by `ThemeProvider` and `ThemeToggle`.
- Shared primitives are defined in Task 2 and used by later tasks.
- Existing route and API behavior remains unchanged.
