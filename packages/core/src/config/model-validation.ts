export const CLAUDE_MODEL_ALIASES = [
  'sonnet', 'opus', 'haiku',
  'opus[1m]', 'sonnet[1m]',
  'opusplan',
] as const;

export const CODEX_MODEL_ALIASES = [
  'gpt-5.4', 'o3', 'o4-mini',
  'o3-pro',
] as const;

export const KNOWN_MODEL_ALIASES = [
  ...CLAUDE_MODEL_ALIASES,
  ...CODEX_MODEL_ALIASES,
  'default',
] as const;

const CLAUDE_MODEL_ID_PATTERN = /^claude-[a-z]+-[\w-]+$/;
const OPENAI_MODEL_ID_PATTERN = /^(gpt-|o\d|chatgpt-)/;

export type BackendType = 'sdk' | 'cli' | 'codex-sdk' | 'codex-cli';

export function isValidModel(value: string): boolean {
  if ((KNOWN_MODEL_ALIASES as readonly string[]).includes(value)) return true;
  return CLAUDE_MODEL_ID_PATTERN.test(value) || OPENAI_MODEL_ID_PATTERN.test(value);
}

export function isValidModelForBackend(
  value: string,
  backend: BackendType,
  configLists?: { claude_models?: string[]; codex_models?: string[] },
): boolean {
  if (value === 'default') return true;

  const claudeList = configLists?.claude_models ?? [...CLAUDE_MODEL_ALIASES];
  const codexList = configLists?.codex_models ?? [...CODEX_MODEL_ALIASES];

  if (backend === 'sdk' || backend === 'cli') {
    if (claudeList.includes(value)) return true;
    return CLAUDE_MODEL_ID_PATTERN.test(value);
  }

  if (backend === 'codex-sdk' || backend === 'codex-cli') {
    if (codexList.includes(value)) return true;
    return OPENAI_MODEL_ID_PATTERN.test(value);
  }

  return isValidModel(value);
}

export function getModelOptionsForBackend(
  backend: BackendType,
  configLists?: { claude_models?: string[]; codex_models?: string[] },
): string[] {
  const claudeList = configLists?.claude_models ?? [...CLAUDE_MODEL_ALIASES];
  const codexList = configLists?.codex_models ?? [...CODEX_MODEL_ALIASES];

  if (backend === 'sdk' || backend === 'cli') {
    return claudeList;
  }
  if (backend === 'codex-sdk' || backend === 'codex-cli') {
    return codexList;
  }
  return [...claudeList, ...codexList];
}
