import { describe, it, expect } from 'vitest';
import { isValidModel, isValidModelForBackend, getModelOptionsForBackend, KNOWN_MODEL_ALIASES } from '../model-validation.js';

describe('isValidModel', () => {
  it('accepts known aliases', () => {
    for (const alias of KNOWN_MODEL_ALIASES) {
      expect(isValidModel(alias)).toBe(true);
    }
  });

  it('accepts full Claude model IDs', () => {
    expect(isValidModel('claude-sonnet-4-6')).toBe(true);
    expect(isValidModel('claude-opus-4-6')).toBe(true);
    expect(isValidModel('claude-haiku-4-5-20251001')).toBe(true);
  });

  it('accepts OpenAI model IDs', () => {
    expect(isValidModel('gpt-5')).toBe(true);
    expect(isValidModel('o3')).toBe(true);
    expect(isValidModel('o4-mini')).toBe(true);
  });

  it('rejects invalid values', () => {
    expect(isValidModel('')).toBe(false);
    expect(isValidModel('random-string')).toBe(false);
    expect(isValidModel('  sonnet  ')).toBe(false);
  });
});

describe('isValidModelForBackend', () => {
  it('accepts Claude aliases for Claude backends', () => {
    expect(isValidModelForBackend('sonnet', 'sdk')).toBe(true);
    expect(isValidModelForBackend('opus', 'cli')).toBe(true);
  });

  it('rejects Codex aliases for Claude backends', () => {
    expect(isValidModelForBackend('gpt-5', 'sdk')).toBe(false);
    expect(isValidModelForBackend('o3', 'cli')).toBe(false);
  });

  it('accepts Codex aliases for Codex backends', () => {
    expect(isValidModelForBackend('gpt-5', 'codex-sdk')).toBe(true);
    expect(isValidModelForBackend('o3', 'codex-cli')).toBe(true);
    expect(isValidModelForBackend('o4-mini', 'codex-sdk')).toBe(true);
  });

  it('rejects Claude aliases for Codex backends', () => {
    expect(isValidModelForBackend('sonnet', 'codex-sdk')).toBe(false);
    expect(isValidModelForBackend('opus', 'codex-cli')).toBe(false);
  });

  it('accepts default for any backend', () => {
    expect(isValidModelForBackend('default', 'sdk')).toBe(true);
    expect(isValidModelForBackend('default', 'codex-sdk')).toBe(true);
  });

  it('accepts full model IDs matching the backend provider', () => {
    expect(isValidModelForBackend('claude-opus-4-6', 'sdk')).toBe(true);
    expect(isValidModelForBackend('gpt-5', 'codex-sdk')).toBe(true);
    expect(isValidModelForBackend('claude-opus-4-6', 'codex-sdk')).toBe(false);
  });
});

describe('getModelOptionsForBackend', () => {
  it('returns Claude models for Claude backends', () => {
    const options = getModelOptionsForBackend('sdk');
    expect(options).toContain('sonnet');
    expect(options).toContain('opus');
    expect(options).not.toContain('gpt-5.4');
  });

  it('returns Codex models for Codex backends', () => {
    const options = getModelOptionsForBackend('codex-sdk');
    expect(options).toContain('gpt-5.4');
    expect(options).toContain('o3');
    expect(options).not.toContain('sonnet');
  });
});
