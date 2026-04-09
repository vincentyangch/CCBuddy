export interface SkillInputSchema {
  type: 'object';
  properties: Record<string, {
    type: string;
    description?: string;
    enum?: string[];
    default?: unknown;
  }>;
  required?: string[];
}

export type SkillPermission = 'filesystem' | 'network' | 'shell' | 'env';
export type SkillSource = 'bundled' | 'generated' | 'local' | 'user';

export interface SkillDefinition {
  name: string;
  description: string;
  version: string;
  source: SkillSource;
  filePath: string;
  inputSchema: SkillInputSchema;
  permissions: SkillPermission[];
  enabled: boolean;
  requiresApproval?: boolean;
}

export interface SkillPersistentMetadata {
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillRuntimeMetadata {
  usageCount: number;
  lastUsed?: string;
}

export interface SkillMetadata extends SkillPersistentMetadata, SkillRuntimeMetadata {}

export interface TrackedRegistryEntry {
  definition: SkillDefinition;
  metadata: SkillPersistentMetadata;
}

export interface LocalRegistryEntry {
  definition: SkillDefinition;
  metadata: SkillPersistentMetadata;
}

export interface RegisteredSkill {
  definition: SkillDefinition;
  metadata: SkillMetadata;
}

export interface SkillInput {
  [key: string]: unknown;
}

export interface SkillMediaOutput {
  data: string;      // base64-encoded binary
  mimeType: string;
  filename?: string;
}

export interface SkillOutput {
  success: boolean;
  result?: unknown;
  error?: string;
  media?: SkillMediaOutput[];
}

export interface RegistryFile {
  skills: Array<RegisteredSkill>;
}

export interface TrackedRegistryFile {
  skills: Array<TrackedRegistryEntry>;
}

export interface LocalRegistryFile {
  skills: Array<LocalRegistryEntry>;
  runtimeMetadata: Record<string, SkillRuntimeMetadata>;
}
