# Local Skills State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate tracked skills from gitignored local skills and runtime metadata so normal CCBuddy usage no longer dirties the repository.

**Architecture:** Keep `skills/registry.yaml` as the tracked catalog for bundled and promoted project skills only. Add a gitignored local layer at `skills/local/` with its own registry for local-only skills plus runtime metadata overlays such as usage counts and last-used timestamps. Preserve the public `SkillRegistry` facade so the rest of the repo can keep calling into the skills package with minimal surface-area churn.

**Tech Stack:** TypeScript, Node.js filesystem APIs, `js-yaml`, Vitest, MCP stdio server

---

## File Map

### Existing files to modify

- `.gitignore`
  - Ignore `skills/local/` so local skills and metadata never dirty git.
- `packages/skills/src/types.ts`
  - Define separate tracked and local registry file shapes and update the skill source model.
- `packages/skills/src/registry.ts`
  - Convert `SkillRegistry` into a facade over tracked registry data plus local state.
- `packages/skills/src/generator.ts`
  - Make `createSkill()` local-first and add explicit promotion to tracked `skills/generated/`.
- `packages/skills/src/mcp-server.ts`
  - Keep `create_skill` local-only, add `promote_skill`, and ensure runtime usage updates go to local state only.
- `packages/skills/src/index.ts`
  - Export any new store types/helpers needed by tests or callers.
- `packages/skills/src/__tests__/registry.test.ts`
  - Cover tracked/local registry behavior, collision rules, and local-only runtime metadata.
- `packages/skills/src/__tests__/generator.test.ts`
  - Cover local-first skill creation and promotion flow.
- `packages/skills/src/__tests__/integration.test.ts`
  - Cover the create → execute → usage → promote lifecycle with the new data model.
- `packages/skills/src/__tests__/mcp-server.test.ts`
  - Cover `create_skill`, `promote_skill`, and local-only metadata persistence through the MCP layer.
- `packages/skills/src/test-skills.ts`
  - Keep local test harness aligned with the new registry layout.
- `skills/registry.yaml`
  - Normalize the tracked registry to stable project-owned definitions only.

### New files to create

- `packages/skills/src/tracked-registry-store.ts`
  - Read/write the tracked registry file without runtime metadata.
- `packages/skills/src/local-skill-state.ts`
  - Read/write `skills/local/registry.yaml`, local skills, and runtime metadata overlays.
- `packages/skills/src/__tests__/local-skill-state.test.ts`
  - Unit coverage for lazy creation, malformed local state, and runtime overlay writes.

### Behavioral boundaries

- Tracked skills:
  - `skills/bundled/`
  - `skills/generated/`
  - Indexed by tracked registry only
- Local skills:
  - `skills/local/`
  - Indexed by local registry only
- Runtime metadata:
  - Stored only in `skills/local/registry.yaml`
  - Applies to both tracked and local skills via an overlay model

### Execution note

The current workspace is already dirty. Execute this plan in an isolated worktree or commit by staging only the files listed in each task.

## Task 1: Introduce Dual Registry Storage and Ignore Local State

**Files:**
- Modify: `.gitignore`
- Modify: `packages/skills/src/types.ts`
- Create: `packages/skills/src/tracked-registry-store.ts`
- Create: `packages/skills/src/local-skill-state.ts`
- Create: `packages/skills/src/__tests__/local-skill-state.test.ts`
- Test: `packages/skills/src/__tests__/local-skill-state.test.ts`

- [ ] **Step 1: Write the failing local-state tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSkillState } from '../local-skill-state.js';

let tmpDir: string;
let localRegistryPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'local-skill-state-'));
  localRegistryPath = join(tmpDir, 'skills', 'local', 'registry.yaml');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('LocalSkillState', () => {
  it('treats a missing local registry as empty and writes it lazily', async () => {
    const state = new LocalSkillState(localRegistryPath);
    await state.load();

    expect(state.listLocalSkills()).toEqual([]);
    expect(state.getRuntimeMetadata('hello-world')).toBeUndefined();

    state.recordUsage('hello-world');
    await state.save();

    expect(existsSync(localRegistryPath)).toBe(true);
    expect(readFileSync(localRegistryPath, 'utf8')).toContain('runtimeMetadata');
  });

  it('stores runtime metadata separately from local skill definitions', async () => {
    const state = new LocalSkillState(localRegistryPath);
    await state.load();

    state.recordUsage('bundled-skill');
    await state.save();

    const raw = readFileSync(localRegistryPath, 'utf8');
    expect(raw).toContain('bundled-skill');
    expect(raw).not.toContain('skills/generated');
  });
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run:

```bash
npm test -w packages/skills -- src/__tests__/local-skill-state.test.ts
```

Expected: FAIL with module-not-found or missing `LocalSkillState` methods.

- [ ] **Step 3: Add the dual registry file types and source enum update**

```ts
export type SkillSource = 'bundled' | 'generated' | 'local';

export interface SkillRuntimeMetadata {
  usageCount: number;
  lastUsed?: string;
  updatedAt: string;
}

export interface TrackedRegistryFile {
  skills: SkillDefinition[];
}

export interface LocalRegistrySkillEntry {
  definition: SkillDefinition;
  metadata: {
    createdBy: string;
    createdAt: string;
    updatedAt: string;
  };
}

export interface LocalRegistryFile {
  localSkills: LocalRegistrySkillEntry[];
  runtimeMetadata: Record<string, SkillRuntimeMetadata>;
}
```

- [ ] **Step 4: Implement tracked/local store primitives and gitignore**

```ts
// packages/skills/src/local-skill-state.ts
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import type { LocalRegistryFile, LocalRegistrySkillEntry, SkillRuntimeMetadata } from './types.js';

export class LocalSkillState {
  private state: LocalRegistryFile = { localSkills: [], runtimeMetadata: {} };

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (!existsSync(this.filePath)) {
      this.state = { localSkills: [], runtimeMetadata: {} };
      return;
    }
    try {
      const parsed = yamlLoad(readFileSync(this.filePath, 'utf8')) as LocalRegistryFile | null;
      this.state = parsed ?? { localSkills: [], runtimeMetadata: {} };
    } catch {
      this.state = { localSkills: [], runtimeMetadata: {} };
    }
  }

  async save(): Promise<void> {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, yamlDump(this.state), 'utf8');
  }

  listLocalSkills(): LocalRegistrySkillEntry[] {
    return this.state.localSkills;
  }

  getRuntimeMetadata(name: string): SkillRuntimeMetadata | undefined {
    return this.state.runtimeMetadata[name];
  }

  recordUsage(name: string): void {
    const now = new Date().toISOString();
    const existing = this.state.runtimeMetadata[name] ?? { usageCount: 0, updatedAt: now };
    this.state.runtimeMetadata[name] = {
      usageCount: existing.usageCount + 1,
      lastUsed: now,
      updatedAt: now,
    };
  }
}
```

```gitignore
skills/local/
```

- [ ] **Step 5: Run the targeted tests to verify the new stores pass**

Run:

```bash
npm test -w packages/skills -- src/__tests__/local-skill-state.test.ts
```

Expected: PASS with `2 passed`.

- [ ] **Step 6: Commit the storage groundwork**

```bash
git add .gitignore \
  packages/skills/src/types.ts \
  packages/skills/src/tracked-registry-store.ts \
  packages/skills/src/local-skill-state.ts \
  packages/skills/src/__tests__/local-skill-state.test.ts
git commit -m "refactor: add local skill state storage"
```

## Task 2: Refactor SkillRegistry Into a Tracked + Local Facade

**Files:**
- Modify: `packages/skills/src/registry.ts`
- Modify: `packages/skills/src/index.ts`
- Modify: `packages/skills/src/__tests__/registry.test.ts`
- Modify: `packages/skills/src/__tests__/integration.test.ts`
- Test: `packages/skills/src/__tests__/registry.test.ts`
- Test: `packages/skills/src/__tests__/integration.test.ts`

- [ ] **Step 1: Add failing registry tests for collision handling and local-only usage persistence**

```ts
it('recordUsage for a tracked skill writes only local runtime metadata', async () => {
  writeFileSync(
    registryPath,
    yamlDump({
      skills: [{ ...makeSkill('hello-world', 'bundled'), filePath: 'skills/bundled/hello-world.mjs' }],
    }),
    'utf8',
  );

  registry = new SkillRegistry(registryPath);
  await registry.load();

  registry.recordUsage('hello-world');
  await registry.saveLocalState();

  expect(readFileSync(registryPath, 'utf8')).not.toContain('usageCount');
  expect(readFileSync(join(tmpDir, 'local', 'registry.yaml'), 'utf8')).toContain('hello-world');
});

it('prefers tracked skills when a local skill collides by name', async () => {
  writeFileSync(
    registryPath,
    yamlDump({ skills: [{ ...makeSkill('weather', 'generated'), filePath: 'skills/generated/weather.mjs' }] }),
    'utf8',
  );
  writeFileSync(
    join(tmpDir, 'local', 'registry.yaml'),
    yamlDump({
      localSkills: [{
        definition: { ...makeSkill('weather', 'local'), filePath: join(tmpDir, 'local', 'weather.mjs') },
        metadata: { createdBy: 'test', createdAt: '2026-04-08T00:00:00Z', updatedAt: '2026-04-08T00:00:00Z' },
      }],
      runtimeMetadata: {},
    }),
    'utf8',
  );

  registry = new SkillRegistry(registryPath);
  await registry.load();

  expect(registry.get('weather')?.definition.source).toBe('generated');
  expect(registry.listBySource('local')).toHaveLength(0);
});
```

- [ ] **Step 2: Run the registry-focused tests to confirm failure**

Run:

```bash
npm test -w packages/skills -- src/__tests__/registry.test.ts src/__tests__/integration.test.ts
```

Expected: FAIL because `SkillRegistry` does not yet support local state, collision filtering, or local-only usage writes.

- [ ] **Step 3: Rebuild `SkillRegistry` as a facade over tracked data plus local state**

```ts
export class SkillRegistry {
  private tracked = new Map<string, SkillDefinition>();
  private local = new Map<string, LocalRegistrySkillEntry>();
  private runtime = new Map<string, SkillRuntimeMetadata>();

  constructor(
    private readonly trackedRegistryPath: string,
    private readonly localRegistryPath = join(dirname(trackedRegistryPath), 'local', 'registry.yaml'),
  ) {}

  async load(): Promise<void> {
    const trackedStore = new TrackedRegistryStore(this.trackedRegistryPath);
    const localState = new LocalSkillState(this.localRegistryPath);
    await trackedStore.load();
    await localState.load();

    this.tracked = new Map(trackedStore.list().map(skill => [skill.name, skill]));
    this.local = new Map();
    for (const entry of localState.listLocalSkills()) {
      if (this.tracked.has(entry.definition.name)) continue;
      this.local.set(entry.definition.name, entry);
    }
    this.runtime = new Map(Object.entries(localState.getAllRuntimeMetadata()));
  }

  recordUsage(name: string): void {
    this.localState.recordUsage(name);
    this.runtime.set(name, this.localState.getRuntimeMetadata(name)!);
  }

  async saveTracked(): Promise<void> {
    await this.trackedStore.replace(Array.from(this.tracked.values()));
    await this.trackedStore.save();
  }

  async saveLocalState(): Promise<void> {
    await this.localState.save();
  }
}
```

- [ ] **Step 4: Update integration assertions to use runtime overlay rather than tracked metadata persistence**

```ts
registry.recordUsage('adder');
await registry.saveLocalState();

const afterUsage = registry.get('adder');
expect(afterUsage!.metadata.usageCount).toBe(1);
expect(afterUsage!.metadata.lastUsed).toBeDefined();

const rawTracked = readFileSync(registryPath, 'utf8');
expect(rawTracked).not.toContain('usageCount');
```

- [ ] **Step 5: Run the registry and integration tests until they pass**

Run:

```bash
npm test -w packages/skills -- src/__tests__/registry.test.ts src/__tests__/integration.test.ts
```

Expected: PASS with both test files green and collision/runtime overlay cases covered.

- [ ] **Step 6: Commit the registry facade refactor**

```bash
git add \
  packages/skills/src/registry.ts \
  packages/skills/src/index.ts \
  packages/skills/src/__tests__/registry.test.ts \
  packages/skills/src/__tests__/integration.test.ts
git commit -m "refactor: split tracked and local skill registry state"
```

## Task 3: Make Skill Creation Local-First and Add Promotion

**Files:**
- Modify: `packages/skills/src/generator.ts`
- Modify: `packages/skills/src/__tests__/generator.test.ts`
- Modify: `packages/skills/src/__tests__/integration.test.ts`
- Test: `packages/skills/src/__tests__/generator.test.ts`
- Test: `packages/skills/src/__tests__/integration.test.ts`

- [ ] **Step 1: Add failing generator tests for local-first creation and move-based promotion**

```ts
it('creates new skills under skills/local and registers them as local', async () => {
  const result = await generator.createSkill({
    name: 'my-local-skill',
    description: 'A local test skill',
    code: VALID_SKILL_CODE,
    inputSchema: VALID_INPUT_SCHEMA,
    createdBy: 'admin-user',
    createdByRole: 'admin',
  });

  const expectedPath = join(tmpDir, 'local', 'my-local-skill.mjs');
  expect(result.success).toBe(true);
  expect(result.filePath).toBe(expectedPath);
  expect(registry.get('my-local-skill')?.definition.source).toBe('local');
});

it('promotes a local skill into skills/generated and removes the local copy', async () => {
  await generator.createSkill({
    name: 'promote-me',
    description: 'A local skill',
    code: VALID_SKILL_CODE,
    inputSchema: VALID_INPUT_SCHEMA,
    createdBy: 'admin-user',
    createdByRole: 'admin',
  });

  const promoted = await generator.promoteSkill('promote-me');

  expect(promoted.success).toBe(true);
  expect(existsSync(join(tmpDir, 'generated', 'promote-me.mjs'))).toBe(true);
  expect(existsSync(join(tmpDir, 'local', 'promote-me.mjs'))).toBe(false);
  expect(registry.get('promote-me')?.definition.source).toBe('generated');
});
```

- [ ] **Step 2: Run the generator-focused tests to verify they fail**

Run:

```bash
npm test -w packages/skills -- src/__tests__/generator.test.ts src/__tests__/integration.test.ts
```

Expected: FAIL because `createSkill()` still writes to `generated/` and `promoteSkill()` does not exist.

- [ ] **Step 3: Change generator creation to target `skills/local/` and local registry only**

```ts
const filePath = join(this.skillsDir, 'local', `${name}.mjs`);
writeFileSync(filePath, code, 'utf8');

this.registry.registerLocal(
  {
    name,
    description,
    version: '1.0.0',
    source: 'local',
    filePath,
    inputSchema,
    permissions,
    enabled: true,
  },
  {
    createdBy,
    createdAt: now,
    updatedAt: now,
  },
);

await this.registry.saveLocalState();
```

- [ ] **Step 4: Add explicit promotion that validates, moves, rewrites source, and saves tracked state**

```ts
async promoteSkill(name: string): Promise<GeneratorResult> {
  const existing = this.registry.get(name);
  if (!existing || existing.definition.source !== 'local') {
    return { success: false, errors: [`Local skill "${name}" not found`] };
  }

  const destination = join(this.skillsDir, 'generated', `${name}.mjs`);
  renameSync(existing.definition.filePath, destination);

  this.registry.unregisterLocal(name);
  this.registry.registerTracked({
    ...existing.definition,
    source: 'generated',
    filePath: join('skills', 'generated', `${name}.mjs`),
  });

  await this.registry.saveTracked();
  await this.registry.saveLocalState();
  return { success: true, filePath: destination };
}
```

- [ ] **Step 5: Re-run the generator and lifecycle tests until they pass**

Run:

```bash
npm test -w packages/skills -- src/__tests__/generator.test.ts src/__tests__/integration.test.ts
```

Expected: PASS with local creation and promotion behavior covered.

- [ ] **Step 6: Commit the local-first generator work**

```bash
git add \
  packages/skills/src/generator.ts \
  packages/skills/src/__tests__/generator.test.ts \
  packages/skills/src/__tests__/integration.test.ts
git commit -m "feat: make generated skills local by default"
```

## Task 4: Wire the MCP Server to Local-Only Runtime State

**Files:**
- Modify: `packages/skills/src/mcp-server.ts`
- Modify: `packages/skills/src/__tests__/mcp-server.test.ts`
- Modify: `packages/skills/src/test-skills.ts`
- Test: `packages/skills/src/__tests__/mcp-server.test.ts`

- [ ] **Step 1: Add failing MCP tests for local-first creation and explicit promotion**

```ts
it('create_skill writes a local skill instead of mutating the tracked registry', async () => {
  const result = await client.callTool({
    name: 'create_skill',
    arguments: {
      name: 'test-greet',
      description: 'Greets a user by name',
      code: 'export default async function(input) { return { success: true, result: `Hello ${input.name}` }; }',
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Name to greet' } },
        required: ['name'],
      },
    },
  });

  const parsed = JSON.parse((result.content as any)[0].text);
  expect(parsed.filePath).toContain('/local/test-greet.mjs');
});

it('promote_skill moves a local skill into the tracked generated area', async () => {
  await client.callTool({ name: 'create_skill', arguments: { /* same as above */ } });
  const result = await client.callTool({ name: 'promote_skill', arguments: { name: 'test-greet' } });
  const parsed = JSON.parse((result.content as any)[0].text);
  expect(parsed.success).toBe(true);
  expect(parsed.filePath).toContain('/generated/test-greet.mjs');
});
```

- [ ] **Step 2: Run the MCP tests to confirm failure**

Run:

```bash
npm test -w packages/skills -- src/__tests__/mcp-server.test.ts
```

Expected: FAIL because the server still creates tracked skills by default and does not expose `promote_skill`.

- [ ] **Step 3: Update `create_skill`, `skill_*` usage recording, and add `promote_skill`**

```ts
tools.push({
  name: 'promote_skill',
  description: 'Promote a local skill into tracked skills/generated/. Moves the skill and removes the local copy.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Local skill name to promote' },
    },
    required: ['name'],
  },
});

if (name === 'create_skill') {
  const result = await generator.createSkill({ /* existing args */ });
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

if (name === 'promote_skill') {
  const result = await generator.promoteSkill(toolArgs.name as string);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

if (name.startsWith('skill_')) {
  registry.recordUsage(skillName);
  await registry.saveLocalState();
  const output = await runner.run(skill.definition.filePath, toolArgs);
  return { content: [{ type: 'text', text: JSON.stringify(output) }] };
}
```

- [ ] **Step 4: Update the local harness to create `skills/local/` and use the new layout**

```ts
mkdirSync(resolve('./skills/local'), { recursive: true });
const registry = new SkillRegistry(resolve('./skills/registry.yaml'));
await registry.load();
```

- [ ] **Step 5: Re-run the MCP tests until they pass**

Run:

```bash
npm test -w packages/skills -- src/__tests__/mcp-server.test.ts
```

Expected: PASS with `create_skill` local-first, `promote_skill` present, and skill execution persisting runtime metadata only to local state.

- [ ] **Step 6: Commit the MCP wiring**

```bash
git add \
  packages/skills/src/mcp-server.ts \
  packages/skills/src/__tests__/mcp-server.test.ts \
  packages/skills/src/test-skills.ts
git commit -m "feat: add local skill promotion flow"
```

## Task 5: Normalize the Tracked Registry and Run Full Skills Verification

**Files:**
- Modify: `skills/registry.yaml`
- Modify: `packages/skills/src/__tests__/registry.test.ts`
- Modify: `packages/skills/src/__tests__/generator.test.ts`
- Modify: `packages/skills/src/__tests__/integration.test.ts`
- Modify: `packages/skills/src/__tests__/mcp-server.test.ts`
- Test: `packages/skills`

- [ ] **Step 1: Add a failing regression assertion that tracked registry entries are stable**

```ts
it('writes tracked registry entries without runtime metadata or absolute machine paths', async () => {
  await registry.saveTracked();
  const raw = readFileSync(registryPath, 'utf8');

  expect(raw).not.toContain('usageCount');
  expect(raw).not.toContain('lastUsed');
  expect(raw).not.toContain('/Users/');
});
```

- [ ] **Step 2: Run the full skills test suite to capture remaining failures**

Run:

```bash
npm test -w packages/skills
```

Expected: FAIL until the tracked registry fixture and all affected tests are aligned with the new schema.

- [ ] **Step 3: Normalize `skills/registry.yaml` to stable tracked definitions only**

```yaml
skills:
  - name: generate-image
    description: Generate an image from a text prompt using Gemini (Nano Banana 2). Returns a PNG image.
    version: 1.0.0
    source: bundled
    filePath: skills/bundled/generate-image.mjs
    inputSchema:
      type: object
      properties:
        prompt:
          type: string
          description: Text description of the image to generate
    permissions:
      - network
      - env
    enabled: true
```

- [ ] **Step 4: Update any remaining test fixtures and helpers to match the new tracked/local schema**

```ts
const registry = new SkillRegistry(registryPath);
await registry.load();
await registry.saveTracked();
await registry.saveLocalState();
```

- [ ] **Step 5: Run the full skills package tests and then repo smoke verification**

Run:

```bash
npm test -w packages/skills
npm test -w packages/main -- src/__tests__/bootstrap.test.ts
```

Expected:

- `packages/skills`: all tests PASS
- `packages/main` bootstrap test remains PASS because `new SkillRegistry(registryPath)` still works

- [ ] **Step 6: Commit the registry normalization and verification sweep**

```bash
git add \
  skills/registry.yaml \
  packages/skills/src/__tests__/registry.test.ts \
  packages/skills/src/__tests__/generator.test.ts \
  packages/skills/src/__tests__/integration.test.ts \
  packages/skills/src/__tests__/mcp-server.test.ts
git commit -m "refactor: keep tracked skill registry stable"
```

## Self-Review

### Spec coverage

- Local-only skills in `skills/local/`: covered by Tasks 1 and 3
- Runtime metadata local-only: covered by Tasks 1, 2, and 4
- Tracked registry stability: covered by Tasks 2 and 5
- Explicit promotion flow: covered by Tasks 3 and 4
- Collision rule with tracked precedence: covered by Task 2
- Migration of tracked registry: covered by Task 5

### Placeholder scan

- No `TODO`, `TBD`, or “implement later” placeholders remain.
- Every task includes exact file paths, commands, and concrete code snippets.

### Type consistency

- Skill source moves to `bundled | generated | local` throughout the plan.
- Runtime metadata is consistently local-only.
- `SkillRegistry` remains the facade used by bootstrap and MCP code.

