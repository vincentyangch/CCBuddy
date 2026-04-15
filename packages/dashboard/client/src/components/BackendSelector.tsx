import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel, StatusPill } from './ui';

const BACKEND_OPTIONS = [
  { value: 'sdk', label: 'Claude SDK', provider: 'Anthropic' },
  { value: 'cli', label: 'Claude CLI', provider: 'Anthropic' },
  { value: 'codex-sdk', label: 'Codex SDK', provider: 'OpenAI' },
  { value: 'codex-cli', label: 'Codex CLI', provider: 'OpenAI' },
];

export function BackendSelector() {
  const [backend, setBackend] = useState<string>('');
  const [switching, setSwitching] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    api.getBackend().then(d => setBackend(d.backend));
  }, []);

  const handleChange = async (newBackend: string) => {
    if (newBackend === backend) return;
    if (!confirm(`Switch backend to ${newBackend}? The model will be auto-reset for the new provider.`)) return;

    setSwitching(true);
    setStatus('');
    try {
      const result = await api.setBackend(newBackend);
      setBackend(result.backend);
      setStatus(`Switched — model set to ${result.model}`);
      setTimeout(() => setStatus(''), 3000);
      // Reload page so ModelSelector and ModelListEditor pick up new state
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
    setSwitching(false);
  };

  const current = BACKEND_OPTIONS.find(o => o.value === backend);

  return (
    <Panel className="p-4">
      <div className="mb-3">
        <label htmlFor="backend-select" className="text-sm font-medium text-[color:var(--sd-text)]">Agent backend</label>
        <div className="mt-1 text-xs text-[color:var(--sd-muted)]">Switch between Claude and Codex at runtime. Model auto-resets on switch.</div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <select
          id="backend-select"
          value={backend}
          onChange={e => handleChange(e.target.value)}
          disabled={switching || !backend}
          className="sd-input min-w-48 flex-1 text-sm"
        >
          {BACKEND_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {current && (
          <StatusPill tone={current.provider === 'OpenAI' ? 'info' : 'neutral'}>
            {current.provider}
          </StatusPill>
        )}
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
