/**
 * Generates Codex exec policy rules (.rules format) from CCBuddy's
 * PermissionGateRule[] configuration.
 *
 * Codex uses prefix_rule(pattern=[...], decision="allow"|"deny") syntax
 * with exact token matching — no regex support. We convert CCBuddy's
 * regex-based rules into conservative deny rules that block the most
 * common dangerous command prefixes.
 *
 * These rules serve as static safety when interactive permission gates
 * (canUseTool callback) are not available in the Codex backend.
 */
import type { PermissionGateRule } from '@ccbuddy/core';
/**
 * Generate a Codex .rules file content from CCBuddy permission gate rules.
 */
export declare function generateCodexRules(gateRules: PermissionGateRule[]): string;
/**
 * Write a Codex .rules file to disk.
 */
export declare function writeCodexRulesFile(path: string, gateRules: PermissionGateRule[]): void;
//# sourceMappingURL=codex-rules.d.ts.map