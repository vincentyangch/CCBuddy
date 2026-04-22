import { useState, useRef, useEffect, useCallback } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { ChatInput } from '../components/ChatInput';
import { ChatSidebar } from '../components/ChatSidebar';
import { api } from '../lib/api';
import ReactMarkdown from 'react-markdown';
import { Button, Panel, StatusPill } from '../components/ui';

interface ChatEntry {
  id: string;
  type: 'user' | 'assistant' | 'thinking' | 'tool_use';
  content: string;
  attachments?: Array<{ type: string; data: string; filename?: string }>;
}

interface RuntimeSession {
  session_key?: string;
  sessionKey?: string;
  platform?: string;
  channel_id?: string;
  channelId?: string;
  model?: string | null;
  reasoning_effort?: string | null;
  reasoningEffort?: string | null;
  service_tier?: string | null;
  serviceTier?: string | null;
  verbosity?: string | null;
}

function getRuntimeSessionKey(session: RuntimeSession | null): string | null {
  return session?.session_key ?? session?.sessionKey ?? null;
}

function getRuntimeChannelId(session: RuntimeSession | null): string | null {
  return session?.channel_id ?? session?.channelId ?? null;
}

export function ChatPage() {
  const [channelId, setChannelId] = useState('webchat-main');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [typing, setTyping] = useState(false);
  const [buttons, setButtons] = useState<{ messageId: string; text: string; buttons: Array<{ id: string; label: string }> } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sidebarRefresh, setSidebarRefresh] = useState(0);
  const [runtimeSession, setRuntimeSession] = useState<RuntimeSession | null>(null);
  const [backend, setBackend] = useState('');
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [reasoningEffortOptions, setReasoningEffortOptions] = useState<string[]>([]);
  const [serviceTierOptions, setServiceTierOptions] = useState<string[]>([]);
  const [verbosityOptions, setVerbosityOptions] = useState<string[]>([]);
  const [savingSessionSettings, setSavingSessionSettings] = useState(false);
  const [sessionSettingsStatus, setSessionSettingsStatus] = useState('');

  const loadRuntimeSession = useCallback(async (sessionIdOverride?: string | null, channelIdOverride?: string) => {
    const targetSessionId = sessionIdOverride ?? activeSessionId;
    const targetChannelId = channelIdOverride ?? channelId;

    try {
      const [sessionData, backendData, modelData] = await Promise.all([
        api.sessions(),
        api.getBackend(),
        api.getModel(),
      ]);

      const webchatSessions = (sessionData.sessions ?? []).filter((session: RuntimeSession) => session.platform === 'webchat');
      const matchedByKey = targetSessionId
        ? webchatSessions.find((session: RuntimeSession) => getRuntimeSessionKey(session) === targetSessionId)
        : null;
      const matchedByChannel = targetChannelId
        ? webchatSessions.find((session: RuntimeSession) => getRuntimeChannelId(session) === targetChannelId)
        : null;
      const matchedSession = matchedByKey ?? matchedByChannel ?? null;

      setRuntimeSession(matchedSession);
      setBackend(backendData.backend);
      setModelOptions(backendData.models);
      setReasoningEffortOptions(modelData.reasoning_effort_options);
      setServiceTierOptions(modelData.service_tier_options ?? []);
      setVerbosityOptions(modelData.verbosity_options);

      const matchedSessionKey = getRuntimeSessionKey(matchedSession);
      if (matchedSessionKey && !targetSessionId) {
        setActiveSessionId(matchedSessionKey);
      }
    } catch {
      setRuntimeSession(null);
    }
  }, [activeSessionId, channelId]);

  const handleEvent = useCallback((type: string, data: any) => {
    switch (type) {
      case 'chat.text':
        setEntries(prev => [...prev, { id: data.messageId, type: 'assistant', content: data.text }]);
        setTyping(false);
        setSidebarRefresh(n => n + 1);
        break;
      case 'chat.edit':
        setEntries(prev => prev.map(m => m.id === data.messageId ? { ...m, content: data.text } : m));
        break;
      case 'chat.typing':
        setTyping(data.active);
        break;
      case 'chat.image':
        setEntries(prev => [...prev, {
          id: crypto.randomUUID(),
          type: 'assistant',
          content: '',
          attachments: [{ type: 'image', data: data.data, filename: data.filename }],
        }]);
        break;
      case 'chat.file':
        setEntries(prev => [...prev, {
          id: crypto.randomUUID(),
          type: 'assistant',
          content: `📎 ${data.filename}`,
          attachments: [{ type: 'file', data: data.data, filename: data.filename }],
        }]);
        break;
      case 'chat.voice':
        setEntries(prev => [...prev, {
          id: crypto.randomUUID(),
          type: 'assistant',
          content: '',
          attachments: [{ type: 'voice', data: data.data }],
        }]);
        break;
      case 'chat.buttons':
        setButtons(data);
        break;
      case 'agent.progress':
        if (data.platform === 'webchat') {
          if (data.type === 'thinking') {
            setEntries(prev => [...prev, { id: crypto.randomUUID(), type: 'thinking', content: data.content }]);
          } else if (data.type === 'tool_use') {
            setEntries(prev => [...prev, { id: crypto.randomUUID(), type: 'tool_use', content: data.content }]);
          }
        }
        break;
    }
  }, []);

  const { connected, send } = useWebSocket({ onEvent: handleEvent, channelId });

  const handleSend = useCallback((text: string, attachments: Array<{ data: string; mimeType: string; filename: string }>) => {
    setEntries(prev => [...prev, {
      id: crypto.randomUUID(),
      type: 'user',
      content: text,
      attachments: attachments.length > 0
        ? attachments.map(a => ({ type: a.mimeType.startsWith('image/') ? 'image' : 'file', data: a.data, filename: a.filename }))
        : undefined,
    }]);
    send({ type: 'chat.message', text, channelId, attachments: attachments.length > 0 ? attachments : undefined });
    setSidebarRefresh(n => n + 1);
  }, [send, channelId]);

  const handleButtonClick = useCallback((messageId: string, buttonLabel: string) => {
    send({ type: 'chat.button_click', messageId, buttonLabel });
    setButtons(null);
  }, [send]);

  const handleSelectSession = useCallback(async (session: { sessionId: string; channelId: string }) => {
    setChannelId(session.channelId);
    setActiveSessionId(session.sessionId);
    // Load history by exact sessionId
    try {
      const data = await api.conversations({ platform: 'webchat', pageSize: '200' });
      const sessionEntries = (data.messages ?? [])
        .filter((m: any) => m.sessionId === session.sessionId)
        .sort((a: any, b: any) => a.timestamp - b.timestamp)
        .map((m: any) => ({
          id: String(m.id),
          type: m.role as 'user' | 'assistant',
          content: m.content,
        }));
      setEntries(sessionEntries);
    } catch {
      setEntries([]);
    }
    await loadRuntimeSession(session.sessionId, session.channelId);
  }, [loadRuntimeSession]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    try {
      await api.deleteConversation(sessionId);
    } catch { /* ignore */ }
    if (sessionId === activeSessionId) {
      setEntries([]);
      setActiveSessionId(null);
    }
    setSidebarRefresh(n => n + 1);
  }, [activeSessionId]);

  const handleNewChat = useCallback(() => {
    const newId = `webchat-${Date.now()}`;
    setChannelId(newId);
    setActiveSessionId(null);
    setRuntimeSession(null);
    setSessionSettingsStatus('');
    setEntries([]);
  }, []);

  const saveSessionSetting = useCallback(async (payload: { model?: string | null; reasoning_effort?: string | null; service_tier?: string | null; verbosity?: string | null }) => {
    const sessionKey = getRuntimeSessionKey(runtimeSession);
    if (!sessionKey) return;

    setSavingSessionSettings(true);
    setSessionSettingsStatus('');
    try {
      await api.setSessionSettings(sessionKey, payload);
      await loadRuntimeSession(sessionKey, getRuntimeChannelId(runtimeSession) ?? channelId);
      setSessionSettingsStatus('Applied');
      setTimeout(() => setSessionSettingsStatus(''), 2000);
    } catch (err) {
      setSessionSettingsStatus(`Error: ${(err as Error).message}`);
    }
    setSavingSessionSettings(false);
  }, [channelId, loadRuntimeSession, runtimeSession]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries]);

  useEffect(() => {
    void loadRuntimeSession();
  }, [loadRuntimeSession, sidebarRefresh]);

  const runtimeSessionKey = getRuntimeSessionKey(runtimeSession);
  const runtimeReasoningEffort = runtimeSession?.reasoning_effort ?? runtimeSession?.reasoningEffort ?? null;
  const runtimeServiceTier = runtimeSession?.service_tier ?? runtimeSession?.serviceTier ?? null;

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col overflow-hidden rounded-[var(--sd-radius)] border border-[color:var(--sd-border)] bg-[color:var(--sd-panel)] lg:flex-row">
      <ChatSidebar activeSessionId={activeSessionId} pendingChannelId={activeSessionId ? null : channelId} onSelectSession={handleSelectSession} onNewChat={handleNewChat} onDeleteSession={handleDeleteSession} refreshKey={sidebarRefresh} />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-[color:var(--sd-border)] px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-[color:var(--sd-subtle)]">Workspace</div>
              <div className="text-sm font-medium">Chat with Po</div>
            </div>
            <StatusPill tone={connected ? 'success' : 'danger'}>
              {connected ? 'Connected' : 'Disconnected'}
            </StatusPill>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {runtimeSessionKey ? (
              <span className="rounded-[var(--sd-radius)] border border-[color:var(--sd-border)] bg-[color:var(--sd-panel-raised)] px-2 py-0.5 text-xs text-[color:var(--sd-muted)]">
                session: {runtimeSessionKey}
              </span>
            ) : (
              <span className="rounded-[var(--sd-radius)] border border-dashed border-[color:var(--sd-border)] px-2 py-0.5 text-xs text-[color:var(--sd-muted)]">
                Session controls appear after the runtime session exists for this chat.
              </span>
            )}
            {runtimeSession?.model && (
              <span className="rounded-[var(--sd-radius)] border border-[color:var(--sd-border)] bg-[color:var(--sd-panel-raised)] px-2 py-0.5 text-xs text-[color:var(--sd-info)]">
                model: {runtimeSession.model}
              </span>
            )}
            {runtimeReasoningEffort && (
              <span className="rounded-[var(--sd-radius)] border border-[color:var(--sd-border)] bg-[color:var(--sd-panel-raised)] px-2 py-0.5 text-xs text-[color:var(--sd-warning)]">
                reasoning: {runtimeReasoningEffort}
              </span>
            )}
            {runtimeServiceTier && (
              <span className="rounded-[var(--sd-radius)] border border-[color:var(--sd-border)] bg-[color:var(--sd-panel-raised)] px-2 py-0.5 text-xs text-[color:var(--sd-info)]">
                service tier: {runtimeServiceTier}
              </span>
            )}
            {runtimeSession?.verbosity && (
              <span className="rounded-[var(--sd-radius)] border border-[color:var(--sd-border)] bg-[color:var(--sd-panel-raised)] px-2 py-0.5 text-xs text-[color:var(--sd-success)]">
                verbosity: {runtimeSession.verbosity}
              </span>
            )}
            {sessionSettingsStatus && (
              <span className={`rounded-[var(--sd-radius)] border px-2 py-0.5 text-xs ${
                sessionSettingsStatus.startsWith('Error')
                  ? 'border-[color:var(--sd-danger)] text-[color:var(--sd-danger)]'
                  : 'border-[color:var(--sd-success)] text-[color:var(--sd-success)]'
              }`}>
                {sessionSettingsStatus}
              </span>
            )}
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-4">
            <div>
              <label htmlFor="chat-session-model-select" className="mb-2 block text-sm font-medium text-[color:var(--sd-text)]">Session model</label>
              <select
                id="chat-session-model-select"
                value={runtimeSession?.model ?? ''}
                onChange={(e) => void saveSessionSetting({ model: e.target.value || null })}
                disabled={savingSessionSettings || !runtimeSessionKey}
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
                  <label htmlFor="chat-session-reasoning-select" className="mb-2 block text-sm font-medium text-[color:var(--sd-text)]">Reasoning effort</label>
                  <select
                    id="chat-session-reasoning-select"
                    value={runtimeReasoningEffort ?? ''}
                    onChange={(e) => void saveSessionSetting({ reasoning_effort: e.target.value || null })}
                    disabled={savingSessionSettings || !runtimeSessionKey}
                    className="sd-input w-full text-sm"
                  >
                    <option value="">Use backend default</option>
                    {reasoningEffortOptions.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="chat-session-service-tier-select" className="mb-2 block text-sm font-medium text-[color:var(--sd-text)]">Service tier</label>
                  <select
                    id="chat-session-service-tier-select"
                    value={runtimeServiceTier ?? ''}
                    onChange={(e) => void saveSessionSetting({ service_tier: e.target.value || null })}
                    disabled={savingSessionSettings || !runtimeSessionKey}
                    className="sd-input w-full text-sm"
                  >
                    <option value="">Use backend default</option>
                    {serviceTierOptions.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="chat-session-verbosity-select" className="mb-2 block text-sm font-medium text-[color:var(--sd-text)]">Verbosity</label>
                  <select
                    id="chat-session-verbosity-select"
                    value={runtimeSession?.verbosity ?? ''}
                    onChange={(e) => void saveSessionSetting({ verbosity: e.target.value || null })}
                    disabled={savingSessionSettings || !runtimeSessionKey}
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
        <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-3">
          {entries.map(entry => {
            if (entry.type === 'thinking') {
              return (
                <div key={entry.id} className="flex justify-start">
                  <Panel className="max-w-[75%] px-3 py-2 text-xs">
                    <details className="cursor-pointer">
                      <summary className="text-[color:var(--sd-info)]">💭 Thinking...</summary>
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-[color:var(--sd-muted)]">{entry.content}</pre>
                    </details>
                  </Panel>
                </div>
              );
            }
            if (entry.type === 'tool_use') {
              return (
                <div key={entry.id} className="flex justify-start">
                  <Panel className="max-w-[75%] px-3 py-2 text-xs">
                    <span className="text-[color:var(--sd-warning)]">🔧 Using {entry.content}...</span>
                  </Panel>
                </div>
              );
            }
            return (
              <div key={entry.id} className={`flex ${entry.type === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[75%] rounded-[var(--sd-radius)] border px-3 py-2 text-sm ${
                  entry.type === 'user' ? 'border-[color:var(--sd-accent)] bg-[color-mix(in_srgb,var(--sd-accent)_14%,transparent)]' : 'border-[color:var(--sd-border)] bg-[color:var(--sd-panel-raised)]'
                }`}>
                  {entry.attachments?.map((a, i) => (
                    <div key={i} className="mb-2">
                      {a.type === 'image' && <img src={`data:image/png;base64,${a.data}`} className="max-w-full rounded" />}
                      {a.type === 'voice' && <audio controls src={`data:audio/webm;base64,${a.data}`} className="max-w-full" />}
                      {a.type === 'file' && <div className="text-xs text-[color:var(--sd-accent)]">📎 {a.filename}</div>}
                    </div>
                  ))}
                  {entry.content && (
                    <div className="prose prose-invert prose-sm max-w-none">
                      <ReactMarkdown>{entry.content}</ReactMarkdown>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {typing && (
            <div className="flex justify-start">
              <div className="rounded-[var(--sd-radius)] border border-[color:var(--sd-border)] bg-[color:var(--sd-panel-raised)] px-3 py-2 text-sm text-[color:var(--sd-muted)]">
                Po is typing...
              </div>
            </div>
          )}
          {buttons && (
            <div className="flex justify-start">
              <Panel className="max-w-[75%] px-3 py-2">
                <div className="text-sm mb-2 whitespace-pre-wrap">{buttons.text}</div>
                <div className="flex gap-2 flex-wrap">
                  {buttons.buttons.map(b => (
                    <Button key={b.id} onClick={() => handleButtonClick(buttons.messageId, b.label)} className="min-h-0 px-3 py-1 text-xs">
                      {b.label}
                    </Button>
                  ))}
                </div>
              </Panel>
            </div>
          )}
        </div>
        <ChatInput onSend={handleSend} disabled={!connected} />
      </div>
    </div>
  );
}
