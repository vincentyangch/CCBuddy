import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-500',
  paused: 'bg-yellow-500',
  archived: 'bg-gray-500',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
};

const FILTERS = ['all', 'active', 'paused', 'archived'] as const;

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

  const load = () => {
    const status = filter === 'all' ? undefined : filter;
    api.sessions(status).then(d => setSessions(d.sessions));
  };

  useEffect(() => { load(); }, [filter]);

  const handleDelete = async (key: string) => {
    if (!confirm(`Delete runtime session "${key}"? This cannot be undone.`)) return;
    setDeleting(key);
    await api.deleteSession(key);
    load();
    setDeleting(null);
  };

  return (
    <div>
      <div className="mb-6">
        <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Operations</div>
        <h2 className="mt-1 text-2xl font-bold">Runtime Sessions</h2>
        <p className="mt-1 text-sm text-gray-500">Agent runtime records for status, model use, cleanup, and event replay.</p>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-4">
        {FILTERS.map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded text-sm ${
              filter === f
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {sessions.length === 0 ? (
        <p className="text-gray-400">No runtime sessions found</p>
      ) : (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-800/50">
              <tr>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Status</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Runtime Key</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Type</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Model</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Last Activity</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">History</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s: any) => {
                const status = s.status ?? 'active';
                const key = s.session_key ?? s.sessionKey;
                return (
                  <tr key={key} className="border-t border-gray-800 hover:bg-gray-800/30">
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${STATUS_COLORS[status] ?? 'bg-gray-500'}`} />
                        <span className="text-xs text-gray-400">{STATUS_LABELS[status] ?? status}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to={`/sessions/${encodeURIComponent(key)}`}
                        className="text-blue-400 hover:underline font-mono"
                      >
                        {key}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-gray-400">
                      {s.is_group_channel ?? s.isGroupChannel ? 'Group' : 'DM'}
                    </td>
                    <td className="px-4 py-3">
                      {s.model ? (
                        <span className="text-xs px-2 py-0.5 rounded bg-blue-900 text-blue-300">{s.model}</span>
                      ) : (
                        <span className="text-gray-600">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-400">
                      {new Date(s.last_activity ?? s.lastActivity).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to={`/conversations?sessionId=${encodeURIComponent(historyConversationId(s, key))}`}
                        className="text-xs text-blue-400 hover:underline"
                      >
                        History
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleDelete(key)}
                        disabled={deleting === key}
                        className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
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
    </div>
  );
}
