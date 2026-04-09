import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { normalizeSkillDefinition } from './skill-definition-normalizer.js';
import type {
  SkillDefinition,
  SkillPersistentMetadata,
  TrackedRegistryEntry,
  TrackedRegistryFile,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function emptyTrackedRegistry(): TrackedRegistryFile {
  return { skills: [] };
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

function normalizeEntry(value: unknown): TrackedRegistryEntry | undefined {
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

function normalizeFile(value: unknown): TrackedRegistryFile {
  if (!isRecord(value) || !Array.isArray(value.skills)) {
    return emptyTrackedRegistry();
  }

  const skills = value.skills
    .map(normalizeEntry)
    .filter((entry): entry is TrackedRegistryEntry => entry !== undefined);

  return { skills };
}

export class TrackedRegistryStore {
  constructor(private readonly filePath: string) {}

  private get baseDir(): string {
    return dirname(this.filePath);
  }

  private toRuntimeDefinition(definition: SkillDefinition): SkillDefinition {
    return {
      ...definition,
      filePath: isAbsolute(definition.filePath)
        ? definition.filePath
        : resolve(this.baseDir, definition.filePath),
    };
  }

  private toStoredDefinition(definition: SkillDefinition): SkillDefinition {
    const absolutePath = isAbsolute(definition.filePath)
      ? definition.filePath
      : resolve(this.baseDir, definition.filePath);

    return {
      ...definition,
      filePath: relative(this.baseDir, absolutePath).split(sep).join('/'),
    };
  }

  async load(): Promise<TrackedRegistryFile> {
    if (!existsSync(this.filePath)) {
      return emptyTrackedRegistry();
    }

    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const file = normalizeFile(yamlLoad(raw));
      return {
        skills: file.skills.map(entry => ({
          definition: this.toRuntimeDefinition(entry.definition),
          metadata: entry.metadata,
        })),
      };
    } catch {
      return emptyTrackedRegistry();
    }
  }

  async save(file: TrackedRegistryFile): Promise<void> {
    mkdirSync(dirname(this.filePath), { recursive: true });

    const normalized: TrackedRegistryFile = {
      skills: file.skills
        .map(entry => ({
          definition: this.toStoredDefinition(entry.definition),
          metadata: entry.metadata,
        }))
        .map(normalizeEntry)
        .filter((entry): entry is TrackedRegistryEntry => entry !== undefined),
    };

    writeFileSync(this.filePath, yamlDump(normalized), 'utf8');
  }
}
