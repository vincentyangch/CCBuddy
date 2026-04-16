import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { PageHeader, Panel, StatusPill } from '../components/ui';

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
};

const FILTERS = ['all', 'active', 'paused', 'archived'] as const;

function statusTone(status: string): 'success' | 'warning' | 'neutral' {
  if (status === 'active') return 'success';
  if (status === 'paused') return 'warning';
  return 'neutral';
}

function historyConversationId(session: any, runtimeKey: string): string {
  const isGroup = session.is_group_channel ?? session.isGroupChannel;
  const userId = session.user_id ?? session.userId;
  const platform = session.platform;
  const channelId = session.channel_id ?? session.channelId;

  if (isGroup && userId && platform && channelId) {
    return `${String(userId).toLowerCase()}-${String(platform).toLowerCase()}-${String(channelId).toLowerCase()}`;
  }

  return runtimeKey;
}

export function SessionsPage() {
  const [sessions, setSessions] = useState<any[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [backend, setBackend] = useState<string>('');

  const load = () => {
    const status = filter === 'all' ? undefined : filter;
    api.sessions(status).then(d => setSessions(d.sessions));
  };

  useEffect(() => { load(); }, [filter]);
  useEffect(() => { api.getBackend().then(d => setBackend(d.backend)); }, []);

  const handleDelete = async (key: string) => {
    if (!confirm(`Delete runtime session "${key}"? This cannot be undone.`)) return;
    setDeleting(key);
    await api.deleteSession(key);
    load();
    setDeleting(null);
  };

  return (
    <div>
      <PageHeader
        domain="Operations"
        title="Runtime Sessions"
        description={`Agent runtime records for status, model use, cleanup, and event replay.${backend ? ` Backend: ${backend}` : ''}`}
      />

      <Panel className="overflow-hidden">
        <div className="flex flex-wrap gap-2 border-b border-[color:var(--sd-border)] p-4">
          {FILTERS.map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-[var(--sd-radius)] px-3 py-1 text-sm ${
                filter === f
                  ? 'sd-button bg-[color:var(--sd-accent)] text-[color:var(--sd-accent-ink)]'
                  : 'sd-button-secondary'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        {sessions.length === 0 ? (
          <p className="p-4 text-sm text-[color:var(--sd-muted)]">No runtime sessions found</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[color:var(--sd-panel-raised)]">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-[color:var(--sd-muted)]">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-[color:var(--sd-muted)]">Runtime Key</th>
                  <th className="px-4 py-3 text-left font-medium text-[color:var(--sd-muted)]">Type</th>
                  <th className="px-4 py-3 text-left font-medium text-[color:var(--sd-muted)]">Model</th>
                  <th className="px-4 py-3 text-left font-medium text-[color:var(--sd-muted)]">Last Activity</th>
                  <th className="px-4 py-3 text-left font-medium text-[color:var(--sd-muted)]">History</th>
                  <th className="px-4 py-3 text-left font-medium text-[color:var(--sd-muted)]"></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s: any) => {
                  const status = s.status ?? 'active';
                  const key = s.session_key ?? s.sessionKey;
                  return (
                    <tr key={key} className="border-t border-[color:var(--sd-border)] hover:bg-[color:var(--sd-panel-raised)]">
                      <td className="px-4 py-3">
                        <StatusPill tone={statusTone(status)}>{STATUS_LABELS[status] ?? status}</StatusPill>
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          to={`/sessions/${encodeURIComponent(key)}`}
                          className="font-mono text-[color:var(--sd-accent)] hover:underline"
                        >
                          {key}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-[color:var(--sd-muted)]">
                        {s.is_group_channel ?? s.isGroupChannel ? 'Group' : 'DM'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {s.model ? (
                            <span className="rounded-[var(--sd-radius)] border border-[color:var(--sd-border)] bg-[color:var(--sd-panel-raised)] px-2 py-0.5 text-xs text-[color:var(--sd-info)]">{s.model}</span>
                          ) : (
                            <span className="text-[color:var(--sd-subtle)]">-</span>
                          )}
                          {(s.reasoning_effort ?? s.reasoningEffort) && (
                            <span className="rounded-[var(--sd-radius)] border border-[color:var(--sd-border)] bg-[color:var(--sd-panel-raised)] px-2 py-0.5 text-xs text-[color:var(--sd-warning)]">
                              reasoning: {s.reasoning_effort ?? s.reasoningEffort}
                            </span>
                          )}
                          {s.verbosity && (
                            <span className="rounded-[var(--sd-radius)] border border-[color:var(--sd-border)] bg-[color:var(--sd-panel-raised)] px-2 py-0.5 text-xs text-[color:var(--sd-success)]">
                              verbosity: {s.verbosity}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-[color:var(--sd-muted)]">
                        {new Date(s.last_activity ?? s.lastActivity).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          to={`/conversations?sessionId=${encodeURIComponent(historyConversationId(s, key))}`}
                          className="text-xs text-[color:var(--sd-accent)] hover:underline"
                        >
                          History
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => handleDelete(key)}
                          disabled={deleting === key}
                          className="text-xs text-[color:var(--sd-danger)] hover:underline disabled:opacity-50"
                        >
                          {deleting === key ? '...' : 'Delete'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
