import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { normalizeSkillDefinition } from './skill-definition-normalizer.js';
import type {
  LocalRegistryEntry,
  LocalRegistryFile,
  SkillPersistentMetadata,
  SkillRuntimeMetadata,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function emptyLocalRegistry(): LocalRegistryFile {
  return { skills: [], runtimeMetadata: {} };
}

function normalizeMetadata(value: unknown): SkillPersistentMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const createdBy = value.createdBy;
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;

  if (!isString(createdBy) || !isString(createdAt) || !isString(updatedAt)) {
    return undefined;
  }

  return { createdBy, createdAt, updatedAt };
}

function normalizeSkillEntry(value: unknown): LocalRegistryEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const definition = normalizeSkillDefinition(value.definition);
  const metadata = normalizeMetadata(value.metadata);

  if (!definition || !metadata) {
    return undefined;
  }

  return {
    definition,
    metadata,
  };
}

function normalizeRuntimeMetadata(value: unknown): SkillRuntimeMetadata | undefined {
  if (!isRecord(value) || !isFiniteNumber(value.usageCount)) {
    return undefined;
  }

  const runtimeMetadata: SkillRuntimeMetadata = {
    usageCount: value.usageCount,
  };

  if (isString(value.lastUsed)) {
    runtimeMetadata.lastUsed = value.lastUsed;
  }

  return runtimeMetadata;
}

function normalizeLocalRegistry(value: unknown): LocalRegistryFile {
  if (!isRecord(value)) {
    return emptyLocalRegistry();
  }

  const skills = Array.isArray(value.skills)
    ? value.skills.map(normalizeSkillEntry).filter((entry): entry is LocalRegistryEntry => entry !== undefined)
    : [];

  const runtimeMetadata: Record<string, SkillRuntimeMetadata> = {};
  if (isRecord(value.runtimeMetadata)) {
    for (const [name, metadata] of Object.entries(value.runtimeMetadata)) {
      const normalized = normalizeRuntimeMetadata(metadata);
      if (normalized) {
        runtimeMetadata[name] = normalized;
      }
    }
  }

  return { skills, runtimeMetadata };
}

export class LocalSkillState {
  constructor(private readonly localDir: string) {}

  private get registryPath(): string {
    return join(this.localDir, 'registry.yaml');
  }

  async load(): Promise<LocalRegistryFile> {
    if (!existsSync(this.registryPath)) {
      return emptyLocalRegistry();
    }

    try {
      const raw = readFileSync(this.registryPath, 'utf8');
      return normalizeLocalRegistry(yamlLoad(raw));
    } catch {
      return emptyLocalRegistry();
    }
  }

  async save(file: LocalRegistryFile): Promise<void> {
    mkdirSync(dirname(this.registryPath), { recursive: true });

    const normalized: LocalRegistryFile = {
      skills: file.skills
        .map(normalizeSkillEntry)
        .filter((entry): entry is LocalRegistryEntry => entry !== undefined),
      runtimeMetadata: {},
    };

    for (const [name, metadata] of Object.entries(file.runtimeMetadata ?? {})) {
      const normalizedMetadata = normalizeRuntimeMetadata(metadata);
      if (normalizedMetadata) {
        normalized.runtimeMetadata[name] = normalizedMetadata;
      }
    }

    writeFileSync(this.registryPath, yamlDump(normalized), 'utf8');
  }

  async loadLocalSkill(name: string): Promise<LocalRegistryEntry | undefined> {
    const file = await this.load();
    return file.skills.find(entry => entry.definition.name === name);
  }

  async saveLocalSkill(entry: LocalRegistryEntry): Promise<void> {
    const file = await this.load();
    const skills = file.skills.filter(existing => existing.definition.name !== entry.definition.name);
    skills.push(entry);

    await this.save({
      skills,
      runtimeMetadata: file.runtimeMetadata,
    });
  }

  async getRuntimeMetadata(name: string): Promise<SkillRuntimeMetadata | undefined> {
    const file = await this.load();
    return file.runtimeMetadata[name];
  }

  async saveRuntimeMetadata(name: string, metadata: SkillRuntimeMetadata): Promise<void> {
    const file = await this.load();

    await this.save({
      skills: file.skills,
      runtimeMetadata: {
        ...file.runtimeMetadata,
        [name]: metadata,
      },
    });
  }
}
