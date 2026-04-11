import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { PageHeader, Panel } from '../components/ui';

export function ConversationsPage() {
  const [messages, setMessages] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [searchParams] = useSearchParams();
  const sessionIdQuery = searchParams.get('sessionId') ?? '';
  const [filters, setFilters] = useState(() => ({
    user: '',
    platform: '',
    search: '',
    conversationId: sessionIdQuery,
  }));
  const pageSize = 50;
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const load = useCallback(async (p: number, f: typeof filters) => {
    const params: Record<string, string> = { page: String(p), pageSize: String(pageSize) };
    if (f.user) params.user = f.user;
    if (f.platform) params.platform = f.platform;
    if (f.search) params.search = f.search;
    if (f.conversationId) params.sessionId = f.conversationId;
    const data = await api.conversations(params);
    setMessages(data.messages);
    setTotal(data.total);
  }, []);

  useEffect(() => {
    setFilters(f => f.conversationId === sessionIdQuery ? f : { ...f, conversationId: sessionIdQuery });
    setPage(1);
  }, [sessionIdQuery]);

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
      <PageHeader
        domain="Workspace"
        title="History"
        description="Stored message history across users, platforms, and conversation IDs."
      />
      <div className="mb-4 flex flex-wrap gap-3">
        <input placeholder="Filter user" value={filters.user}
          onChange={e => updateFilter('user', e.target.value)}
          className="sd-input w-40 text-sm" />
        <input placeholder="Filter platform" value={filters.platform}
          onChange={e => updateFilter('platform', e.target.value)}
          className="sd-input w-40 text-sm" />
        <input placeholder="Conversation ID" value={filters.conversationId}
          onChange={e => updateFilter('conversationId', e.target.value)}
          className="sd-input w-56 text-sm" />
        <input placeholder="Search..." value={filters.search}
          onChange={e => updateFilter('search', e.target.value)}
          className="sd-input min-w-48 flex-1 text-sm" />
      </div>
      <div className="mb-3 text-sm text-[color:var(--sd-muted)]">{total} messages</div>
      <div className="space-y-2">
        {messages.map((m: any) => (
          <Panel key={m.id} className="p-3">
            <div className="mb-2 flex flex-wrap gap-4 text-xs text-[color:var(--sd-muted)]">
              <span>{m.role === 'user' ? '👤' : '🤖'} {m.userId}</span>
              <span>{m.platform}</span>
              <span>{new Date(m.timestamp).toLocaleString()}</span>
              <span className="font-mono">Conversation {m.sessionId}</span>
            </div>
            <div className="text-sm whitespace-pre-wrap line-clamp-3">{m.content}</div>
          </Panel>
        ))}
      </div>
      {totalPages > 1 && (
        <div className="flex gap-2 mt-4 justify-center">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
            className="sd-button-secondary min-h-0 px-3 py-1 text-sm">Prev</button>
          <span className="px-3 py-1 text-sm text-[color:var(--sd-muted)]">{page} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
            className="sd-button-secondary min-h-0 px-3 py-1 text-sm">Next</button>
        </div>
      )}
    </div>
  );
}
