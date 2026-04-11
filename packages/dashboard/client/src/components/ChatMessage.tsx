import { Panel } from './ui';

export function ChatMessage({ role, content }: { role: string; content: string }) {
  const isUser = role === 'user';
  return (
    <Panel accent={isUser} className="my-3 p-3">
      <div className="mb-1 text-xs font-medium text-[color:var(--sd-muted)]">{isUser ? 'User' : 'Assistant'}</div>
      <div className="whitespace-pre-wrap text-sm">{content}</div>
    </Panel>
  );
}
