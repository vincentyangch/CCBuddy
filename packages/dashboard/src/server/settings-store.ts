import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import yaml from 'js-yaml';

export type LocalSettingsConfig = Record<string, any>;

export function loadLocalSettingsConfig(localPath: string): LocalSettingsConfig {
  if (!existsSync(localPath)) {
    return {};
  }

  const raw = readFileSync(localPath, 'utf8');
  const parsed = yaml.load(raw) as { ccbuddy?: LocalSettingsConfig } | null;
  return parsed?.ccbuddy ?? {};
}

export function saveLocalSettingsConfig(localPath: string, config: LocalSettingsConfig): void {
  mkdirSync(dirname(localPath), { recursive: true });
  const yamlContent = yaml.dump({ ccbuddy: config }, { lineWidth: 120 });
  writeFileSync(localPath, yamlContent, 'utf8');
}
