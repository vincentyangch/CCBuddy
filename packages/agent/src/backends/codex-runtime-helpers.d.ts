import type { AgentRequest, PermissionGateRule } from '@ccbuddy/core';
export type CodexConfigValue = string | number | boolean | CodexConfigValue[] | {
    [key: string]: CodexConfigValue;
};
export type CodexConfigOverrideObject = Record<string, CodexConfigValue>;
export interface PreparedCodexMcpServer {
    [key: string]: CodexConfigValue | undefined;
    type: 'stdio';
    command: string;
    args: string[];
    env?: Record<string, string>;
}
interface ProtectedFileSnapshot {
    relativePath: string;
    resolvedPath: string;
    existed: boolean;
    content?: Buffer;
}
export declare function serializeCodexConfigOverrides(configOverrides: CodexConfigOverrideObject): string[];
export declare function prepareCodexMcpServers(mcpServers: AgentRequest['mcpServers']): {
    config: Record<string, PreparedCodexMcpServer>;
    inheritedEnv: Record<string, string>;
};
export declare function snapshotProtectedFiles(workingDirectory: string | undefined, rules: PermissionGateRule[] | undefined): Map<string, ProtectedFileSnapshot>;
export declare function restoreProtectedFiles(workingDirectory: string | undefined, snapshots: Map<string, ProtectedFileSnapshot>, changedPaths: string[]): string[];
export declare function restoreModifiedProtectedFiles(snapshots: Map<string, ProtectedFileSnapshot>): string[];
export {};
//# sourceMappingURL=codex-runtime-helpers.d.ts.map
