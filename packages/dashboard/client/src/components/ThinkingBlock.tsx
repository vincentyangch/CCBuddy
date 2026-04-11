import { useState } from 'react';
import { Panel } from './ui';

export function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Panel className="my-2 overflow-hidden">
      <button onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between bg-[color:var(--sd-panel-raised)] px-3 py-2 text-left text-sm text-[color:var(--sd-muted)] hover:text-[color:var(--sd-text)]">
        <span>Thinking...</span>
        <span>{expanded ? '▼' : '▶'}</span>
      </button>
      {expanded && <pre className="max-h-96 overflow-auto whitespace-pre-wrap px-3 py-2 text-xs text-[color:var(--sd-text)]">{content}</pre>}
    </Panel>
  );
}
