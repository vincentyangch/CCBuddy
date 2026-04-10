export type SettingsSource = 'local' | 'default' | 'effective_only' | 'runtime_override';

function walkObject(
  value: unknown,
  path: string[],
  visit: (path: string, value: unknown) => void,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    visit(path.join('.'), value);
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    walkObject(child, [...path, key], visit);
  }
}

export function buildSettingsSourceMap(
  localConfig: Record<string, unknown>,
  effectiveConfig: Record<string, unknown>,
): { sources: Record<string, SettingsSource> } {
  const sources: Record<string, SettingsSource> = {};

  walkObject(effectiveConfig, [], (path) => {
    if (path) sources[path] = 'effective_only';
  });

  walkObject(localConfig, [], (path) => {
    if (path) sources[path] = 'local';
  });

  return { sources };
}
