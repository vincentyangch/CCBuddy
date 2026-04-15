import { describe, it, expect } from 'vitest';
import { generateCodexRules } from '../codex-rules.js';
import type { PermissionGateRule } from '@ccbuddy/core';

describe('generateCodexRules', () => {
  const defaultRules: PermissionGateRule[] = [
    { name: 'destructive-rm', pattern: 'rm\\s+-(r|rf|fr)\\s+(?!/tmp)', tool: 'Bash', description: 'Recursive delete on non-temp paths' },
    { name: 'destructive-git', pattern: 'git\\s+(reset\\s+--hard|checkout\\s+\\.|clean\\s+-f)', tool: 'Bash', description: 'Destructive git operations' },
    { name: 'local-config', pattern: 'config/local\\.yaml', tool: '*', description: 'Modify local config (contains secrets)' },
    { name: 'launchctl', pattern: 'launchctl', tool: 'Bash', description: 'LaunchAgent operations' },
    { name: 'npm-publish', pattern: 'npm\\s+publish', tool: 'Bash', description: 'Package publishing' },
  ];

  it('generates deny rules for destructive-rm', () => {
    const output = generateCodexRules(defaultRules);
    expect(output).toContain('prefix_rule(pattern=["rm", "-rf"], decision="deny")');
    expect(output).toContain('prefix_rule(pattern=["rm", "-fr"], decision="deny")');
    expect(output).toContain('prefix_rule(pattern=["rm", "-r"], decision="deny")');
  });

  it('generates deny rules for destructive-git', () => {
    const output = generateCodexRules(defaultRules);
    expect(output).toContain('prefix_rule(pattern=["git", "reset", "--hard"], decision="deny")');
    expect(output).toContain('prefix_rule(pattern=["git", "checkout", "."], decision="deny")');
    expect(output).toContain('prefix_rule(pattern=["git", "clean", "-f"], decision="deny")');
    expect(output).toContain('prefix_rule(pattern=["git", "push", "--force"], decision="deny")');
  });

  it('generates deny rules for launchctl', () => {
    const output = generateCodexRules(defaultRules);
    expect(output).toContain('prefix_rule(pattern=["launchctl"], decision="deny")');
  });

  it('generates deny rules for npm-publish', () => {
    const output = generateCodexRules(defaultRules);
    expect(output).toContain('prefix_rule(pattern=["npm", "publish"], decision="deny")');
  });

  it('skips non-Bash rules (local-config uses tool: *)', () => {
    // local-config with tool: * should be skipped since it's a file path pattern
    // not a command prefix
    const output = generateCodexRules([
      { name: 'local-config', pattern: 'config/local\\.yaml', tool: '*', description: 'Modify local config' },
    ]);
    // Should still have the header but no deny rules
    expect(output).toContain('Auto-generated');
    expect(output).not.toContain('decision="deny"');
  });

  it('returns header for empty rules', () => {
    const output = generateCodexRules([]);
    expect(output).toContain('Auto-generated');
    expect(output).not.toContain('decision="deny"');
  });
});
