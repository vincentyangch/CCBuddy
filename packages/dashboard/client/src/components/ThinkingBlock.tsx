import { useState } from 'react';

export function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="my-2 border border-gray-700 rounded-lg overflow-hidden">
      <button onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 text-left text-sm text-gray-400 bg-gray-800/50 hover:bg-gray-800 flex justify-between items-center">
        <span>Thinking...</span>
        <span>{expanded ? '▼' : '▶'}</span>
      </button>
      {expanded && <pre className="px-3 py-2 text-xs text-gray-300 whitespace-pre-wrap max-h-96 overflow-auto">{content}</pre>}
    </div>
  );
}
