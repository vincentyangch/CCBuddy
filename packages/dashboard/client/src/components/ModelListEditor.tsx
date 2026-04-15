import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel, StatusPill } from './ui';

export function ModelListEditor() {
  const [backend, setBackend] = useState<string>('');
  const [claudeModels, setClaudeModels] = useState<string[]>([]);
  const [codexModels, setCodexModels] = useState<string[]>([]);
  const [newModel, setNewModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    api.getBackend().then(d => {
      setBackend(d.backend);
      setClaudeModels(d.claude_models);
      setCodexModels(d.codex_models);
    });
  }, []);

  const isCodex = backend.startsWith('codex');
  const activeList = isCodex ? codexModels : claudeModels;
  const setActiveList = isCodex ? setCodexModels : setClaudeModels;
  const listKey = isCodex ? 'codex_models' : 'claude_models';

  const save = async (updated: string[]) => {
    setSaving(true);
    setStatus('');
    try {
      const result = await api.setModels({ [listKey]: updated });
      setClaudeModels(result.claude_models);
      setCodexModels(result.codex_models);
      setStatus('Saved');
      setTimeout(() => setStatus(''), 2000);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
    setSaving(false);
  };

  const handleAdd = () => {
    const trimmed = newModel.trim();
    if (!trimmed || activeList.includes(trimmed)) return;
    const updated = [...activeList, trimmed];
    setActiveList(updated);
    setNewModel('');
    save(updated);
  };

  const handleRemove = (model: string) => {
    const updated = activeList.filter(m => m !== model);
    setActiveList(updated);
    save(updated);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <Panel className="p-4">
      <div className="mb-3">
        <label className="text-sm font-medium text-[color:var(--sd-text)]">
          {isCodex ? 'Codex' : 'Claude'} model list
        </label>
        <div className="mt-1 text-xs text-[color:var(--sd-muted)]">
          Models available in the runtime selector for the active backend.
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        {activeList.map(model => (
          <span
            key={model}
            className="inline-flex items-center gap-1.5 rounded-[var(--sd-radius)] border border-[color:var(--sd-border)] bg-[color:var(--sd-panel-raised)] px-2.5 py-1 text-xs text-[color:var(--sd-text)]"
          >
            {model}
            <button
              onClick={() => handleRemove(model)}
              disabled={saving}
              className="ml-0.5 text-[color:var(--sd-muted)] hover:text-[color:var(--sd-danger)]"
              aria-label={`Remove ${model}`}
            >
              x
            </button>
          </span>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newModel}
          onChange={e => setNewModel(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add model..."
          disabled={saving}
          className="sd-input flex-1 text-sm"
        />
        <button
          onClick={handleAdd}
          disabled={saving || !newModel.trim()}
          className="sd-btn sd-btn-primary text-sm"
        >
          Add
        </button>
      </div>

      {status && (
        <div className="mt-2">
          <StatusPill tone={status.startsWith('Error') ? 'danger' : 'success'}>
            {status}
          </StatusPill>
        </div>
      )}
    </Panel>
  );
}
