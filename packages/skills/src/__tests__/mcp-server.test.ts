import { describe, it, expect, afterAll } from 'vitest';
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
