import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel, StatusPill } from './ui';

export function ModelSelector() {
  const [model, setModel] = useState<string>('');
  const [source, setSource] = useState<string>('');
  const [backend, setBackend] = useState<string>('');
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [reasoningEffort, setReasoningEffort] = useState<string>('');
  const [reasoningEffortSource, setReasoningEffortSource] = useState<string>('');
  const [verbosity, setVerbosity] = useState<string>('');
  const [verbositySource, setVerbositySource] = useState<string>('');
  const [reasoningEffortOptions, setReasoningEffortOptions] = useState<string[]>([]);
  const [verbosityOptions, setVerbosityOptions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>('');

  const reloadState = () => {
    return Promise.all([api.getModel(), api.getBackend()]).then(([modelData, backendData]) => {
      setModel(modelData.model);
      setSource(modelData.source);
      setBackend(backendData.backend);
      setModelOptions(backendData.models);
      setReasoningEffort(modelData.reasoning_effort ?? '');
      setReasoningEffortSource(modelData.reasoning_effort_source);
      setVerbosity(modelData.verbosity ?? '');
      setVerbositySource(modelData.verbosity_source);
      setReasoningEffortOptions(modelData.reasoning_effort_options);
      setVerbosityOptions(modelData.verbosity_options);
    });
  };

  useEffect(() => {
    void reloadState();
  }, []);

  const handleChange = async (newModel: string) => {
    setSaving(true);
    setStatus('');
    try {
      await api.setModel({ model: newModel });
      await reloadState();
      setStatus('Applied');
      setTimeout(() => setStatus(''), 2000);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
    setSaving(false);
  };

  const handleReasoningEffortChange = async (newValue: string) => {
    setSaving(true);
    setStatus('');
    try {
      await api.setModel({ reasoning_effort: newValue || null });
      await reloadState();
      setStatus('Applied');
      setTimeout(() => setStatus(''), 2000);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
    setSaving(false);
  };

  const handleVerbosityChange = async (newValue: string) => {
    setSaving(true);
    setStatus('');
    try {
      await api.setModel({ verbosity: newValue || null });
      await reloadState();
      setStatus('Applied');
      setTimeout(() => setStatus(''), 2000);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
    setSaving(false);
  };

  const isCodex = backend.startsWith('codex');

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
      {isCodex && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <label htmlFor="runtime-reasoning-effort-select" className="text-sm font-medium text-[color:var(--sd-text)]">Reasoning effort</label>
              <StatusPill tone={reasoningEffortSource === 'runtime_override' ? 'warning' : 'neutral'}>
                {reasoningEffortSource === 'runtime_override' ? 'runtime override' : 'backend default'}
              </StatusPill>
            </div>
            <select
              id="runtime-reasoning-effort-select"
              value={reasoningEffort}
              onChange={e => handleReasoningEffortChange(e.target.value)}
              disabled={saving}
              className="sd-input w-full text-sm"
            >
              <option value="">Backend default</option>
              {reasoningEffortOptions.map(option => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <label htmlFor="runtime-verbosity-select" className="text-sm font-medium text-[color:var(--sd-text)]">Verbosity</label>
              <StatusPill tone={verbositySource === 'runtime_override' ? 'warning' : 'neutral'}>
                {verbositySource === 'runtime_override' ? 'runtime override' : 'backend default'}
              </StatusPill>
            </div>
            <select
              id="runtime-verbosity-select"
              value={verbosity}
              onChange={e => handleVerbosityChange(e.target.value)}
              disabled={saving}
              className="sd-input w-full text-sm"
            >
              <option value="">Backend default</option>
              {verbosityOptions.map(option => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>
        </div>
      )}
    </Panel>
  );
}
