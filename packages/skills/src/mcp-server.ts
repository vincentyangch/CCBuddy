#!/usr/bin/env node
/**
 * MCP server entry point for CCBuddy skills.
 *
 * Wraps SkillRegistry, SkillGenerator, SkillValidator, and SkillRunner
 * and exposes skills as MCP tools via stdio transport.
 *
 * CLI args:
 *   --registry <path>   Path to registry YAML file
 *   --skills-dir <path> Parent directory for skills (generator appends /generated/)
 *   --no-approval       Disable approval requirement for elevated permissions
 *   --no-git-commit     Disable automatic git commit after skill creation
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, copyFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join as pathJoin, resolve as pathResolve, basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { SkillRegistry } from './registry.js';
import { SkillGenerator } from './generator.js';
import { SkillValidator } from './validator.js';
import { SkillRunner } from './runner.js';
import type { SkillPermission } from './types.js';
import { MemoryDatabase, MessageStore, SummaryStore, RetrievalTools, ProfileStore, SessionDatabase, WorkspaceStore } from '@ccbuddy/memory';
import { SwiftBridge, AppleCalendarService, AppleRemindersService, AppleShortcutsService, JxaBridge, AppleNotesService } from '@ccbuddy/apple';
import { isValidModelForBackend, getModelOptionsForBackend } from '@ccbuddy/core';
import type { BackendType } from '@ccbuddy/core';

// ── CLI argument parsing ────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  registryPath: string;
  skillsDir: string;
  requireApproval: boolean;
  autoGitCommit: boolean;
  memoryDbPath: string;
  heartbeatStatusFile: string;
  appleHelperPath: string;
  sessionKey: string;
  dataDir: string;
  channelKey: string;
  ownerUserId: string;
  backend: BackendType;
} {
  let registryPath = '';
  let skillsDir = '';
  let requireApproval = true;
  let autoGitCommit = true;
  let memoryDbPath = '';
  let heartbeatStatusFile = '';
  let appleHelperPath = '';
  let sessionKey = '';
  let dataDir = '';
  let channelKey = '';
  let ownerUserId = '';
  let backend: BackendType = 'sdk';

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--registry':
        registryPath = argv[++i] ?? '';
        break;
      case '--skills-dir':
        skillsDir = argv[++i] ?? '';
        break;
      case '--no-approval':
        requireApproval = false;
        break;
      case '--no-git-commit':
        autoGitCommit = false;
        break;
      case '--memory-db':
        memoryDbPath = argv[++i] ?? '';
        break;
      case '--heartbeat-status-file':
        heartbeatStatusFile = argv[++i] ?? '';
        break;
      case '--apple-helper':
        appleHelperPath = argv[++i] ?? '';
        break;
      case '--session-key':
        sessionKey = argv[++i] ?? '';
        break;
      case '--data-dir':
        dataDir = argv[++i] ?? '';
        break;
      case '--channel-key':
        channelKey = argv[++i] ?? '';
        break;
      case '--owner-user-id':
        ownerUserId = argv[++i] ?? '';
        break;
      case '--backend':
        backend = (argv[++i] ?? 'sdk') as BackendType;
        break;
    }
  }

  if (!registryPath) {
    console.error('Error: --registry <path> is required');
    process.exit(1);
  }
  if (!skillsDir) {
    console.error('Error: --skills-dir <path> is required');
    process.exit(1);
  }

  return { registryPath, skillsDir, requireApproval, autoGitCommit, memoryDbPath, heartbeatStatusFile, appleHelperPath, sessionKey, dataDir, channelKey, ownerUserId, backend };
}

function loadRuntimeModelLists(dataDir: string): { claude_models?: string[]; codex_models?: string[] } {
  if (!dataDir) return {};

  try {
    const runtimeConfig = JSON.parse(readFileSync(pathJoin(dataDir, 'runtime-config.json'), 'utf8')) as {
      claude_models?: unknown;
      codex_models?: unknown;
    };

    const lists: { claude_models?: string[]; codex_models?: string[] } = {};
    if (Array.isArray(runtimeConfig.claude_models) && runtimeConfig.claude_models.every((model) => typeof model === 'string')) {
      lists.claude_models = runtimeConfig.claude_models;
    }
    if (Array.isArray(runtimeConfig.codex_models) && runtimeConfig.codex_models.every((model) => typeof model === 'string')) {
      lists.codex_models = runtimeConfig.codex_models;
    }
    return lists;
  } catch {
    return {};
  }
}

function parseGatewayPidLock(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as { pid?: unknown };
    if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return parsed.pid;
    }
  } catch {
    // Fall through to legacy raw-PID parsing.
  }

  const pid = Number.parseInt(trimmed, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function parseChannelKey(channelKey: string): { platform: string; channel: string } | null {
  const separator = channelKey.indexOf('-');
  if (separator <= 0 || separator === channelKey.length - 1) return null;
  return {
    platform: channelKey.slice(0, separator),
    channel: channelKey.slice(separator + 1),
  };
}

// ── Elevated permission check ───────────────────────────────────────────────

const ELEVATED_PERMISSIONS: Set<SkillPermission> = new Set([
  'filesystem',
  'network',
  'shell',
  'env',
]);

function hasElevatedPermissions(permissions: SkillPermission[]): boolean {
  return permissions.some((p) => ELEVATED_PERMISSIONS.has(p));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // 1. Load registry
  const registry = new SkillRegistry(args.registryPath);
  await registry.load();

  // 1b. Optionally wire memory retrieval tools + profile store
  let retrievalTools: RetrievalTools | null = null;
  let profileStore: ProfileStore | null = null;
  let memoryDatabase: MemoryDatabase | null = null;
  let profileDatabase: MemoryDatabase | null = null;
  let sessionDb: SessionDatabase | undefined;
  let workspaceStore: WorkspaceStore | undefined;
  // ownerUserId: the default userId for memory tool calls when userId is omitted.
  // Resolved from --owner-user-id arg, falling back to the first user in the DB.
  let ownerUserId: string = args.ownerUserId;
  if (args.memoryDbPath) {
    memoryDatabase = new MemoryDatabase(args.memoryDbPath, { readonly: true });
    const messageStore = new MessageStore(memoryDatabase);
    const summaryStore = new SummaryStore(memoryDatabase);
    retrievalTools = new RetrievalTools(messageStore, summaryStore);
    // Auto-detect ownerUserId if not provided via CLI arg
    if (!ownerUserId) {
      const userIds = messageStore.getDistinctUserIds();
      if (userIds.length > 0) ownerUserId = userIds[0];
    }

    // Writable connection for profile updates (WAL mode supports concurrent writers)
    profileDatabase = new MemoryDatabase(args.memoryDbPath);
    profileStore = new ProfileStore(profileDatabase);
    sessionDb = new SessionDatabase(profileDatabase.raw());
    workspaceStore = new WorkspaceStore(profileDatabase.raw());

    // Register cleanup handlers for database shutdown
    const closeDatabases = () => { memoryDatabase?.close(); profileDatabase?.close(); };
    process.on('exit', closeDatabases);
    process.on('SIGTERM', () => { closeDatabases(); process.exit(0); });
    process.on('SIGINT', () => { closeDatabases(); process.exit(0); });
  }

  // 1c. Optionally wire Apple calendar tools
  let calendarService: AppleCalendarService | null = null;
  let remindersService: AppleRemindersService | null = null;
  let shortcutsService: AppleShortcutsService | null = null;
  let notesService: AppleNotesService | null = null;
  if (args.appleHelperPath) {
    const bridge = new SwiftBridge(args.appleHelperPath);
    calendarService = new AppleCalendarService(bridge);
    remindersService = new AppleRemindersService(bridge);
    shortcutsService = new AppleShortcutsService();
    notesService = new AppleNotesService(new JxaBridge());
  }

  // 2. Create validator, generator, runner
  const validator = new SkillValidator();
  const generator = new SkillGenerator(registry, validator, args.skillsDir);
  const runner = new SkillRunner({ timeoutMs: 120_000 });

  // 3. Wire git commit hook if enabled
  if (args.autoGitCommit) {
    generator.onAfterSave = async (filePath, skillName) => {
      const { execFile } = await import('node:child_process');
      await new Promise<void>((resolve) => {
        execFile('git', ['add', filePath], (err) => {
          if (err) {
            console.warn(`[Skills] git add failed: ${err.message}`);
            resolve();
            return;
          }
          execFile(
            'git',
            ['commit', '-m', `skill: add ${skillName}`],
            (err2) => {
              if (err2)
                console.warn(`[Skills] git commit failed: ${err2.message}`);
              resolve();
            },
          );
        });
      });
    };
  }

  // 3b. Load bundled skills from skills/bundled/
  await generator.loadBundledSkills();

  // 4. Create MCP server
  const server = new Server(
    { name: 'ccbuddy-skills', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // 5. ListTools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }> = [];

    // Static tools
    tools.push({
      name: 'list_skills',
      description:
        'List all registered skills with their metadata (name, description, version, source, permissions, usageCount, enabled)',
      inputSchema: { type: 'object', properties: {} },
    });

    tools.push({
      name: 'create_skill',
      description:
        'Create a new local skill. Provide name, description, code (JS/TS with export default async function), input_schema, and optional permissions/approved flag.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name (lowercase, alphanumeric, hyphens)' },
          description: { type: 'string', description: 'What the skill does' },
          code: { type: 'string', description: 'Skill source code — must be plain JavaScript (no TypeScript syntax), with export default async function' },
          input_schema: {
            type: 'object',
            description: 'JSON Schema for skill input',
          },
          permissions: {
            type: 'array',
            items: { type: 'string', enum: ['filesystem', 'network', 'shell', 'env'] },
            description: 'Required permissions (optional)',
          },
          approved: {
            type: 'boolean',
            description:
              'Set to true if user has approved elevated permissions',
          },
        },
        required: ['name', 'description', 'code', 'input_schema'],
      },
    });

    tools.push({
      name: 'promote_skill',
      description:
        'Promote a local skill into skills/generated/. Moves the local file into the tracked generated area and updates the tracked registry entry.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Local skill name to promote' },
        },
        required: ['name'],
      },
    });

    if (args.sessionKey) {
      const isCodex = args.backend.startsWith('codex');
      const modelDesc = isCodex
        ? 'Model alias (gpt-5.4, gpt-5.4-mini, gpt-5.4-pro, gpt-5.4-nano) or full OpenAI model ID'
        : 'Model alias (sonnet, opus, haiku, opus[1m], sonnet[1m], opusplan) or full model ID (e.g., claude-opus-4-6)';
      const runtimeModelLists = loadRuntimeModelLists(args.dataDir);
      const available = getModelOptionsForBackend(args.backend, runtimeModelLists);
      tools.push({
        name: 'switch_model',
        description: `Switch the AI model for subsequent messages in this session. Available models: ${available.join(', ')}`,
        inputSchema: {
          type: 'object',
          properties: {
            model: {
              type: 'string',
              description: modelDesc,
            },
          },
          required: ['model'],
        },
      });
      tools.push({
        name: 'get_current_model',
        description: 'Get the model, reasoning effort, and verbosity currently configured for this session.',
        inputSchema: { type: 'object', properties: {} },
      });
      tools.push({
        name: 'switch_reasoning_effort',
        description: 'Switch the reasoning effort for subsequent messages in this session.',
        inputSchema: {
          type: 'object',
          properties: {
            reasoning_effort: {
              type: 'string',
              enum: ['minimal', 'low', 'medium', 'high', 'xhigh'],
              description: 'Reasoning effort for supported models',
            },
          },
          required: ['reasoning_effort'],
        },
      });
      tools.push({
        name: 'switch_verbosity',
        description: 'Switch the response verbosity for subsequent messages in this session.',
        inputSchema: {
          type: 'object',
          properties: {
            verbosity: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'Response verbosity for supported models',
            },
          },
          required: ['verbosity'],
        },
      });
      tools.push({
        name: 'pause_session',
        description: 'Pause the current session so it can be resumed later, even after hours or days. Use when the user says they are stepping away and want to continue later.',
        inputSchema: { type: 'object', properties: {} },
      });
      tools.push({
        name: 'restart_gateway',
        description: 'Restart the CCBuddy gateway process. Use when the user asks to restart, reboot, or reload the gateway. The process will shut down gracefully and launchd will restart it automatically.',
        inputSchema: { type: 'object', properties: {} },
      });
    }

    // Dynamic tools — one per enabled registered skill
    for (const { definition } of registry.list()) {
      if (!definition.enabled) continue;
      tools.push({
        name: `skill_${definition.name}`,
        description: definition.description,
        inputSchema: definition.inputSchema as unknown as Record<string, unknown>,
      });
    }

    // Memory retrieval tools — exposed when --memory-db is provided
    if (retrievalTools) {
      for (const tool of retrievalTools.getToolDefinitions()) {
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        });
      }
    }

    // Profile tools — exposed when --memory-db is provided
    if (profileStore) {
      tools.push({
        name: 'profile_get',
        description: 'Get all profile entries for a user, or a single key. Profile data is automatically included in every conversation as <user_profile> context. Use this to store user preferences, facts about the user, briefing preferences, personality notes, and anything you learn about the user that should persist across conversations.',
        inputSchema: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'The user ID' },
            key: { type: 'string', description: 'Optional specific key to retrieve. Omit to get all entries.' },
          },
          required: ['userId'],
        },
      });
      tools.push({
        name: 'profile_set',
        description: 'Set a profile entry for a user. This data persists across conversations and is automatically included in context. Use descriptive keys like "name", "timezone", "briefing_preferences", "interests", "communication_style", etc.',
        inputSchema: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'The user ID' },
            key: { type: 'string', description: 'The profile key (e.g., "name", "timezone", "interests")' },
            value: { type: 'string', description: 'The value to store' },
          },
          required: ['userId', 'key', 'value'],
        },
      });
      tools.push({
        name: 'profile_delete',
        description: 'Delete a profile entry for a user.',
        inputSchema: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'The user ID' },
            key: { type: 'string', description: 'The profile key to delete' },
          },
          required: ['userId', 'key'],
        },
      });

      // Notification preference tools
      tools.push({
        name: 'notification_get',
        description: 'Get the current notification preferences for a user. Returns merged config defaults + user overrides.',
        inputSchema: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'The user ID' },
          },
          required: ['userId'],
        },
      });
      tools.push({
        name: 'notification_set',
        description: 'Update notification preferences for a user. Can toggle master switch, enable/disable specific types (health, memory, errors, sessions), change delivery target, or set quiet hours.',
        inputSchema: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'The user ID' },
            enabled: { type: 'boolean', description: 'Master notification switch' },
            type: { type: 'string', description: 'Notification type to configure (health, memory, errors, sessions)' },
            type_enabled: { type: 'boolean', description: 'Enable/disable the specified type (requires type)' },
            target_platform: { type: 'string', description: 'Delivery platform (e.g., discord)' },
            target_channel: { type: 'string', description: 'Delivery channel ID or "DM"' },
            quiet_start: { type: 'string', description: 'Quiet hours start (HH:MM)' },
            quiet_end: { type: 'string', description: 'Quiet hours end (HH:MM)' },
            quiet_timezone: { type: 'string', description: 'Quiet hours timezone' },
          },
          required: ['userId'],
        },
      });
      tools.push({
        name: 'notification_mute',
        description: 'Temporarily mute all notifications for a user for a specified number of minutes. Pass 0 to unmute.',
        inputSchema: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'The user ID' },
            minutes: { type: 'number', description: 'Minutes to mute (0 to unmute)' },
          },
          required: ['userId', 'minutes'],
        },
      });
    }

    if (workspaceStore && args.channelKey) {
      tools.push({
        name: 'set_workspace',
        description: 'Map the current channel to a working directory. Future messages in this channel will use that directory for CCBuddy agent work. The directory must exist.',
        inputSchema: {
          type: 'object',
          properties: {
            directory: { type: 'string', description: 'Absolute path to the project directory (~ is expanded to home dir)' },
          },
          required: ['directory'],
        },
      });
      tools.push({
        name: 'get_workspace',
        description: 'Show the working directory mapped to the current channel, or indicate if using the default.',
        inputSchema: { type: 'object', properties: {} },
      });
      tools.push({
        name: 'remove_workspace',
        description: 'Remove the workspace mapping for the current channel. Future messages will use the default working directory.',
        inputSchema: { type: 'object', properties: {} },
      });
    }

    // send_file tool — always available
    tools.push({
      name: 'send_file',
      description: 'Send a file to the user via their chat platform (Discord/Telegram). Copies the file to the outbound queue for delivery. Use this whenever you have a file on disk that you want to share with the user — images, documents, audio, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file to send' },
        },
        required: ['file_path'],
      },
    });

    // System health tool — exposed when --heartbeat-status-file is provided
    if (args.heartbeatStatusFile) {
      tools.push({
        name: 'system_health',
        description: 'Get the latest system health status from the heartbeat monitor. Returns module statuses (process, database, agent) and system metrics (cpu, memory, disk).',
        inputSchema: { type: 'object', properties: {} },
      });
    }

    // Calendar tools
    if (calendarService) {
      for (const tool of calendarService.getToolDefinitions()) {
        tools.push(tool);
      }
    }

    // Reminders tools
    if (remindersService) {
      for (const tool of remindersService.getToolDefinitions()) {
        tools.push(tool);
      }
    }

    // Shortcuts tools
    if (shortcutsService) {
      for (const tool of shortcutsService.getToolDefinitions()) {
        tools.push(tool);
      }
    }

    // Notes tools
    if (notesService) {
      for (const tool of notesService.getToolDefinitions()) {
        tools.push(tool);
      }
    }

    return { tools };
  });

  // 6. CallTool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const toolArgs = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
    // ── list_skills ───────────────────────────────────────────────────────
    if (name === 'list_skills') {
      const skills = registry.list().map(({ definition, metadata }) => ({
        name: definition.name,
        description: definition.description,
        version: definition.version,
        source: definition.source,
        permissions: definition.permissions,
        usageCount: metadata.usageCount,
        enabled: definition.enabled,
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify(skills) }],
      };
    }

    // ── create_skill ──────────────────────────────────────────────────────
    if (name === 'create_skill') {
      const skillName = toolArgs.name as string;
      const description = toolArgs.description as string;
      const code = toolArgs.code as string;
      const inputSchema = toolArgs.input_schema as {
        type: 'object';
        properties: Record<string, { type: string; description?: string }>;
        required?: string[];
      };
      const permissions = (toolArgs.permissions ?? []) as SkillPermission[];
      const approved = (toolArgs.approved ?? false) as boolean;

      // Check if elevated permissions require approval
      if (
        hasElevatedPermissions(permissions) &&
        args.requireApproval &&
        !approved
      ) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error:
                  'This skill requires elevated permissions (' +
                  permissions.join(', ') +
                  '). Please get user approval and retry with approved: true.',
              }),
            },
          ],
        };
      }

      const result = await generator.createSkill({
        name: skillName,
        description,
        code,
        inputSchema,
        permissions,
        createdBy: 'agent',
        createdByRole: 'system',
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    // ── promote_skill ────────────────────────────────────────────────────
    if (name === 'promote_skill') {
      const skillName = toolArgs.name as string;
      const result = await generator.promoteSkill(skillName);

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    // ── skill_<name> (dynamic) ────────────────────────────────────────────
    if (name.startsWith('skill_')) {
      const skillName = name.slice('skill_'.length);
      const skill = registry.get(skillName);

      if (!skill) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: `Skill "${skillName}" not found` }),
            },
          ],
        };
      }

      if (!skill.definition.enabled) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: `Skill "${skillName}" is disabled`,
              }),
            },
          ],
        };
      }

      // Record usage and persist
      registry.recordUsage(skillName);
      await registry.saveLocalState();

      // Run skill
      const output = await runner.run(skill.definition.filePath, toolArgs);

      // Strip media from the tool result to avoid sending huge base64 through MCP.
      // Skills that produce media write files to data/outbound/ and include filePath references.
      // The agent gets a clean text result; media delivery is handled out-of-band.
      const { media, ...cleanOutput } = output as unknown as Record<string, unknown>;
      if (media && Array.isArray(media) && media.length > 0) {
        (cleanOutput as Record<string, unknown>).mediaFiles = (media as Array<Record<string, unknown>>).map(
          (m) => ({ filePath: m.filePath, mimeType: m.mimeType, filename: m.filename }),
        );
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(cleanOutput) }],
      };
    }

    // ── memory_grep ───────────────────────────────────────────────────────
    if (retrievalTools && name === 'memory_grep') {
      const userId = (toolArgs.userId as string | undefined) || ownerUserId;
      const result = retrievalTools.grep(userId, toolArgs.query as string);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    // ── memory_get_briefs ─────────────────────────────────────────────────
    if (retrievalTools && name === 'memory_get_briefs') {
      const userId = (toolArgs.userId as string | undefined) || ownerUserId;
      const jobName = toolArgs.jobName as string | undefined;
      const limit = toolArgs.limit as number | undefined;
      const startMs = toolArgs.startMs as number | undefined;
      const endMs = toolArgs.endMs as number | undefined;
      const opts = (limit !== undefined || startMs !== undefined || endMs !== undefined)
        ? { limit, startMs, endMs }
        : undefined;
      const result = retrievalTools.getBriefs(userId, jobName, opts);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    // ── memory_describe ───────────────────────────────────────────────────
    if (retrievalTools && name === 'memory_describe') {
      const userId = (toolArgs.userId as string | undefined) || ownerUserId;
      const result = retrievalTools.describe(userId, {
        startMs: toolArgs.startMs as number,
        endMs: toolArgs.endMs as number,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    // ── memory_expand ─────────────────────────────────────────────────────
    if (retrievalTools && name === 'memory_expand') {
      const userId = (toolArgs.userId as string | undefined) || ownerUserId;
      const result = retrievalTools.expand(userId, toolArgs.nodeId as number);
      return { content: [{ type: 'text', text: JSON.stringify(result ?? { error: 'Node not found' }) }] };
    }

    // ── profile_get ─────────────────────────────────────────────────────
    if (profileStore && name === 'profile_get') {
      const userId = toolArgs.userId as string;
      const key = toolArgs.key as string | undefined;
      if (key) {
        const value = profileStore.get(userId, key);
        return { content: [{ type: 'text', text: JSON.stringify({ userId, key, value: value ?? null }) }] };
      }
      const all = profileStore.getAll(userId);
      return { content: [{ type: 'text', text: JSON.stringify({ userId, profile: all }) }] };
    }

    // ── profile_set ─────────────────────────────────────────────────────
    if (profileStore && name === 'profile_set') {
      const userId = toolArgs.userId as string;
      const key = toolArgs.key as string;
      const value = toolArgs.value as string;
      profileStore.set(userId, key, value);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, userId, key, value }) }] };
    }

    // ── profile_delete ──────────────────────────────────────────────────
    if (profileStore && name === 'profile_delete') {
      const userId = toolArgs.userId as string;
      const key = toolArgs.key as string;
      profileStore.delete(userId, key);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, userId, key, deleted: true }) }] };
    }

    // ── notification_get ───────────────────────────────────────────────
    if (profileStore && name === 'notification_get') {
      const userId = toolArgs.userId as string;
      const prefs: Record<string, string | undefined> = {
        notification_enabled: profileStore.get(userId, 'notification_enabled'),
        notification_types: profileStore.get(userId, 'notification_types'),
        notification_target: profileStore.get(userId, 'notification_target'),
        notification_quiet_hours: profileStore.get(userId, 'notification_quiet_hours'),
        notification_mute_until: profileStore.get(userId, 'notification_mute_until'),
      };
      const result = Object.fromEntries(Object.entries(prefs).filter(([, v]) => v !== undefined));
      return {
        content: [{
          type: 'text',
          text: Object.keys(result).length > 0
            ? JSON.stringify(result, null, 2)
            : 'No notification preferences set — using config defaults.',
        }],
      };
    }

    // ── notification_set ───────────────────────────────────────────────
    if (profileStore && name === 'notification_set') {
      const userId = toolArgs.userId as string;
      const changes: string[] = [];

      if (toolArgs.enabled !== undefined) {
        profileStore.set(userId, 'notification_enabled', String(toolArgs.enabled));
        changes.push(`enabled: ${toolArgs.enabled}`);
      }

      if (toolArgs.type && toolArgs.type_enabled !== undefined) {
        const existing = profileStore.get(userId, 'notification_types');
        let types: Record<string, boolean> = {};
        if (existing) try { types = JSON.parse(existing); } catch {}
        types[toolArgs.type as string] = toolArgs.type_enabled as boolean;
        profileStore.set(userId, 'notification_types', JSON.stringify(types));
        changes.push(`${toolArgs.type}: ${toolArgs.type_enabled}`);
      }

      if (toolArgs.target_platform || toolArgs.target_channel) {
        const target = {
          platform: (toolArgs.target_platform as string) ?? 'discord',
          channel: (toolArgs.target_channel as string) ?? 'DM',
        };
        profileStore.set(userId, 'notification_target', JSON.stringify(target));
        changes.push(`target: ${target.platform}/${target.channel}`);
      }

      if (toolArgs.quiet_start || toolArgs.quiet_end) {
        const quietHours = {
          start: (toolArgs.quiet_start as string) ?? '23:00',
          end: (toolArgs.quiet_end as string) ?? '07:00',
          timezone: (toolArgs.quiet_timezone as string) ?? 'America/Chicago',
        };
        profileStore.set(userId, 'notification_quiet_hours', JSON.stringify(quietHours));
        changes.push(`quiet hours: ${quietHours.start}-${quietHours.end} ${quietHours.timezone}`);
      }

      return {
        content: [{
          type: 'text',
          text: changes.length > 0
            ? `Notification preferences updated: ${changes.join(', ')}`
            : 'No changes specified.',
        }],
      };
    }

    // ── notification_mute ──────────────────────────────────────────────
    if (profileStore && name === 'notification_mute') {
      const userId = toolArgs.userId as string;
      const minutes = toolArgs.minutes as number;

      if (minutes <= 0) {
        profileStore.delete(userId, 'notification_mute_until');
        return { content: [{ type: 'text', text: 'Notifications unmuted.' }] };
      }

      const until = new Date(Date.now() + minutes * 60_000).toISOString();
      profileStore.set(userId, 'notification_mute_until', until);
      return {
        content: [{ type: 'text', text: `Notifications muted until ${until} (${minutes} minutes).` }],
      };
    }

    // ── send_file ───────────────────────────────────────────────────────
    if (name === 'send_file') {
      const filePath = toolArgs.file_path as string;

      // Restrict to the current working directory to prevent path traversal
      const cwd = process.cwd();
      const resolved = pathResolve(filePath);
      if (!resolved.startsWith(cwd + '/') && resolved !== cwd) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `File must be within the working directory (${cwd})` }) }] };
      }

      try {
        // Verify file exists
        readFileSync(resolved, { flag: 'r' });
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `File not found: ${filePath}` }) }] };
      }

      const outDir = process.env.CCBUDDY_OUTBOUND_DIR;
      if (!outDir) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ success: false, error: 'CCBUDDY_OUTBOUND_DIR is not set for this request' }),
          }],
        };
      }

      try { mkdirSync(outDir, { recursive: true }); } catch { /* exists */ }
      const ext = extname(resolved) || '.bin';
      const outFilename = `${basename(resolved, ext)}-${randomUUID().slice(0, 8)}${ext}`;
      const outPath = pathJoin(outDir, outFilename);
      copyFileSync(resolved, outPath);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `File queued for delivery: ${outFilename}` }) }] };
    }

    // ── system_health ─────────────────────────────────────────────────────
    if (name === 'system_health' && args.heartbeatStatusFile) {
      try {
        const raw = readFileSync(args.heartbeatStatusFile, 'utf8');
        const data = JSON.parse(raw);
        // Mark as stale if timestamp is >10 minutes old (2x default 5-min heartbeat interval)
        const STALE_THRESHOLD_MS = 10 * 60 * 1000;
        if (data.timestamp && Date.now() - data.timestamp > STALE_THRESHOLD_MS) {
          data.stale = true;
        }
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'no_data', message: 'Heartbeat status file not available' }) }] };
      }
    }

    // ── apple_calendar_list ────────────────────────────────────────────────
    if (calendarService && name === 'apple_calendar_list') {
      const result = await calendarService.listEvents(toolArgs.from as string, toolArgs.to as string);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, events: result }) }] };
    }

    // ── apple_calendar_search ──────────────────────────────────────────────
    if (calendarService && name === 'apple_calendar_search') {
      const result = await calendarService.searchEvents(
        toolArgs.query as string,
        toolArgs.from as string | undefined,
        toolArgs.to as string | undefined,
      );
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, events: result }) }] };
    }

    // ── apple_calendar_create ──────────────────────────────────────────────
    if (calendarService && name === 'apple_calendar_create') {
      const event = await calendarService.createEvent({
        title: toolArgs.title as string,
        start: toolArgs.start as string,
        end: toolArgs.end as string,
        calendar: toolArgs.calendar as string | undefined,
        location: toolArgs.location as string | undefined,
        notes: toolArgs.notes as string | undefined,
        allDay: toolArgs.allDay as boolean | undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, event }) }] };
    }

    // ── apple_calendar_update ──────────────────────────────────────────────
    if (calendarService && name === 'apple_calendar_update') {
      const event = await calendarService.updateEvent(toolArgs.id as string, {
        title: toolArgs.title as string | undefined,
        start: toolArgs.start as string | undefined,
        end: toolArgs.end as string | undefined,
        calendar: toolArgs.calendar as string | undefined,
        location: toolArgs.location as string | undefined,
        notes: toolArgs.notes as string | undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, event }) }] };
    }

    // ── apple_calendar_delete ──────────────────────────────────────────────
    if (calendarService && name === 'apple_calendar_delete') {
      await calendarService.deleteEvent(toolArgs.id as string);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
    }

    // ── apple_reminders_list ──────────────────────────────────────────────
    if (remindersService && name === 'apple_reminders_list') {
      const result = await remindersService.listReminders(
        toolArgs.list as string | undefined,
        toolArgs.showCompleted as boolean | undefined,
      );
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, reminders: result }) }] };
    }

    // ── apple_reminders_create ────────────────────────────────────────────
    if (remindersService && name === 'apple_reminders_create') {
      const reminder = await remindersService.createReminder({
        title: toolArgs.title as string,
        due: toolArgs.due as string | undefined,
        list: toolArgs.list as string | undefined,
        notes: toolArgs.notes as string | undefined,
        priority: toolArgs.priority as number | undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, reminder }) }] };
    }

    // ── apple_reminders_complete ──────────────────────────────────────────
    if (remindersService && name === 'apple_reminders_complete') {
      const reminder = await remindersService.completeReminder(toolArgs.id as string);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, reminder }) }] };
    }

    // ── apple_reminders_delete ────────────────────────────────────────────
    if (remindersService && name === 'apple_reminders_delete') {
      await remindersService.deleteReminder(toolArgs.id as string);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
    }

    // ── apple_reminders_create_list ───────────────────────────────────────
    if (remindersService && name === 'apple_reminders_create_list') {
      await remindersService.createList(toolArgs.name as string);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
    }

    // ── apple_shortcuts_list ───────────────────────────────────────────────
    if (shortcutsService && name === 'apple_shortcuts_list') {
      const shortcuts = await shortcutsService.listShortcuts();
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, shortcuts }) }] };
    }

    // ── apple_shortcuts_run ────────────────────────────────────────────────
    if (shortcutsService && name === 'apple_shortcuts_run') {
      const result = await shortcutsService.runShortcut(
        toolArgs.name as string,
        toolArgs.input as string | undefined,
      );
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }) }] };
    }

    // ── apple_notes_search ─────────────────────────────────────────────────
    if (notesService && name === 'apple_notes_search') {
      const notes = await notesService.searchNotes(toolArgs.query as string);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, notes }) }] };
    }

    // ── apple_notes_read ───────────────────────────────────────────────────
    if (notesService && name === 'apple_notes_read') {
      const note = await notesService.readNote(toolArgs.name as string);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, note }) }] };
    }

    // ── apple_notes_create ─────────────────────────────────────────────────
    if (notesService && name === 'apple_notes_create') {
      const note = await notesService.createNote({
        title: toolArgs.title as string,
        body: toolArgs.body as string | undefined,
        folder: toolArgs.folder as string | undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, note }) }] };
    }

    // ── apple_notes_update ─────────────────────────────────────────────────
    if (notesService && name === 'apple_notes_update') {
      const note = await notesService.updateNote({
        name: toolArgs.name as string,
        title: toolArgs.title as string | undefined,
        body: toolArgs.body as string | undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, note }) }] };
    }

    // ── apple_notes_delete ─────────────────────────────────────────────────
    if (notesService && name === 'apple_notes_delete') {
      await notesService.deleteNote(toolArgs.name as string);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
    }

    // ── set_workspace ──────────────────────────────────────────────────
    if (workspaceStore && name === 'set_workspace') {
      let dir = toolArgs.directory as string;
      if (dir.startsWith('~')) {
        dir = dir.replace(/^~/, process.env.HOME ?? '');
      }
      const { existsSync, statSync } = await import('node:fs');
      if (!existsSync(dir)) {
        return { content: [{ type: 'text', text: `Directory does not exist: ${dir}` }] };
      }
      try {
        if (!statSync(dir).isDirectory()) {
          return { content: [{ type: 'text', text: `Path is not a directory: ${dir}` }] };
        }
      } catch {
        return { content: [{ type: 'text', text: `Cannot access path: ${dir}` }] };
      }
      workspaceStore.set(args.channelKey, dir);
      return { content: [{ type: 'text', text: `Workspace set to ${dir} for this channel. Future messages will use this directory.` }] };
    }

    // ── get_workspace ──────────────────────────────────────────────────
    if (workspaceStore && name === 'get_workspace') {
      const dir = workspaceStore.get(args.channelKey);
      return {
        content: [{
          type: 'text',
          text: dir
            ? `This channel is mapped to: ${dir}`
            : 'No workspace mapped — using default working directory.',
        }],
      };
    }

    // ── remove_workspace ───────────────────────────────────────────────
    if (workspaceStore && name === 'remove_workspace') {
      workspaceStore.remove(args.channelKey);
      return { content: [{ type: 'text', text: 'Workspace mapping removed. This channel will use the default working directory.' }] };
    }

    // ── switch_model ──────────────────────────────────────────────────────
    switch (name) {
      case 'switch_model': {
        const { model } = toolArgs as { model: string };
        const runtimeModelLists = loadRuntimeModelLists(args.dataDir);
        if (!isValidModelForBackend(model, args.backend, runtimeModelLists)) {
          const available = getModelOptionsForBackend(args.backend, runtimeModelLists).join(', ');
          return { content: [{ type: 'text', text: `Invalid model "${model}" for ${args.backend} backend. Available: ${available}` }] };
        }
        if (sessionDb && args.sessionKey) {
          sessionDb.updateModel(args.sessionKey, model);
        }
        return { content: [{ type: 'text', text: `Model switched to ${model}. This takes effect on the next message.` }] };
      }
      case 'get_current_model': {
        if (sessionDb && args.sessionKey) {
          const row = sessionDb.getByKey(args.sessionKey);
          const model = row?.model ?? null;
          const reasoningEffort = row?.reasoning_effort ?? null;
          const verbosity = row?.verbosity ?? null;
          const lines = [
            model ? `Current model override: ${model}` : 'No model override — using config default.',
            reasoningEffort ? `Reasoning effort override: ${reasoningEffort}` : 'No reasoning effort override — using backend default.',
            verbosity ? `Verbosity override: ${verbosity}` : 'No verbosity override — using backend default.',
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        return { content: [{ type: 'text', text: 'No model override — using config default.' }] };
      }
      case 'switch_reasoning_effort': {
        const { reasoning_effort } = toolArgs as { reasoning_effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' };
        if (sessionDb && args.sessionKey) {
          sessionDb.updateReasoningEffort(args.sessionKey, reasoning_effort);
        }
        return { content: [{ type: 'text', text: `Reasoning effort switched to ${reasoning_effort}. This takes effect on the next message.` }] };
      }
      case 'switch_verbosity': {
        const { verbosity } = toolArgs as { verbosity: 'low' | 'medium' | 'high' };
        if (sessionDb && args.sessionKey) {
          sessionDb.updateVerbosity(args.sessionKey, verbosity);
        }
        return { content: [{ type: 'text', text: `Verbosity switched to ${verbosity}. This takes effect on the next message.` }] };
      }
      case 'pause_session': {
        if (sessionDb && args.sessionKey) {
          sessionDb.updateStatus(args.sessionKey, 'paused');
          return { content: [{ type: 'text', text: 'Session paused. It will be resumed when you send your next message, even after hours or days.' }] };
        }
        return { content: [{ type: 'text', text: 'Session pausing is not available (no session key).' }] };
      }
      case 'restart_gateway': {
        // Read PID from lockfile and send SIGUSR1 for graceful restart
        try {
          const pidFile = pathJoin(args.dataDir, 'ccbuddy.pid');
          const pidContent = readFileSync(pidFile, 'utf8').trim();
          const pid = parseGatewayPidLock(pidContent);
          if (pid === null) {
            return { content: [{ type: 'text', text: 'Failed to restart: invalid PID in lockfile.' }] };
          }

          const reportTarget = parseChannelKey(args.channelKey);
          if (!reportTarget) {
            return { content: [{ type: 'text', text: 'Failed to restart: invalid channel key.' }] };
          }

          const intentPath = pathJoin(args.dataDir, 'restart-intent.json');
          const intentTmpPath = `${intentPath}.tmp`;
          const restartIntent = {
            kind: 'requested_restart',
            requestedAt: new Date().toISOString(),
            reportTarget,
            sessionKey: args.sessionKey || undefined,
          };
          writeFileSync(intentTmpPath, JSON.stringify(restartIntent), 'utf8');
          renameSync(intentTmpPath, intentPath);

          process.kill(pid, 'SIGUSR1');
          return { content: [{ type: 'text', text: `Restart signal sent (PID ${pid}). The gateway will shut down gracefully and launchd will restart it.` }] };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: 'text', text: `Failed to restart: ${msg}` }] };
        }
      }
    }

    // ── Unknown tool ──────────────────────────────────────────────────────
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: false, error: `Unknown tool: ${name}` }),
        },
      ],
    };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: false, error: (err as Error).message }),
          },
        ],
      };
    }
  });

  // 7. Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal error in MCP skills server:', err);
  process.exit(1);
});
