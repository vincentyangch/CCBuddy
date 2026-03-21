import type { PermissionGateRule } from '@ccbuddy/core';

interface CompiledRule {
  rule: PermissionGateRule;
  regex: RegExp;
}

export class PermissionGateChecker {
  private readonly compiled: CompiledRule[];

  constructor(rules: PermissionGateRule[]) {
    this.compiled = [];
    for (const rule of rules) {
      try {
        this.compiled.push({ rule, regex: new RegExp(rule.pattern) });
      } catch {
        console.warn(`[PermissionGate] Skipping rule "${rule.name}" — invalid regex: ${rule.pattern}`);
      }
    }
  }

  check(toolName: string, input: Record<string, unknown>): PermissionGateRule | null {
    for (const { rule, regex } of this.compiled) {
      if (rule.tool !== '*' && rule.tool !== toolName) continue;

      const text = this.extractText(toolName, input);
      if (text && regex.test(text)) {
        return rule;
      }
    }
    return null;
  }

  private extractText(toolName: string, input: Record<string, unknown>): string | null {
    switch (toolName) {
      case 'Bash':
        return typeof input.command === 'string' ? input.command : null;
      case 'Write':
      case 'Edit':
      case 'Read':
        return typeof input.file_path === 'string' ? input.file_path : null;
      default:
        return JSON.stringify(input);
    }
  }
}
