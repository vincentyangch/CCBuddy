export const KNOWN_MODEL_ALIASES = [
  'sonnet', 'opus', 'haiku',
  'opus[1m]', 'sonnet[1m]',
  'opusplan', 'default',
] as const;

const MODEL_ID_PATTERN = /^claude-[a-z]+-[\w-]+$/;

export function isValidModel(value: string): boolean {
  if ((KNOWN_MODEL_ALIASES as readonly string[]).includes(value)) return true;
  return MODEL_ID_PATTERN.test(value);
}
