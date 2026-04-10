import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_CONFIG } from '@ccbuddy/core';

export type SettingsSource = 'local' | 'env' | 'default' | 'effective_only' | 'runtime_override';

type PrimitiveShape = 'string' | 'number' | 'boolean';
type ShapeNode =
  | PrimitiveShape
  | {
      [key: string]: ShapeNode | boolean | undefined;
      $dynamic?: ShapeNode;
      $arrayOf?: ShapeNode;
      $allowAdditionalStringKeys?: boolean;
    };

const SETTINGS_SHAPE: ShapeNode = {
  data_dir: 'string',
  log_level: 'string',
  agent: {
    backend: 'string',
    model: 'string',
    max_concurrent_sessions: 'number',
    session_timeout_minutes: 'number',
    queue_max_depth: 'number',
    queue_timeout_seconds: 'number',
    rate_limits: {
      admin: 'number',
      trusted: 'number',
      chat: 'number',
      system: 'number',
    },
    default_working_directory: 'string',
    admin_skip_permissions: 'boolean',
    session_cleanup_hours: 'number',
    pending_input_timeout_minutes: 'number',
    graceful_shutdown_timeout_seconds: 'number',
    session_timeout_ms: 'number',
    user_input_timeout_ms: 'number',
    max_pause_ms: 'number',
    trusted_allowed_tools: {
      $arrayOf: 'string',
    },
    max_turns: 'number',
    compaction_threshold: 'number',
    compaction_summary_tokens: 'number',
    permission_gates: {
      enabled: 'boolean',
      timeout_ms: 'number',
      rules: {
        $arrayOf: {
          name: 'string',
          pattern: 'string',
          tool: 'string',
          description: 'string',
        },
      },
    },
  },
  memory: {
    db_path: 'string',
    max_context_tokens: 'number',
    context_threshold: 'number',
    fresh_tail_count: 'number',
    leaf_chunk_tokens: 'number',
    leaf_target_tokens: 'number',
    condensed_target_tokens: 'number',
    max_expand_tokens: 'number',
    consolidation_cron: 'string',
    backup_cron: 'string',
    backup_dir: 'string',
    max_backups: 'number',
    message_retention_days: 'number',
  },
  gateway: {
    unknown_user_reply: 'boolean',
  },
  platforms: {
    $dynamic: {
      enabled: 'boolean',
      token: 'string',
      channels: {
        $dynamic: {
          mode: 'string',
        },
      },
    },
  },
  scheduler: {
    timezone: 'string',
    default_target: {
      platform: 'string',
      channel: 'string',
    },
    jobs: {
      $dynamic: {
        cron: 'string',
        prompt: 'string',
        skill: 'string',
        user: 'string',
        target: {
          platform: 'string',
          channel: 'string',
        },
        enabled: 'boolean',
        permission_level: 'string',
        timezone: 'string',
        model: 'string',
        silent: 'boolean',
        catchup_window_minutes: 'number',
      },
    },
  },
  heartbeat: {
    interval_seconds: 'number',
    alert_target: {
      platform: 'string',
      channel: 'string',
    },
    daily_report_cron: 'string',
    checks: {
      process: 'boolean',
      database: 'boolean',
      agent: 'boolean',
    },
  },
  webhooks: {
    enabled: 'boolean',
    port: 'number',
    endpoints: {
      $dynamic: {
        path: 'string',
        secret_env: 'string',
        signature_header: 'string',
        signature_algorithm: 'string',
        prompt_template: 'string',
        max_payload_chars: 'number',
        user: 'string',
        target: {
          platform: 'string',
          channel: 'string',
        },
        enabled: 'boolean',
      },
    },
  },
  media: {
    max_file_size_mb: 'number',
    allowed_mime_types: {
      $arrayOf: 'string',
    },
    voice_enabled: 'boolean',
    tts_max_chars: 'number',
  },
  image_generation: {
    enabled: 'boolean',
    provider: 'string',
    model: 'string',
  },
  skills: {
    generated_dir: 'string',
    sandbox_enabled: 'boolean',
    require_admin_approval_for_elevated: 'boolean',
    auto_git_commit: 'boolean',
    mcp_server_path: 'string',
  },
  apple: {
    enabled: 'boolean',
    helper_path: 'string',
    shortcuts_enabled: 'boolean',
  },
  dashboard: {
    enabled: 'boolean',
    port: 'number',
    host: 'string',
    auth_token_env: 'string',
  },
  notifications: {
    enabled: 'boolean',
    default_target: {
      platform: 'string',
      channel: 'string',
    },
    quiet_hours: {
      start: 'string',
      end: 'string',
      timezone: 'string',
    },
    types: {
      health: 'boolean',
      memory: 'boolean',
      errors: 'boolean',
      sessions: 'boolean',
    },
  },
  users: {
    $dynamic: {
      name: 'string',
      role: 'string',
      $allowAdditionalStringKeys: true,
    },
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnvPlaceholder(value: unknown): value is string {
  return typeof value === 'string' && /^\$\{[^}]+\}$/.test(value);
}

function walkLeaves(
  value: unknown,
  path: string[],
  visit: (path: string, value: unknown) => void,
): void {
  if (!isPlainObject(value)) {
    if (path.length > 0) {
      visit(path.join('.'), value);
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    walkLeaves(child, [...path, key], visit);
  }
}

function getValueAtPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (!isPlainObject(current) || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

export function buildSettingsSourceMap(
  localConfig: Record<string, unknown>,
  effectiveConfig: Record<string, unknown>,
  runtimeModel: string | null = null,
): { sources: Record<string, SettingsSource> } {
  const sources: Record<string, SettingsSource> = {};
  const localLeaves = new Map<string, unknown>();

  walkLeaves(localConfig, [], (path, value) => {
    localLeaves.set(path, value);
  });

  if (runtimeModel) {
    sources['agent.model'] = 'runtime_override';
  }

  walkLeaves(effectiveConfig, [], (path, value) => {
    if (sources[path] === 'runtime_override') {
      return;
    }

    if (localLeaves.has(path)) {
      sources[path] = isEnvPlaceholder(localLeaves.get(path)) ? 'env' : 'local';
      return;
    }

    const defaultValue = getValueAtPath(DEFAULT_CONFIG, path);
    if (isDeepStrictEqual(value, defaultValue)) {
      sources[path] = 'default';
      return;
    }

    sources[path] = 'effective_only';
  });

  return { sources };
}

function validatePrimitive(value: unknown, shape: PrimitiveShape): boolean {
  switch (shape) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
  }
}

function validateAgainstShape(value: unknown, shape: ShapeNode, path: string[]): string | null {
  if (typeof shape === 'string') {
    if (isEnvPlaceholder(value) && shape === 'string') {
      return null;
    }
    return validatePrimitive(value, shape)
      ? null
      : `${path.join('.')} must be a ${shape}`;
  }

  if (shape.$arrayOf) {
    if (!Array.isArray(value)) {
      return `${path.join('.')} must be an array`;
    }
    for (const [index, item] of value.entries()) {
      const itemError = validateAgainstShape(item, shape.$arrayOf, [...path, String(index)]);
      if (itemError) return itemError;
    }
    return null;
  }

  if (!isPlainObject(value)) {
    return `${path.join('.')} must be an object`;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];

    if (shape.$dynamic) {
      const dynamicError = validateAgainstShape(child, shape.$dynamic, childPath);
      if (dynamicError) return dynamicError;
      continue;
    }

    if (key in shape) {
      const nextShape = shape[key] as ShapeNode | undefined;
      if (!nextShape || typeof nextShape === 'boolean') {
        return `Unsupported validation shape for ${childPath.join('.')}`;
      }
      const childError = validateAgainstShape(child, nextShape, childPath);
      if (childError) return childError;
      continue;
    }

    if (shape.$allowAdditionalStringKeys && typeof child === 'string') {
      continue;
    }

    return `Unknown config key: ${childPath.join('.')}`;
  }

  return null;
}

export function validateLocalSettingsConfig(config: Record<string, unknown>): string | null {
  return validateAgainstShape(config, SETTINGS_SHAPE, ['config']);
}
