import { dirname, join } from 'node:path';
import type { ToolDescription } from '@ccbuddy/core';
import { LocalSkillState } from './local-skill-state.js';
import { TrackedRegistryStore } from './tracked-registry-store.js';
import type {
  LocalRegistryEntry,
  LocalRegistryFile,
  RegisteredSkill,
  SkillDefinition,
  SkillMetadata,
  SkillPersistentMetadata,
  SkillRuntimeMetadata,
  SkillSource,
  TrackedRegistryEntry,
  TrackedRegistryFile,
} from './types.js';

export type { ToolDescription };

type RegistryEntry = TrackedRegistryEntry | LocalRegistryEntry;

const TRACKED_RUNTIME_PREFIX = 'tracked:';
const LOCAL_RUNTIME_PREFIX = 'local:';

function isLocalSource(source: SkillSource): boolean {
  return source === 'local' || source === 'user';
}

function runtimeKey(prefix: typeof TRACKED_RUNTIME_PREFIX | typeof LOCAL_RUNTIME_PREFIX, name: string): string {
  return `${prefix}${name}`;
}

function parseRuntimeKey(key: string): {
  scope?: 'tracked' | 'local';
  name: string;
} {
  if (key.startsWith(TRACKED_RUNTIME_PREFIX)) {
    return { scope: 'tracked', name: key.slice(TRACKED_RUNTIME_PREFIX.length) };
  }

  if (key.startsWith(LOCAL_RUNTIME_PREFIX)) {
    return { scope: 'local', name: key.slice(LOCAL_RUNTIME_PREFIX.length) };
  }

  return { name: key };
}

function splitMetadata(metadata: SkillMetadata): {
  persistent: SkillPersistentMetadata;
  runtime: SkillRuntimeMetadata;
} {
  const { createdBy, createdAt, updatedAt, usageCount, lastUsed } = metadata;
  const runtime: SkillRuntimeMetadata = { usageCount };

  if (lastUsed !== undefined) {
    runtime.lastUsed = lastUsed;
  }

  return {
    persistent: { createdBy, createdAt, updatedAt },
    runtime,
  };
}

function composeMetadata(
  persistent: SkillPersistentMetadata,
  runtime?: SkillRuntimeMetadata,
): SkillMetadata {
  return {
    ...persistent,
    usageCount: runtime?.usageCount ?? 0,
    ...(runtime?.lastUsed !== undefined ? { lastUsed: runtime.lastUsed } : {}),
  };
}

export class SkillRegistry {
  private trackedSkills: Map<string, TrackedRegistryEntry> = new Map();
  private localSkills: Map<string, LocalRegistryEntry> = new Map();
  private trackedRuntimeMetadata: Map<string, SkillRuntimeMetadata> = new Map();
  private localRuntimeMetadata: Map<string, SkillRuntimeMetadata> = new Map();
  private externalTools: Map<string, ToolDescription> = new Map();

  private readonly trackedStore: TrackedRegistryStore;
  private readonly localState: LocalSkillState;

  constructor(private readonly filePath: string) {
    this.trackedStore = new TrackedRegistryStore(filePath);
    this.localState = new LocalSkillState(join(dirname(filePath), 'local'));
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  async load(): Promise<void> {
    const [trackedFile, localFile] = await Promise.all([
      this.trackedStore.load(),
      this.localState.load(),
    ]);

    this.trackedSkills = new Map(
      trackedFile.skills.map(entry => [entry.definition.name, entry]),
    );
    this.localSkills = new Map(
      localFile.skills.map(entry => [entry.definition.name, entry]),
    );
    for (const name of this.localSkills.keys()) {
      if (this.trackedSkills.has(name)) {
        console.warn(`[Skills] Local skill "${name}" is shadowed by a tracked skill and will be ignored`);
      }
    }
    this.trackedRuntimeMetadata = new Map();
    this.localRuntimeMetadata = new Map();

    for (const [rawKey, metadata] of Object.entries(localFile.runtimeMetadata ?? {})) {
      const { scope, name } = parseRuntimeKey(rawKey);

      if (scope === 'tracked') {
        this.trackedRuntimeMetadata.set(name, metadata);
        continue;
      }

      if (scope === 'local') {
        this.localRuntimeMetadata.set(name, metadata);
        continue;
      }

      if (this.localSkills.has(name) && !this.trackedSkills.has(name)) {
        this.localRuntimeMetadata.set(name, metadata);
        continue;
      }

      if (this.trackedSkills.has(name) && !this.localSkills.has(name)) {
        this.trackedRuntimeMetadata.set(name, metadata);
        continue;
      }

      if (this.trackedSkills.has(name) && this.localSkills.has(name)) {
        this.localRuntimeMetadata.set(name, metadata);
        continue;
      }

      this.localRuntimeMetadata.set(name, metadata);
    }
  }

  async save(): Promise<void> {
    const file: TrackedRegistryFile = {
      skills: Array.from(this.trackedSkills.values()),
    };

    await this.trackedStore.save(file);
  }

  async saveLocalState(): Promise<void> {
    const runtimeMetadata: Record<string, SkillRuntimeMetadata> = {};

    for (const [name, metadata] of this.trackedRuntimeMetadata.entries()) {
      runtimeMetadata[runtimeKey(TRACKED_RUNTIME_PREFIX, name)] = metadata;
    }

    for (const [name, metadata] of this.localRuntimeMetadata.entries()) {
      runtimeMetadata[runtimeKey(LOCAL_RUNTIME_PREFIX, name)] = metadata;
    }

    const file: LocalRegistryFile = {
      skills: Array.from(this.localSkills.values()),
      runtimeMetadata,
    };

    await this.localState.save(file);
  }

  // ── Skill CRUD ────────────────────────────────────────────────────────────

  register(definition: SkillDefinition, metadata: SkillMetadata): void {
    const { persistent, runtime } = splitMetadata(metadata);
    const entry = { definition, metadata: persistent };

    if (isLocalSource(definition.source)) {
      this.localSkills.set(definition.name, entry);
      this.localRuntimeMetadata.set(definition.name, runtime);
      return;
    }

    if (this.trackedSkills.has(definition.name)) {
      throw new Error(`Skill "${definition.name}" is already registered`);
    }

    this.trackedSkills.set(definition.name, entry);
    this.trackedRuntimeMetadata.set(definition.name, runtime);
  }

  unregister(name: string): void {
    if (this.trackedSkills.has(name)) {
      this.removeTracked(name);
    } else {
      this.removeLocal(name);
    }
  }

  removeTracked(name: string): void {
    this.trackedSkills.delete(name);
    this.trackedRuntimeMetadata.delete(name);
  }

  removeLocal(name: string): void {
    this.localSkills.delete(name);
    this.localRuntimeMetadata.delete(name);
  }

  update(name: string, definition: SkillDefinition): void {
    const trackedExisting = this.trackedSkills.get(name);
    const localExisting = this.localSkills.get(name);
    const existing = trackedExisting ?? localExisting;

    if (!existing) {
      throw new Error(`Skill "${name}" not found`);
    }

    const runtime = isLocalSource(existing.definition.source)
      ? this.localRuntimeMetadata.get(name)
      : this.trackedRuntimeMetadata.get(name);
    const updatedMetadata: SkillPersistentMetadata = {
      ...existing.metadata,
      updatedAt: new Date().toISOString(),
    };

    const updatedEntry = { definition, metadata: updatedMetadata };

    if (isLocalSource(definition.source)) {
      if (trackedExisting) {
        this.trackedSkills.delete(name);
        this.trackedRuntimeMetadata.delete(name);
      }

      this.localSkills.set(name, updatedEntry);
      if (runtime) {
        this.localRuntimeMetadata.set(name, runtime);
      } else {
        this.localRuntimeMetadata.delete(name);
      }
    } else {
      if (localExisting && !trackedExisting) {
        this.localSkills.delete(name);
        this.localRuntimeMetadata.delete(name);
      }

      this.trackedSkills.set(name, updatedEntry);
      if (runtime) {
        this.trackedRuntimeMetadata.set(name, runtime);
      } else {
        this.trackedRuntimeMetadata.delete(name);
      }
    }
  }

  get(name: string): RegisteredSkill | undefined {
    const entry = this.trackedSkills.get(name) ?? this.localSkills.get(name);
    if (!entry) return undefined;
    const runtime = this.trackedSkills.has(name)
      ? this.trackedRuntimeMetadata.get(name)
      : this.localRuntimeMetadata.get(name);

    return {
      definition: entry.definition,
      metadata: composeMetadata(
        entry.metadata,
        runtime,
      ),
    };
  }

  list(): RegisteredSkill[] {
    const visibleEntries: RegistryEntry[] = [
      ...this.trackedSkills.values(),
      ...Array.from(this.localSkills.entries())
        .filter(([name]) => !this.trackedSkills.has(name))
        .map(([, entry]) => entry),
    ];

    return visibleEntries.map(entry => ({
      definition: entry.definition,
      metadata: composeMetadata(
        entry.metadata,
        this.trackedSkills.has(entry.definition.name)
          ? this.trackedRuntimeMetadata.get(entry.definition.name)
          : this.localRuntimeMetadata.get(entry.definition.name),
      ),
    }));
  }

  listBySource(source: SkillSource): RegisteredSkill[] {
    return this.list().filter(skill => skill.definition.source === source);
  }

  recordUsage(name: string): void {
    if (this.trackedSkills.has(name)) {
      const current = this.trackedRuntimeMetadata.get(name) ?? { usageCount: 0 };
      this.trackedRuntimeMetadata.set(name, {
        usageCount: current.usageCount + 1,
        lastUsed: new Date().toISOString(),
      });
      return;
    }

    if (this.localSkills.has(name)) {
      const current = this.localRuntimeMetadata.get(name) ?? { usageCount: 0 };
      this.localRuntimeMetadata.set(name, {
        usageCount: current.usageCount + 1,
        lastUsed: new Date().toISOString(),
      });
    }
  }

  // ── External Tool Registry ─────────────────────────────────────────────────

  registerExternalTool(tool: ToolDescription): void {
    this.externalTools.set(tool.name, tool);
  }

  unregisterExternalTool(name: string): void {
    this.externalTools.delete(name);
  }

  // ── Tool Descriptions (for Claude Code) ───────────────────────────────────

  getToolDescriptions(): ToolDescription[] {
    const skillTools: ToolDescription[] = this.list().map(({ definition }) => ({
      name: `skill_${definition.name}`,
      description: definition.description,
      inputSchema: definition.inputSchema,
    }));

    const externalToolsList: ToolDescription[] = Array.from(this.externalTools.values());

    return [...skillTools, ...externalToolsList];
  }
}
