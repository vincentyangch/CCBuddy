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

export const api = {
  auth: (token: string) =>
    fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }).then(r => r.ok),

  status: () => request<any>('/api/status'),
  sessions: () => request<{ sessions: any[] }>('/api/sessions'),
  sessionEvents: (key: string) => request<{ events: any[] }>(`/api/sessions/${encodeURIComponent(key)}/events`),
  conversations: (params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString();
    return request<any>(`/api/conversations?${qs}`);
  },
  logs: (params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString();
    return request<{ lines: string[]; file: string }>(`/api/logs?${qs}`);
  },
  config: () => request<{ config: any }>('/api/config'),
  updateConfig: (config: any) =>
    request<{ ok: boolean }>('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ config }),
    }),
  deleteConversation: (sessionId: string) =>
    fetch(`/api/conversations/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getToken()}` },
    }).then(r => r.json()),
  getModel: () => request<{ model: string; source: string }>('/api/config/model'),
  setModel: (model: string) =>
    request<{ ok: boolean; model: string }>('/api/config/model', {
      method: 'PUT',
      body: JSON.stringify({ model }),
    }),
};
