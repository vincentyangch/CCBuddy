import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export function PermissionGatesToggle() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');

  useEffect(() => {
    Promise.all([
      api.getLocalSettings(),
      api.getEffectiveSettings(),
    ]).then(([, effective]) => {
      setEnabled(!effective.config.agent?.admin_skip_permissions);
      setLoading(false);
    });
  }, []);

  const handleToggle = async () => {
    const newValue = !enabled;
    setStatus('');
    try {
      const [local] = await Promise.all([
        api.getLocalSettings(),
        api.getEffectiveSettings(),
      ]);
      const config = local.config;
      config.agent = { ...config.agent, admin_skip_permissions: !newValue };
      await api.updateLocalSettings(config);
      setEnabled(newValue);
      setStatus('Applied — restart required');
      setTimeout(() => setStatus(''), 3000);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
  };

  if (loading) return null;

  return (
    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-gray-400">Permission Gates</div>
          <div className="text-xs text-gray-600 mt-1">
            {enabled ? 'Po asks before dangerous operations' : 'All operations auto-approved'}
          </div>
        </div>
        <button
          onClick={handleToggle}
          className={`relative w-11 h-6 rounded-full transition-colors ${enabled ? 'bg-green-600' : 'bg-gray-700'}`}
        >
          <span className={`block w-4 h-4 bg-white rounded-full transition-transform absolute top-1 ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>
      {status && (
        <div className={`text-xs mt-2 ${status.startsWith('Error') ? 'text-red-400' : 'text-yellow-400'}`}>{status}</div>
      )}
    </div>
  );
}
