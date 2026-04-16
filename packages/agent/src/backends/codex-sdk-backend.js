import { writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Codex } from '@openai/codex-sdk';
import { generateCodexRules } from './codex-rules.js';
import { restoreModifiedProtectedFiles, restoreProtectedFiles, snapshotProtectedFiles } from './codex-runtime-helpers.js';
export class CodexSdkBackend {
    options;
    abortControllers = new Map();
    rulesFilePath;
    constructor(options = {}) {
        this.options = options;
        // Generate static deny rules from permission gate config
        if (options.permissionGateRules && options.permissionGateRules.length > 0) {
            const rulesDir = join(tmpdir(), `ccbuddy-codex-rules-${randomUUID()}`);
            mkdirSync(rulesDir, { recursive: true });
            this.rulesFilePath = join(rulesDir, 'ccbuddy.rules');
            const content = generateCodexRules(options.permissionGateRules);
            writeFileSync(this.rulesFilePath, content, 'utf8');
            console.info(`[CodexSdkBackend] Generated Codex deny rules at ${this.rulesFilePath}`);
        }
        else {
            this.rulesFilePath = null;
        }
    }
    destroy() {
        if (this.rulesFilePath) {
            try {
                rmSync(dirname(this.rulesFilePath), { recursive: true, force: true });
            }
            catch { /* ignore */ }
        }
    }
    async *execute(request) {
        const base = {
            sessionId: request.sessionId,
            userId: request.userId,
            channelId: request.channelId,
            platform: request.platform,
        };
        const tempFiles = [];
        const protectedFiles = snapshotProtectedFiles(request.workingDirectory, this.options.permissionGateRules);
        const blockedProtectedPaths = new Set();
        try {
            // Build Codex instance with env and optional overrides
            const codexEnv = { ...process.env };
            if (request.env)
                Object.assign(codexEnv, request.env);
            const codexConfig = {};
            // MCP servers — pass via config overrides
            if (request.mcpServers && request.mcpServers.length > 0) {
                for (const s of request.mcpServers) {
                    codexConfig[`mcp_servers.${s.name}.type`] = 'stdio';
                    codexConfig[`mcp_servers.${s.name}.command`] = s.command;
                    codexConfig[`mcp_servers.${s.name}.args`] = s.args;
                    if (s.env)
                        codexConfig[`mcp_servers.${s.name}.env`] = s.env;
                }
            }
            // Wire in deny rules file if generated
            if (this.rulesFilePath) {
                codexConfig['exec_policy.rules_file'] = this.rulesFilePath;
            }
            if (request.verbosity) {
                codexConfig.model_verbosity = request.verbosity;
            }
            const codex = new Codex({
                codexPathOverride: this.options.codexPath,
                apiKey: this.options.apiKey,
                env: codexEnv,
                config: codexConfig,
            });
            // Build thread options
            const threadOpts = {
                workingDirectory: request.workingDirectory,
                networkAccessEnabled: this.options.networkAccess ?? true,
                skipGitRepoCheck: true,
            };
            if (request.model)
                threadOpts.model = request.model;
            if (request.reasoningEffort)
                threadOpts.modelReasoningEffort = request.reasoningEffort;
            // Map permission levels to Codex approval/sandbox modes
            switch (request.permissionLevel) {
                case 'admin':
                case 'system':
                    threadOpts.approvalPolicy = 'never';
                    threadOpts.sandboxMode = 'danger-full-access';
                    break;
                case 'trusted':
                    threadOpts.approvalPolicy = 'never';
                    threadOpts.sandboxMode = this.options.defaultSandbox ?? 'workspace-write';
                    break;
                case 'chat':
                    threadOpts.approvalPolicy = 'never';
                    threadOpts.sandboxMode = 'read-only';
                    break;
            }
            // Create or resume thread
            const thread = request.resumeSessionId
                ? codex.resumeThread(request.resumeSessionId, threadOpts)
                : codex.startThread(threadOpts);
            // Build prompt with memory context and system prompt prepended
            let fullPrompt = request.prompt;
            if (request.memoryContext) {
                fullPrompt = `<memory_context>\n${request.memoryContext}\n</memory_context>\n\n${fullPrompt}`;
            }
            if (request.systemPrompt) {
                fullPrompt = `<system_instructions>\n${request.systemPrompt}\n</system_instructions>\n\n${fullPrompt}`;
            }
            if (request.permissionLevel === 'chat') {
                fullPrompt = `IMPORTANT: You are in chat-only mode. Do NOT use any tools (no shell commands, no file operations, no web searches). Only respond with text.\n\n${fullPrompt}`;
            }
            // Build input — handle image attachments via temp files
            let input;
            const imageInputs = [];
            if (request.attachments && request.attachments.length > 0) {
                for (const att of request.attachments) {
                    if (att.type === 'image') {
                        const ext = att.mimeType.split('/')[1] || 'png';
                        const tempPath = join(tmpdir(), `ccbuddy-img-${randomUUID()}.${ext}`);
                        writeFileSync(tempPath, att.data);
                        tempFiles.push(tempPath);
                        imageInputs.push({ type: 'local_image', path: tempPath });
                    }
                    else {
                        // Non-image attachments: metadata-only note prepended to prompt
                        const sizeKB = Math.round(att.data.byteLength / 1024);
                        fullPrompt = `[Attached: ${att.mimeType} "${att.filename ?? 'unnamed'}" (${sizeKB}KB)]\n${fullPrompt}`;
                    }
                }
            }
            if (imageInputs.length > 0) {
                input = [...imageInputs, { type: 'text', text: fullPrompt }];
            }
            else {
                input = fullPrompt;
            }
            // Run with streaming
            const ac = new AbortController();
            this.abortControllers.set(request.sessionId, ac);
            const streamed = await thread.runStreamed(input, { signal: ac.signal });
            let threadId = request.sdkSessionId;
            let responseText = '';
            let terminalError;
            let sawTurnCompleted = false;
            for await (const event of streamed.events) {
                const mapped = this.mapEvent(event, base);
                if (mapped) {
                    for (const ev of mapped)
                        yield ev;
                }
                // Capture thread ID from thread.started
                if (event.type === 'thread.started') {
                    threadId = event.thread_id;
                }
                // Accumulate final response from agent_message items
                if (event.type === 'item.completed' && event.item.type === 'agent_message') {
                    responseText = event.item.text;
                }
                if (event.type === 'item.completed' && event.item.type === 'file_change') {
                    const restored = restoreProtectedFiles(request.workingDirectory, protectedFiles, event.item.changes.map((change) => change.path));
                    for (const filePath of restored)
                        blockedProtectedPaths.add(filePath);
                }
                // Handle turn completion
                if (event.type === 'turn.completed') {
                    sawTurnCompleted = true;
                }
                // Handle turn failure
                if (event.type === 'turn.failed') {
                    terminalError = event.error.message;
                }
                if (event.type === 'error') {
                    terminalError = event.message;
                }
            }
            const restored = restoreModifiedProtectedFiles(protectedFiles);
            for (const filePath of restored)
                blockedProtectedPaths.add(filePath);
            if (blockedProtectedPaths.size > 0) {
                const files = [...blockedProtectedPaths].join(', ');
                const suffix = terminalError ? ` Underlying error: ${terminalError}` : '';
                yield { ...base, type: 'error', error: `Blocked protected file modification and restored: ${files}.${suffix}` };
            }
            else if (terminalError) {
                yield { ...base, type: 'error', error: terminalError };
            }
            else if (sawTurnCompleted) {
                yield { ...base, type: 'complete', response: responseText, sdkSessionId: threadId };
            }
        }
        catch (err) {
            const restored = restoreModifiedProtectedFiles(protectedFiles);
            const suffix = restored.length > 0 ? ` Protected files restored: ${restored.join(', ')}` : '';
            yield { ...base, type: 'error', error: `${err.message}${suffix}` };
        }
        finally {
            this.abortControllers.delete(request.sessionId);
            for (const f of tempFiles) {
                try {
                    unlinkSync(f);
                }
                catch { /* ignore cleanup errors */ }
            }
        }
    }
    async abort(sessionId) {
        const ac = this.abortControllers.get(sessionId);
        if (ac) {
            ac.abort();
            this.abortControllers.delete(sessionId);
        }
    }
    mapEvent(event, base) {
        switch (event.type) {
            case 'item.started':
                return this.mapItemStarted(event.item, base);
            case 'item.updated':
                return this.mapItemUpdated(event.item, base);
            case 'item.completed':
                return this.mapItemCompleted(event.item, base);
            default:
                return null;
        }
    }
    mapItemStarted(item, base) {
        switch (item.type) {
            case 'command_execution':
                return [{ ...base, type: 'tool_use', tool: `Bash: ${item.command ?? ''}` }];
            case 'file_change':
                return [{ ...base, type: 'tool_use', tool: 'FileChange' }];
            case 'mcp_tool_call':
                return [{ ...base, type: 'tool_use', tool: `${item.server}/${item.tool}` }];
            case 'web_search':
                return [{ ...base, type: 'tool_use', tool: `WebSearch: ${item.query ?? ''}` }];
            default:
                return null;
        }
    }
    mapItemUpdated(item, base) {
        switch (item.type) {
            case 'agent_message':
                if (item.text) {
                    return [{ ...base, type: 'text', content: item.text }];
                }
                return null;
            case 'reasoning':
                if (item.text) {
                    return [{ ...base, type: 'thinking', content: item.text }];
                }
                return null;
            default:
                return null;
        }
    }
    mapItemCompleted(item, base) {
        switch (item.type) {
            case 'command_execution': {
                const cmd = item;
                return [{
                        ...base,
                        type: 'tool_result',
                        tool: 'Bash',
                        toolInput: { command: cmd.command },
                        toolOutput: cmd.aggregated_output ?? '',
                    }];
            }
            case 'file_change': {
                const fc = item;
                const summary = (fc.changes ?? [])
                    .map((c) => `${c.kind}: ${c.path}`)
                    .join(', ');
                return [{
                        ...base,
                        type: 'tool_result',
                        tool: 'FileChange',
                        toolInput: { changes: fc.changes },
                        toolOutput: summary,
                    }];
            }
            case 'mcp_tool_call': {
                const mcp = item;
                const output = mcp.error?.message ?? JSON.stringify(mcp.result ?? '');
                return [{
                        ...base,
                        type: 'tool_result',
                        tool: `${mcp.server}/${mcp.tool}`,
                        toolInput: mcp.arguments ?? {},
                        toolOutput: output,
                    }];
            }
            default:
                return null;
        }
    }
}
//# sourceMappingURL=codex-sdk-backend.js.map
