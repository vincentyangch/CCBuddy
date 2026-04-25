const getToken = () => localStorage.getItem('dashboard_token') ?? '';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Authorization': `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (res.status === 401) {
    localStorage.removeItem('dashboard_token');
    window.location.reload();
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

type SettingsResponse = { config: any };
type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
type ServiceTier = 'flex' | 'fast';
type Verbosity = 'low' | 'medium' | 'high';
export type SchedulerJobStatus = 'registered' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface SchedulerJobState {
  jobName: string;
  type: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  targetPlatform: string | null;
  targetChannel: string | null;
  lastStatus: SchedulerJobStatus | null;
  lastSessionId: string | null;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
  nextExpectedAt: number | null;
  updatedAt: number;
}

export const api = {
  auth: (token: string) =>
    fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }).then(r => r.ok),

  status: () => request<any>('/api/status'),
  schedulerJobs: () => request<{ jobs: SchedulerJobState[] }>('/api/scheduler/jobs'),
  runSchedulerJob: (jobName: string) =>
    request<{ ok: boolean; result: { jobName: string; accepted: boolean } }>(
      `/api/scheduler/jobs/${encodeURIComponent(jobName)}/run`,
      { method: 'POST' },
    ),
  sessions: (status?: string) => {
    const params = status ? `?status=${status}` : '';
    return request<{ sessions: any[] }>(`/api/sessions${params}`);
  },
  deleteSession: (key: string) =>
    fetch(`/api/sessions/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getToken()}` },
    }).then(r => r.json()),
  setSessionSettings: (
    key: string,
    payload: { model?: string | null; reasoning_effort?: ReasoningEffort | null; service_tier?: ServiceTier | null; verbosity?: Verbosity | null },
  ) =>
    request<{ ok: boolean; session_key: string; model: string | null; reasoning_effort: ReasoningEffort | null; service_tier: ServiceTier | null; verbosity: Verbosity | null }>(
      `/api/sessions/${encodeURIComponent(key)}/settings`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    ),
  sessionEvents: (key: string) => request<{ events: any[] }>(`/api/sessions/${encodeURIComponent(key)}/events`),
  conversations: (params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString();
    return request<any>(`/api/conversations?${qs}`);
  },
  logs: (params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString();
    return request<{ lines: string[]; file: string }>(`/api/logs?${qs}`);
  },
  getLocalSettings: () => request<SettingsResponse>('/api/settings/local'),
  updateLocalSettings: (config: any) =>
    request<{ ok: boolean }>('/api/settings/local', {
      method: 'PUT',
      body: JSON.stringify({ config }),
    }),
  getEffectiveSettings: () => request<SettingsResponse>('/api/settings/effective'),
  getSettingsMeta: () => request<{ sources: Record<string, string> }>('/api/settings/meta'),
  deleteConversation: (sessionId: string) =>
    fetch(`/api/conversations/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getToken()}` },
    }).then(r => r.json()),
  getModel: () => request<{
    model: string;
    source: string;
    backend: string;
    reasoning_effort: ReasoningEffort | null;
    reasoning_effort_source: string;
    service_tier: ServiceTier | null;
    service_tier_source: string;
    verbosity: Verbosity | null;
    verbosity_source: string;
    reasoning_effort_options: ReasoningEffort[];
    service_tier_options: ServiceTier[];
    verbosity_options: Verbosity[];
  }>('/api/config/model'),
  setModel: (payload: { model?: string | null; reasoning_effort?: ReasoningEffort | null; service_tier?: ServiceTier | null; verbosity?: Verbosity | null }) =>
    request<{ ok: boolean; model: string; reasoning_effort: ReasoningEffort | null; service_tier: ServiceTier | null; verbosity: Verbosity | null }>('/api/config/model', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  getBackend: () => request<{ backend: string; models: string[]; claude_models: string[]; codex_models: string[] }>('/api/config/backend'),
  setBackend: (backend: string) =>
    request<{ ok: boolean; backend: string; model: string; models: string[] }>('/api/config/backend', {
      method: 'PUT',
      body: JSON.stringify({ backend }),
    }),
  setModels: (lists: { claude_models?: string[]; codex_models?: string[] }) =>
    request<{ ok: boolean; claude_models: string[]; codex_models: string[] }>('/api/config/models', {
      method: 'PUT',
      body: JSON.stringify(lists),
    }),
};
