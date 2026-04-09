import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { LocalSkillState } from '../local-skill-state.js';
import { TrackedRegistryStore } from '../tracked-registry-store.js';
import type {
  LocalRegistryFile,
  SkillDefinition,
  SkillPersistentMetadata,
  SkillRuntimeMetadata,
  TrackedRegistryFile,
} from '../types.js';

function makeSkill(name: string, source: SkillDefinition['source'] = 'local'): SkillDefinition {
  return {
    name,
    description: `Description for ${name}`,
    version: '1.0.0',
    source,
    filePath: `skills/${source}/${name}.mjs`,
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string' },
      },
    },
    permissions: [],
    enabled: true,
  };
}

function makePersistentMetadata(): SkillPersistentMetadata {
  return {
    createdBy: 'test',
    createdAt: '2026-04-08T10:00:00Z',
    updatedAt: '2026-04-08T10:00:00Z',
  };
}

function makeRuntimeMetadata(): SkillRuntimeMetadata {
  return {
    usageCount: 3,
    lastUsed: '2026-04-08T12:00:00Z',
  };
}

let tmpDir: string;
let localDir: string;
let trackedPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'skill-local-state-'));
  localDir = join(tmpDir, 'skills', 'local');
  trackedPath = join(tmpDir, 'skills', 'registry.yaml');
  mkdirSync(localDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('TrackedRegistryStore', () => {
  it('writes tracked registry entries without runtime metadata and reloads absolute paths for runtime use', async () => {
    const store = new TrackedRegistryStore(trackedPath);
    const trackedFilePath = join(tmpDir, 'skills', 'generated', 'tracked-skill.mjs');
    const trackedFile: TrackedRegistryFile = {
      skills: [
        {
          definition: {
            ...makeSkill('tracked-skill', 'generated'),
            filePath: trackedFilePath,
          },
          metadata: makePersistentMetadata(),
        },
      ],
    };

    await store.save(trackedFile);

    const parsed = yamlLoad(readFileSync(trackedPath, 'utf8')) as Record<string, unknown>;
    expect(parsed.runtimeMetadata).toBeUndefined();
    expect((parsed.skills as Array<{ definition: { filePath: string } }>)[0].definition.filePath).toBe('generated/tracked-skill.mjs');

    const loaded = await store.load();
    expect(loaded.skills).toHaveLength(1);
    expect(loaded.skills[0].definition.name).toBe('tracked-skill');
    expect(loaded.skills[0].definition.filePath).toBe(trackedFilePath);
    expect(loaded.skills[0].metadata.createdBy).toBe('test');
  });

  it('skips tracked entries with malformed skill definitions', async () => {
    writeFileSync(
      trackedPath,
      `skills:
  - definition:
      name: valid-tracked
      description: Valid tracked skill
      version: "1.0.0"
      source: generated
      filePath: skills/generated/valid-tracked.mjs
      inputSchema:
        type: object
        properties: {}
      permissions: []
      enabled: true
    metadata:
      createdBy: test
      createdAt: "2026-04-08T10:00:00Z"
      updatedAt: "2026-04-08T10:00:00Z"
  - definition:
      name: broken-tracked
      source: generated
      inputSchema:
        type: object
        properties: {}
      permissions: []
      enabled: true
    metadata:
      createdBy: test
      createdAt: "2026-04-08T10:00:00Z"
      updatedAt: "2026-04-08T10:00:00Z"
`,
      'utf8',
    );

    const store = new TrackedRegistryStore(trackedPath);

    const loaded = await store.load();

    expect(loaded.skills).toHaveLength(1);
    expect(loaded.skills[0].definition.name).toBe('valid-tracked');
  });
});

describe('LocalSkillState', () => {
  it('treats a missing local registry as empty', async () => {
    const state = new LocalSkillState(localDir);

    const loaded = await state.load();

    expect(loaded.skills).toEqual([]);
    expect(loaded.runtimeMetadata).toEqual({});
  });

  it('lazily creates the local registry when runtime metadata is saved', async () => {
    const state = new LocalSkillState(localDir);

    await state.saveRuntimeMetadata('local-only-skill', makeRuntimeMetadata());

    const registryPath = join(localDir, 'registry.yaml');
    expect(existsSync(registryPath)).toBe(true);

    const parsed = yamlLoad(readFileSync(registryPath, 'utf8')) as LocalRegistryFile;
    expect(parsed.skills).toEqual([]);
    expect(parsed.runtimeMetadata['local-only-skill']).toEqual(makeRuntimeMetadata());
  });

  it('stores runtime metadata separately from local skill definitions', async () => {
    const state = new LocalSkillState(localDir);
    const file: LocalRegistryFile = {
      skills: [
        {
          definition: makeSkill('local-skill'),
          metadata: makePersistentMetadata(),
        },
      ],
      runtimeMetadata: {
        'local-skill': makeRuntimeMetadata(),
      },
    };

    await state.save(file);

    const loaded = await state.load();
    expect(loaded.skills).toHaveLength(1);
    expect(loaded.skills[0].definition.name).toBe('local-skill');
    expect(loaded.skills[0].metadata).toEqual(makePersistentMetadata());
    expect(loaded.runtimeMetadata['local-skill']).toEqual(makeRuntimeMetadata());
  });

  it('treats malformed local registry YAML as empty', async () => {
    writeFileSync(join(localDir, 'registry.yaml'), '{ invalid yaml: [[[');
    const state = new LocalSkillState(localDir);

    const loaded = await state.load();

    expect(loaded.skills).toEqual([]);
    expect(loaded.runtimeMetadata).toEqual({});
  });

  it('skips local entries with malformed skill definitions while preserving valid ones', async () => {
    writeFileSync(
      join(localDir, 'registry.yaml'),
      `skills:
  - definition:
      name: valid-local
      description: Valid local skill
      version: "1.0.0"
      source: local
      filePath: skills/local/valid-local.mjs
      inputSchema:
        type: object
        properties: {}
      permissions: []
      enabled: true
    metadata:
      createdBy: test
      createdAt: "2026-04-08T10:00:00Z"
      updatedAt: "2026-04-08T10:00:00Z"
  - definition:
      name: broken-local
      description: Missing file path
      version: "1.0.0"
      source: local
      inputSchema:
        type: object
        properties: {}
      permissions: []
      enabled: true
    metadata:
      createdBy: test
      createdAt: "2026-04-08T10:00:00Z"
      updatedAt: "2026-04-08T10:00:00Z"
runtimeMetadata:
  local:valid-local:
    usageCount: 1
`,
      'utf8',
    );

    const state = new LocalSkillState(localDir);

    const loaded = await state.load();

    expect(loaded.skills).toHaveLength(1);
    expect(loaded.skills[0].definition.name).toBe('valid-local');
    expect(loaded.runtimeMetadata['local:valid-local']?.usageCount).toBe(1);
  });
});
