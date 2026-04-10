# Dashboard Settings Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard’s unsafe resolved-config editor with a safe settings foundation built around editable `config/local.yaml`, read-only effective config, and field-source metadata.

**Architecture:** This plan covers Phase 1 of the larger dashboard redesign. The server will stop round-tripping through the live resolved config object and instead expose separate `local`, `effective`, and `meta` settings endpoints. The current config page will be converted into a transitional settings UI that edits only local config, can inspect effective values read-only, and preserves `${ENV_VAR}` placeholders safely.

**Tech Stack:** TypeScript, Fastify, React 19, existing dashboard server tests, existing dashboard client API layer

---

## Scope Note

The approved dashboard review spec spans several independent subprojects:

1. safe config/settings foundation
2. information architecture redesign
3. workspace/operations reorganization
4. visual redesign and shell overhaul

This implementation plan covers only the first subproject. That is intentional: it fixes the current unsafe settings bug and creates the data-model boundary the later UX and design work will depend on.

## File Map

### Existing files to modify

- `packages/dashboard/src/server/index.ts`
  - Replace `/api/config` editing with separate settings endpoints and wire in the new settings services.
- `packages/dashboard/src/server/__tests__/server.test.ts`
  - Add server coverage for local/effective/meta settings APIs and placeholder preservation.
- `packages/dashboard/client/src/lib/api.ts`
  - Replace the single config API surface with explicit settings endpoints.
- `packages/dashboard/client/src/pages/ConfigPage.tsx`
  - Convert the current raw config page into a transitional settings foundation page that edits local config and inspects effective config.

### New files to create

- `packages/dashboard/src/server/settings-store.ts`
  - Load persisted `config/local.yaml`, preserve editable values, and write validated local config back to disk.
- `packages/dashboard/src/server/settings-meta.ts`
  - Build field-source metadata and section-level settings views from local config plus effective config.
- `packages/dashboard/src/server/__tests__/settings-store.test.ts`
  - Unit tests for placeholder preservation, local config loading, and safe writes.

### Files intentionally deferred to later plans

- `packages/dashboard/client/src/App.tsx`
  - Navigation and shell changes belong to the IA/visual redesign plan, not this foundation plan.
- `packages/dashboard/client/src/main.css`
  - Design system and shell styling are deferred until the settings model is safe.
- `packages/dashboard/client/src/pages/StatusPage.tsx`
- `packages/dashboard/client/src/pages/SessionsPage.tsx`
- `packages/dashboard/client/src/pages/ConversationsPage.tsx`
- `packages/dashboard/client/src/pages/ChatPage.tsx`
- `packages/dashboard/client/src/pages/LogsPage.tsx`

## Task 1: Add a Safe Local Settings Store

**Files:**
- Create: `packages/dashboard/src/server/settings-store.ts`
- Create: `packages/dashboard/src/server/__tests__/settings-store.test.ts`
- Test: `packages/dashboard/src/server/__tests__/settings-store.test.ts`

- [ ] **Step 1: Write the failing settings-store tests**

Create `packages/dashboard/src/server/__tests__/settings-store.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  loadLocalSettingsConfig,
  saveLocalSettingsConfig,
  type LocalSettingsConfig,
} from '../settings-store.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('settings-store', () => {
  it('loads persisted local config without resolving env placeholders', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-'));
    tempDirs.push(dir);
    const localPath = join(dir, 'local.yaml');
    writeFileSync(localPath, [
      'ccbuddy:',
      '  platforms:',
      '    discord:',
      '      token: ${DISCORD_TOKEN}',
      '  agent:',
      '    model: opus',
      '',
    ].join('\\n'), 'utf8');

    const loaded = loadLocalSettingsConfig(localPath);

    expect(loaded.platforms.discord.token).toBe('${DISCORD_TOKEN}');
    expect(loaded.agent.model).toBe('opus');
  });

  it('writes local config back without flattening existing placeholders', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-'));
    tempDirs.push(dir);
    const localPath = join(dir, 'local.yaml');
    writeFileSync(localPath, [
      'ccbuddy:',
      '  platforms:',
      '    discord:',
      '      token: ${DISCORD_TOKEN}',
      '',
    ].join('\\n'), 'utf8');

    const nextConfig: LocalSettingsConfig = {
      platforms: {
        discord: {
          token: '${DISCORD_TOKEN}',
          enabled: true,
        },
      },
      agent: {
        admin_skip_permissions: false,
      },
    };

    saveLocalSettingsConfig(localPath, nextConfig);

    const raw = readFileSync(localPath, 'utf8');
    expect(raw).toContain('${DISCORD_TOKEN}');
    const parsed = yaml.load(raw) as { ccbuddy: LocalSettingsConfig };
    expect(parsed.ccbuddy.platforms.discord.token).toBe('${DISCORD_TOKEN}');
    expect(parsed.ccbuddy.agent.admin_skip_permissions).toBe(false);
  });

  it('treats missing local config as an empty editable config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-'));
    tempDirs.push(dir);
    const localPath = join(dir, 'local.yaml');

    const loaded = loadLocalSettingsConfig(localPath);

    expect(loaded).toEqual({});
  });
});
```

- [ ] **Step 2: Run the new settings-store test file to verify it fails**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm test -w packages/dashboard -- src/server/__tests__/settings-store.test.ts
```

Expected: FAIL with module-not-found for `../settings-store.js`.

- [ ] **Step 3: Implement the local settings store**

Create `packages/dashboard/src/server/settings-store.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import yaml from 'js-yaml';

export type LocalSettingsConfig = Record<string, any>;

export function loadLocalSettingsConfig(localPath: string): LocalSettingsConfig {
  if (!existsSync(localPath)) {
    return {};
  }

  const raw = readFileSync(localPath, 'utf8');
  const parsed = yaml.load(raw) as { ccbuddy?: LocalSettingsConfig } | null;
  return parsed?.ccbuddy ?? {};
}

export function saveLocalSettingsConfig(localPath: string, config: LocalSettingsConfig): void {
  mkdirSync(dirname(localPath), { recursive: true });
  const yamlContent = yaml.dump({ ccbuddy: config }, { lineWidth: 120 });
  writeFileSync(localPath, yamlContent, 'utf8');
}
```

- [ ] **Step 4: Re-run the settings-store tests**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm test -w packages/dashboard -- src/server/__tests__/settings-store.test.ts
```

Expected: PASS with `3` tests green.

- [ ] **Step 5: Commit the settings-store groundwork**

```bash
git add packages/dashboard/src/server/settings-store.ts \
  packages/dashboard/src/server/__tests__/settings-store.test.ts
git commit -m "refactor: add dashboard settings store"
```

## Task 2: Add Local, Effective, and Meta Settings APIs

**Files:**
- Modify: `packages/dashboard/src/server/index.ts`
- Modify: `packages/dashboard/src/server/__tests__/server.test.ts`
- Create: `packages/dashboard/src/server/settings-meta.ts`
- Test: `packages/dashboard/src/server/__tests__/server.test.ts`

- [ ] **Step 1: Add failing server tests for the new settings APIs**

Extend `packages/dashboard/src/server/__tests__/server.test.ts` with:

```ts
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

Add cleanup support near the top of the file:

```ts
const tempDirs: string[] = [];

afterEach(async () => {
  if (server) await server.stop();
  delete process.env.TEST_DASHBOARD_TOKEN;
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Add these tests:

```ts
it('GET /api/settings/local returns persisted local config instead of effective config', async () => {
  const deps = createMockDeps();
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-api-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'local.yaml'), [
    'ccbuddy:',
    '  platforms:',
    '    discord:',
    '      token: ${DISCORD_TOKEN}',
    '',
  ].join('\\n'), 'utf8');
  deps.configDir = dir;
  (deps.config as any).platforms = {
    discord: { enabled: true, token: 'resolved-token' },
  };

  server = new DashboardServer(deps as any);
  const address = await server.start();

  const res = await fetch(`${address}/api/settings/local`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.config.platforms.discord.token).toBe('${DISCORD_TOKEN}');
});

it('PUT /api/settings/local preserves placeholders while updating editable values', async () => {
  const deps = createMockDeps();
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-api-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'local.yaml'), [
    'ccbuddy:',
    '  platforms:',
    '    discord:',
    '      token: ${DISCORD_TOKEN}',
    '',
  ].join('\\n'), 'utf8');
  deps.configDir = dir;

  server = new DashboardServer(deps as any);
  const address = await server.start();

  const res = await fetch(`${address}/api/settings/local`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      config: {
        platforms: {
          discord: {
            token: '${DISCORD_TOKEN}',
            enabled: true,
          },
        },
        agent: {
          admin_skip_permissions: false,
        },
      },
    }),
  });

  expect(res.status).toBe(200);
  const raw = readFileSync(join(dir, 'local.yaml'), 'utf8');
  expect(raw).toContain('${DISCORD_TOKEN}');
  expect(raw).toContain('admin_skip_permissions: false');
});

it('GET /api/settings/effective returns the resolved runtime config read-only', async () => {
  const deps = createMockDeps();
  (deps.config as any).platforms = {
    discord: { enabled: true, token: 'resolved-token' },
  };
  server = new DashboardServer(deps as any);
  const address = await server.start();

  const res = await fetch(`${address}/api/settings/effective`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.config.platforms.discord.token).toBe('••••••');
});

it('GET /api/settings/meta reports field sources for local and env-backed values', async () => {
  const deps = createMockDeps();
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-api-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'local.yaml'), [
    'ccbuddy:',
    '  agent:',
    '    model: opus',
    '',
  ].join('\\n'), 'utf8');
  deps.configDir = dir;
  (deps.config as any).agent = {
    model: 'opus',
    admin_skip_permissions: true,
  };
  (deps.config as any).platforms = {
    discord: { enabled: true, token: 'resolved-token' },
  };

  server = new DashboardServer(deps as any);
  const address = await server.start();

  const res = await fetch(`${address}/api/settings/meta`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.sources['agent.model']).toBe('local');
  expect(data.sources['platforms.discord.token']).toBe('effective_only');
});
```

- [ ] **Step 2: Run the server test file to verify the new cases fail**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm test -w packages/dashboard -- src/server/__tests__/server.test.ts
```

Expected: FAIL with 404s for `/api/settings/local`, `/api/settings/effective`, and `/api/settings/meta`.

- [ ] **Step 3: Implement server-side settings metadata and endpoints**

Create `packages/dashboard/src/server/settings-meta.ts`:

```ts
export type SettingsSource = 'local' | 'default' | 'effective_only' | 'runtime_override';

function walkObject(
  value: unknown,
  path: string[],
  visit: (path: string, value: unknown) => void,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    visit(path.join('.'), value);
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    walkObject(child, [...path, key], visit);
  }
}

export function buildSettingsSourceMap(localConfig: Record<string, unknown>, effectiveConfig: Record<string, unknown>) {
  const sources: Record<string, SettingsSource> = {};

  walkObject(effectiveConfig, [], (path) => {
    if (path) sources[path] = 'effective_only';
  });

  walkObject(localConfig, [], (path) => {
    if (path) sources[path] = 'local';
  });

  return { sources };
}
```

Update `packages/dashboard/src/server/index.ts` to import and use the new helpers:

```ts
import { loadLocalSettingsConfig, saveLocalSettingsConfig } from './settings-store.js';
import { buildSettingsSourceMap } from './settings-meta.js';
```

Replace the current config endpoints with:

```ts
this.app.get('/api/settings/local', async () => {
  const localPath = join(this.deps.configDir, 'local.yaml');
  return { config: loadLocalSettingsConfig(localPath) };
});

this.app.put('/api/settings/local', async (request, reply) => {
  const body = request.body as { config: Record<string, unknown> } | null;
  if (!body?.config) {
    return reply.status(400).send({ error: 'Missing config in request body' });
  }

  const localPath = join(this.deps.configDir, 'local.yaml');
  const backupPath = localPath + '.bak';

  try {
    try { copyFileSync(localPath, backupPath); } catch { /* no existing file */ }
    saveLocalSettingsConfig(localPath, body.config as Record<string, unknown>);
    return { ok: true, backup: backupPath };
  } catch (err) {
    return reply.status(500).send({ error: (err as Error).message });
  }
});

this.app.get('/api/settings/effective', async () => {
  const config = JSON.parse(JSON.stringify(this.deps.config));
  if (config.platforms) {
    for (const key of Object.keys(config.platforms)) {
      if (config.platforms[key]?.token) config.platforms[key].token = '••••••';
    }
  }
  return { config };
});

this.app.get('/api/settings/meta', async () => {
  const localPath = join(this.deps.configDir, 'local.yaml');
  const localConfig = loadLocalSettingsConfig(localPath);
  return buildSettingsSourceMap(localConfig, this.deps.config as unknown as Record<string, unknown>);
});
```

Keep a temporary compatibility alias:

```ts
this.app.get('/api/config', async () => {
  const config = JSON.parse(JSON.stringify(this.deps.config));
  if (config.platforms) {
    for (const key of Object.keys(config.platforms)) {
      if (config.platforms[key]?.token) config.platforms[key].token = '••••••';
    }
  }
  return { config };
});
```

but remove `PUT /api/config` entirely in this phase so the unsafe editor path is gone.

- [ ] **Step 4: Re-run the server tests**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm test -w packages/dashboard -- src/server/__tests__/server.test.ts src/server/__tests__/settings-store.test.ts
```

Expected: PASS with the new settings endpoint tests green.

- [ ] **Step 5: Commit the server settings foundation**

```bash
git add packages/dashboard/src/server/index.ts \
  packages/dashboard/src/server/settings-meta.ts \
  packages/dashboard/src/server/__tests__/server.test.ts
git commit -m "feat: add dashboard settings APIs"
```

## Task 3: Convert the Config Page Into a Safe Transitional Settings UI

**Files:**
- Modify: `packages/dashboard/client/src/lib/api.ts`
- Modify: `packages/dashboard/client/src/pages/ConfigPage.tsx`
- Test: manual or targeted build verification

- [ ] **Step 1: Update the client API surface to use explicit settings endpoints**

Modify `packages/dashboard/client/src/lib/api.ts`:

```ts
export const api = {
  // ...existing methods...
  getLocalSettings: () => request<{ config: any }>('/api/settings/local'),
  updateLocalSettings: (config: any) =>
    request<{ ok: boolean }>('/api/settings/local', {
      method: 'PUT',
      body: JSON.stringify({ config }),
    }),
  getEffectiveSettings: () => request<{ config: any }>('/api/settings/effective'),
  getSettingsMeta: () => request<{ sources: Record<string, string> }>('/api/settings/meta'),
  getModel: () => request<{ model: string; source: string }>('/api/config/model'),
  setModel: (model: string) =>
    request<{ ok: boolean; model: string }>('/api/config/model', {
      method: 'PUT',
      body: JSON.stringify({ model }),
    }),
};
```

- [ ] **Step 2: Replace the current raw config editor page with a split local/effective view**

Update `packages/dashboard/client/src/pages/ConfigPage.tsx` to use explicit settings data:

```ts
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

const TABS = ['General', 'Agent', 'Users', 'Platforms', 'Scheduler', 'Memory', 'Media', 'Skills', 'Webhooks', 'Apple', 'Dashboard'] as const;
const TAB_KEYS: Record<string, string> = {
  General: '_root', Agent: 'agent', Users: 'users', Platforms: 'platforms',
  Scheduler: 'scheduler', Memory: 'memory', Media: 'media', Skills: 'skills',
  Webhooks: 'webhooks', Apple: 'apple', Dashboard: 'dashboard',
};

function SourceBadge({ source }: { source?: string }) {
  const classes = source === 'local'
    ? 'bg-blue-900 text-blue-300'
    : source === 'effective_only'
      ? 'bg-gray-800 text-gray-400'
      : 'bg-gray-800 text-gray-500';
  return <span className={`text-[11px] px-2 py-0.5 rounded ${classes}`}>{source ?? 'unknown'}</span>;
}

function getAtPath(obj: any, path: string[]) {
  let current = obj;
  for (const key of path) {
    if (current == null) return undefined;
    current = current[key];
  }
  return current;
}

function ConfigField({
  label,
  localValue,
  effectiveValue,
  source,
  onChange,
  type = 'text',
}: {
  label: string;
  localValue: any;
  effectiveValue: any;
  source?: string;
  onChange: (v: any) => void;
  type?: string;
}) {
  const displayValue = localValue ?? effectiveValue ?? '';

  if (typeof displayValue === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-3 py-2 border-b border-gray-800 last:border-b-0">
        <div>
          <div className="text-sm text-white">{label}</div>
          <div className="text-xs text-gray-500 mt-1">Effective: {String(effectiveValue)}</div>
        </div>
        <div className="flex items-center gap-2">
          <SourceBadge source={source} />
          <input
            type="checkbox"
            checked={Boolean(displayValue)}
            onChange={(e) => onChange(e.target.checked)}
            className="rounded bg-gray-800 border-gray-600"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="py-3 border-b border-gray-800 last:border-b-0">
      <div className="flex items-center justify-between gap-3 mb-2">
        <label className="text-sm text-white">{label}</label>
        <SourceBadge source={source} />
      </div>
      <input
        type={type}
        value={String(displayValue)}
        onChange={(e) => onChange(type === 'number' ? Number(e.target.value) : e.target.value)}
        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm"
      />
      <div className="text-xs text-gray-500 mt-1">
        Effective value: {String(effectiveValue ?? '')}
      </div>
    </div>
  );
}

function renderFields(
  localObj: Record<string, any>,
  effectiveObj: Record<string, any>,
  path: string[],
  sourceMap: Record<string, string>,
  onChange: (path: string[], value: any) => void,
): React.ReactNode[] {
  const keys = Array.from(new Set([
    ...Object.keys(localObj ?? {}),
    ...Object.keys(effectiveObj ?? {}),
  ]));

  return keys.map((key) => {
    const fullPath = [...path, key];
    const pathKey = fullPath.join('.');
    const localValue = localObj?.[key];
    const effectiveValue = effectiveObj?.[key];

    if (
      (localValue && typeof localValue === 'object' && !Array.isArray(localValue)) ||
      (effectiveValue && typeof effectiveValue === 'object' && !Array.isArray(effectiveValue))
    ) {
      return (
        <div key={key} className="rounded-xl border border-gray-800 p-4 mb-4">
          <div className="text-sm font-medium text-gray-200 mb-3">{key}</div>
          {renderFields(localValue ?? {}, effectiveValue ?? {}, fullPath, sourceMap, onChange)}
        </div>
      );
    }

    const type = typeof (localValue ?? effectiveValue) === 'number' ? 'number' : 'text';
    return (
      <ConfigField
        key={pathKey}
        label={key}
        localValue={localValue}
        effectiveValue={effectiveValue}
        source={sourceMap[pathKey]}
        type={type}
        onChange={(value) => onChange(fullPath, value)}
      />
    );
  });
}

export function ConfigPage() {
  const [localConfig, setLocalConfig] = useState<any>(null);
  const [effectiveConfig, setEffectiveConfig] = useState<any>(null);
  const [sourceMap, setSourceMap] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<string>('General');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    Promise.all([
      api.getLocalSettings(),
      api.getEffectiveSettings(),
      api.getSettingsMeta(),
    ]).then(([local, effective, meta]) => {
      setLocalConfig(local.config);
      setEffectiveConfig(effective.config);
      setSourceMap(meta.sources);
    });
  }, []);

  const handleChange = (path: string[], value: any) => {
    setLocalConfig((prev: any) => {
      const next = JSON.parse(JSON.stringify(prev ?? {}));
      let obj = next;
      for (let i = 0; i < path.length - 1; i++) {
        obj[path[i]] = obj[path[i]] ?? {};
        obj = obj[path[i]];
      }
      obj[path[path.length - 1]] = value;
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setStatus('');
    try {
      await api.updateLocalSettings(localConfig ?? {});
      setStatus('Saved local settings');
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
    setSaving(false);
  };

  if (!localConfig || !effectiveConfig) {
    return <p className="text-gray-400">Loading...</p>;
  }

  const tabKey = TAB_KEYS[tab];
  const localSection = tabKey === '_root'
    ? { data_dir: localConfig.data_dir, log_level: localConfig.log_level }
    : localConfig[tabKey] ?? {};
  const effectiveSection = tabKey === '_root'
    ? { data_dir: effectiveConfig.data_dir, log_level: effectiveConfig.log_level }
    : effectiveConfig[tabKey] ?? {};

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Settings Foundation</h2>
          <p className="text-sm text-gray-500 mt-1">
            Edits write to local config only. Effective values are shown for reference.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {status && (
            <span className={`text-sm ${status.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
              {status}
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Local Settings'}
          </button>
        </div>
      </div>

      <div className="flex gap-1 mb-6 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-lg text-sm ${tab === t ? 'bg-blue-600' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
        {renderFields(localSection, effectiveSection, tabKey === '_root' ? [] : [tabKey], sourceMap, handleChange)}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify the dashboard package still builds**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm test -w packages/dashboard -- src/server/__tests__/server.test.ts src/server/__tests__/settings-store.test.ts
/opt/homebrew/opt/node@22/bin/npm run build -w packages/dashboard
```

Expected:
- dashboard server tests PASS
- dashboard TypeScript build passes
- client build may still be subject to the known local dependency issue around Vite plugins; if that remains, report it explicitly but confirm the server and TypeScript portions are green

- [ ] **Step 4: Commit the transitional settings UI**

```bash
git add packages/dashboard/client/src/lib/api.ts \
  packages/dashboard/client/src/pages/ConfigPage.tsx
git commit -m "feat: switch dashboard to safe local settings"
```

## Task 4: Final Verification and Handoff

**Files:**
- Verify only; no new files

- [ ] **Step 1: Re-run the full Phase 1 verification set**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm test -w packages/dashboard -- src/server/__tests__/server.test.ts src/server/__tests__/settings-store.test.ts
/opt/homebrew/opt/node@22/bin/npm run build -w packages/dashboard
git diff --check
git status --short
```

Expected:
- dashboard server/settings tests PASS
- dashboard package TypeScript build passes
- if the client build still fails because local frontend dependencies are missing, record that explicitly as an environment issue rather than a code issue
- `git diff --check` prints nothing
- `git status --short` shows only the intended dashboard settings foundation files

- [ ] **Step 2: Stop here unless verification forces follow-up edits**

If verification is clean, do not create another commit in this task. Hand the branch off with the Task 1, Task 2, and Task 3 commits.
