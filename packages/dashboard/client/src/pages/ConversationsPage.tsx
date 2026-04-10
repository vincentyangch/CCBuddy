import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../lib/api';

export function ConversationsPage() {
  const [messages, setMessages] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ user: '', platform: '', search: '' });
  const pageSize = 50;
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const load = useCallback(async (p: number, f: typeof filters) => {
    const params: Record<string, string> = { page: String(p), pageSize: String(pageSize) };
    if (f.user) params.user = f.user;
    if (f.platform) params.platform = f.platform;
    if (f.search) params.search = f.search;
    const data = await api.conversations(params);
    setMessages(data.messages);
    setTotal(data.total);
  }, []);

  // Debounce filter changes by 400ms, but load immediately on page change
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => load(page, filters), 400);
    return () => clearTimeout(debounceRef.current);
  }, [page, filters, load]);

  const updateFilter = (key: string, value: string) => {
    setFilters(f => ({ ...f, [key]: value }));
    setPage(1);
  };

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div>
      <div className="mb-6">
        <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Workspace</div>
        <h2 className="mt-1 text-2xl font-bold">History</h2>
        <p className="mt-1 text-sm text-gray-500">Stored message history across users, platforms, and sessions.</p>
      </div>
      <div className="flex gap-3 mb-4">
        <input placeholder="Filter user" value={filters.user}
          onChange={e => updateFilter('user', e.target.value)}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-40" />
        <input placeholder="Filter platform" value={filters.platform}
          onChange={e => updateFilter('platform', e.target.value)}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-40" />
        <input placeholder="Search..." value={filters.search}
          onChange={e => updateFilter('search', e.target.value)}
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
