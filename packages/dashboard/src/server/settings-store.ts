import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import yaml from 'js-yaml';

export type LocalSettingsConfig = Record<string, any>;

export function loadLocalSettingsConfig(localPath: string): LocalSettingsConfig {
  if (!existsSync(localPath)) {
    return {};
  }

  const raw = readFileSync(localPath, 'utf8');
  const parsed = yaml.load(raw);
  if (!isRecord(parsed)) {
    return {};
  }

  const localConfig = parsed.ccbuddy;
  return isRecord(localConfig) ? localConfig : {};
}

export function saveLocalSettingsConfig(localPath: string, config: LocalSettingsConfig): void {
  const dir = dirname(localPath);
  mkdirSync(dir, { recursive: true });
  const mode = existsSync(localPath) ? statSync(localPath).mode & 0o777 : 0o600;
  const yamlContent = yaml.dump({ ccbuddy: config }, { lineWidth: 120 });
  const tempPath = `${localPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, yamlContent, { encoding: 'utf8', mode });
  renameSync(tempPath, localPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
