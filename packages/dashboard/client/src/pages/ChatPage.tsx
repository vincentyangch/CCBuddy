import { useState, useRef, useEffect, useCallback } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { ChatInput } from '../components/ChatInput';
import { ChatSidebar } from '../components/ChatSidebar';
import { api } from '../lib/api';
import ReactMarkdown from 'react-markdown';

interface ChatEntry {
  id: string;
  type: 'user' | 'assistant' | 'thinking' | 'tool_use';
  content: string;
  attachments?: Array<{ type: string; data: string; filename?: string }>;
}

export function ChatPage() {
  const [channelId, setChannelId] = useState('webchat-main');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [typing, setTyping] = useState(false);
  const [buttons, setButtons] = useState<{ messageId: string; text: string; buttons: Array<{ id: string; label: string }> } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sidebarRefresh, setSidebarRefresh] = useState(0);

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
    send({ type: 'chat.message', text, attachments: attachments.length > 0 ? attachments : undefined });
  }, [send]);

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
  }, []);

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
    setEntries([]);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries]);

  return (
    <div className="flex h-[calc(100vh-theme(spacing.12))] -m-6">
      <ChatSidebar activeSessionId={activeSessionId} onSelectSession={handleSelectSession} onNewChat={handleNewChat} onDeleteSession={handleDeleteSession} refreshKey={sidebarRefresh} />
      <div className="flex-1 flex flex-col">
        <div className="px-4 py-3 border-b border-gray-800 flex justify-between items-center">
          <span className="text-sm font-medium">Chat with Po</span>
          <span className={`text-xs px-2 py-0.5 rounded ${connected ? 'bg-green-900 text-green-400' : 'bg-red-900 text-red-400'}`}>
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-3">
          {entries.map(entry => {
            if (entry.type === 'thinking') {
              return (
                <div key={entry.id} className="flex justify-start">
                  <details className="max-w-[75%] rounded-lg px-3 py-2 text-xs bg-gray-900 border border-gray-800 cursor-pointer">
                    <summary className="text-purple-400">💭 Thinking...</summary>
                    <pre className="mt-1 text-gray-500 whitespace-pre-wrap text-[11px] max-h-40 overflow-auto">{entry.content}</pre>
                  </details>
                </div>
              );
            }
            if (entry.type === 'tool_use') {
              return (
                <div key={entry.id} className="flex justify-start">
                  <div className="max-w-[75%] rounded-lg px-3 py-2 text-xs bg-gray-900 border border-gray-800">
                    <span className="text-yellow-400">🔧 Using {entry.content}...</span>
                  </div>
                </div>
              );
            }
            return (
              <div key={entry.id} className={`flex ${entry.type === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                  entry.type === 'user' ? 'bg-blue-900/30 border border-blue-800/50' : 'bg-gray-800 border border-gray-700'
                }`}>
                  {entry.attachments?.map((a, i) => (
                    <div key={i} className="mb-2">
                      {a.type === 'image' && <img src={`data:image/png;base64,${a.data}`} className="max-w-full rounded" />}
                      {a.type === 'voice' && <audio controls src={`data:audio/webm;base64,${a.data}`} className="max-w-full" />}
                      {a.type === 'file' && <div className="text-blue-400 text-xs">📎 {a.filename}</div>}
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
              <div className="rounded-lg px-3 py-2 text-sm bg-gray-800 border border-gray-700 text-gray-500">
                Po is typing...
              </div>
            </div>
          )}
          {buttons && (
            <div className="flex justify-start">
              <div className="max-w-[75%] rounded-lg px-3 py-2 bg-gray-800 border border-gray-700">
                <div className="text-sm mb-2 whitespace-pre-wrap">{buttons.text}</div>
                <div className="flex gap-2 flex-wrap">
                  {buttons.buttons.map(b => (
                    <button key={b.id} onClick={() => handleButtonClick(buttons.messageId, b.label)} className="px-3 py-1 bg-blue-600 rounded text-xs text-white hover:bg-blue-500">
                      {b.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
        <ChatInput onSend={handleSend} disabled={!connected} />
      </div>
    </div>
  );
}
