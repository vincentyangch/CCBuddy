import type { MessageTarget } from '../types/events.js';

export interface PermissionGateRule {
  name: string;
  pattern: string;
  tool: string;
  description: string;
}

export interface PermissionGateConfig {
  enabled: boolean;
  timeout_ms: number;
  rules: PermissionGateRule[];
}

export interface AgentConfig {
  backend: 'sdk' | 'cli';
  model: string;
  max_concurrent_sessions: number;
  session_timeout_minutes: number;
  queue_max_depth: number;
  queue_timeout_seconds: number;
  rate_limits: {
    admin: number;
    chat: number;
    system: number;
  };
  default_working_directory: string;
  admin_skip_permissions: boolean;
  session_cleanup_hours: number;
  pending_input_timeout_minutes: number;
  graceful_shutdown_timeout_seconds: number;
  session_timeout_ms: number;
  user_input_timeout_ms: number;
  max_pause_ms: number;
  permission_gates: PermissionGateConfig;
}

export interface MemoryConfig {
  db_path: string;
  max_context_tokens: number;
  context_threshold: number;
  fresh_tail_count: number;
  leaf_chunk_tokens: number;
  leaf_target_tokens: number;
  condensed_target_tokens: number;
  max_expand_tokens: number;
  consolidation_cron: string;
  backup_cron: string;
  backup_dir: string;
  max_backups: number;
  message_retention_days: number;
}

export type ActivationMode = 'all' | 'mention';

export interface ChannelActivationConfig {
  mode: ActivationMode;
}

export interface PlatformAdapterConfig {
  enabled?: boolean;
  token?: string;
  channels?: Record<string, ChannelActivationConfig>;
}

export interface PlatformConfig {
  discord?: PlatformAdapterConfig;
  telegram?: PlatformAdapterConfig;
  [key: string]: PlatformAdapterConfig | undefined;
}

export interface HeartbeatConfig {
  interval_seconds: number;
  alert_target?: MessageTarget;
  daily_report_cron?: string;
  checks: {
    process: boolean;
    database: boolean;
    agent: boolean;
  };
}

export interface WebhookEndpointConfig {
  path: string;
  secret_env?: string;
  signature_header?: string;
  signature_algorithm?: string;
  prompt_template: string;
  max_payload_chars?: number;
  user: string;
  target?: MessageTarget;
  enabled?: boolean;
}

export interface WebhooksConfig {
  enabled: boolean;
  port: number;
  endpoints?: Record<string, WebhookEndpointConfig>;
}

export interface MediaConfig {
  max_file_size_mb: number;
  allowed_mime_types: string[];
  voice_enabled: boolean;
  tts_max_chars: number;
}

export interface ImageGenerationConfig {
  enabled: boolean;
  provider?: string;
  model?: string;
}

export interface SkillsConfig {
  generated_dir: string;
  sandbox_enabled: boolean;
  require_admin_approval_for_elevated: boolean;
  auto_git_commit: boolean;
  mcp_server_path?: string;
}

export interface AppleConfig {
  enabled: boolean;
  helper_path?: string;
  shortcuts_enabled?: boolean;
}

export interface ScheduledJobConfig {
  cron: string;
  prompt?: string;
  skill?: string;
  user: string;
  target?: MessageTarget;
  enabled?: boolean;
  permission_level?: 'admin' | 'system';
  timezone?: string;
  model?: string;
}

export interface SchedulerConfig {
  timezone: string;
  default_target?: MessageTarget;
  jobs?: Record<string, ScheduledJobConfig>;
}

export interface UserConfig {
  name: string;
  role: 'admin' | 'chat';
  [key: string]: string | undefined;
}

export interface GatewayConfig {
  unknown_user_reply: boolean;
}

export interface DashboardConfig {
  enabled: boolean;
  port: number;
  host: string;
  auth_token_env: string;
}

export interface NotificationConfig {
  enabled: boolean;
  default_target: {
    platform: string;
    channel: string;
  };
  quiet_hours: {
    start: string;
    end: string;
    timezone: string;
  };
  types: {
    health: boolean;
    memory: boolean;
    errors: boolean;
    sessions: boolean;
  };
}

export interface CCBuddyConfig {
  data_dir: string;
  log_level: 'debug' | 'info' | 'warn' | 'error';
  agent: AgentConfig;
  memory: MemoryConfig;
  gateway: GatewayConfig;
  platforms: PlatformConfig;
  scheduler: SchedulerConfig;
  heartbeat: HeartbeatConfig;
  webhooks: WebhooksConfig;
  media: MediaConfig;
  image_generation: ImageGenerationConfig;
  skills: SkillsConfig;
  apple: AppleConfig;
  dashboard: DashboardConfig;
  notifications: NotificationConfig;
  users: Record<string, UserConfig>;
}

export const DEFAULT_CONFIG: CCBuddyConfig = {
  data_dir: './data',
  log_level: 'info',
  agent: {
    backend: 'sdk',
    model: 'sonnet',
    max_concurrent_sessions: 3,
    session_timeout_minutes: 30,
    queue_max_depth: 10,
    queue_timeout_seconds: 120,
    rate_limits: {
      admin: 30,
      chat: 10,
      system: 20,
    },
    default_working_directory: '~',
    admin_skip_permissions: true,
    session_cleanup_hours: 24,
    pending_input_timeout_minutes: 10,
    graceful_shutdown_timeout_seconds: 30,
    session_timeout_ms: 3_600_000, // 1 hour
    user_input_timeout_ms: 300_000, // 5 minutes
    max_pause_ms: 604_800_000, // 7 days
    permission_gates: {
      enabled: true,
      timeout_ms: 300_000,
      rules: [
        { name: 'destructive-rm', pattern: 'rm\\s+-(r|rf|fr)\\s+(?!/tmp)', tool: 'Bash', description: 'Recursive delete on non-temp paths' },
        { name: 'destructive-git', pattern: 'git\\s+(reset\\s+--hard|checkout\\s+\\.|clean\\s+-f)', tool: 'Bash', description: 'Destructive git operations' },
        { name: 'local-config', pattern: 'config/local\\.yaml', tool: '*', description: 'Modify local config (contains secrets)' },
        { name: 'launchctl', pattern: 'launchctl', tool: 'Bash', description: 'LaunchAgent operations' },
        { name: 'npm-publish', pattern: 'npm\\s+publish', tool: 'Bash', description: 'Package publishing' },
      ],
    },
  },
  memory: {
    db_path: './data/memory.sqlite',
    max_context_tokens: 100000,
    context_threshold: 0.75,
    fresh_tail_count: 32,
    leaf_chunk_tokens: 20000,
    leaf_target_tokens: 1200,
    condensed_target_tokens: 2000,
    max_expand_tokens: 4000,
    consolidation_cron: '0 3 * * *',
    backup_cron: '0 4 * * *',
    backup_dir: './data/backups',
    max_backups: 7,
    message_retention_days: 30,
  },
  gateway: {
    unknown_user_reply: true,
  },
  platforms: {},
  scheduler: {
    timezone: 'UTC',
  },
  heartbeat: {
    interval_seconds: 60,
    checks: {
      process: true,
      database: true,
      agent: true,
    },
  },
  webhooks: {
    enabled: false,
    port: 18800,
  },
  media: {
    max_file_size_mb: 10,
    allowed_mime_types: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'],
    voice_enabled: false,
    tts_max_chars: 500,
  },
  image_generation: {
    enabled: false,
  },
  skills: {
    generated_dir: './skills/generated',
    sandbox_enabled: true,
    require_admin_approval_for_elevated: true,
    auto_git_commit: true,
  },
  apple: {
    enabled: false,
  },
  dashboard: {
    enabled: false,
    port: 18801,
    host: '127.0.0.1',
    auth_token_env: 'CCBUDDY_DASHBOARD_TOKEN',
  },
  notifications: {
    enabled: true,
    default_target: {
      platform: 'discord',
      channel: 'DM',
    },
    quiet_hours: {
      start: '23:00',
      end: '07:00',
      timezone: 'America/Chicago',
    },
    types: {
      health: true,
      memory: true,
      errors: true,
      sessions: true,
    },
  },
  users: {},
};
