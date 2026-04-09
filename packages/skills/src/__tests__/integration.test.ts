import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { SkillRegistry } from '../registry.js';
import { LocalSkillState } from '../local-skill-state.js';
import { SkillValidator } from '../validator.js';
import { SkillGenerator } from '../generator.js';
import { SkillRunner } from '../runner.js';

// ── Skill code snippets ──────────────────────────────────────────────────────

const ADDER_CODE = `export default async function(input) {
  return { success: true, result: input.a + input.b };
}`;

const ADDER_DOUBLED_CODE = `export default async function(input) {
  return { success: true, result: (input.a + input.b) * 2 };
}`;

// ── Test fixtures ────────────────────────────────────────────────────────────

let tmpDir: string;
let registryPath: string;
let registry: SkillRegistry;
let validator: SkillValidator;
let generator: SkillGenerator;
let runner: SkillRunner;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'skill-integration-'));
  mkdirSync(join(tmpDir, 'generated'), { recursive: true });
  mkdirSync(join(tmpDir, 'bundled'), { recursive: true });
  mkdirSync(join(tmpDir, 'user'), { recursive: true });

  registryPath = join(tmpDir, 'registry.yaml');
  registry = new SkillRegistry(registryPath);
  await registry.load();

  validator = new SkillValidator();
  generator = new SkillGenerator(registry, validator, tmpDir);
  runner = new SkillRunner({ timeoutMs: 5000 });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Full lifecycle integration test ─────────────────────────────────────────

describe('Skills full lifecycle', () => {
  it('keeps tracked skills ahead of colliding local skills', async () => {
    registry.register({
      name: 'shared',
      description: 'Tracked shared skill',
      version: '1.0.0',
      source: 'generated',
      filePath: join(tmpDir, 'generated', 'shared.mjs'),
      inputSchema: {
        type: 'object',
        properties: {},
      },
      permissions: [],
      enabled: true,
    }, {
      createdBy: 'system',
      createdAt: '2026-04-08T10:00:00Z',
      updatedAt: '2026-04-08T10:00:00Z',
      usageCount: 0,
    });
    await registry.save();

    const localState = new LocalSkillState(join(tmpDir, 'local'));
    await localState.saveLocalSkill({
      definition: {
        name: 'shared',
        description: 'Local shared skill',
        version: '1.0.0',
        source: 'local',
        filePath: join(tmpDir, 'local', 'shared.mjs'),
        inputSchema: {
          type: 'object',
          properties: {},
        },
        permissions: [],
        enabled: true,
      },
      metadata: {
        createdBy: 'local-user',
        createdAt: '2026-04-08T11:00:00Z',
        updatedAt: '2026-04-08T11:00:00Z',
      },
    });

    const reloadedRegistry = new SkillRegistry(registryPath);
    await reloadedRegistry.load();

    expect(reloadedRegistry.get('shared')?.definition.source).toBe('generated');
    expect(reloadedRegistry.list().filter(skill => skill.definition.name === 'shared')).toHaveLength(1);
  });

  it('create local → register → execute → record usage → update → execute updated', async () => {
    // Step 1: Create skill via generator
    const createResult = await generator.createSkill({
      name: 'adder',
      description: 'Adds two numbers together',
      code: ADDER_CODE,
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'First operand' },
          b: { type: 'number', description: 'Second operand' },
        },
        required: ['a', 'b'],
      },
      permissions: [],
      createdBy: 'admin-user',
      createdByRole: 'admin',
    });

    expect(createResult.success).toBe(true);
    expect(createResult.filePath).toBeDefined();
    expect(createResult.filePath).toBe(join(tmpDir, 'local', 'adder.mjs'));

    // Step 2: Verify it's registered in the registry
    const registered = registry.get('adder');
    expect(registered).toBeDefined();
    expect(registered!.definition.name).toBe('adder');
    expect(registered!.definition.source).toBe('local');
    expect(registered!.definition.enabled).toBe(true);
    expect(registered!.metadata.createdBy).toBe('admin-user');
    expect(registered!.metadata.usageCount).toBe(0);

    // Step 3: Execute it via runner — pass { a: 3, b: 4 }, expect result 7
    const output1 = await runner.run(createResult.filePath!, { a: 3, b: 4 });
    expect(output1.success).toBe(true);
    expect(output1.result).toBe(7);

    // Step 4: Record usage, verify count incremented
    registry.recordUsage('adder');
    const afterUsage = registry.get('adder');
    expect(afterUsage!.metadata.usageCount).toBe(1);
    expect(afterUsage!.metadata.lastUsed).toBeDefined();

    await registry.saveLocalState();

    const localRaw = yamlLoad(readFileSync(join(tmpDir, 'local', 'registry.yaml'), 'utf8')) as {
      runtimeMetadata?: Record<string, { usageCount: number; lastUsed?: string }>;
    };
    expect(localRaw.runtimeMetadata?.['local:adder']?.usageCount).toBe(1);
    expect(localRaw.runtimeMetadata?.['local:adder']?.lastUsed).toBeDefined();

    const reloadedRegistry = new SkillRegistry(registryPath);
    await reloadedRegistry.load();
    expect(reloadedRegistry.get('adder')?.metadata.usageCount).toBe(1);

    // Step 5: Update the skill (multiply result by 2)
    const updateResult = await generator.updateSkill('adder', {
      code: ADDER_DOUBLED_CODE,
    });
    expect(updateResult.success).toBe(true);
    expect(updateResult.filePath).toBe(join(tmpDir, 'local', 'adder.mjs'));

    const reloadedAfterUpdate = new SkillRegistry(registryPath);
    await reloadedAfterUpdate.load();
    expect(reloadedAfterUpdate.get('adder')?.definition.source).toBe('local');
    expect(reloadedAfterUpdate.get('adder')?.definition.description).toBe('Adds two numbers together');

    // Step 6: Execute updated version — expect result 14
    const output2 = await runner.run(updateResult.filePath!, { a: 3, b: 4 });
    expect(output2.success).toBe(true);
    expect(output2.result).toBe(14);

    // Step 7: Verify tool descriptions are available
    const toolDescriptions = registry.getToolDescriptions();
    const adderTool = toolDescriptions.find(t => t.name === 'skill_adder');
    expect(adderTool).toBeDefined();
    expect(adderTool!.name).toBe('skill_adder');
    expect(adderTool!.description).toBe('Adds two numbers together');
    expect(adderTool!.inputSchema.type).toBe('object');
  }, 15000);

  it('promotes a local skill into generated and removes the local copy', async () => {
    const createResult = await generator.createSkill({
      name: 'promote-adder',
      description: 'Starts local',
      code: ADDER_CODE,
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'First operand' },
          b: { type: 'number', description: 'Second operand' },
        },
        required: ['a', 'b'],
      },
      permissions: [],
      createdBy: 'admin-user',
      createdByRole: 'admin',
    });

    expect(createResult.success).toBe(true);
    expect(createResult.filePath).toBe(join(tmpDir, 'local', 'promote-adder.mjs'));

    const promoteResult = await generator.promoteSkill('promote-adder');
    expect(promoteResult.success).toBe(true);
    expect(promoteResult.filePath).toBe(join(tmpDir, 'generated', 'promote-adder.mjs'));

    const promoted = registry.get('promote-adder');
    expect(promoted).toBeDefined();
    expect(promoted!.definition.source).toBe('generated');
    expect(promoted!.definition.filePath).toBe(join(tmpDir, 'generated', 'promote-adder.mjs'));

    expect(readFileSync(join(tmpDir, 'generated', 'promote-adder.mjs'), 'utf8')).toBe(ADDER_CODE);

    const reloadedRegistry = new SkillRegistry(registryPath);
    await reloadedRegistry.load();
    expect(reloadedRegistry.get('promote-adder')?.definition.source).toBe('generated');
    expect(reloadedRegistry.get('promote-adder')?.definition.filePath).toBe(join(tmpDir, 'generated', 'promote-adder.mjs'));
    expect(reloadedRegistry.listBySource('local').find(skill => skill.definition.name === 'promote-adder')).toBeUndefined();
  }, 15000);
});
