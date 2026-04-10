import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';

const TABS = ['General', 'Agent', 'Users', 'Platforms', 'Scheduler', 'Memory', 'Media', 'Skills', 'Webhooks', 'Apple', 'Dashboard'] as const;
const TAB_KEYS: Record<string, string> = {
  General: '_root', Agent: 'agent', Users: 'users', Platforms: 'platforms',
  Scheduler: 'scheduler', Memory: 'memory', Media: 'media', Skills: 'skills',
  Webhooks: 'webhooks', Apple: 'apple', Dashboard: 'dashboard',
};

const SOURCE_LABELS: Record<string, string> = {
  local: 'Local',
  env: 'Env',
  default: 'Default',
  effective_only: 'Effective only',
  runtime_override: 'Runtime override',
};

function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getDisplayValue(localValue: unknown, effectiveValue: unknown) {
  return localValue ?? effectiveValue ?? '';
}

function isEditableSource(source?: string) {
  return source !== 'env' && source !== 'effective_only';
}

function sourceClassName(source?: string) {
  if (source === 'local') return 'bg-blue-950 text-blue-300 border-blue-900';
  if (source === 'env') return 'bg-emerald-950 text-emerald-300 border-emerald-900';
  if (source === 'effective_only') return 'bg-gray-800 text-gray-400 border-gray-700';
  if (source === 'runtime_override') return 'bg-amber-950 text-amber-300 border-amber-900';
  return 'bg-gray-900 text-gray-500 border-gray-800';
}

function SourceBadge({ source }: { source?: string }) {
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[11px] uppercase tracking-wide ${sourceClassName(source)}`}>
      {SOURCE_LABELS[source ?? ''] ?? source ?? 'Unknown'}
    </span>
  );
}

function ConfigField({
  label,
  localValue,
  effectiveValue,
  source,
  onChange,
  type = 'text',
}: {
  label: string;
  localValue: any;
  effectiveValue: any;
  source?: string;
  onChange: (v: any) => void;
  type?: string;
}) {
  const editable = isEditableSource(source);
  const displayValue = editable
    ? getDisplayValue(localValue, effectiveValue)
    : (localValue ?? '');
  const effectiveText = String(effectiveValue ?? '');

  if (typeof displayValue === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-3 border-b border-gray-800 py-2 last:border-b-0">
        <div>
          <div className="text-sm text-white">{label}</div>
          <div className="mt-1 text-xs text-gray-500">
            Effective value: {effectiveText}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <SourceBadge source={source} />
          <input
            type="checkbox"
            checked={Boolean(displayValue)}
            onChange={(e) => onChange(e.target.checked)}
            disabled={!editable}
            className="rounded border-gray-600 bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-gray-800 py-3 last:border-b-0">
      <div className="mb-2 flex items-center justify-between gap-3">
        <label className="text-sm text-white">{label}</label>
        <SourceBadge source={source} />
      </div>
      <input
        type={type}
        value={String(displayValue)}
        onChange={(e) => onChange(type === 'number' ? Number(e.target.value) : e.target.value)}
        readOnly={!editable}
        className={`w-full rounded-lg border border-gray-700 px-3 py-2 text-sm ${editable ? 'bg-gray-800' : 'bg-gray-900 text-gray-500 cursor-not-allowed'}`}
      />
      <div className="mt-1 text-xs text-gray-500">
        Effective value: {effectiveText}
      </div>
    </div>
  );
}

function renderFields(
  localObj: Record<string, any>,
  effectiveObj: Record<string, any>,
  path: string[],
  sourceMap: Record<string, string>,
  onChange: (path: string[], value: any) => void,
): ReactNode[] {
  const keys = Array.from(new Set([
    ...Object.keys(localObj ?? {}),
    ...Object.keys(effectiveObj ?? {}),
  ]));

  return keys.map((key) => {
    const fullPath = [...path, key];
    const pathKey = fullPath.join('.');
    const localValue = localObj?.[key];
    const effectiveValue = effectiveObj?.[key];

    if (isPlainObject(localValue) || isPlainObject(effectiveValue)) {
      return (
        <div key={pathKey} className="mb-4 rounded-xl border border-gray-800 p-4">
          <div className="mb-3 text-sm font-medium text-gray-200">{key}</div>
          {renderFields(
            isPlainObject(localValue) ? localValue : {},
            isPlainObject(effectiveValue) ? effectiveValue : {},
            fullPath,
            sourceMap,
            onChange,
          )}
        </div>
      );
    }

    const type = typeof getDisplayValue(localValue, effectiveValue) === 'number' ? 'number' : 'text';
    return (
      <ConfigField
        key={pathKey}
        label={key}
        localValue={localValue}
        effectiveValue={effectiveValue}
        source={sourceMap[pathKey]}
        type={type}
        onChange={(value) => onChange(fullPath, value)}
      />
    );
  });
}

export function ConfigPage() {
  const [localConfig, setLocalConfig] = useState<Record<string, any> | null>(null);
  const [effectiveConfig, setEffectiveConfig] = useState<Record<string, any> | null>(null);
  const [sourceMap, setSourceMap] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<string>('General');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState('');

  const loadSettings = async (cancelled = false) => {
    const loadLocal = api.getLocalSettings()
      .then(({ config }) => {
        if (!cancelled) setLocalConfig(config);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError((prev) => prev ? `${prev}\n${err.message}` : `Error loading local settings: ${err.message}`);
      });

    const loadEffective = api.getEffectiveSettings()
      .then(({ config }) => {
        if (!cancelled) setEffectiveConfig(config);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError((prev) => prev ? `${prev}\n${err.message}` : `Error loading effective settings: ${err.message}`);
      });

    const loadMeta = api.getSettingsMeta()
      .then((meta) => {
        if (!cancelled) setSourceMap(meta.sources);
      })
      .catch(() => {
        if (!cancelled) setSourceMap({});
      });

    await Promise.allSettled([loadLocal, loadEffective, loadMeta]);
    if (!cancelled) setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    void loadSettings(cancelled);

    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = (path: string[], value: any) => {
    setLocalConfig((prev) => {
      const next = JSON.parse(JSON.stringify(prev ?? {}));
      let obj = next;
      for (let i = 0; i < path.length - 1; i += 1) {
        obj[path[i]] = obj[path[i]] ?? {};
        obj = obj[path[i]];
      }
      obj[path[path.length - 1]] = value;
      return next;
    });
  };

  const handleSave = async () => {
    if (!localConfig) return;
    setSaving(true);
    setStatus('');
    try {
      await api.updateLocalSettings(localConfig);
      await loadSettings();
      setStatus('Saved local settings');
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="text-gray-400">Loading...</p>;
  }

  if (loadError || !localConfig || !effectiveConfig) {
    return (
      <div className="rounded-xl border border-red-900 bg-red-950/40 p-4 text-sm text-red-200">
        {loadError || 'Unable to load settings.'}
      </div>
    );
  }

  const tabKey = TAB_KEYS[tab];
  const localSection = tabKey === '_root'
    ? { data_dir: localConfig.data_dir, log_level: localConfig.log_level }
    : localConfig[tabKey] ?? {};
  const effectiveSection = tabKey === '_root'
    ? { data_dir: effectiveConfig.data_dir, log_level: effectiveConfig.log_level }
    : effectiveConfig[tabKey] ?? {};

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Settings</h2>
          <p className="mt-1 text-sm text-gray-500">
            Edits write to <code className="rounded bg-gray-800 px-1 py-0.5 text-gray-300">config/local.yaml</code>.
            Effective values stay read-only for reference.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {status && (
            <span className={`text-sm ${status.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
              {status}
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Local Settings'}
          </button>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-3 py-1.5 text-sm ${tab === t ? 'bg-blue-600' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-gray-800 bg-gray-900 p-6">
        <div className="mb-4 flex items-center gap-2 text-xs text-gray-500">
          <span>Local edits only</span>
          <span>•</span>
          <span>Effective values below are read-only</span>
        </div>
        {renderFields(
          localSection,
          effectiveSection,
          tabKey === '_root' ? [] : [tabKey],
          sourceMap,
          handleChange,
        )}
      </div>
    </div>
  );
}
