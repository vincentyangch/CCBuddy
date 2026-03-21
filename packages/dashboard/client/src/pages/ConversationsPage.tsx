import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';

export function ConversationsPage() {
  const [messages, setMessages] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ user: '', platform: '', search: '' });
  const pageSize = 50;

  const load = useCallback(async () => {
    const params: Record<string, string> = { page: String(page), pageSize: String(pageSize) };
    if (filters.user) params.user = filters.user;
    if (filters.platform) params.platform = filters.platform;
    if (filters.search) params.search = filters.search;
    const data = await api.conversations(params);
    setMessages(data.messages);
    setTotal(data.total);
  }, [page, filters]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Conversations</h2>
      <div className="flex gap-3 mb-4">
        <input placeholder="Filter user" value={filters.user}
          onChange={e => { setFilters(f => ({ ...f, user: e.target.value })); setPage(1); }}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-40" />
        <input placeholder="Filter platform" value={filters.platform}
          onChange={e => { setFilters(f => ({ ...f, platform: e.target.value })); setPage(1); }}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-40" />
        <input placeholder="Search..." value={filters.search}
          onChange={e => { setFilters(f => ({ ...f, search: e.target.value })); setPage(1); }}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm flex-1" />
      </div>
      <div className="text-sm text-gray-400 mb-3">{total} messages</div>
      <div className="space-y-2">
        {messages.map((m: any) => (
          <div key={m.id} className="bg-gray-900 rounded-lg border border-gray-800 p-3">
            <div className="flex gap-4 text-xs text-gray-500 mb-2">
              <span>{m.role === 'user' ? '👤' : '🤖'} {m.userId}</span>
              <span>{m.platform}</span>
              <span>{new Date(m.timestamp).toLocaleString()}</span>
              <span className="font-mono">{m.sessionId}</span>
            </div>
            <div className="text-sm whitespace-pre-wrap line-clamp-3">{m.content}</div>
          </div>
        ))}
      </div>
      {totalPages > 1 && (
        <div className="flex gap-2 mt-4 justify-center">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
            className="px-3 py-1 bg-gray-800 rounded text-sm disabled:opacity-50">Prev</button>
          <span className="px-3 py-1 text-sm text-gray-400">{page} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
            className="px-3 py-1 bg-gray-800 rounded text-sm disabled:opacity-50">Next</button>
        </div>
      )}
    </div>
  );
}
