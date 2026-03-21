import { describe, it, expect } from 'vitest';
import { isValidModel, KNOWN_MODEL_ALIASES } from '../model-validation.js';

describe('isValidModel', () => {
  it('accepts known aliases', () => {
    for (const alias of KNOWN_MODEL_ALIASES) {
      expect(isValidModel(alias)).toBe(true);
    }
  });

  it('accepts full model IDs matching pattern', () => {
    expect(isValidModel('claude-sonnet-4-6')).toBe(true);
    expect(isValidModel('claude-opus-4-6')).toBe(true);
    expect(isValidModel('claude-haiku-4-5-20251001')).toBe(true);
  });

  it('rejects invalid values', () => {
    expect(isValidModel('')).toBe(false);
    expect(isValidModel('gpt-4')).toBe(false);
    expect(isValidModel('random-string')).toBe(false);
    expect(isValidModel('  sonnet  ')).toBe(false);
  });
});
