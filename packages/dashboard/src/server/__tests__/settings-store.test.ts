import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  loadLocalSettingsConfig,
  saveLocalSettingsConfig,
  type LocalSettingsConfig,
} from '../settings-store.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('settings-store', () => {
  it('loads persisted local config without resolving env placeholders', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-'));
    tempDirs.push(dir);
    const localPath = join(dir, 'local.yaml');
    writeFileSync(localPath, [
      'ccbuddy:',
      '  platforms:',
      '    discord:',
      '      token: ${DISCORD_TOKEN}',
      '  agent:',
      '    model: opus',
      '',
    ].join('\n'), 'utf8');

    const loaded = loadLocalSettingsConfig(localPath);

    expect(loaded.platforms.discord.token).toBe('${DISCORD_TOKEN}');
    expect(loaded.agent.model).toBe('opus');
  });

  it('writes local config back without flattening existing placeholders', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-'));
    tempDirs.push(dir);
    const localPath = join(dir, 'local.yaml');
    writeFileSync(localPath, [
      'ccbuddy:',
      '  platforms:',
      '    discord:',
      '      token: ${DISCORD_TOKEN}',
      '',
    ].join('\n'), 'utf8');

    const nextConfig: LocalSettingsConfig = {
      platforms: {
        discord: {
          token: '${DISCORD_TOKEN}',
          enabled: true,
        },
      },
      agent: {
        admin_skip_permissions: false,
      },
    };

    saveLocalSettingsConfig(localPath, nextConfig);

    const raw = readFileSync(localPath, 'utf8');
    expect(raw).toContain('${DISCORD_TOKEN}');
    const parsed = yaml.load(raw) as { ccbuddy: LocalSettingsConfig };
    expect(parsed.ccbuddy.platforms.discord.token).toBe('${DISCORD_TOKEN}');
    expect(parsed.ccbuddy.agent.admin_skip_permissions).toBe(false);
  });

  it('treats missing local config as an empty editable config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-'));
    tempDirs.push(dir);
    const localPath = join(dir, 'local.yaml');

    const loaded = loadLocalSettingsConfig(localPath);

    expect(loaded).toEqual({});
  });
});
