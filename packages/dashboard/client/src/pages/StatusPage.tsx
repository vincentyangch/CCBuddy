import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';

interface StatusData {
  heartbeat: {
    modules?: Record<string, string>;
    system?: { cpuPercent: number; memoryPercent: number; diskPercent: number };
  };
  sessions: any[];
  queueSize: number;
  uptime: number;
}

function Gauge({ label, value }: { label: string; value: number }) {
  const color = value > 80 ? 'bg-red-500' : value > 60 ? 'bg-yellow-500' : 'bg-blue-500';
  return (
    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
      <div className="text-sm text-gray-400 mb-2">{label}</div>
      <div className="text-2xl font-bold mb-2">{Math.round(value)}%</div>
      <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = { healthy: 'bg-green-500', degraded: 'bg-yellow-500', down: 'bg-red-500' };
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${colors[status] ?? 'bg-gray-500'} mr-2`} />;
}

export function StatusPage() {
  const [data, setData] = useState<StatusData | null>(null);

  useEffect(() => { api.status().then(setData); }, []);

  useWebSocket(useCallback((type: string, payload: any) => {
    if (type === 'heartbeat.status') {
      setData(prev => prev ? { ...prev, heartbeat: payload } : prev);
    }
  }, []));

  if (!data) return <p className="text-gray-400">Loading...</p>;

  const sys = data.heartbeat.system;
  const mods = data.heartbeat.modules ?? {};
  const upH = Math.floor(data.uptime / 3600);
  const upM = Math.floor((data.uptime % 3600) / 60);

  return (
    <div>
      <div className="mb-6">
        <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Operations</div>
        <h2 className="mt-1 text-2xl font-bold">System Status</h2>
        <p className="mt-1 text-sm text-gray-500">Runtime health, queue depth, active runtime sessions, and uptime.</p>
      </div>
      {sys && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <Gauge label="CPU" value={sys.cpuPercent} />
          <Gauge label="Memory" value={sys.memoryPercent} />
          <Gauge label="Disk" value={sys.diskPercent} />
        </div>
      )}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
          <div className="text-sm text-gray-400 mb-3">Modules</div>
          {Object.entries(mods).map(([name, status]) => (
            <div key={name} className="flex items-center mb-1 text-sm">
              <StatusBadge status={status} />
              <span className="capitalize">{name}</span>
              <span className="ml-auto text-gray-500">{status}</span>
            </div>
          ))}
        </div>
        <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
          <div className="text-sm text-gray-400 mb-3">Overview</div>
          <div className="text-sm mb-1">Runtime Sessions: <span className="text-white font-medium">{data.sessions.length}</span></div>
          <div className="text-sm mb-1">Queue Depth: <span className="text-white font-medium">{data.queueSize}</span></div>
          <div className="text-sm">Uptime: <span className="text-white font-medium">{upH}h {upM}m</span></div>
        </div>
      </div>
      {data.sessions.length > 0 && (
        <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
          <div className="text-sm text-gray-400 mb-3">Active Runtime Sessions</div>
          {data.sessions.map((s: any) => (
            <div key={s.sessionKey} className="text-sm mb-1 flex justify-between">
              <span className="font-mono">{s.sessionKey}</span>
              <span className="text-gray-500">{new Date(s.lastActivity).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
