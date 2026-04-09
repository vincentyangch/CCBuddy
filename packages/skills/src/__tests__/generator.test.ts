import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { SkillRegistry } from '../registry.js';
import { SkillValidator } from '../validator.js';
import { SkillGenerator } from '../generator.js';
import type { CreateSkillRequest, UpdateSkillRequest } from '../generator.js';

// ── helpers ────────────────────────────────────────────────────────────────

const VALID_SKILL_CODE = `export default async function (input) {
  return { success: true, result: input.value };
}`;

const INVALID_SKILL_CODE = `import { exec } from 'child_process';
export default async function (input) {
  exec('ls');
  return { success: true };
}`;

const VALID_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    value: { type: 'string', description: 'The value to process' },
  },
};

// ── test setup ─────────────────────────────────────────────────────────────

let tmpDir: string;
let registry: SkillRegistry;
let validator: SkillValidator;
let generator: SkillGenerator;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'skill-generator-'));
  mkdirSync(join(tmpDir, 'generated'), { recursive: true });
  mkdirSync(join(tmpDir, 'bundled'), { recursive: true });
  mkdirSync(join(tmpDir, 'user'), { recursive: true });

  const registryPath = join(tmpDir, 'registry.yaml');
  registry = new SkillRegistry(registryPath);
  await registry.load();

  validator = new SkillValidator();
  generator = new SkillGenerator(registry, validator, tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── tests ──────────────────────────────────────────────────────────────────

describe('SkillGenerator', () => {
  describe('createSkill', () => {
    it('creates a local skill .mjs file and registers it as local', async () => {
      const request: CreateSkillRequest = {
        name: 'my-skill',
        description: 'A test skill',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin-user',
        createdByRole: 'admin',
      };

      const result = await generator.createSkill(request);

      expect(result.success).toBe(true);
      expect(result.filePath).toBeDefined();
      expect(result.errors).toBeUndefined();

      // File should exist on disk
      const expectedPath = join(tmpDir, 'local', 'my-skill.mjs');
      expect(existsSync(expectedPath)).toBe(true);
      expect(readFileSync(expectedPath, 'utf8')).toBe(VALID_SKILL_CODE);

      // Should be registered
      const skill = registry.get('my-skill');
      expect(skill).toBeDefined();
      expect(skill?.definition.name).toBe('my-skill');
      expect(skill?.definition.source).toBe('local');
      expect(skill?.definition.filePath).toBe(expectedPath);
      expect(skill?.metadata.createdBy).toBe('admin-user');

      const reloadedRegistry = new SkillRegistry(join(tmpDir, 'registry.yaml'));
      await reloadedRegistry.load();
      expect(reloadedRegistry.get('my-skill')?.definition.source).toBe('local');
      expect(reloadedRegistry.get('my-skill')?.definition.filePath).toBe(expectedPath);
    });

    it('rejects duplicate local create attempts without overwriting the existing draft', async () => {
      const firstRequest: CreateSkillRequest = {
        name: 'duplicate-local',
        description: 'First draft',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin-user',
        createdByRole: 'admin',
      };

      const firstResult = await generator.createSkill(firstRequest);
      expect(firstResult.success).toBe(true);

      registry.recordUsage('duplicate-local');
      await registry.saveLocalState();

      const duplicateResult = await generator.createSkill({
        ...firstRequest,
        description: 'Second draft',
        code: `export default async function (input) {
  return { success: true, result: 'overwritten' };
}`,
      });

      expect(duplicateResult.success).toBe(false);
      expect(duplicateResult.errors).toBeDefined();
      expect(duplicateResult.errors!.some(error => error.toLowerCase().includes('local skill'))).toBe(true);

      const filePath = join(tmpDir, 'local', 'duplicate-local.mjs');
      expect(readFileSync(filePath, 'utf8')).toBe(VALID_SKILL_CODE);
      expect(registry.get('duplicate-local')?.metadata.usageCount).toBe(1);

      const reloadedRegistry = new SkillRegistry(join(tmpDir, 'registry.yaml'));
      await reloadedRegistry.load();
      expect(reloadedRegistry.get('duplicate-local')?.metadata.usageCount).toBe(1);
      expect(readFileSync(filePath, 'utf8')).toBe(VALID_SKILL_CODE);
    });

    it('restores the local file and registry when local-state save fails', async () => {
      vi.spyOn(registry, 'saveLocalState').mockRejectedValueOnce(new Error('local save failed'));

      const request: CreateSkillRequest = {
        name: 'rollback-create',
        description: 'A test skill',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin-user',
        createdByRole: 'admin',
      };

      const result = await generator.createSkill(request);

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some(error => error.includes('local save failed'))).toBe(true);
      expect(existsSync(join(tmpDir, 'local', 'rollback-create.mjs'))).toBe(false);
      expect(registry.get('rollback-create')).toBeUndefined();

      const reloadedRegistry = new SkillRegistry(join(tmpDir, 'registry.yaml'));
      await reloadedRegistry.load();
      expect(reloadedRegistry.get('rollback-create')).toBeUndefined();
    });

    it('rejects create attempts that collide with tracked skills', async () => {
      registry.register(
        {
          name: 'shared-runtime',
          description: 'Tracked skill',
          version: '1.0.0',
          source: 'generated',
          filePath: join(tmpDir, 'generated', 'shared-runtime.mjs'),
          inputSchema: VALID_INPUT_SCHEMA,
          permissions: [],
          enabled: true,
        },
        {
          createdBy: 'system',
          createdAt: '2026-04-08T10:00:00Z',
          updatedAt: '2026-04-08T10:00:00Z',
          usageCount: 2,
          lastUsed: '2026-04-08T11:00:00Z',
        },
      );
      await registry.save();
      await registry.saveLocalState();

      const result = await generator.createSkill({
        name: 'shared-runtime',
        description: 'Local draft skill',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin-user',
        createdByRole: 'admin',
      });

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some(error => error.toLowerCase().includes('tracked'))).toBe(true);
      expect(existsSync(join(tmpDir, 'local', 'shared-runtime.mjs'))).toBe(false);
      expect(registry.get('shared-runtime')?.definition.source).toBe('generated');
      expect(registry.get('shared-runtime')?.metadata.usageCount).toBe(2);
      expect(registry.get('shared-runtime')?.metadata.lastUsed).toBe('2026-04-08T11:00:00Z');

      const reloadedRegistry = new SkillRegistry(join(tmpDir, 'registry.yaml'));
      await reloadedRegistry.load();
      expect(reloadedRegistry.get('shared-runtime')?.definition.source).toBe('generated');
      expect(reloadedRegistry.get('shared-runtime')?.metadata.usageCount).toBe(2);
      expect(reloadedRegistry.get('shared-runtime')?.metadata.lastUsed).toBe('2026-04-08T11:00:00Z');
    });

    it('rejects invalid code (child_process import)', async () => {
      const request: CreateSkillRequest = {
        name: 'bad-skill',
        description: 'A dangerous skill',
        code: INVALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin-user',
        createdByRole: 'admin',
      };

      const result = await generator.createSkill(request);

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
      expect(result.filePath).toBeUndefined();

      // File should NOT be created
      const expectedPath = join(tmpDir, 'generated', 'bad-skill.mjs');
      expect(existsSync(expectedPath)).toBe(false);

      // Should NOT be registered
      expect(registry.get('bad-skill')).toBeUndefined();
    });

    it('rejects skill creation from chat users (createdByRole: chat)', async () => {
      const request: CreateSkillRequest = {
        name: 'chat-skill',
        description: 'Created by chat user',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'some-user',
        createdByRole: 'chat',
      };

      const result = await generator.createSkill(request);

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some(e => e.toLowerCase().includes('chat'))).toBe(true);
      expect(existsSync(join(tmpDir, 'generated', 'chat-skill.mjs'))).toBe(false);
    });

    it('rejects invalid skill names - path traversal', async () => {
      const request: CreateSkillRequest = {
        name: '../escape',
        description: 'Path traversal attempt',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin',
        createdByRole: 'admin',
      };

      const result = await generator.createSkill(request);
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('rejects invalid skill names - uppercase letters', async () => {
      const request: CreateSkillRequest = {
        name: 'MySkill',
        description: 'Has uppercase',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin',
        createdByRole: 'admin',
      };

      const result = await generator.createSkill(request);
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('rejects invalid skill names - spaces', async () => {
      const request: CreateSkillRequest = {
        name: 'my skill',
        description: 'Has spaces',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin',
        createdByRole: 'admin',
      };

      const result = await generator.createSkill(request);
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('rejects invalid skill names - empty string', async () => {
      const request: CreateSkillRequest = {
        name: '',
        description: 'Empty name',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin',
        createdByRole: 'admin',
      };

      const result = await generator.createSkill(request);
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
    });
  });

  describe('updateSkill', () => {
    it('updates an existing local skill and persists the update', async () => {
      // First create the skill
      const createRequest: CreateSkillRequest = {
        name: 'update-me',
        description: 'Original description',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin',
        createdByRole: 'admin',
      };
      await generator.createSkill(createRequest);

      const newCode = `export default async function (input) {
  return { success: true, result: 'updated: ' + input.value };
}`;

      const updates: UpdateSkillRequest = {
        description: 'Updated description',
        code: newCode,
      };

      const result = await generator.updateSkill('update-me', updates);

      expect(result.success).toBe(true);

      // File should have new code
      const filePath = join(tmpDir, 'local', 'update-me.mjs');
      expect(readFileSync(filePath, 'utf8')).toBe(newCode);

      // Registry should have updated description
      const skill = registry.get('update-me');
      expect(skill?.definition.description).toBe('Updated description');
      expect(skill?.definition.source).toBe('local');

      const reloadedRegistry = new SkillRegistry(join(tmpDir, 'registry.yaml'));
      await reloadedRegistry.load();
      expect(reloadedRegistry.get('update-me')?.definition.description).toBe('Updated description');
      expect(reloadedRegistry.get('update-me')?.definition.source).toBe('local');
      expect(reloadedRegistry.get('update-me')?.definition.filePath).toBe(filePath);
    });

    it('restores the prior local skill when local-state save fails', async () => {
      const createRequest: CreateSkillRequest = {
        name: 'update-rollback',
        description: 'Original description',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin',
        createdByRole: 'admin',
      };
      await generator.createSkill(createRequest);

      registry.recordUsage('update-rollback');
      await registry.saveLocalState();

      vi.spyOn(registry, 'saveLocalState').mockRejectedValueOnce(new Error('local save failed'));

      const newCode = `export default async function (input) {
  return { success: true, result: 'updated: ' + input.value };
}`;

      const result = await generator.updateSkill('update-rollback', {
        description: 'Updated description',
        code: newCode,
      });

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some(error => error.includes('local save failed'))).toBe(true);
      expect(readFileSync(join(tmpDir, 'local', 'update-rollback.mjs'), 'utf8')).toBe(VALID_SKILL_CODE);
      expect(registry.get('update-rollback')?.definition.description).toBe('Original description');
      expect(registry.get('update-rollback')?.metadata.usageCount).toBe(1);
      expect(registry.get('update-rollback')?.metadata.lastUsed).toBeDefined();

      const reloadedRegistry = new SkillRegistry(join(tmpDir, 'registry.yaml'));
      await reloadedRegistry.load();
      expect(reloadedRegistry.get('update-rollback')?.definition.description).toBe('Original description');
      expect(reloadedRegistry.get('update-rollback')?.metadata.usageCount).toBe(1);
      expect(reloadedRegistry.get('update-rollback')?.metadata.lastUsed).toBeDefined();
    });
  });

  describe('promoteSkill', () => {
    it('moves a local skill into generated and removes the local copy', async () => {
      await generator.createSkill({
        name: 'promote-me',
        description: 'Local draft skill',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin-user',
        createdByRole: 'admin',
      });

      registry.recordUsage('promote-me');
      await registry.saveLocalState();

      const result = await generator.promoteSkill('promote-me');

      expect(result.success).toBe(true);
      expect(result.filePath).toBe(join(tmpDir, 'generated', 'promote-me.mjs'));

      expect(existsSync(join(tmpDir, 'generated', 'promote-me.mjs'))).toBe(true);
      expect(readFileSync(join(tmpDir, 'generated', 'promote-me.mjs'), 'utf8')).toBe(VALID_SKILL_CODE);
      expect(existsSync(join(tmpDir, 'local', 'promote-me.mjs'))).toBe(false);

      const skill = registry.get('promote-me');
      expect(skill?.definition.source).toBe('generated');
      expect(skill?.definition.filePath).toBe(join(tmpDir, 'generated', 'promote-me.mjs'));
      expect(skill?.metadata.usageCount).toBe(0);
      expect(skill?.metadata.lastUsed).toBeUndefined();

      const reloadedRegistry = new SkillRegistry(join(tmpDir, 'registry.yaml'));
      await reloadedRegistry.load();
      expect(reloadedRegistry.get('promote-me')?.definition.source).toBe('generated');
      expect(reloadedRegistry.get('promote-me')?.definition.filePath).toBe(join(tmpDir, 'generated', 'promote-me.mjs'));
      expect(reloadedRegistry.get('promote-me')?.metadata.usageCount).toBe(0);
      expect(reloadedRegistry.get('promote-me')?.metadata.lastUsed).toBeUndefined();
      expect(reloadedRegistry.listBySource('local').find(skill => skill.definition.name === 'promote-me')).toBeUndefined();

      const localRaw = yamlLoad(readFileSync(join(tmpDir, 'local', 'registry.yaml'), 'utf8')) as {
        runtimeMetadata?: Record<string, { usageCount: number; lastUsed?: string }>;
      };
      expect(localRaw.runtimeMetadata?.['local:promote-me']).toBeUndefined();
      expect(localRaw.runtimeMetadata?.['tracked:promote-me']?.usageCount).toBe(0);
      expect(localRaw.runtimeMetadata?.['tracked:promote-me']?.lastUsed).toBeUndefined();
    });

    it('refuses to promote when a tracked skill with the same name already exists', async () => {
      await generator.createSkill({
        name: 'shared',
        description: 'Local draft skill',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin-user',
        createdByRole: 'admin',
      });

      registry.register(
        {
          name: 'shared',
          description: 'Tracked skill',
          version: '1.0.0',
          source: 'generated',
          filePath: join(tmpDir, 'generated', 'shared.mjs'),
          inputSchema: VALID_INPUT_SCHEMA,
          permissions: [],
          enabled: true,
        },
        {
          createdBy: 'system',
          createdAt: '2026-04-08T12:00:00Z',
          updatedAt: '2026-04-08T12:00:00Z',
          usageCount: 0,
        },
      );
      await registry.save();

      const result = await generator.promoteSkill('shared');

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some(error => error.toLowerCase().includes('tracked'))).toBe(true);
      expect(existsSync(join(tmpDir, 'local', 'shared.mjs'))).toBe(true);
      expect(registry.get('shared')?.definition.source).toBe('generated');
    });

    it('restores the local draft when tracked persistence fails', async () => {
      await generator.createSkill({
        name: 'rollback-tracked',
        description: 'Local draft skill',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin-user',
        createdByRole: 'admin',
      });

      registry.recordUsage('rollback-tracked');
      await registry.saveLocalState();

      vi.spyOn(registry, 'save').mockRejectedValueOnce(new Error('tracked save failed'));

      const result = await generator.promoteSkill('rollback-tracked');

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some(error => error.includes('tracked save failed'))).toBe(true);
      expect(existsSync(join(tmpDir, 'local', 'rollback-tracked.mjs'))).toBe(true);
      expect(existsSync(join(tmpDir, 'generated', 'rollback-tracked.mjs'))).toBe(false);
      expect(registry.get('rollback-tracked')?.definition.source).toBe('local');
      expect(registry.get('rollback-tracked')?.metadata.usageCount).toBe(1);
      expect(registry.get('rollback-tracked')?.metadata.lastUsed).toBeDefined();

      const reloadedRegistry = new SkillRegistry(join(tmpDir, 'registry.yaml'));
      await reloadedRegistry.load();
      expect(reloadedRegistry.get('rollback-tracked')?.definition.source).toBe('local');
      expect(reloadedRegistry.get('rollback-tracked')?.metadata.usageCount).toBe(1);
      expect(reloadedRegistry.get('rollback-tracked')?.metadata.lastUsed).toBeDefined();
    });

    it('restores the local draft when local-state persistence fails after tracked save', async () => {
      await generator.createSkill({
        name: 'rollback-local',
        description: 'Local draft skill',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin-user',
        createdByRole: 'admin',
      });

      const localPath = join(tmpDir, 'local', 'rollback-local.mjs');
      const originalSaveLocalState = registry.saveLocalState.bind(registry);
      vi.spyOn(registry, 'saveLocalState')
        .mockRejectedValueOnce(new Error('local save failed'))
        .mockImplementation(async () => {
          expect(existsSync(localPath)).toBe(true);
          return originalSaveLocalState();
        });

      const result = await generator.promoteSkill('rollback-local');

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some(error => error.includes('local save failed'))).toBe(true);
      expect(existsSync(join(tmpDir, 'local', 'rollback-local.mjs'))).toBe(true);
      expect(existsSync(join(tmpDir, 'generated', 'rollback-local.mjs'))).toBe(false);
      expect(registry.get('rollback-local')?.definition.source).toBe('local');

      const reloadedRegistry = new SkillRegistry(join(tmpDir, 'registry.yaml'));
      await reloadedRegistry.load();
      expect(reloadedRegistry.get('rollback-local')?.definition.source).toBe('local');
    });
  });

  describe('loadBundledSkills', () => {
    it('loads bundled skills from bundled/ directory with companion .json metadata', async () => {
      // Create a bundled skill with companion json
      const bundledCode = `export default async function (input) {
  const name = input.name ?? 'World';
  return { success: true, result: \`Hello, \${name}!\` };
}`;
      writeFileSync(join(tmpDir, 'bundled', 'hello-world.mjs'), bundledCode, 'utf8');
      writeFileSync(
        join(tmpDir, 'bundled', 'hello-world.json'),
        JSON.stringify({
          name: 'hello-world',
          description: 'A simple greeting skill',
          version: '1.0.0',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Name to greet' },
            },
          },
          permissions: [],
        }),
        'utf8',
      );

      const count = await generator.loadBundledSkills();

      expect(count).toBe(1);

      const skill = registry.get('hello-world');
      expect(skill).toBeDefined();
      expect(skill?.definition.source).toBe('bundled');
      expect(skill?.definition.description).toBe('A simple greeting skill');
    });

    it('lets bundled skills win over pre-existing local drafts with the same name', async () => {
      registry.register(
        {
          name: 'hello-world',
          description: 'Local draft skill',
          version: '1.0.0',
          source: 'local',
          filePath: join(tmpDir, 'local', 'hello-world.mjs'),
          inputSchema: VALID_INPUT_SCHEMA,
          permissions: [],
          enabled: true,
        },
        {
          createdBy: 'admin-user',
          createdAt: '2026-04-08T10:00:00Z',
          updatedAt: '2026-04-08T10:00:00Z',
          usageCount: 1,
        },
      );

      const bundledCode = `export default async function (input) {
  return { success: true, result: input.value };
}`;
      writeFileSync(join(tmpDir, 'bundled', 'hello-world.mjs'), bundledCode, 'utf8');
      writeFileSync(
        join(tmpDir, 'bundled', 'hello-world.json'),
        JSON.stringify({
          name: 'hello-world',
          description: 'Bundled greeting skill',
          version: '1.0.0',
          inputSchema: VALID_INPUT_SCHEMA,
          permissions: [],
        }),
        'utf8',
      );

      const count = await generator.loadBundledSkills();

      expect(count).toBe(1);
      expect(registry.get('hello-world')?.definition.source).toBe('bundled');
      expect(registry.get('hello-world')?.definition.description).toBe('Bundled greeting skill');
      expect(registry.list().filter(skill => skill.definition.name === 'hello-world')).toHaveLength(1);
    });
  });
});
