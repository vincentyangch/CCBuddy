import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { ChatMessage } from '../components/ChatMessage';
import { ThinkingBlock } from '../components/ThinkingBlock';
import { ToolUseBlock } from '../components/ToolUseBlock';
import { PageHeader, Panel } from '../components/ui';

export function SessionDetailPage() {
  const { key } = useParams<{ key: string }>();
  const [events, setEvents] = useState<any[]>([]);
  const [session, setSession] = useState<any | null>(null);
  const [backend, setBackend] = useState<string>('');
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [reasoningEffortOptions, setReasoningEffortOptions] = useState<string[]>([]);
  const [serviceTierOptions, setServiceTierOptions] = useState<string[]>([]);
  const [verbosityOptions, setVerbosityOptions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [loading, setLoading] = useState(true);

  const load = () => {
    if (!key) return Promise.resolve();
    return Promise.all([api.sessionEvents(key), api.sessions(), api.getBackend(), api.getModel()]).then(([eventData, sessionData, backendData, modelData]) => {
      setEvents(eventData.events);
      setSession(sessionData.sessions.find((item) => (item.session_key ?? item.sessionKey) === key) ?? null);
      setBackend(backendData.backend);
      setModelOptions(backendData.models);
      setReasoningEffortOptions(modelData.reasoning_effort_options);
      setServiceTierOptions(modelData.service_tier_options ?? []);
      setVerbosityOptions(modelData.verbosity_options);
      setLoading(false);
    });
  };

  useEffect(() => {
    void load();
  }, [key]);

  const saveSetting = async (payload: { model?: string | null; reasoning_effort?: string | null; service_tier?: string | null; verbosity?: string | null }) => {
    if (!key) return;
    setSaving(true);
    setStatus('');
    try {
      await api.setSessionSettings(key, payload);
      await load();
      setStatus('Applied');
      setTimeout(() => setStatus(''), 2000);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
    setSaving(false);
  };

  if (loading) return <p className="text-[color:var(--sd-muted)]">Loading...</p>;

  return (
    <div>
      <Link to="/sessions" className="mb-4 inline-block text-sm text-[color:var(--sd-accent)] hover:underline">
        &larr; Back to Runtime Sessions
      </Link>
      <PageHeader
        domain="Operations"
        title="Runtime Session"
        description={decodeURIComponent(key ?? '')}
      />
      <Panel className="max-w-3xl p-4">
        {session && (
          <div className="mb-4 border-b border-[color:var(--sd-border)] pb-4">
            <div className="mb-3 flex flex-wrap gap-2">
              <span className="rounded-[var(--sd-radius)] border border-[color:var(--sd-border)] bg-[color:var(--sd-panel-raised)] px-2 py-0.5 text-xs text-[color:var(--sd-muted)]">
                backend: {backend || 'unknown'}
              </span>
              {status && (
                <span className={`rounded-[var(--sd-radius)] border px-2 py-0.5 text-xs ${
                  status.startsWith('Error')
                    ? 'border-[color:var(--sd-danger)] text-[color:var(--sd-danger)]'
                    : 'border-[color:var(--sd-success)] text-[color:var(--sd-success)]'
                }`}>
                  {status}
                </span>
              )}
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
            {session.model && (
              <span className="rounded-[var(--sd-radius)] border border-[color:var(--sd-border)] bg-[color:var(--sd-panel-raised)] px-2 py-0.5 text-xs text-[color:var(--sd-info)]">
                model: {session.model}
              </span>
            )}
            {(session.reasoning_effort ?? session.reasoningEffort) && (
              <span className="rounded-[var(--sd-radius)] border border-[color:var(--sd-border)] bg-[color:var(--sd-panel-raised)] px-2 py-0.5 text-xs text-[color:var(--sd-warning)]">
                reasoning: {session.reasoning_effort ?? session.reasoningEffort}
              </span>
            )}
            {(session.service_tier ?? session.serviceTier) && (
              <span className="rounded-[var(--sd-radius)] border border-[color:var(--sd-border)] bg-[color:var(--sd-panel-raised)] px-2 py-0.5 text-xs text-[color:var(--sd-info)]">
                service tier: {session.service_tier ?? session.serviceTier}
              </span>
            )}
            {session.verbosity && (
              <span className="rounded-[var(--sd-radius)] border border-[color:var(--sd-border)] bg-[color:var(--sd-panel-raised)] px-2 py-0.5 text-xs text-[color:var(--sd-success)]">
                verbosity: {session.verbosity}
              </span>
            )}
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <div>
                <label htmlFor="session-model-select" className="mb-2 block text-sm font-medium text-[color:var(--sd-text)]">Session model</label>
                <select
                  id="session-model-select"
                  value={session.model ?? ''}
                  onChange={(e) => void saveSetting({ model: e.target.value || null })}
                  disabled={saving}
                  className="sd-input w-full text-sm"
                >
                  <option value="">Use runtime default</option>
                  {modelOptions.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>
              {backend.startsWith('codex') && (
                <>
                  <div>
                    <label htmlFor="session-reasoning-select" className="mb-2 block text-sm font-medium text-[color:var(--sd-text)]">Reasoning effort</label>
                    <select
                      id="session-reasoning-select"
                      value={session.reasoning_effort ?? session.reasoningEffort ?? ''}
                      onChange={(e) => void saveSetting({ reasoning_effort: e.target.value || null })}
                      disabled={saving}
                      className="sd-input w-full text-sm"
                    >
                      <option value="">Use backend default</option>
                      {reasoningEffortOptions.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="session-service-tier-select" className="mb-2 block text-sm font-medium text-[color:var(--sd-text)]">Service tier</label>
                    <select
                      id="session-service-tier-select"
                      value={session.service_tier ?? session.serviceTier ?? ''}
                      onChange={(e) => void saveSetting({ service_tier: e.target.value || null })}
                      disabled={saving}
                      className="sd-input w-full text-sm"
                    >
                      <option value="">Use backend default</option>
                      {serviceTierOptions.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="session-verbosity-select" className="mb-2 block text-sm font-medium text-[color:var(--sd-text)]">Verbosity</label>
                    <select
                      id="session-verbosity-select"
                      value={session.verbosity ?? ''}
                      onChange={(e) => void saveSetting({ verbosity: e.target.value || null })}
                      disabled={saving}
                      className="sd-input w-full text-sm"
                    >
                      <option value="">Use backend default</option>
                      {verbosityOptions.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        {events.length === 0 ? (
          <p className="text-sm text-[color:var(--sd-muted)]">No events recorded for this runtime session</p>
        ) : (
          events.map((e: any, i: number) => {
            if (e.eventType === 'thinking') return <ThinkingBlock key={i} content={e.content} />;
            if (e.eventType === 'tool_use' || e.eventType === 'tool_result')
              return <ToolUseBlock key={i} tool={e.content} input={e.toolInput} output={e.toolOutput} />;
            if (e.eventType === 'text') return <ChatMessage key={i} role="assistant" content={e.content} />;
            return null;
          })
        )}
      </Panel>
    </div>
  );
}
