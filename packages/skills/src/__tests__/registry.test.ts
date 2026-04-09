import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { load as yamlLoad } from 'js-yaml';
import { SkillRegistry, type ToolDescription } from '../registry.js';
import { LocalSkillState } from '../local-skill-state.js';
import type { SkillDefinition, SkillMetadata } from '../types.js';

// ── helpers ────────────────────────────────────────────────────────────────

function makeSkill(name: string, source: SkillDefinition['source'] = 'bundled'): SkillDefinition {
  return {
    name,
    description: `Description for ${name}`,
    version: '1.0.0',
    source,
    filePath: `skills/${source}/${name}.mjs`,
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Input value' },
      },
      required: ['input'],
    },
    permissions: [],
    enabled: true,
  };
}

function makeMeta(): SkillMetadata {
  return {
    createdBy: 'test',
    createdAt: '2026-03-16T10:00:00Z',
    updatedAt: '2026-03-16T10:00:00Z',
    usageCount: 0,
  };
}

// ── test setup ─────────────────────────────────────────────────────────────

let tmpDir: string;
let registryPath: string;
let localDir: string;
let registry: SkillRegistry;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'skill-registry-'));
  registryPath = join(tmpDir, 'registry.yaml');
  localDir = join(tmpDir, 'local');
  registry = new SkillRegistry(registryPath);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── tests ──────────────────────────────────────────────────────────────────

describe('SkillRegistry', () => {
  it('loads from empty registry file (no file present)', async () => {
    await registry.load();
    expect(registry.list()).toHaveLength(0);
  });

  it('registers a skill and retrieves it', async () => {
    await registry.load();
    const skill = makeSkill('hello-world');
    const meta = makeMeta();

    registry.register(skill, meta);
    const retrieved = registry.get('hello-world');

    expect(retrieved).toBeDefined();
    expect(retrieved?.definition.name).toBe('hello-world');
    expect(retrieved?.metadata.createdBy).toBe('test');
  });

  it('persists to YAML file and reloads', async () => {
    await registry.load();
    registry.register(makeSkill('persist-me'), makeMeta());
    await registry.save();

    // Create a fresh instance pointing to same file
    const registry2 = new SkillRegistry(registryPath);
    await registry2.load();

    expect(registry2.list()).toHaveLength(1);
    expect(registry2.get('persist-me')?.definition.name).toBe('persist-me');
  });

  it('unregisters a skill', async () => {
    await registry.load();
    registry.register(makeSkill('to-remove'), makeMeta());
    expect(registry.list()).toHaveLength(1);

    registry.unregister('to-remove');
    expect(registry.list()).toHaveLength(0);
    expect(registry.get('to-remove')).toBeUndefined();
  });

  it('prevents duplicate names', async () => {
    await registry.load();
    registry.register(makeSkill('duplicate'), makeMeta());

    expect(() => registry.register(makeSkill('duplicate'), makeMeta())).toThrow();
  });

  it('updates existing skill version', async () => {
    await registry.load();
    registry.register(makeSkill('versioned'), makeMeta());

    const updatedDef = { ...makeSkill('versioned'), version: '2.0.0' };
    registry.update('versioned', updatedDef);

    const result = registry.get('versioned');
    expect(result?.definition.version).toBe('2.0.0');
    // updatedAt should be set to a recent date
    expect(result?.metadata.updatedAt).not.toBe('2026-03-16T10:00:00Z');
  });

  it('moves skills between tracked and local stores when source changes', async () => {
    await registry.load();
    registry.register(makeSkill('promote-local', 'local'), makeMeta());
    registry.register(makeSkill('demote-tracked', 'generated'), makeMeta());

    registry.update('promote-local', makeSkill('promote-local', 'generated'));
    registry.update('demote-tracked', makeSkill('demote-tracked', 'local'));

    expect(registry.get('promote-local')?.definition.source).toBe('generated');
    expect(registry.get('demote-tracked')?.definition.source).toBe('local');

    await registry.save();
    await registry.saveLocalState();

    const trackedRaw = yamlLoad(readFileSync(registryPath, 'utf8')) as {
      skills?: Array<{ definition?: { name?: string; source?: string } }>;
    };
    const trackedNames = trackedRaw.skills?.map(skill => skill.definition?.name);

    const localRaw = yamlLoad(readFileSync(join(localDir, 'registry.yaml'), 'utf8')) as {
      skills?: Array<{ definition?: { name?: string; source?: string } }>;
    };
    const localNames = localRaw.skills?.map(skill => skill.definition?.name);

    expect(trackedNames).toContain('promote-local');
    expect(trackedNames).not.toContain('demote-tracked');
    expect(localNames).toContain('demote-tracked');
    expect(localNames).not.toContain('promote-local');
  });

  it('filters by source (bundled/generated/user)', async () => {
    await registry.load();
    registry.register(makeSkill('bundled-skill', 'bundled'), makeMeta());
    registry.register(makeSkill('generated-skill', 'generated'), makeMeta());
    registry.register(makeSkill('user-skill', 'user'), makeMeta());

    expect(registry.listBySource('bundled')).toHaveLength(1);
    expect(registry.listBySource('generated')).toHaveLength(1);
    expect(registry.listBySource('user')).toHaveLength(1);
    expect(registry.listBySource('bundled')[0].definition.name).toBe('bundled-skill');
  });

  it('tracks usage count and lastUsed', async () => {
    await registry.load();
    registry.register(makeSkill('tracked'), makeMeta());

    registry.recordUsage('tracked');
    registry.recordUsage('tracked');

    const result = registry.get('tracked');
    expect(result?.metadata.usageCount).toBe(2);
    expect(result?.metadata.lastUsed).toBeDefined();
  });

  it('tracks usage in local state without writing usage metadata to tracked YAML', async () => {
    await registry.load();
    registry.register(makeSkill('tracked'), makeMeta());

    registry.recordUsage('tracked');
    registry.recordUsage('tracked');

    await registry.save();
    await registry.saveLocalState();

    const trackedRaw = yamlLoad(readFileSync(registryPath, 'utf8')) as Record<string, unknown>;
    const trackedSkill = (trackedRaw.skills as Array<Record<string, unknown>>)[0];
    expect(trackedSkill.metadata).not.toHaveProperty('usageCount');

    const localRaw = yamlLoad(readFileSync(join(localDir, 'registry.yaml'), 'utf8')) as {
      runtimeMetadata?: Record<string, { usageCount: number; lastUsed?: string }>;
    };

    expect(localRaw.runtimeMetadata?.['tracked:tracked']?.usageCount).toBe(2);
    expect(localRaw.runtimeMetadata?.['tracked:tracked']?.lastUsed).toBeDefined();

    const freshRegistry = new SkillRegistry(registryPath);
    await freshRegistry.load();
    expect(freshRegistry.get('tracked')?.metadata.usageCount).toBe(2);
  });

  it('keeps tracked metadata isolated from hidden local runtime metadata', async () => {
    await registry.load();
    registry.register(makeSkill('shared', 'generated'), makeMeta());
    await registry.save();

    const localState = new LocalSkillState(localDir);
    await localState.save({
      skills: [
        {
          definition: makeSkill('shared', 'local'),
          metadata: makeMeta(),
        },
      ],
      runtimeMetadata: {
        'local:shared': {
          usageCount: 5,
          lastUsed: '2026-03-16T11:00:00Z',
        },
      },
    });

    const reloadedRegistry = new SkillRegistry(registryPath);
    await reloadedRegistry.load();
    const shared = reloadedRegistry.get('shared');

    expect(shared?.definition.source).toBe('generated');
    expect(shared?.metadata.usageCount).toBe(0);
    expect(shared?.metadata.lastUsed).toBeUndefined();
  });

  it('preserves tracked runtime metadata when updating a tracked skill that collides with a hidden local draft', async () => {
    await registry.load();
    registry.register(makeSkill('shared', 'generated'), makeMeta());
    registry.recordUsage('shared');
    registry.recordUsage('shared');
    await registry.save();
    await registry.saveLocalState();

    const localState = new LocalSkillState(localDir);
    await localState.saveLocalSkill({
      definition: makeSkill('shared', 'local'),
      metadata: makeMeta(),
    });
    await localState.saveRuntimeMetadata('local:shared', {
      usageCount: 5,
      lastUsed: '2026-03-16T11:00:00Z',
    });

    const reloadedRegistry = new SkillRegistry(registryPath);
    await reloadedRegistry.load();

    reloadedRegistry.update('shared', {
      ...makeSkill('shared', 'generated'),
      description: 'Updated tracked skill',
    });

    expect(reloadedRegistry.get('shared')?.definition.description).toBe('Updated tracked skill');
    expect(reloadedRegistry.get('shared')?.metadata.usageCount).toBe(2);
    expect(reloadedRegistry.get('shared')?.metadata.lastUsed).toBeDefined();

    await reloadedRegistry.saveLocalState();

    const localRaw = yamlLoad(readFileSync(join(localDir, 'registry.yaml'), 'utf8')) as {
      skills?: Array<{ definition?: { name?: string; source?: string } }>;
      runtimeMetadata?: Record<string, { usageCount: number; lastUsed?: string }>;
    };

    expect(localRaw.skills?.map(skill => skill.definition?.name)).toContain('shared');
    expect(localRaw.skills?.find(skill => skill.definition?.name === 'shared')?.definition?.source).toBe('local');
    expect(localRaw.runtimeMetadata?.['tracked:shared']?.usageCount).toBe(2);
    expect(localRaw.runtimeMetadata?.['tracked:shared']?.lastUsed).toBeDefined();
    expect(localRaw.runtimeMetadata?.['local:shared']?.usageCount).toBe(5);
    expect(localRaw.runtimeMetadata?.['local:shared']?.lastUsed).toBe('2026-03-16T11:00:00Z');
  });

  it('prefers tracked skills over colliding local skills while still loading non-colliding locals', async () => {
    await registry.load();
    registry.register(makeSkill('shared', 'generated'), makeMeta());
    await registry.save();

    const localState = new LocalSkillState(localDir);
    await localState.saveLocalSkill({
      definition: makeSkill('shared', 'local'),
      metadata: makeMeta(),
    });
    await localState.saveLocalSkill({
      definition: makeSkill('local-only', 'local'),
      metadata: makeMeta(),
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mergedRegistry = new SkillRegistry(registryPath);
    try {
      await mergedRegistry.load();
      expect(mergedRegistry.get('shared')?.definition.source).toBe('generated');
      expect(mergedRegistry.get('local-only')?.definition.source).toBe('local');
      expect(mergedRegistry.list().map(skill => skill.definition.name)).toEqual(
        expect.arrayContaining(['shared', 'local-only']),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Local skill "shared"'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('generates tool descriptions for Claude Code (prefixed skill_)', async () => {
    await registry.load();
    registry.register(makeSkill('my-tool'), makeMeta());

    const tools = registry.getToolDescriptions();
    const skillTool = tools.find(t => t.name === 'skill_my-tool');

    expect(skillTool).toBeDefined();
    expect(skillTool?.description).toContain('my-tool');
    expect(skillTool?.inputSchema.type).toBe('object');
  });

  it('registers external tools from other modules', async () => {
    await registry.load();
    const externalTool: ToolDescription = {
      name: 'apple_send_message',
      description: 'Send an iMessage via Apple Messages',
      inputSchema: {
        type: 'object',
        properties: {
          recipient: { type: 'string', description: 'Phone or email' },
          message: { type: 'string', description: 'Message text' },
        },
        required: ['recipient', 'message'],
      },
    };

    registry.registerExternalTool(externalTool);

    const tools = registry.getToolDescriptions();
    const found = tools.find(t => t.name === 'apple_send_message');
    expect(found).toBeDefined();
    expect(found?.description).toBe('Send an iMessage via Apple Messages');
  });

  it('includes both skill-based and external tools in getToolDescriptions()', async () => {
    await registry.load();
    registry.register(makeSkill('skill-a'), makeMeta());
    registry.registerExternalTool({
      name: 'memory_recall',
      description: 'Recall from memory',
      inputSchema: { type: 'object', properties: {} },
    });

    const tools = registry.getToolDescriptions();
    const names = tools.map(t => t.name);

    expect(names).toContain('skill_skill-a');
    expect(names).toContain('memory_recall');
  });

  it('update on non-existent skill throws', async () => {
    await registry.load();

    expect(() => registry.update('ghost', makeSkill('ghost'))).toThrow();
  });

  it('handles corrupted YAML file gracefully (no crash)', async () => {
    writeFileSync(registryPath, '{ invalid yaml: [[[');

    const corruptRegistry = new SkillRegistry(registryPath);
    await expect(corruptRegistry.load()).resolves.not.toThrow();
    expect(corruptRegistry.list()).toHaveLength(0);
  });

  it('recordUsage on non-existent skill is silent no-op', async () => {
    await registry.load();

    expect(() => registry.recordUsage('does-not-exist')).not.toThrow();
    expect(registry.list()).toHaveLength(0);
  });

  it('unregisterExternalTool removes an external tool', async () => {
    await registry.load();
    const tool: ToolDescription = {
      name: 'media_play',
      description: 'Play media',
      inputSchema: { type: 'object', properties: {} },
    };

    registry.registerExternalTool(tool);
    expect(registry.getToolDescriptions().find(t => t.name === 'media_play')).toBeDefined();

    registry.unregisterExternalTool('media_play');
    expect(registry.getToolDescriptions().find(t => t.name === 'media_play')).toBeUndefined();
  });
});
