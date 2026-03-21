import { useState, useRef, useEffect, useCallback } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { ChatInput } from '../components/ChatInput';
import { ChatSidebar } from '../components/ChatSidebar';
import { api } from '../lib/api';
import ReactMarkdown from 'react-markdown';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: Array<{ type: string; data: string; filename?: string }>;
}

interface AgentProgress {
  id: string;
  type: 'thinking' | 'tool_use';
  content: string;
}

export function ChatPage() {
  const [channelId, setChannelId] = useState('webchat-main');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [progress, setProgress] = useState<AgentProgress[]>([]);
  const [typing, setTyping] = useState(false);
  const [buttons, setButtons] = useState<{ messageId: string; text: string; buttons: Array<{ id: string; label: string }> } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sidebarRefresh, setSidebarRefresh] = useState(0);

  const handleEvent = useCallback((type: string, data: any) => {
    switch (type) {
      case 'chat.text':
        setMessages(prev => [...prev, { id: data.messageId, role: 'assistant', content: data.text }]);
        setProgress([]);
        setTyping(false);
        setSidebarRefresh(n => n + 1);
        break;
      case 'chat.edit':
        setMessages(prev => prev.map(m => m.id === data.messageId ? { ...m, content: data.text } : m));
        break;
      case 'chat.typing':
        setTyping(data.active);
        break;
      case 'chat.image':
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: '',
          attachments: [{ type: 'image', data: data.data, filename: data.filename }],
        }]);
        break;
      case 'chat.file':
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `📎 ${data.filename}`,
          attachments: [{ type: 'file', data: data.data, filename: data.filename }],
        }]);
        break;
      case 'chat.voice':
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          role: 'assistant',
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
            setProgress(prev => [...prev, { id: crypto.randomUUID(), type: 'thinking', content: data.content }]);
          } else if (data.type === 'tool_use') {
            setProgress(prev => [...prev, { id: crypto.randomUUID(), type: 'tool_use', content: data.content }]);
          }
        }
        break;
    }
  }, []);

  const { connected, send } = useWebSocket({ onEvent: handleEvent, channelId });

  const handleSend = useCallback((text: string, attachments: Array<{ data: string; mimeType: string; filename: string }>) => {
    setMessages(prev => [...prev, {
      id: crypto.randomUUID(),
      role: 'user',
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

  const handleSelectSession = useCallback(async (selectedChannelId: string) => {
    setChannelId(selectedChannelId);
    setProgress([]);
    // Load history from DB
    try {
      const data = await api.conversations({ platform: 'webchat', pageSize: '100' });
      const sessionMessages = (data.messages ?? [])
        .filter((m: any) => m.sessionId.endsWith(`-webchat-${selectedChannelId}`))
        .sort((a: any, b: any) => a.timestamp - b.timestamp)
        .map((m: any) => ({
          id: String(m.id),
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));
      setMessages(sessionMessages);
    } catch {
      setMessages([]);
    }
  }, []);

  const handleNewChat = useCallback(() => {
    const newId = `webchat-${Date.now()}`;
    setChannelId(newId);
    setMessages([]);
    setProgress([]);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, progress]);

  return (
    <div className="flex h-[calc(100vh-theme(spacing.12))] -m-6">
      <ChatSidebar activeChannelId={channelId} onSelectSession={handleSelectSession} onNewChat={handleNewChat} refreshKey={sidebarRefresh} />
      <div className="flex-1 flex flex-col">
        <div className="px-4 py-3 border-b border-gray-800 flex justify-between items-center">
          <span className="text-sm font-medium">Chat with Po</span>
          <span className={`text-xs px-2 py-0.5 rounded ${connected ? 'bg-green-900 text-green-400' : 'bg-red-900 text-red-400'}`}>
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-3">
          {messages.map(msg => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                msg.role === 'user' ? 'bg-blue-900/30 border border-blue-800/50' : 'bg-gray-800 border border-gray-700'
              }`}>
                {msg.attachments?.map((a, i) => (
                  <div key={i} className="mb-2">
                    {a.type === 'image' && <img src={`data:image/png;base64,${a.data}`} className="max-w-full rounded" />}
                    {a.type === 'voice' && <audio controls src={`data:audio/webm;base64,${a.data}`} className="max-w-full" />}
                    {a.type === 'file' && <div className="text-blue-400 text-xs">📎 {a.filename}</div>}
                  </div>
                ))}
                {msg.content && (
                  <div className="prose prose-invert prose-sm max-w-none">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                )}
              </div>
            </div>
          ))}
          {progress.map(p => (
            <div key={p.id} className="flex justify-start">
              <div className="max-w-[75%] rounded-lg px-3 py-2 text-xs bg-gray-900 border border-gray-800">
                {p.type === 'thinking' && <span className="text-purple-400">💭 {p.content.slice(0, 200)}{p.content.length > 200 ? '...' : ''}</span>}
                {p.type === 'tool_use' && <span className="text-yellow-400">🔧 Using {p.content}...</span>}
              </div>
            </div>
          ))}
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
