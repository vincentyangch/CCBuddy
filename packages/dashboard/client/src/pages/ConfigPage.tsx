import { useEffect, useState } from 'react';
import { api } from '../lib/api';

const TABS = ['General', 'Agent', 'Users', 'Platforms', 'Scheduler', 'Memory', 'Media', 'Skills', 'Webhooks', 'Apple', 'Dashboard'] as const;
const TAB_KEYS: Record<string, string> = {
  General: '_root', Agent: 'agent', Users: 'users', Platforms: 'platforms',
  Scheduler: 'scheduler', Memory: 'memory', Media: 'media', Skills: 'skills',
  Webhooks: 'webhooks', Apple: 'apple', Dashboard: 'dashboard',
};

function ConfigField({ label, value, onChange, type = 'text' }: {
  label: string; value: any; onChange: (v: any) => void; type?: string;
}) {
  if (typeof value === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm py-1">
        <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)}
          className="rounded bg-gray-800 border-gray-600" />
        {label}
      </label>
    );
  }
  return (
    <div className="flex items-center gap-3 py-1">
      <label className="text-sm text-gray-400 w-48 shrink-0">{label}</label>
      <input type={type} value={String(value ?? '')} onChange={e => {
        const v = type === 'number' ? Number(e.target.value) : e.target.value;
        onChange(v);
      }} className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm" />
    </div>
  );
}

function renderFields(obj: Record<string, any>, path: string[], onChange: (path: string[], value: any) => void): React.ReactNode[] {
  return Object.entries(obj).map(([key, value]) => {
    const fullPath = [...path, key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return (
        <div key={key} className="ml-4 mb-3">
          <div className="text-sm font-medium text-gray-300 mb-1">{key}</div>
          {renderFields(value, fullPath, onChange)}
        </div>
      );
    }
    const type = typeof value === 'number' ? 'number' : 'text';
    return <ConfigField key={key} label={key} value={value} type={type}
      onChange={v => onChange(fullPath, v)} />;
  });
}

export function ConfigPage() {
  const [config, setConfig] = useState<any>(null);
  const [tab, setTab] = useState<string>('General');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>('');

  useEffect(() => { api.config().then(d => setConfig(d.config)); }, []);

  const handleChange = (path: string[], value: any) => {
    setConfig((prev: any) => {
      const next = JSON.parse(JSON.stringify(prev));
      let obj = next;
      for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]];
      obj[path[path.length - 1]] = value;
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setStatus('');
    try {
      await api.updateConfig(config);
      setStatus('Saved successfully');
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
    setSaving(false);
  };

  if (!config) return <p className="text-gray-400">Loading...</p>;

  const tabKey = TAB_KEYS[tab];
  const section = tabKey === '_root'
    ? { data_dir: config.data_dir, log_level: config.log_level }
    : config[tabKey] ?? {};

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Config</h2>
        <div className="flex items-center gap-3">
          {status && <span className={`text-sm ${status.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>{status}</span>}
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium disabled:opacity-50">
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
      <div className="flex gap-1 mb-6 flex-wrap">
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-lg text-sm ${tab === t ? 'bg-blue-600' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
            {t}
          </button>
        ))}
      </div>
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
        {renderFields(section, tabKey === '_root' ? [] : [tabKey], handleChange)}
      </div>
    </div>
  );
}
