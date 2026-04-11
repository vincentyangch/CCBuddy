import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Button } from './ui';

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
    <div className="flex max-h-64 w-full flex-col border-b border-[color:var(--sd-border)] bg-[color:var(--sd-panel)] p-3 lg:max-h-none lg:w-56 lg:border-b-0 lg:border-r">
      <Button onClick={onNewChat} className="mb-3 w-full px-3 py-2 text-sm">
        + New Chat
      </Button>
      <div className="mb-2 px-1 text-xs uppercase text-[color:var(--sd-subtle)]">Recent chats</div>
      <div className="flex-1 overflow-auto space-y-1">
        {pendingChannelId && !sessions.some(s => s.channelId === pendingChannelId) && (
          <div
            className="w-full truncate rounded-[var(--sd-radius)] border border-[color:var(--sd-accent)] bg-[color-mix(in_srgb,var(--sd-accent)_14%,transparent)] px-3 py-2 text-left text-xs text-[color:var(--sd-text)]"
          >
            <div className="truncate">New conversation</div>
            <div className="mt-0.5 text-[10px] text-[color:var(--sd-muted)]">now</div>
          </div>
        )}
        {sessions.map(s => (
          <div
            key={s.sessionId}
            className={`flex w-full items-stretch gap-1 rounded-[var(--sd-radius)] ${
              s.sessionId === activeSessionId
                ? 'border border-[color:var(--sd-accent)] bg-[color-mix(in_srgb,var(--sd-accent)_14%,transparent)] text-[color:var(--sd-text)]'
                : 'text-[color:var(--sd-muted)] hover:bg-[color:var(--sd-panel-raised)] hover:text-[color:var(--sd-text)]'
            }`}
          >
            <button
              type="button"
              onClick={() => onSelectSession(s)}
              className="min-w-0 flex-1 rounded-[var(--sd-radius)] px-3 py-2 text-left text-xs text-inherit"
            >
              <div className="truncate">{s.lastMessage || 'New conversation'}</div>
              <div className="mt-0.5 text-[10px] text-[color:var(--sd-subtle)]">{new Date(s.timestamp).toLocaleDateString()}</div>
            </button>
            {onDeleteSession && (
              <button
                type="button"
                onClick={() => onDeleteSession(s.sessionId)}
                className="flex w-8 flex-none items-center justify-center rounded-[var(--sd-radius)] text-xs text-[color:var(--sd-subtle)] hover:bg-[color:var(--sd-panel-raised)] hover:text-[color:var(--sd-danger)]"
                aria-label={`Delete chat ${s.lastMessage || s.sessionId}`}
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
