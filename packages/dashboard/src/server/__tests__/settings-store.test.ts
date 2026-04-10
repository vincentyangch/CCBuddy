import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    const originalDiscordToken = process.env.DISCORD_TOKEN;
    process.env.DISCORD_TOKEN = 'resolved-token';

    try {
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
    } finally {
      if (originalDiscordToken === undefined) {
        delete process.env.DISCORD_TOKEN;
      } else {
        process.env.DISCORD_TOKEN = originalDiscordToken;
      }
    }
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

    const loaded = loadLocalSettingsConfig(localPath);
    loaded.platforms.discord.enabled = true;
    loaded.agent = {
      admin_skip_permissions: false,
    };

    saveLocalSettingsConfig(localPath, loaded);

    const raw = readFileSync(localPath, 'utf8');
    expect(raw).toContain('${DISCORD_TOKEN}');
    const parsed = yaml.load(raw) as { ccbuddy: LocalSettingsConfig };
    expect(parsed.ccbuddy.platforms.discord.token).toBe('${DISCORD_TOKEN}');
    expect(parsed.ccbuddy.agent.admin_skip_permissions).toBe(false);
  });

  it('preserves the existing file mode when saving local config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-'));
    tempDirs.push(dir);
    const localPath = join(dir, 'local.yaml');
    writeFileSync(localPath, [
      'ccbuddy:',
      '  agent:',
      '    model: opus',
      '',
    ].join('\n'), 'utf8');
    chmodSync(localPath, 0o640);

    const loaded = loadLocalSettingsConfig(localPath);
    loaded.agent.model = 'sonnet';

    saveLocalSettingsConfig(localPath, loaded);

    const mode = statSync(localPath).mode & 0o777;
    expect(mode).toBe(0o640);
  });

  it('treats missing local config as an empty editable config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-'));
    tempDirs.push(dir);
    const localPath = join(dir, 'local.yaml');

    const loaded = loadLocalSettingsConfig(localPath);

    expect(loaded).toEqual({});
  });

  it('treats invalid local config shapes as an empty editable config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-settings-'));
    tempDirs.push(dir);
    const localPath = join(dir, 'local.yaml');
    writeFileSync(localPath, ['ccbuddy: 123', ''].join('\n'), 'utf8');

    const loaded = loadLocalSettingsConfig(localPath);

    expect(loaded).toEqual({});
  });
});
