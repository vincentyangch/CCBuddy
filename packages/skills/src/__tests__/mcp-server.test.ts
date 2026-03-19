import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

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
  mkdirSync(join(skillsDir, 'generated'), { recursive: true });

  const registryPath = join(tmpDir, 'registry.yaml');
  writeFileSync(registryPath, 'skills: []\n', 'utf8');

  return { registryPath, skillsDir, tmpDir };
}

async function createClient(
  registryPath: string,
  skillsDir: string,
  extraArgs: string[] = [],
): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath, '--registry', registryPath, '--skills-dir', skillsDir, ...extraArgs],
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

  it('create_skill creates a skill and returns success', async () => {
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
      expect(parsed.filePath).toBeDefined();
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
    `);
    db.prepare('INSERT INTO messages (user_id, session_id, platform, content, role, timestamp, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'testuser', 'sess-1', 'discord', 'Hello world', 'user', Date.now(), 10
    );
    db.prepare('INSERT INTO summary_nodes (user_id, depth, content, source_ids, tokens, timestamp) VALUES (?, ?, ?, ?, ?, ?)').run(
      'testuser', 0, 'Summary about greetings', '[1]', 20, Date.now()
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
    expect(parsed.count).toBe(1);
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
