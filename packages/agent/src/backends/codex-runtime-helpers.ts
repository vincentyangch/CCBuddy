import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import type { AgentRequest, PermissionGateRule } from '@ccbuddy/core';

export type CodexConfigValue =
  | string
  | number
  | boolean
  | CodexConfigValue[]
  | { [key: string]: CodexConfigValue };

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

const DIRECT_FILE_RULES = new Map<string, string>([
  ['local-config', 'config/local.yaml'],
]);

const SENSITIVE_ENV_KEY_PATTERN = /(TOKEN|SECRET|PASSWORD|PASS|API_KEY|AUTH|CREDENTIAL|COOKIE|SESSION|JWT)/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTomlValue(value: CodexConfigValue, path: string): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Codex config override at ${path} must be a finite number`);
    }
    return `${value}`;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    const rendered = value.map((item, index) => toTomlValue(item, `${path}[${index}]`));
    return `[${rendered.join(', ')}]`;
  }
  if (isPlainObject(value)) {
    const parts: string[] = [];
    for (const [key, child] of Object.entries(value)) {
      parts.push(`${formatTomlKey(key)} = ${toTomlValue(child as CodexConfigValue, `${path}.${key}`)}`);
    }
    return `{${parts.join(', ')}}`;
  }
  throw new Error(`Unsupported Codex config override at ${path}`);
}

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

function formatTomlKey(key: string): string {
  return TOML_BARE_KEY.test(key) ? key : JSON.stringify(key);
}

function flattenConfigOverrides(
  value: CodexConfigValue,
  prefix: string,
  overrides: string[],
): void {
  if (!isPlainObject(value)) {
    if (!prefix) {
      throw new Error('Codex config overrides must be a plain object');
    }
    overrides.push(`${prefix}=${toTomlValue(value, prefix)}`);
    return;
  }

  const entries = Object.entries(value);
  if (!prefix && entries.length === 0) return;
  if (prefix && entries.length === 0) {
    overrides.push(`${prefix}={}`);
    return;
  }

  for (const [key, child] of entries) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) {
      flattenConfigOverrides(child as CodexConfigValue, path, overrides);
    } else {
      overrides.push(`${path}=${toTomlValue(child as CodexConfigValue, path)}`);
    }
  }
}

function extractLiteralProtectedPath(rule: PermissionGateRule): string | null {
  if (rule.tool !== '*' && rule.tool !== 'Write' && rule.tool !== 'Edit' && rule.tool !== 'Read') {
    return null;
  }

  const direct = DIRECT_FILE_RULES.get(rule.name);
  if (direct) return direct;

  if (/[()[\]{}+*?|^$]/.test(rule.pattern)) return null;
  if (rule.pattern.includes('\\s') || rule.pattern.includes('\\w') || rule.pattern.includes('\\d')) return null;

  const decoded = rule.pattern
    .replace(/\\\./g, '.')
    .replace(/\\\//g, '/')
    .replace(/\\\\/g, '\\');

  if (!/^[A-Za-z0-9._/\-]+$/.test(decoded)) return null;
  return decoded;
}

function resolveGuardPath(baseDir: string, filePath: string): string {
  return normalize(isAbsolute(filePath) ? filePath : resolve(baseDir, filePath));
}

export function serializeCodexConfigOverrides(configOverrides: CodexConfigOverrideObject): string[] {
  const overrides: string[] = [];
  flattenConfigOverrides(configOverrides, '', overrides);
  return overrides;
}

export function prepareCodexMcpServers(
  mcpServers: AgentRequest['mcpServers'],
): {
  config: Record<string, PreparedCodexMcpServer>;
  inheritedEnv: Record<string, string>;
} {
  const config: Record<string, PreparedCodexMcpServer> = {};
  const inheritedEnv: Record<string, string> = {};

  for (const server of mcpServers ?? []) {
    const inlineEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.env ?? {})) {
      if (SENSITIVE_ENV_KEY_PATTERN.test(key)) {
        inheritedEnv[key] = value;
      } else {
        inlineEnv[key] = value;
      }
    }

    config[server.name] = {
      type: 'stdio',
      command: server.command,
      args: server.args,
      ...(Object.keys(inlineEnv).length > 0 ? { env: inlineEnv } : {}),
    };
  }

  return { config, inheritedEnv };
}

export function snapshotProtectedFiles(
  workingDirectory: string | undefined,
  rules: PermissionGateRule[] | undefined,
): Map<string, ProtectedFileSnapshot> {
  const baseDir = resolve(workingDirectory ?? process.cwd());
  const snapshots = new Map<string, ProtectedFileSnapshot>();

  for (const rule of rules ?? []) {
    const relativePath = extractLiteralProtectedPath(rule);
    if (!relativePath) continue;

    const resolvedPath = resolveGuardPath(baseDir, relativePath);
    if (snapshots.has(resolvedPath)) continue;

    const existed = existsSync(resolvedPath);
    snapshots.set(resolvedPath, {
      relativePath: normalize(relativePath),
      resolvedPath,
      existed,
      content: existed ? readFileSync(resolvedPath) : undefined,
    });
  }

  return snapshots;
}

export function restoreProtectedFiles(
  workingDirectory: string | undefined,
  snapshots: Map<string, ProtectedFileSnapshot>,
  changedPaths: string[],
): string[] {
  const baseDir = resolve(workingDirectory ?? process.cwd());
  const restored = new Set<string>();

  for (const changePath of changedPaths) {
    const resolvedPath = resolveGuardPath(baseDir, changePath);
    const snapshot = snapshots.get(resolvedPath);
    if (!snapshot || restored.has(snapshot.relativePath)) continue;

    if (snapshot.existed && snapshot.content) {
      mkdirSync(dirname(snapshot.resolvedPath), { recursive: true });
      writeFileSync(snapshot.resolvedPath, snapshot.content);
    } else {
      try { unlinkSync(snapshot.resolvedPath); } catch { /* ignore */ }
    }

    restored.add(snapshot.relativePath);
  }

  return [...restored];
}

export function restoreModifiedProtectedFiles(
  snapshots: Map<string, ProtectedFileSnapshot>,
): string[] {
  const restored = new Set<string>();

  for (const snapshot of snapshots.values()) {
    const existsNow = existsSync(snapshot.resolvedPath);
    const contentNow = existsNow ? readFileSync(snapshot.resolvedPath) : undefined;
    const contentChanged = snapshot.existed && existsNow
      ? !(snapshot.content?.equals(contentNow ?? Buffer.alloc(0)) ?? false)
      : false;
    const wasModified = snapshot.existed !== existsNow || contentChanged;

    if (!wasModified) continue;

    if (snapshot.existed && snapshot.content) {
      mkdirSync(dirname(snapshot.resolvedPath), { recursive: true });
      writeFileSync(snapshot.resolvedPath, snapshot.content);
    } else {
      try { unlinkSync(snapshot.resolvedPath); } catch { /* ignore */ }
    }
    restored.add(snapshot.relativePath);
  }

  return [...restored];
}
