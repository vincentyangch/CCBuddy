import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeModelFile, readModelFile } from '../model-file.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('model-file', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ccbuddy-model-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes and reads a model file', () => {
    const filePath = join(dir, 'test-session.model');
    writeModelFile(filePath, 'opus[1m]');
    expect(readModelFile(filePath)).toBe('opus[1m]');
  });

  it('returns null when file does not exist', () => {
    expect(readModelFile(join(dir, 'nonexistent.model'))).toBeNull();
  });

  it('uses atomic write (tmp + rename)', () => {
    const filePath = join(dir, 'atomic-test.model');
    writeModelFile(filePath, 'sonnet');
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(filePath + '.tmp')).toBe(false);
  });
});
