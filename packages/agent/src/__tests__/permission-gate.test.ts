import { describe, it, expect, vi } from 'vitest';
import { PermissionGateChecker } from '../permission-gate.js';
import type { PermissionGateRule } from '@ccbuddy/core';

const RULES: PermissionGateRule[] = [
  { name: 'destructive-rm', pattern: 'rm\\s+-(r|rf|fr)\\s+(?!/tmp)', tool: 'Bash', description: 'Recursive delete' },
  { name: 'destructive-git', pattern: 'git\\s+(reset\\s+--hard|checkout\\s+\\.|clean\\s+-f)', tool: 'Bash', description: 'Destructive git ops' },
  { name: 'local-config', pattern: 'config/local\\.yaml', tool: '*', description: 'Local config' },
  { name: 'launchctl', pattern: 'launchctl', tool: 'Bash', description: 'LaunchAgent ops' },
  { name: 'npm-publish', pattern: 'npm\\s+publish', tool: 'Bash', description: 'Package publishing' },
];

describe('PermissionGateChecker', () => {
  const checker = new PermissionGateChecker(RULES);

  it('matches Bash command against correct rule', () => {
    const result = checker.check('Bash', { command: 'rm -rf /home/user/project' });
    expect(result).not.toBeNull();
    expect(result!.name).toBe('destructive-rm');
  });

  it('matches destructive git operations', () => {
    expect(checker.check('Bash', { command: 'git reset --hard HEAD~3' })?.name).toBe('destructive-git');
    expect(checker.check('Bash', { command: 'git checkout .' })?.name).toBe('destructive-git');
    expect(checker.check('Bash', { command: 'git clean -fd' })?.name).toBe('destructive-git');
  });

  it('matches Write file_path against wildcard rule', () => {
    const result = checker.check('Write', { file_path: 'config/local.yaml', content: 'secrets' });
    expect(result).not.toBeNull();
    expect(result!.name).toBe('local-config');
  });

  it('matches Edit file_path against wildcard rule', () => {
    const result = checker.check('Edit', { file_path: 'config/local.yaml', old_string: 'a', new_string: 'b' });
    expect(result).not.toBeNull();
    expect(result!.name).toBe('local-config');
  });

  it('returns null when no rules match', () => {
    expect(checker.check('Bash', { command: 'ls -la' })).toBeNull();
    expect(checker.check('Bash', { command: 'git status' })).toBeNull();
    expect(checker.check('Write', { file_path: 'src/index.ts', content: 'code' })).toBeNull();
  });

  it('returns first matching rule when multiple match', () => {
    const result = checker.check('Bash', { command: 'rm -rf /home && git reset --hard' });
    expect(result!.name).toBe('destructive-rm');
  });

  it('does not match tool-specific rule against wrong tool', () => {
    expect(checker.check('Write', { file_path: 'launchctl-notes.txt', content: '' })).toBeNull();
  });

  it('wildcard tool matches any tool name', () => {
    expect(checker.check('Bash', { command: 'cat config/local.yaml' })?.name).toBe('local-config');
    expect(checker.check('Read', { file_path: 'config/local.yaml' })?.name).toBe('local-config');
  });

  it('handles invalid regex gracefully', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badChecker = new PermissionGateChecker([
      { name: 'bad-regex', pattern: '[invalid(', tool: 'Bash', description: 'Bad pattern' },
      { name: 'good-rule', pattern: 'rm -rf', tool: 'Bash', description: 'Good pattern' },
    ]);
    expect(badChecker.check('Bash', { command: 'rm -rf /' })?.name).toBe('good-rule');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('matches rm -rf /tmp as non-gated (negative lookahead)', () => {
    expect(checker.check('Bash', { command: 'rm -rf /tmp/build' })).toBeNull();
  });

  it('constructs with empty rules', () => {
    const empty = new PermissionGateChecker([]);
    expect(empty.check('Bash', { command: 'rm -rf /' })).toBeNull();
  });
});
