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

export const api = {
  auth: (token: string) =>
    fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }).then(r => r.ok),

  status: () => request<any>('/api/status'),
  sessions: (status?: string) => {
    const params = status ? `?status=${status}` : '';
    return request<{ sessions: any[] }>(`/api/sessions${params}`);
  },
  deleteSession: (key: string) =>
    fetch(`/api/sessions/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getToken()}` },
    }).then(r => r.json()),
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
  getModel: () => request<{ model: string; source: string; backend: string }>('/api/config/model'),
  setModel: (model: string) =>
    request<{ ok: boolean; model: string }>('/api/config/model', {
      method: 'PUT',
      body: JSON.stringify({ model }),
    }),
  getBackend: () => request<{ backend: string; models: string[] }>('/api/config/backend'),
};
