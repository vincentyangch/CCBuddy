import { useEffect, useState } from 'react';
import { api } from '../lib/api';

const MODEL_OPTIONS = ['sonnet', 'opus', 'haiku', 'opus[1m]', 'sonnet[1m]', 'opusplan'];

export function ModelSelector() {
  const [model, setModel] = useState<string>('');
  const [source, setSource] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    api.getModel().then(d => {
      setModel(d.model);
      setSource(d.source);
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
    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
      <div className="mb-3">
        <div className="text-sm font-medium text-gray-200">Runtime model</div>
        <div className="mt-1 text-xs text-gray-500">Applies immediately and overrides the local default.</div>
      </div>
      <div className="flex items-center gap-3">
        <select
          value={model}
          onChange={e => handleChange(e.target.value)}
          disabled={saving}
          className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white disabled:opacity-50"
        >
          {MODEL_OPTIONS.map(m => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <span className={`text-xs px-2 py-1 rounded ${source === 'runtime_override' ? 'bg-yellow-900 text-yellow-300' : 'bg-gray-800 text-gray-500'}`}>
          {source === 'runtime_override' ? 'runtime override' : 'config default'}
        </span>
        {status && (
          <span className={`text-xs ${status.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>{status}</span>
        )}
      </div>
    </div>
  );
}
