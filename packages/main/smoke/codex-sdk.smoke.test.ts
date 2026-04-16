import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CodexSdkBackend } from '../../agent/src/backends/codex-sdk-backend.js';
import { MemoryDatabase } from '../../memory/src/database.js';
import { SessionDatabase } from '../../memory/src/session-database.js';
import type { AgentEvent, AgentRequest } from '@ccbuddy/core';

const RUN_SMOKE = process.env.CCBUDDY_RUN_CODEX_SMOKE === '1';
const smokeDescribe = RUN_SMOKE ? describe : describe.skip;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const require = createRequire(import.meta.url);
const tsxLoaderPath = require.resolve('tsx');
const skillsMcpServerPath = join(repoRoot, 'packages', 'skills', 'src', 'mcp-server.ts');

const apiKeyEnvName = process.env.CCBUDDY_CODEX_SMOKE_KEY_ENV ?? 'OPENAI_API_KEY';
const apiKey = process.env[apiKeyEnvName];
const baseModel = process.env.CCBUDDY_CODEX_SMOKE_MODEL ?? 'gpt-5.4-mini';
const switchModel = process.env.CCBUDDY_CODEX_SMOKE_SWITCH_MODEL ?? 'gpt-5.4';
const codexPath = process.env.CCBUDDY_CODEX_PATH;

const sessionKey = 'codex-smoke-session';
const rememberedToken = 'FALCON-SMOKE';
const protectedConfigContents = 'secret: original\n';

type TerminalEvent = Extract<AgentEvent, { type: 'complete' | 'error' }>;

async function collectTerminalEvent(
  backend: CodexSdkBackend,
  request: AgentRequest,
): Promise<{ events: AgentEvent[]; terminal: TerminalEvent }> {
  const events: AgentEvent[] = [];
  for await (const event of backend.execute(request)) {
    events.push(event);
    if (event.type === 'complete' || event.type === 'error') {
      return { events, terminal: event };
    }
  }
  throw new Error('Smoke test did not receive a terminal event');
}

smokeDescribe('Codex SDK Smoke', () => {
  let tempDir = '';
  let workspaceDir = '';
  let dataDir = '';
  let registryPath = '';
  let skillsDir = '';
  let memoryDbPath = '';
  let sessionDb: SessionDatabase;
  let database: MemoryDatabase;
  let backend: CodexSdkBackend;

  beforeAll(() => {
    if (!apiKey) {
      throw new Error(`Set ${apiKeyEnvName} and CCBUDDY_RUN_CODEX_SMOKE=1 to run the live Codex smoke test`);
    }
    if (baseModel === switchModel) {
      throw new Error('CCBUDDY_CODEX_SMOKE_MODEL and CCBUDDY_CODEX_SMOKE_SWITCH_MODEL must be different');
    }

    tempDir = mkdtempSync(join(tmpdir(), 'ccbuddy-codex-smoke-'));
    workspaceDir = join(tempDir, 'workspace');
    dataDir = join(tempDir, 'data');
    skillsDir = join(tempDir, 'skills');
    registryPath = join(skillsDir, 'registry.yaml');
    memoryDbPath = join(dataDir, 'memory.sqlite');

    mkdirSync(join(workspaceDir, 'config'), { recursive: true });
    mkdirSync(join(skillsDir, 'local'), { recursive: true });
    mkdirSync(join(skillsDir, 'generated'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(join(workspaceDir, 'README.md'), '# Codex smoke workspace\n', 'utf8');
    writeFileSync(join(workspaceDir, 'config', 'local.yaml'), protectedConfigContents, 'utf8');
    writeFileSync(registryPath, 'skills: []\n', 'utf8');
    writeFileSync(
      join(dataDir, 'runtime-config.json'),
      JSON.stringify({ codex_models: [baseModel, switchModel] }, null, 2),
      'utf8',
    );

    execFileSync('git', ['init'], { cwd: workspaceDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'smoke@example.com'], { cwd: workspaceDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Codex Smoke'], { cwd: workspaceDir, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: workspaceDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'Initial smoke workspace'], { cwd: workspaceDir, stdio: 'ignore' });

    database = new MemoryDatabase(memoryDbPath);
    database.init();
    sessionDb = new SessionDatabase(database.raw());
    const now = Date.now();
    sessionDb.upsert({
      session_key: sessionKey,
      sdk_session_id: 'placeholder-sdk-session',
      user_id: 'smoke',
      platform: 'system',
      channel_id: 'smoke',
      is_group_channel: false,
      model: baseModel,
      turns: 0,
      status: 'active',
      created_at: now,
      last_activity: now,
    });

    backend = new CodexSdkBackend({
      apiKey,
      codexPath,
      networkAccess: true,
      defaultSandbox: 'workspace-write',
      permissionGateRules: [
        { name: 'local-config', pattern: 'config/local\\.yaml', tool: '*', description: 'Modify local config (contains secrets)' },
      ],
    });
  }, 30_000);

  afterAll(() => {
    backend?.destroy();
    database?.close();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('authenticates, resumes, uses MCP model switching, and rolls back protected config edits', async () => {
    const requestBase: Pick<AgentRequest, 'userId' | 'sessionId' | 'channelId' | 'platform' | 'permissionLevel' | 'workingDirectory'> = {
      userId: 'smoke',
      sessionId: 'codex-smoke',
      channelId: 'smoke',
      platform: 'system',
      permissionLevel: 'admin',
      workingDirectory: workspaceDir,
    };

    const firstTurn = await collectTerminalEvent(backend, {
      ...requestBase,
      model: baseModel,
      prompt: `Remember the secret token ${rememberedToken} for the rest of this conversation. Reply with exactly BASIC_OK.`,
    });
    expect(firstTurn.terminal.type).toBe('complete');
    expect(firstTurn.terminal.response).toContain('BASIC_OK');
    expect(firstTurn.terminal.sdkSessionId).toBeTruthy();

    const resumedTurn = await collectTerminalEvent(backend, {
      ...requestBase,
      model: baseModel,
      resumeSessionId: firstTurn.terminal.sdkSessionId,
      prompt: 'What secret token did I ask you to remember? Reply with exactly RESUME_OK TOKEN:<token>.',
    });
    expect(resumedTurn.terminal.type).toBe('complete');
    expect(resumedTurn.terminal.response).toContain(`RESUME_OK TOKEN:${rememberedToken}`);

    const switchTurn = await collectTerminalEvent(backend, {
      ...requestBase,
      model: baseModel,
      mcpServers: [{
        name: 'skills',
        command: process.execPath,
        args: [
          '--import', tsxLoaderPath,
          skillsMcpServerPath,
          '--registry', registryPath,
          '--skills-dir', skillsDir,
          '--memory-db', memoryDbPath,
          '--data-dir', dataDir,
          '--session-key', sessionKey,
          '--backend', 'codex-sdk',
          '--no-approval',
          '--no-git-commit',
        ],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          TMPDIR: process.env.TMPDIR ?? '',
        },
      }],
      prompt: `Use the switch_model tool to switch this session to ${switchModel}. After the tool succeeds, reply with exactly MCP_OK.`,
    });
    expect(switchTurn.terminal.type).toBe('complete');
    expect(switchTurn.terminal.response).toContain('MCP_OK');
    expect(switchTurn.events.some((event) => event.type === 'tool_use' && event.tool === 'skills/switch_model')).toBe(true);
    expect(sessionDb.getByKey(sessionKey)?.model).toBe(switchModel);

    const protectedEditTurn = await collectTerminalEvent(backend, {
      ...requestBase,
      model: switchModel,
      prompt: "Use a file-editing tool or shell command to replace the contents of config/local.yaml with exactly:\npwned: true",
    });
    expect(protectedEditTurn.terminal.type).toBe('error');
    expect(protectedEditTurn.terminal.error).toContain('config/local.yaml');
    expect(readFileSync(join(workspaceDir, 'config', 'local.yaml'), 'utf8')).toBe(protectedConfigContents);
  }, 300_000);
});
