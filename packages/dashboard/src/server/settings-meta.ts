import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_CONFIG } from '@ccbuddy/core';

export type SettingsSource = 'local' | 'default' | 'effective_only' | 'runtime_override';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walkLeaves(
  value: unknown,
  path: string[],
  visit: (path: string, value: unknown) => void,
): void {
  if (!isPlainObject(value)) {
    if (path.length > 0) {
      visit(path.join('.'), value);
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    walkLeaves(child, [...path, key], visit);
  }
}

function getValueAtPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (!isPlainObject(current) || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

export function buildSettingsSourceMap(
  localConfig: Record<string, unknown>,
  effectiveConfig: Record<string, unknown>,
  runtimeModel: string | null = null,
): { sources: Record<string, SettingsSource> } {
  const sources: Record<string, SettingsSource> = {};
  const localLeaves = new Set<string>();

  walkLeaves(localConfig, [], (path) => {
    localLeaves.add(path);
  });

  walkLeaves(effectiveConfig, [], (path, value) => {
    if (path === 'agent.model' && runtimeModel) {
      sources[path] = 'runtime_override';
      return;
    }

    if (localLeaves.has(path)) {
      sources[path] = 'local';
      return;
    }

    const defaultValue = getValueAtPath(DEFAULT_CONFIG, path);
    if (isDeepStrictEqual(value, defaultValue)) {
      sources[path] = 'default';
      return;
    }

    sources[path] = 'effective_only';
  });

  return { sources };
}
