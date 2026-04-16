import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { ModelSelector } from '../components/ModelSelector';
import { ModelListEditor } from '../components/ModelListEditor';
import { BackendSelector } from '../components/BackendSelector';
import { Button, PageHeader, Panel, StatusPill } from '../components/ui';

const SETTINGS_GROUPS = [
  { label: 'Core', tabs: ['Agent', 'General', 'Users'] },
  { label: 'Interfaces', tabs: ['Platforms', 'Gateway', 'Media', 'Image Generation', 'Apple', 'Dashboard'] },
  { label: 'Automation', tabs: ['Scheduler', 'Notifications', 'Webhooks', 'Heartbeat'] },
  { label: 'Data & Tools', tabs: ['Memory', 'Skills'] },
] as const;
const TAB_KEYS: Record<string, string> = {
  General: '_root', Agent: 'agent', Users: 'users', Platforms: 'platforms',
  Scheduler: 'scheduler', Gateway: 'gateway', Memory: 'memory', Heartbeat: 'heartbeat',
  Notifications: 'notifications', Media: 'media', 'Image Generation': 'image_generation',
  Skills: 'skills', Webhooks: 'webhooks', Apple: 'apple', Dashboard: 'dashboard',
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

function getSelectValue(localValue: unknown, effectiveValue: unknown) {
  const value = getDisplayValue(localValue, effectiveValue);
  return typeof value === 'string' ? value : '';
}

function isEditableSource(source?: string) {
  return source !== 'env' && source !== 'effective_only';
}

function sourceTone(source?: string): 'success' | 'warning' | 'neutral' | 'info' {
  if (source === 'local') return 'info';
  if (source === 'env') return 'success';
  if (source === 'runtime_override') return 'warning';
  return 'neutral';
}

function SourceBadge({ source }: { source?: string }) {
  return (
    <StatusPill tone={sourceTone(source)}>
      {SOURCE_LABELS[source ?? ''] ?? source ?? 'Unknown'}
    </StatusPill>
  );
}

function sanitizeFieldSegment(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, '-');
}

function SelectConfigField({
  id,
  label,
  localValue,
  effectiveValue,
  source,
  options,
  placeholder,
  onChange,
  effectiveLabel = 'Effective value',
}: {
  id: string;
  label: string;
  localValue: unknown;
  effectiveValue: unknown;
  source?: string;
  options: string[];
  placeholder: string;
  onChange: (value: string | undefined) => void;
  effectiveLabel?: string;
}) {
  const editable = isEditableSource(source);
  const value = getSelectValue(localValue, effectiveValue);
  const effectiveText = typeof effectiveValue === 'string' && effectiveValue ? effectiveValue : placeholder;

  return (
    <div className="border-b border-[color:var(--sd-border)] py-3 last:border-b-0">
      <div className="mb-2 flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm text-[color:var(--sd-text)]">{label}</label>
        <SourceBadge source={source} />
      </div>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value || undefined)}
        disabled={!editable}
        aria-describedby={`${id}-effective`}
        className={`sd-input w-full text-sm ${editable ? '' : 'cursor-not-allowed opacity-60'}`}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
      <div id={`${id}-effective`} className="mt-1 text-xs text-[color:var(--sd-muted)]">
        {effectiveLabel}: {effectiveText}
      </div>
    </div>
  );
}

function ConfigField({
  id,
  label,
  localValue,
  effectiveValue,
  source,
  onChange,
  type = 'text',
}: {
  id: string;
  label: string;
  localValue: any;
  effectiveValue: any;
  source?: string;
  onChange: (v: any) => void;
  type?: string;
}) {
  const editable = isEditableSource(source);
  const displayValue = source === 'runtime_override'
    ? (localValue ?? '')
    : editable
      ? getDisplayValue(localValue, effectiveValue)
      : (localValue ?? '');
  const effectiveText = String(effectiveValue ?? '');

  if (typeof displayValue === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-3 border-b border-[color:var(--sd-border)] py-2 last:border-b-0">
        <div>
          <label htmlFor={id} className="text-sm text-[color:var(--sd-text)]">{label}</label>
          <div id={`${id}-effective`} className="mt-1 text-xs text-[color:var(--sd-muted)]">
            Effective value: {effectiveText}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <SourceBadge source={source} />
          <input
            id={id}
            type="checkbox"
            checked={Boolean(displayValue)}
            onChange={(e) => onChange(e.target.checked)}
            disabled={!editable}
            aria-describedby={`${id}-effective`}
            className="rounded border-[color:var(--sd-control-border)] bg-[color:var(--sd-input)] disabled:cursor-not-allowed disabled:opacity-50"
            style={{ accentColor: 'var(--sd-accent)' }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-[color:var(--sd-border)] py-3 last:border-b-0">
      <div className="mb-2 flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm text-[color:var(--sd-text)]">{label}</label>
        <SourceBadge source={source} />
      </div>
      <input
        id={id}
        type={type}
        value={String(displayValue)}
        onChange={(e) => onChange(type === 'number' ? Number(e.target.value) : e.target.value)}
        readOnly={!editable}
        aria-describedby={`${id}-effective`}
        className={`sd-input w-full text-sm ${editable ? '' : 'cursor-not-allowed opacity-60'}`}
      />
      <div id={`${id}-effective`} className="mt-1 text-xs text-[color:var(--sd-muted)]">
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
  hiddenPaths: Set<string> = new Set(),
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

    if (hiddenPaths.has(pathKey)) {
      return null;
    }

    if (isPlainObject(localValue) || isPlainObject(effectiveValue)) {
      return (
        <div key={pathKey} className="mb-4 rounded-[var(--sd-radius)] border border-[color:var(--sd-border)] p-4">
          <div className="mb-3 text-sm font-medium text-[color:var(--sd-muted)]">{key}</div>
          {renderFields(
            isPlainObject(localValue) ? localValue : {},
            isPlainObject(effectiveValue) ? effectiveValue : {},
            fullPath,
            sourceMap,
            onChange,
            hiddenPaths,
          )}
        </div>
      );
    }

    const type = typeof getDisplayValue(localValue, effectiveValue) === 'number' ? 'number' : 'text';
    const fieldId = `config-field-${(pathKey || key).replace(/[^A-Za-z0-9_-]/g, '-')}`;
    return (
      <ConfigField
        key={pathKey}
        id={fieldId}
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

function PermissionGatesControl({
  localConfig,
  effectiveConfig,
  source,
  onChange,
}: {
  localConfig: Record<string, any>;
  effectiveConfig: Record<string, any>;
  source?: string;
  onChange: (path: string[], value: any) => void;
}) {
  const localSkip = localConfig.agent?.admin_skip_permissions;
  const effectiveSkip = effectiveConfig.agent?.admin_skip_permissions;
  const enabled = typeof localSkip === 'boolean'
    ? !localSkip
    : !Boolean(effectiveSkip);

  const handleToggle = () => {
    const nextEnabled = !enabled;
    onChange(['agent', 'admin_skip_permissions'], !nextEnabled);
  };

  return (
    <Panel className="p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium text-[color:var(--sd-text)]">Permission gates</div>
            <SourceBadge source={source} />
          </div>
          <div className="mt-1 text-xs text-[color:var(--sd-muted)]">
            {enabled ? 'Prompts before privileged operations.' : 'Privileged operations auto-approve for admins.'}
          </div>
          <div className="mt-2 text-xs text-[color:var(--sd-warning)]">Save local settings to persist. Restart required.</div>
        </div>
        <button
          type="button"
          onClick={handleToggle}
          aria-pressed={enabled}
          aria-label={enabled ? 'Disable permission gates' : 'Enable permission gates'}
          className="relative h-8 w-14 rounded-full transition-colors"
          style={{ backgroundColor: enabled ? 'var(--sd-success)' : 'var(--sd-border-strong)' }}
        >
          <span className={`absolute top-1 block h-6 w-6 rounded-full bg-white transition-transform ${enabled ? 'translate-x-7' : 'translate-x-1'}`} />
        </button>
      </div>
    </Panel>
  );
}

function SchedulerSettingsControl({
  localConfig,
  effectiveConfig,
  sourceMap,
  onChange,
}: {
  localConfig: Record<string, any>;
  effectiveConfig: Record<string, any>;
  sourceMap: Record<string, string>;
  onChange: (path: string[], value: any) => void;
}) {
  const effectiveBackend = isPlainObject(effectiveConfig.agent) && typeof effectiveConfig.agent.backend === 'string'
    ? effectiveConfig.agent.backend
    : '';
  const [backend, setBackend] = useState<string>(effectiveBackend);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [reasoningEffortOptions, setReasoningEffortOptions] = useState<string[]>([]);
  const [verbosityOptions, setVerbosityOptions] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;

    Promise.all([api.getBackend(), api.getModel()])
      .then(([backendData, modelData]) => {
        if (cancelled) return;
        setBackend(backendData.backend);
        setModelOptions(backendData.models);
        setReasoningEffortOptions(modelData.reasoning_effort_options);
        setVerbosityOptions(modelData.verbosity_options);
      })
      .catch(() => {
        if (cancelled) return;
        setBackend(effectiveBackend);
      });

    return () => {
      cancelled = true;
    };
  }, [effectiveBackend]);

  const schedulerLocal = isPlainObject(localConfig.scheduler) ? localConfig.scheduler : {};
  const schedulerEffective = isPlainObject(effectiveConfig.scheduler) ? effectiveConfig.scheduler : {};
  const localJobs = isPlainObject(schedulerLocal.jobs) ? schedulerLocal.jobs : {};
  const effectiveJobs = isPlainObject(schedulerEffective.jobs) ? schedulerEffective.jobs : {};
  const jobNames = Array.from(new Set([
    ...Object.keys(localJobs),
    ...Object.keys(effectiveJobs),
  ])).sort();
  const isCodex = backend.startsWith('codex') || effectiveBackend.startsWith('codex');

  return (
    <div className="mb-6 grid gap-4">
      <Panel className="p-4">
        <div className="mb-3">
          <div className="text-sm font-medium text-[color:var(--sd-text)]">Scheduler defaults</div>
          <div className="mt-1 text-xs text-[color:var(--sd-muted)]">Used when a scheduler job does not specify its own runtime overrides.</div>
        </div>
        <div className={`grid gap-3 ${isCodex ? 'lg:grid-cols-3' : 'lg:grid-cols-1'}`}>
          <SelectConfigField
            id="scheduler-default-model-select"
            label="Default model"
            localValue={schedulerLocal.default_model}
            effectiveValue={schedulerEffective.default_model}
            source={sourceMap['scheduler.default_model']}
            options={modelOptions}
            placeholder="Use agent default"
            effectiveLabel="Effective fallback"
            onChange={(value) => onChange(['scheduler', 'default_model'], value)}
          />
          {isCodex && (
            <SelectConfigField
              id="scheduler-default-reasoning-select"
              label="Default reasoning effort"
              localValue={schedulerLocal.default_reasoning_effort}
              effectiveValue={schedulerEffective.default_reasoning_effort}
              source={sourceMap['scheduler.default_reasoning_effort']}
              options={reasoningEffortOptions}
              placeholder="Use backend default"
              effectiveLabel="Effective fallback"
              onChange={(value) => onChange(['scheduler', 'default_reasoning_effort'], value)}
            />
          )}
          {isCodex && (
            <SelectConfigField
              id="scheduler-default-verbosity-select"
              label="Default verbosity"
              localValue={schedulerLocal.default_verbosity}
              effectiveValue={schedulerEffective.default_verbosity}
              source={sourceMap['scheduler.default_verbosity']}
              options={verbosityOptions}
              placeholder="Use backend default"
              effectiveLabel="Effective fallback"
              onChange={(value) => onChange(['scheduler', 'default_verbosity'], value)}
            />
          )}
        </div>
      </Panel>

      {jobNames.map((jobName) => {
        const localJob = isPlainObject(localJobs[jobName]) ? localJobs[jobName] : {};
        const effectiveJob = isPlainObject(effectiveJobs[jobName]) ? effectiveJobs[jobName] : {};
        const safeJobName = sanitizeFieldSegment(jobName);
        const cron = typeof effectiveJob.cron === 'string' ? effectiveJob.cron : 'Not configured';
        const jobType = typeof effectiveJob.skill === 'string' ? 'skill' : 'prompt';

        return (
          <Panel key={jobName} className="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <div className="text-sm font-medium text-[color:var(--sd-text)]">{jobName}</div>
              <StatusPill tone="neutral">{jobType}</StatusPill>
              <span className="text-xs text-[color:var(--sd-muted)]">cron: {cron}</span>
            </div>
            <div className={`grid gap-3 ${isCodex ? 'lg:grid-cols-3' : 'lg:grid-cols-1'}`}>
              <SelectConfigField
                id={`scheduler-job-${safeJobName}-model-select`}
                label="Job model"
                localValue={localJob.model}
                effectiveValue={effectiveJob.model}
                source={sourceMap[`scheduler.jobs.${jobName}.model`]}
                options={modelOptions}
                placeholder="Use scheduler default"
                effectiveLabel="Effective override"
                onChange={(value) => onChange(['scheduler', 'jobs', jobName, 'model'], value)}
              />
              {isCodex && (
                <SelectConfigField
                  id={`scheduler-job-${safeJobName}-reasoning-select`}
                  label="Reasoning effort"
                  localValue={localJob.reasoning_effort}
                  effectiveValue={effectiveJob.reasoning_effort}
                  source={sourceMap[`scheduler.jobs.${jobName}.reasoning_effort`]}
                  options={reasoningEffortOptions}
                  placeholder="Use scheduler default"
                  effectiveLabel="Effective override"
                  onChange={(value) => onChange(['scheduler', 'jobs', jobName, 'reasoning_effort'], value)}
                />
              )}
              {isCodex && (
                <SelectConfigField
                  id={`scheduler-job-${safeJobName}-verbosity-select`}
                  label="Verbosity"
                  localValue={localJob.verbosity}
                  effectiveValue={effectiveJob.verbosity}
                  source={sourceMap[`scheduler.jobs.${jobName}.verbosity`]}
                  options={verbosityOptions}
                  placeholder="Use scheduler default"
                  effectiveLabel="Effective override"
                  onChange={(value) => onChange(['scheduler', 'jobs', jobName, 'verbosity'], value)}
                />
              )}
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

export function ConfigPage() {
  const [localConfig, setLocalConfig] = useState<Record<string, any> | null>(null);
  const [effectiveConfig, setEffectiveConfig] = useState<Record<string, any> | null>(null);
  const [sourceMap, setSourceMap] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<string>('Agent');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState('');
  const [dirty, setDirty] = useState(false);

  const loadSettings = async (cancelled = false, clearDirty = false) => {
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
    if (!cancelled) {
      setLoading(false);
      if (clearDirty) setDirty(false);
    }
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
    setDirty(true);
    setStatus('');
    setLocalConfig((prev) => {
      const next = JSON.parse(JSON.stringify(prev ?? {}));
      let obj = next;
      for (let i = 0; i < path.length - 1; i += 1) {
        obj[path[i]] = obj[path[i]] ?? {};
        obj = obj[path[i]];
      }
      if (value === undefined) {
        delete obj[path[path.length - 1]];
      } else {
        obj[path[path.length - 1]] = value;
      }
      return next;
    });
  };

  const handleSave = async () => {
    if (!localConfig) return;
    setSaving(true);
    setStatus('');
    try {
      await api.updateLocalSettings(localConfig);
      await loadSettings(false, true);
      setStatus('Saved local settings');
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="text-[color:var(--sd-muted)]">Loading...</p>;
  }

  if (loadError || !localConfig || !effectiveConfig) {
    return (
      <Panel className="p-4 text-sm text-[color:var(--sd-danger)]">
        {loadError || 'Unable to load settings.'}
      </Panel>
    );
  }

  const tabKey = TAB_KEYS[tab];
  const localSection = tabKey === '_root'
    ? { data_dir: localConfig.data_dir, log_level: localConfig.log_level }
    : localConfig[tabKey] ?? {};
  const effectiveSection = tabKey === '_root'
    ? { data_dir: effectiveConfig.data_dir, log_level: effectiveConfig.log_level }
    : effectiveConfig[tabKey] ?? {};
  const hiddenPaths = new Set<string>();
  if (tabKey === 'agent') {
    hiddenPaths.add('agent.admin_skip_permissions');
  }
  if (tabKey === 'scheduler') {
    hiddenPaths.add('scheduler.default_model');
    hiddenPaths.add('scheduler.default_reasoning_effort');
    hiddenPaths.add('scheduler.default_verbosity');
    const localJobs = isPlainObject(localConfig.scheduler?.jobs) ? localConfig.scheduler.jobs : {};
    const effectiveJobs = isPlainObject(effectiveConfig.scheduler?.jobs) ? effectiveConfig.scheduler.jobs : {};
    for (const jobName of new Set([...Object.keys(localJobs), ...Object.keys(effectiveJobs)])) {
      hiddenPaths.add(`scheduler.jobs.${jobName}.model`);
      hiddenPaths.add(`scheduler.jobs.${jobName}.reasoning_effort`);
      hiddenPaths.add(`scheduler.jobs.${jobName}.verbosity`);
    }
  }

  return (
    <div>
      <PageHeader
        domain="Admin"
        title="Settings"
        description="Edits write to config/local.yaml. Effective values stay read-only for reference."
        actions={(
          <div className="flex flex-wrap items-center gap-3">
            <div role="status" aria-live="polite">
              {status && (
                <span className={`text-sm ${status.startsWith('Error') ? 'text-[color:var(--sd-danger)]' : 'text-[color:var(--sd-success)]'}`}>
                  {status}
                </span>
              )}
              {dirty && !status && (
                <span className="text-sm text-[color:var(--sd-warning)]">Unsaved local settings</span>
              )}
            </div>
            <Button
              onClick={handleSave}
              disabled={saving || !dirty}
            >
              {saving ? 'Saving...' : 'Save Local Settings'}
            </Button>
          </div>
        )}
      />

      <div className="mb-6 grid gap-3 xl:grid-cols-4">
        {SETTINGS_GROUPS.map((group) => (
          <Panel key={group.label} className="p-3">
            <div className="mb-2 px-1 text-xs font-medium uppercase text-[color:var(--sd-subtle)]">{group.label}</div>
            <div className="flex flex-wrap gap-1">
              {group.tabs.map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`rounded-[var(--sd-radius)] px-3 py-1.5 text-sm ${
                    tab === t
                      ? 'sd-button min-h-0 bg-[color:var(--sd-accent)] text-[color:var(--sd-accent-ink)]'
                      : 'sd-button-secondary min-h-0 hover:text-[color:var(--sd-text)]'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </Panel>
        ))}
      </div>

      {tabKey === 'agent' && (
        <div className="mb-6 grid gap-4 lg:grid-cols-2">
          <BackendSelector />
          <ModelSelector />
          <ModelListEditor />
          <PermissionGatesControl
            localConfig={localConfig}
            effectiveConfig={effectiveConfig}
            source={sourceMap['agent.admin_skip_permissions']}
            onChange={handleChange}
          />
        </div>
      )}

      {tabKey === 'scheduler' && (
        <SchedulerSettingsControl
          localConfig={localConfig}
          effectiveConfig={effectiveConfig}
          sourceMap={sourceMap}
          onChange={handleChange}
        />
      )}

      <Panel className="p-6">
        <div className="mb-4 flex items-center gap-2 text-xs text-[color:var(--sd-muted)]">
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
          hiddenPaths,
        )}
      </Panel>
    </div>
  );
}
