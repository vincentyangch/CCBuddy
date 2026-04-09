import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const bundledSkillModuleUrl = new URL('../../../../skills/bundled/generate-image.mjs', import.meta.url).href;

describe('bundled generate-image skill', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bundled-media-'));
    mkdirSync(join(tmpDir, 'outbound'), { recursive: true });
    process.env.GEMINI_API_KEY = 'test-key';
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.CCBUDDY_OUTBOUND_DIR;
    delete process.env.GEMINI_API_KEY;
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('writes generated media into CCBUDDY_OUTBOUND_DIR', async () => {
    process.env.CCBUDDY_OUTBOUND_DIR = join(tmpDir, 'outbound');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{
              inlineData: {
                data: Buffer.from('png-bytes').toString('base64'),
                mimeType: 'image/png',
              },
            }],
          },
        }],
      }),
    }));

    const mod = await import(bundledSkillModuleUrl);
    const result = await mod.default({ prompt: 'A red bird' });

    expect(result.success).toBe(true);
    expect(result.media[0].filePath).toContain(join(tmpDir, 'outbound'));
    expect(readdirSync(join(tmpDir, 'outbound'))).toHaveLength(1);
  });

  it('fails clearly when CCBUDDY_OUTBOUND_DIR is missing', async () => {
    const mod = await import(bundledSkillModuleUrl);

    await expect(mod.default({ prompt: 'A red bird' })).rejects.toThrow('CCBUDDY_OUTBOUND_DIR');
  });
});
