import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

export function SessionsPage() {
  const [sessions, setSessions] = useState<any[]>([]);

  useEffect(() => { api.sessions().then(d => setSessions(d.sessions)); }, []);

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Sessions</h2>
      {sessions.length === 0 ? (
        <p className="text-gray-400">No active sessions</p>
      ) : (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-800/50">
              <tr>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Session Key</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Type</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Model</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Last Activity</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s: any) => (
                <tr key={s.sessionKey} className="border-t border-gray-800 hover:bg-gray-800/30">
                  <td className="px-4 py-3">
                    <Link to={`/sessions/${encodeURIComponent(s.sessionKey)}`} className="text-blue-400 hover:underline font-mono">{s.sessionKey}</Link>
                  </td>
                  <td className="px-4 py-3 text-gray-400">{s.isGroupChannel ? 'Group' : 'DM'}</td>
                  <td className="px-4 py-3">
                    {s.model ? (
                      <span className="text-xs px-2 py-0.5 rounded bg-blue-900 text-blue-300">{s.model}</span>
                    ) : (
                      <span className="text-gray-600">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400">{new Date(s.lastActivity).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
