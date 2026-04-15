export { loadConfig } from './loader.js';
export { type CCBuddyConfig, type AgentConfig, type MemoryConfig, DEFAULT_CONFIG } from './schema.js';
export type * from './schema.js';
export type { PermissionGateRule, PermissionGateConfig } from './schema.js';
export { isValidModel, isValidModelForBackend, getModelOptionsForBackend, KNOWN_MODEL_ALIASES, CLAUDE_MODEL_ALIASES, CODEX_MODEL_ALIASES, type BackendType } from './model-validation.js';
