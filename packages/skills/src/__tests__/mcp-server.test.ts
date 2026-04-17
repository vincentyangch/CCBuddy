import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { load as yamlLoad } from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', '..', 'dist', 'mcp-server.js');

// Collect temp dirs for cleanup
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

function makeTmpEnv(): { registryPath: string; skillsDir: string; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  tmpDirs.push(tmpDir);

  const skillsDir = join(tmpDir, 'skills');
  mkdirSync(join(skillsDir, 'local'), { recursive: true });
  mkdirSync(join(skillsDir, 'generated'), { recursive: true });

  const registryPath = join(skillsDir, 'registry.yaml');
  writeFileSync(registryPath, 'skills: []\n', 'utf8');

  return { registryPath, skillsDir, tmpDir };
}

function readYamlFile<T>(filePath: string): T {
  return yamlLoad(readFileSync(filePath, 'utf8')) as T;
}

async function createClient(
  registryPath: string,
  skillsDir: string,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
): Promise<{ client: Client; transport: StdioClientTransport }> {
  const envEntries = Object.entries({ ...process.env, ...extraEnv }).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const env = Object.fromEntries(envEntries);

  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath, '--registry', registryPath, '--skills-dir', skillsDir, ...extraArgs],
    env,
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MCP server integration', () => {
  it('lists tools including meta-tools', async () => {
    const { registryPath, skillsDir } = makeTmpEnv();
    const { client, transport } = await createClient(registryPath, skillsDir, [
      '--no-approval',
      '--no-git-commit',
    ]);

    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).toContain('list_skills');
      expect(names).toContain('create_skill');
      expect(names).toContain('promote_skill');
    } finally {
      await transport.close();
    }
  }, 15_000);

  it('list_skills returns empty array when no skills registered', async () => {
    const { registryPath, skillsDir } = makeTmpEnv();
    const { client, transport } = await createClient(registryPath, skillsDir, [
      '--no-approval',
      '--no-git-commit',
    ]);

    try {
      const result = await client.callTool({ name: 'list_skills', arguments: {} });
      const content = result.content as Array<{ type: string; text: string }>;
      const skills = JSON.parse(content[0].text);
      expect(skills).toEqual([]);
    } finally {
      await transport.close();
    }
  }, 15_000);

  it('switch_model uses runtime-config model lists for validation and tool descriptions', async () => {
    const { registryPath, skillsDir, tmpDir } = makeTmpEnv();
    writeFileSync(join(tmpDir, 'runtime-config.json'), JSON.stringify({
      codex_models: ['gpt-5.4', 'gpt-5.4-mini'],
    }), 'utf8');

    const { client, transport } = await createClient(registryPath, skillsDir, [
      '--no-approval',
      '--no-git-commit',
      '--backend', 'codex-sdk',
      '--session-key', 'session-1',
      '--data-dir', tmpDir,
    ]);

    try {
      const tools = await client.listTools();
      const switchModel = tools.tools.find((tool) => tool.name === 'switch_model');
      expect(switchModel?.description).toContain('gpt-5.4-mini');

      const result = await client.callTool({
        name: 'switch_model',
        arguments: { model: 'gpt-5.4-mini' },
      });
      expect((result.content as Array<{ text: string }>)[0].text).toContain('Model switched to gpt-5.4-mini');

      const invalid = await client.callTool({
        name: 'switch_model',
        arguments: { model: 'legacy-model' },
      });
      expect((invalid.content as Array<{ text: string }>)[0].text).toContain('Invalid model "legacy-model"');
    } finally {
      await transport.close();
    }
  }, 15_000);

  it('send_file copies files into CCBUDDY_OUTBOUND_DIR', async () => {
    const { registryPath, skillsDir } = makeTmpEnv();
    const workingDir = mkdtempSync(join(process.cwd(), 'send-file-test-'));
    tmpDirs.push(workingDir);
    const sourcePath = join(workingDir, 'report.txt');
    const outboundDir = join(workingDir, 'outbound', 'request-1');
    mkdirSync(outboundDir, { recursive: true });
    writeFileSync(sourcePath, 'hello', 'utf8');

    const { client, transport } = await createClient(
      registryPath,
      skillsDir,
      ['--no-approval', '--no-git-commit'],
      { CCBUDDY_OUTBOUND_DIR: outboundDir },
    );

    try {
      const result = await client.callTool({
        name: 'send_file',
        arguments: { file_path: sourcePath },
      });
      const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(parsed.success).toBe(true);

      const queuedFiles = readdirSync(outboundDir);
      expect(queuedFiles).toHaveLength(1);
      expect(readFileSync(join(outboundDir, queuedFiles[0]!), 'utf8')).toBe('hello');
    } finally {
      await transport.close();
    }
  }, 15_000);

  it('send_file fails clearly when CCBUDDY_OUTBOUND_DIR is missing', async () => {
    const { registryPath, skillsDir } = makeTmpEnv();
    const workingDir = mkdtempSync(join(process.cwd(), 'send-file-test-'));
    tmpDirs.push(workingDir);
    const sourcePath = join(workingDir, 'report.txt');
    writeFileSync(sourcePath, 'hello', 'utf8');

    const { client, transport } = await createClient(registryPath, skillsDir, [
      '--no-approval',
      '--no-git-commit',
    ]);

    try {
      const result = await client.callTool({
        name: 'send_file',
        arguments: { file_path: sourcePath },
      });
      const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('CCBUDDY_OUTBOUND_DIR');
    } finally {
      await transport.close();
    }
  }, 15_000);

  it('create_skill writes a local skill instead of mutating the tracked registry', async () => {
    const { registryPath, skillsDir } = makeTmpEnv();
    const { client, transport } = await createClient(registryPath, skillsDir, [
      '--no-approval',
      '--no-git-commit',
    ]);

    try {
      const result = await client.callTool({
        name: 'create_skill',
        arguments: {
          name: 'test-greet',
          description: 'Greets a user by name',
          code: 'export default async function(input) { return { success: true, result: `Hello ${input.name}` }; }',
          input_schema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Name to greet' },
            },
            required: ['name'],
          },
        },
      });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.filePath).toContain(join('skills', 'local'));
      expect(parsed.filePath).toContain('test-greet.mjs');

      const trackedRegistry = readYamlFile<{ skills: Array<{ definition: { name: string } }> }>(registryPath);
      expect(trackedRegistry.skills).toEqual([]);

      const localRegistryPath = join(skillsDir, 'local', 'registry.yaml');
      const localRegistry = readYamlFile<{
        skills: Array<{ definition: { name: string; filePath: string; source: string } }>;
        runtimeMetadata: Record<string, unknown>;
      }>(localRegistryPath);
      expect(localRegistry.skills).toHaveLength(1);
      expect(localRegistry.skills[0].definition.name).toBe('test-greet');
      expect(localRegistry.skills[0].definition.source).toBe('local');
    } finally {
      await transport.close();
    }
  }, 15_000);

  it('promote_skill moves a local skill into the tracked generated area', async () => {
    const { registryPath, skillsDir } = makeTmpEnv();
    const { client, transport } = await createClient(registryPath, skillsDir, [
      '--no-approval',
      '--no-git-commit',
    ]);

    try {
      await client.callTool({
        name: 'create_skill',
        arguments: {
          name: 'test-greet',
          description: 'Greets a user by name',
          code: 'export default async function(input) { return { success: true, result: `Hello ${input.name}` }; }',
          input_schema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Name to greet' },
            },
            required: ['name'],
          },
        },
      });

      const result = await client.callTool({
        name: 'promote_skill',
        arguments: {
          name: 'test-greet',
        },
      });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.filePath).toContain(join('skills', 'generated'));

      const generatedPath = join(skillsDir, 'generated', 'test-greet.mjs');
      const localPath = join(skillsDir, 'local', 'test-greet.mjs');
      expect(parsed.filePath).toBe(generatedPath);
      expect(readFileSync(generatedPath, 'utf8')).toContain('Hello ${input.name}');

      const trackedRegistry = readYamlFile<{
        skills: Array<{ definition: { name: string; source: string; filePath: string } }>;
      }>(registryPath);
      expect(trackedRegistry.skills).toHaveLength(1);
      expect(trackedRegistry.skills[0].definition.name).toBe('test-greet');
      expect(trackedRegistry.skills[0].definition.source).toBe('generated');
      expect(trackedRegistry.skills[0].definition.filePath).toBe('generated/test-greet.mjs');
      expect(existsSync(localPath)).toBe(false);

      const localRegistryPath = join(skillsDir, 'local', 'registry.yaml');
      const localRegistry = readYamlFile<{
        skills: Array<unknown>;
        runtimeMetadata: Record<string, { usageCount: number; lastUsed?: string }>;
      }>(localRegistryPath);
      expect(localRegistry.skills).toEqual([]);
      expect(localRegistry.runtimeMetadata['tracked:test-greet']).toEqual({ usageCount: 0 });
    } finally {
      await transport.close();
    }
  }, 15_000);

  it('skill execution records usage in local state only', async () => {
    const { registryPath, skillsDir } = makeTmpEnv();
    const { client, transport } = await createClient(registryPath, skillsDir, [
      '--no-approval',
      '--no-git-commit',
    ]);

    try {
      await client.callTool({
        name: 'create_skill',
        arguments: {
          name: 'test-greet',
          description: 'Greets a user by name',
          code: 'export default async function(input) { return { success: true, result: `Hello ${input.name}` }; }',
          input_schema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Name to greet' },
            },
            required: ['name'],
          },
        },
      });

      const execution = await client.callTool({
        name: 'skill_test-greet',
        arguments: {
          name: 'CCBuddy',
        },
      });

      const executionContent = execution.content as Array<{ type: string; text: string }>;
      const executionParsed = JSON.parse(executionContent[0].text);
      expect(executionParsed.success).toBe(true);
      expect(executionParsed.result).toBe('Hello CCBuddy');

      const trackedRegistry = readYamlFile<{ skills: Array<{ definition: { name: string } }> }>(registryPath);
      expect(trackedRegistry.skills).toEqual([]);

      const localRegistryPath = join(skillsDir, 'local', 'registry.yaml');
      const localRegistry = readYamlFile<{
        skills: Array<{ definition: { name: string } }>;
        runtimeMetadata: Record<string, { usageCount: number; lastUsed?: string }>;
      }>(localRegistryPath);
      expect(localRegistry.runtimeMetadata['local:test-greet']).toBeDefined();
      expect(localRegistry.runtimeMetadata['local:test-greet'].usageCount).toBe(1);
      expect(localRegistry.skills[0].definition.name).toBe('test-greet');
    } finally {
      await transport.close();
    }
  }, 15_000);

  it('create_skill rejects elevated permissions without approval', async () => {
    const { registryPath, skillsDir } = makeTmpEnv();
    // Note: no --no-approval flag, so approval is required
    const { client, transport } = await createClient(registryPath, skillsDir, [
      '--no-git-commit',
    ]);

    try {
      const result = await client.callTool({
        name: 'create_skill',
        arguments: {
          name: 'test-shell',
          description: 'Runs a shell command',
          code: 'export default async function(input) { return { success: true, result: "done" }; }',
          input_schema: {
            type: 'object',
            properties: {
              cmd: { type: 'string', description: 'Command to run' },
            },
          },
          permissions: ['shell'],
          // No approved: true — should be rejected
        },
      });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain('elevated permissions');
    } finally {
      await transport.close();
    }
  }, 15_000);

  it('restart_gateway accepts JSON pid lockfiles', async () => {
    const { registryPath, skillsDir, tmpDir } = makeTmpEnv();
    const child = spawn('/bin/sh', ['-c', 'trap "exit 0" USR1; while true; do sleep 1; done'], {
      stdio: 'ignore',
    });

    try {
      expect(child.pid).toBeTypeOf('number');
      writeFileSync(join(tmpDir, 'ccbuddy.pid'), JSON.stringify({
        pid: child.pid,
        startedAtMs: Date.now(),
        createdAt: new Date().toISOString(),
        instanceId: 'test-instance',
      }), 'utf8');

      const { client, transport } = await createClient(registryPath, skillsDir, [
        '--no-approval',
        '--no-git-commit',
        '--data-dir', tmpDir,
      ]);

      try {
        const result = await client.callTool({
          name: 'restart_gateway',
          arguments: {},
        });
        const text = (result.content as Array<{ text: string }>)[0].text;
        expect(text).toContain(`Restart signal sent (PID ${child.pid})`);
      } finally {
        await transport.close();
      }

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('restart target did not exit after SIGUSR1')), 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }
  }, 15_000);
});

describe('with --memory-db', () => {
  let memClient: Client;
  let memTransport: StdioClientTransport;
  let testDbPath: string;
  const { registryPath, skillsDir, tmpDir } = makeTmpEnv();

  beforeAll(async () => {
    testDbPath = join(tmpDir, 'test-memory.sqlite');
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(testDbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        content TEXT NOT NULL,
        role TEXT NOT NULL,
        attachments TEXT,
        timestamp INTEGER NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE summary_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        source_ids TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        session_key TEXT PRIMARY KEY,
        sdk_session_id TEXT NOT NULL,
        user_id TEXT,
        platform TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        is_group_channel BOOLEAN NOT NULL DEFAULT 0,
        model TEXT,
        reasoning_effort TEXT,
        verbosity TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        last_activity INTEGER NOT NULL,
        turns INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, key)
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        channel_key TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const now = Date.now();
    db.prepare('INSERT INTO messages (user_id, session_id, platform, content, role, timestamp, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'testuser', 'sess-1', 'discord', 'Hello world', 'user', now, 10
    );
    db.prepare('INSERT INTO summary_nodes (user_id, depth, content, source_ids, tokens, timestamp) VALUES (?, ?, ?, ?, ?, ?)').run(
      'testuser', 0, 'Summary about greetings', '[1]', 20, now
    );
    // Seed a scheduled briefing pair
    db.prepare('INSERT INTO messages (user_id, session_id, platform, content, role, timestamp, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'testuser', 'sess-1', 'discord', '[Scheduled: evening_briefing]', 'user', now + 1, 5
    );
    db.prepare('INSERT INTO messages (user_id, session_id, platform, content, role, timestamp, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'testuser', 'sess-1', 'discord', 'Good evening! Here is your brief.', 'assistant', now + 2, 20
    );
    db.close();

    memTransport = new StdioClientTransport({
      command: 'node',
      args: [serverPath, '--registry', registryPath, '--skills-dir', skillsDir, '--memory-db', testDbPath],
    });
    memClient = new Client({ name: 'test-client', version: '1.0.0' });
    await memClient.connect(memTransport);
  }, 15_000);

  afterAll(async () => {
    await memClient?.close();
  });

  it('lists memory tools alongside skill tools', async () => {
    const result = await memClient.listTools();
    const names = result.tools.map(t => t.name);
    expect(names).toContain('list_skills');
    expect(names).toContain('create_skill');
    expect(names).toContain('memory_grep');
    expect(names).toContain('memory_get_briefs');
    expect(names).toContain('memory_describe');
    expect(names).toContain('memory_expand');
  });

  it('memory_grep returns matching messages and summaries', async () => {
    const result = await memClient.callTool({ name: 'memory_grep', arguments: { userId: 'testuser', query: 'Hello' } });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.messages.length).toBeGreaterThan(0);
    expect(parsed.messages[0].content).toContain('Hello');
  });

  it('memory_describe returns messages in time range', async () => {
    const now = Date.now();
    const result = await memClient.callTool({
      name: 'memory_describe',
      arguments: { userId: 'testuser', startMs: now - 60_000, endMs: now + 60_000 },
    });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.count).toBeGreaterThan(0);
  });

  it('memory_get_briefs returns scheduled briefing pairs', async () => {
    const result = await memClient.callTool({
      name: 'memory_get_briefs',
      arguments: { userId: 'testuser', jobName: 'evening_briefing' },
    });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.briefs[0].trigger.content).toBe('[Scheduled: evening_briefing]');
    expect(parsed.briefs[0].response.content).toBe('Good evening! Here is your brief.');
  });

  it('memory_grep works without explicit userId (uses owner default)', async () => {
    const result = await memClient.callTool({
      name: 'memory_grep',
      arguments: { query: 'Hello' },
    });
    const parsed = JSON.parse((result.content as any)[0].text);
    // Should not throw — will return results or empty array depending on owner user resolution
    expect(parsed).toHaveProperty('messages');
    expect(parsed).toHaveProperty('summaries');
  });

  it('persists session reasoning effort and verbosity overrides via MCP tools', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(testDbPath);
    const now = Date.now();
    db.prepare(`
      INSERT OR REPLACE INTO sessions (
        session_key, sdk_session_id, user_id, platform, channel_id, is_group_channel,
        model, reasoning_effort, verbosity, status, created_at, last_activity, turns
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('session-1', 'sdk-1', 'testuser', 'discord', 'ch1', 0, 'gpt-5.4', null, null, 'active', now, now, 0);
    db.close();

    const { client, transport } = await createClient(registryPath, skillsDir, [
      '--no-approval',
      '--no-git-commit',
      '--memory-db', testDbPath,
      '--backend', 'codex-sdk',
      '--session-key', 'session-1',
      '--data-dir', tmpDir,
    ]);

    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toContain('switch_reasoning_effort');
      expect(names).toContain('switch_verbosity');

      const reasoning = await client.callTool({
        name: 'switch_reasoning_effort',
        arguments: { reasoning_effort: 'high' },
      });
      expect((reasoning.content as Array<{ text: string }>)[0].text).toContain('Reasoning effort switched to high');

      const verbosity = await client.callTool({
        name: 'switch_verbosity',
        arguments: { verbosity: 'low' },
      });
      expect((verbosity.content as Array<{ text: string }>)[0].text).toContain('Verbosity switched to low');

      const current = await client.callTool({
        name: 'get_current_model',
        arguments: {},
      });
      const currentText = (current.content as Array<{ text: string }>)[0].text;
      expect(currentText).toContain('Current model override: gpt-5.4');
      expect(currentText).toContain('Reasoning effort override: high');
      expect(currentText).toContain('Verbosity override: low');
    } finally {
      await transport.close();
    }

    const verifyDb = new Database(testDbPath, { readonly: true });
    const row = verifyDb.prepare('SELECT reasoning_effort, verbosity FROM sessions WHERE session_key = ?').get('session-1') as {
      reasoning_effort: string | null;
      verbosity: string | null;
    };
    verifyDb.close();

    expect(row.reasoning_effort).toBe('high');
    expect(row.verbosity).toBe('low');
  });

});

describe('with --heartbeat-status-file', () => {
  let hbClient: Client;
  let hbTransport: StdioClientTransport;
  let statusFilePath: string;
  const { registryPath, skillsDir, tmpDir } = makeTmpEnv();

  beforeAll(async () => {
    statusFilePath = join(tmpDir, 'heartbeat-status.json');
    writeFileSync(statusFilePath, JSON.stringify({
      modules: { process: 'healthy', database: 'healthy', agent: 'degraded' },
      system: { cpuPercent: 10, memoryPercent: 2.5, diskPercent: 45 },
      timestamp: Date.now(),
    }));

    hbTransport = new StdioClientTransport({
      command: 'node',
      args: [serverPath, '--registry', registryPath, '--skills-dir', skillsDir, '--heartbeat-status-file', statusFilePath],
    });
    hbClient = new Client({ name: 'test-client', version: '1.0.0' });
    await hbClient.connect(hbTransport);
  }, 15_000);

  afterAll(async () => {
    await hbClient?.close();
  });

  it('lists system_health tool', async () => {
    const result = await hbClient.listTools();
    const names = result.tools.map(t => t.name);
    expect(names).toContain('system_health');
  });

  it('returns heartbeat status', async () => {
    const result = await hbClient.callTool({ name: 'system_health', arguments: {} });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.modules.agent).toBe('degraded');
    expect(parsed.system.cpuPercent).toBe(10);
  });

  it('returns stale warning when data is old', async () => {
    const stalePath = join(tmpDir, 'heartbeat-stale.json');
    writeFileSync(stalePath, JSON.stringify({
      modules: { process: 'healthy' },
      system: { cpuPercent: 5, memoryPercent: 1, diskPercent: 30 },
      timestamp: Date.now() - 700_000, // ~11 minutes ago
    }));

    const staleTransport = new StdioClientTransport({
      command: 'node',
      args: [serverPath, '--registry', registryPath, '--skills-dir', skillsDir, '--heartbeat-status-file', stalePath],
    });
    const staleClient = new Client({ name: 'test-client', version: '1.0.0' });
    await staleClient.connect(staleTransport);

    const result = await staleClient.callTool({ name: 'system_health', arguments: {} });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.stale).toBe(true);

    await staleClient.close();
  }, 15_000);

  it('returns no-data when file missing', async () => {
    const badTransport = new StdioClientTransport({
      command: 'node',
      args: [serverPath, '--registry', registryPath, '--skills-dir', skillsDir, '--heartbeat-status-file', join(tmpDir, 'nonexistent.json')],
    });
    const badClient = new Client({ name: 'test-client', version: '1.0.0' });
    await badClient.connect(badTransport);

    const result = await badClient.callTool({ name: 'system_health', arguments: {} });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.status).toBe('no_data');

    await badClient.close();
  }, 15_000);
});
