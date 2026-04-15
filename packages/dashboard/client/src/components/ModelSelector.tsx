import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel, StatusPill } from './ui';

export function ModelSelector() {
  const [model, setModel] = useState<string>('');
  const [source, setSource] = useState<string>('');
  const [backend, setBackend] = useState<string>('');
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    Promise.all([api.getModel(), api.getBackend()]).then(([modelData, backendData]) => {
      setModel(modelData.model);
      setSource(modelData.source);
      setBackend(backendData.backend);
      setModelOptions(backendData.models);
    });
  }, []);

  const handleChange = async (newModel: string) => {
    setSaving(true);
    setStatus('');
    try {
      await api.setModel(newModel);
      setModel(newModel);
      setSource('runtime_override');
      setStatus('Applied');
      setTimeout(() => setStatus(''), 2000);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
    setSaving(false);
  };

  return (
    <Panel className="p-4">
      <div className="mb-3">
        <label htmlFor="runtime-model-select" className="text-sm font-medium text-[color:var(--sd-text)]">Runtime model</label>
        <div className="mt-1 text-xs text-[color:var(--sd-muted)]">Applies immediately and overrides the local default.</div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <select
          id="runtime-model-select"
          value={model}
          onChange={e => handleChange(e.target.value)}
          disabled={saving || modelOptions.length === 0}
          className="sd-input min-w-48 flex-1 text-sm"
        >
          {modelOptions.map(m => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        {backend && (
          <StatusPill tone={backend.startsWith('codex') ? 'info' : 'neutral'}>
            {backend}
          </StatusPill>
        )}
        <StatusPill tone={source === 'runtime_override' ? 'warning' : 'neutral'}>
          {source === 'runtime_override' ? 'runtime override' : 'config default'}
        </StatusPill>
        {status && (
          <span
            role="status"
            aria-live="polite"
            className={`text-xs ${status.startsWith('Error') ? 'text-[color:var(--sd-danger)]' : 'text-[color:var(--sd-success)]'}`}
          >
            {status}
          </span>
        )}
      </div>
    </Panel>
  );
}
