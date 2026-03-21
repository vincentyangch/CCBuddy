import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Session {
  sessionId: string;
  channelId: string;
  lastMessage: string;
  timestamp: number;
}

interface ChatSidebarProps {
  activeChannelId: string;
  onSelectSession: (channelId: string) => void;
  onNewChat: () => void;
  refreshKey?: number;
}

/** Extract original channelId from sessionId (format: {user}-webchat-{channelId}) */
function extractChannelId(sessionId: string): string {
  const marker = '-webchat-';
  const idx = sessionId.indexOf(marker);
  return idx >= 0 ? sessionId.slice(idx + marker.length) : sessionId;
}

export function ChatSidebar({ activeChannelId, onSelectSession, onNewChat, refreshKey }: ChatSidebarProps) {
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    api.conversations({ platform: 'webchat', pageSize: '50' }).then(data => {
      const grouped = new Map<string, Session>();
      for (const msg of (data.messages ?? [])) {
        const channelId = extractChannelId(msg.sessionId);
        if (!grouped.has(channelId) || msg.timestamp > grouped.get(channelId)!.timestamp) {
          grouped.set(channelId, {
            sessionId: msg.sessionId,
            channelId,
            lastMessage: msg.content?.slice(0, 50) ?? '',
            timestamp: msg.timestamp,
          });
        }
      }
      setSessions(Array.from(grouped.values()).sort((a, b) => b.timestamp - a.timestamp));
    });
  }, [refreshKey]);

  return (
    <div className="w-56 bg-gray-900 border-r border-gray-800 p-3 flex flex-col">
      <button onClick={onNewChat} className="mb-3 px-3 py-2 bg-blue-600 rounded-lg text-sm text-white hover:bg-blue-500 w-full">
        + New Chat
      </button>
      <div className="text-xs text-gray-500 uppercase mb-2 px-1">Sessions</div>
      <div className="flex-1 overflow-auto space-y-1">
        {sessions.map(s => (
          <button
            key={s.channelId}
            onClick={() => onSelectSession(s.channelId)}
            className={`w-full text-left px-3 py-2 rounded-lg text-xs truncate ${
              s.channelId === activeChannelId
                ? 'bg-blue-900/30 border border-blue-800 text-white'
                : 'text-gray-400 hover:bg-gray-800 hover:text-white'
            }`}
          >
            <div className="truncate">{s.lastMessage || 'New conversation'}</div>
            <div className="text-gray-600 text-[10px] mt-0.5">{new Date(s.timestamp).toLocaleDateString()}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
