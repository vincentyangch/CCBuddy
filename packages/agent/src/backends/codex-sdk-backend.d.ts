import type { AgentBackend, AgentRequest, AgentEvent, PermissionGateRule } from '@ccbuddy/core';
export interface CodexSdkBackendOptions {
    codexPath?: string;
    apiKey?: string;
    networkAccess?: boolean;
    defaultSandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    /** Permission gate rules to convert to static Codex deny rules */
    permissionGateRules?: PermissionGateRule[];
}
export declare class CodexSdkBackend implements AgentBackend {
    private readonly options;
    private readonly abortControllers;
    private readonly rulesFilePath;
    constructor(options?: CodexSdkBackendOptions);
    destroy(): void;
    execute(request: AgentRequest): AsyncGenerator<AgentEvent>;
    abort(sessionId: string): Promise<void>;
    private mapEvent;
    private mapItemStarted;
    private mapItemUpdated;
    private mapItemCompleted;
}
//# sourceMappingURL=codex-sdk-backend.d.ts.map