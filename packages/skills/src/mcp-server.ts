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
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join as pathJoin, basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { SkillRegistry } from './registry.js';
import { SkillGenerator } from './generator.js';
import { SkillValidator } from './validator.js';
import { SkillRunner } from './runner.js';
import type { SkillPermission } from './types.js';
import { MemoryDatabase, MessageStore, SummaryStore, RetrievalTools, ProfileStore, SessionDatabase } from '@ccbuddy/memory';
import { SwiftBridge, AppleCalendarService, AppleRemindersService, AppleShortcutsService, JxaBridge, AppleNotesService } from '@ccbuddy/apple';
import { isValidModel } from '@ccbuddy/core';

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

  return { registryPath, skillsDir, requireApproval, autoGitCommit, memoryDbPath, heartbeatStatusFile, appleHelperPath, sessionKey, dataDir };
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
  if (args.memoryDbPath) {
    memoryDatabase = new MemoryDatabase(args.memoryDbPath, { readonly: true });
    const messageStore = new MessageStore(memoryDatabase);
    const summaryStore = new SummaryStore(memoryDatabase);
    retrievalTools = new RetrievalTools(messageStore, summaryStore);

    // Writable connection for profile updates (WAL mode supports concurrent writers)
    profileDatabase = new MemoryDatabase(args.memoryDbPath);
    profileStore = new ProfileStore(profileDatabase);
    sessionDb = new SessionDatabase(profileDatabase.raw());

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
        'Create a new skill. Provide name, description, code (JS/TS with export default async function), input_schema, and optional permissions/approved flag.',
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

    if (args.sessionKey) {
      tools.push({
        name: 'switch_model',
        description: 'Switch the AI model for subsequent messages in this session. Use when the current task needs more capability (e.g., opus[1m] for complex work) or to switch back to the default for simpler tasks.',
        inputSchema: {
          type: 'object',
          properties: {
            model: {
              type: 'string',
              description: 'Model alias (sonnet, opus, haiku, opus[1m], sonnet[1m], opusplan) or full model ID (e.g., claude-opus-4-6)',
            },
          },
          required: ['model'],
        },
      });
      tools.push({
        name: 'get_current_model',
        description: 'Get the model currently configured for this session.',
        inputSchema: { type: 'object', properties: {} },
      });
      tools.push({
        name: 'pause_session',
        description: 'Pause the current session so it can be resumed later, even after hours or days. Use when the user says they are stepping away and want to continue later.',
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
      await registry.save();

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
      const result = retrievalTools.grep(toolArgs.userId as string, toolArgs.query as string);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    // ── memory_describe ───────────────────────────────────────────────────
    if (retrievalTools && name === 'memory_describe') {
      const result = retrievalTools.describe(toolArgs.userId as string, {
        startMs: toolArgs.startMs as number,
        endMs: toolArgs.endMs as number,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    // ── memory_expand ─────────────────────────────────────────────────────
    if (retrievalTools && name === 'memory_expand') {
      const result = retrievalTools.expand(toolArgs.userId as string, toolArgs.nodeId as number);
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

    // ── send_file ───────────────────────────────────────────────────────
    if (name === 'send_file') {
      const filePath = toolArgs.file_path as string;
      try {
        // Verify file exists
        readFileSync(filePath, { flag: 'r' });
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `File not found: ${filePath}` }) }] };
      }
      const outDir = pathJoin(process.cwd(), 'data', 'outbound');
      try { mkdirSync(outDir, { recursive: true }); } catch { /* exists */ }
      const ext = extname(filePath) || '.bin';
      const outFilename = `${basename(filePath, ext)}-${randomUUID().slice(0, 8)}${ext}`;
      const outPath = pathJoin(outDir, outFilename);
      copyFileSync(filePath, outPath);
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

    // ── switch_model ──────────────────────────────────────────────────────
    switch (name) {
      case 'switch_model': {
        const { model } = toolArgs as { model: string };
        if (!isValidModel(model)) {
          return { content: [{ type: 'text', text: `Invalid model: "${model}". Use an alias (sonnet, opus, haiku, opus[1m], sonnet[1m], opusplan) or a full model ID (e.g., claude-opus-4-6).` }] };
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
          return { content: [{ type: 'text', text: model ? `Current model override: ${model}` : 'No model override — using config default.' }] };
        }
        return { content: [{ type: 'text', text: 'No model override — using config default.' }] };
      }
      case 'pause_session': {
        if (sessionDb && args.sessionKey) {
          sessionDb.updateStatus(args.sessionKey, 'paused');
          return { content: [{ type: 'text', text: 'Session paused. It will be resumed when you send your next message, even after hours or days.' }] };
        }
        return { content: [{ type: 'text', text: 'Session pausing is not available (no session key).' }] };
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
