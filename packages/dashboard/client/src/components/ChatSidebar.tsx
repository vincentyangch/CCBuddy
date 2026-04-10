import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Session {
  sessionId: string;
  channelId: string;
  lastMessage: string;
  timestamp: number;
}

interface ChatSidebarProps {
  activeSessionId: string | null;
  pendingChannelId?: string | null;
  onSelectSession: (session: { sessionId: string; channelId: string }) => void;
  onNewChat: () => void;
  onDeleteSession?: (sessionId: string) => void;
  refreshKey?: number;
}

/** Extract original channelId from sessionId (format: {user}-webchat-{channelId}) */
function extractChannelId(sessionId: string): string {
  const marker = '-webchat-';
  const idx = sessionId.indexOf(marker);
  return idx >= 0 ? sessionId.slice(idx + marker.length) : sessionId;
}

export function ChatSidebar({ activeSessionId, pendingChannelId, onSelectSession, onNewChat, onDeleteSession, refreshKey }: ChatSidebarProps) {
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    api.conversations({ platform: 'webchat', pageSize: '200' }).then(data => {
      // Group by exact sessionId
      const grouped = new Map<string, Session>();
      for (const msg of (data.messages ?? [])) {
        if (!grouped.has(msg.sessionId) || msg.timestamp > grouped.get(msg.sessionId)!.timestamp) {
          grouped.set(msg.sessionId, {
            sessionId: msg.sessionId,
            channelId: extractChannelId(msg.sessionId),
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
      <div className="text-xs text-gray-500 uppercase mb-2 px-1">Recent chats</div>
      <div className="flex-1 overflow-auto space-y-1">
        {pendingChannelId && !sessions.some(s => s.channelId === pendingChannelId) && (
          <div
            className="w-full text-left px-3 py-2 rounded-lg text-xs truncate bg-blue-900/30 border border-blue-800 text-white"
          >
            <div className="truncate">New conversation</div>
            <div className="text-gray-600 text-[10px] mt-0.5">now</div>
          </div>
        )}
        {sessions.map(s => (
          <div
            key={s.sessionId}
            className={`group relative w-full text-left px-3 py-2 rounded-lg text-xs truncate cursor-pointer ${
              s.sessionId === activeSessionId
                ? 'bg-blue-900/30 border border-blue-800 text-white'
                : 'text-gray-400 hover:bg-gray-800 hover:text-white'
            }`}
            onClick={() => onSelectSession(s)}
          >
            <div className="truncate pr-5">{s.lastMessage || 'New conversation'}</div>
            <div className="text-gray-600 text-[10px] mt-0.5">{new Date(s.timestamp).toLocaleDateString()}</div>
            {onDeleteSession && (
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteSession(s.sessionId); }}
                className="absolute top-1.5 right-1.5 hidden group-hover:block text-gray-600 hover:text-red-400 text-xs"
                title="Delete chat"
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
