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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!key) return;
    api.sessionEvents(key).then(d => { setEvents(d.events); setLoading(false); });
  }, [key]);

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
