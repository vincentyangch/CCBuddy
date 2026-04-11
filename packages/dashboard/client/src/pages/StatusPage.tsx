import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { PageHeader, Panel, StatusPill } from '../components/ui';

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
  const tone = value > 80 ? 'danger' : value > 60 ? 'warning' : 'info';
  const color = tone === 'danger'
    ? 'var(--sd-danger)'
    : tone === 'warning'
      ? 'var(--sd-warning)'
      : 'var(--sd-info)';

  return (
    <Panel className="p-4">
      <div className="mb-2 text-sm text-[color:var(--sd-muted)]">{label}</div>
      <div className="mb-2 text-3xl font-bold">{Math.round(value)}%</div>
      <div className="h-2 w-full overflow-hidden rounded-[var(--sd-radius)] bg-[color:var(--sd-border)]">
        <div className="h-full rounded-[var(--sd-radius)] transition-all" style={{ width: `${Math.min(value, 100)}%`, background: color }} />
      </div>
    </Panel>
  );
}

function moduleTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'healthy') return 'success';
  if (status === 'degraded') return 'warning';
  if (status === 'down') return 'danger';
  return 'neutral';
}

export function StatusPage() {
  const [data, setData] = useState<StatusData | null>(null);

  useEffect(() => { api.status().then(setData); }, []);

  useWebSocket(useCallback((type: string, payload: any) => {
    if (type === 'heartbeat.status') {
      setData(prev => prev ? { ...prev, heartbeat: payload } : prev);
    }
  }, []));

  if (!data) return <p className="text-[color:var(--sd-muted)]">Loading...</p>;

  const sys = data.heartbeat.system;
  const mods = data.heartbeat.modules ?? {};
  const upH = Math.floor(data.uptime / 3600);
  const upM = Math.floor((data.uptime % 3600) / 60);

  return (
    <div>
      <PageHeader
        domain="Operations"
        title="System Status"
        description="Runtime health, queue depth, active runtime sessions, and uptime."
      />
      {sys && (
        <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Gauge label="CPU" value={sys.cpuPercent} />
          <Gauge label="Memory" value={sys.memoryPercent} />
          <Gauge label="Disk" value={sys.diskPercent} />
        </div>
      )}
      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel className="p-4">
          <div className="mb-3 text-sm text-[color:var(--sd-muted)]">Modules</div>
          <div className="space-y-2">
            {Object.entries(mods).map(([name, status]) => (
              <div key={name} className="flex items-center gap-2 text-sm">
                <span className="capitalize">{name}</span>
                <span className="ml-auto">
                  <StatusPill tone={moduleTone(status)}>{status}</StatusPill>
                </span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel className="p-4">
          <div className="mb-3 text-sm text-[color:var(--sd-muted)]">Overview</div>
          <div className="space-y-1 text-sm">
            <div>Runtime Sessions: <span className="font-medium text-[color:var(--sd-text)]">{data.sessions.length}</span></div>
            <div>Queue Depth: <span className="font-medium text-[color:var(--sd-text)]">{data.queueSize}</span></div>
            <div>Uptime: <span className="font-medium text-[color:var(--sd-text)]">{upH}h {upM}m</span></div>
          </div>
          <Link to="/sessions" className="mt-3 inline-block text-sm text-[color:var(--sd-accent)] hover:underline">
            Open runtime sessions
          </Link>
        </Panel>
      </div>
    </div>
  );
}
