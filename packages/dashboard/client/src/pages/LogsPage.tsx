import { useEffect, useState, useRef, useCallback } from 'react';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';

const LOG_FILES = ['stdout', 'stderr', 'app'] as const;

export function LogsPage() {
  const [file, setFile] = useState<string>('stdout');
  const [lines, setLines] = useState<string[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.logs({ file, lines: '500' }).then(d => setLines(d.lines));
  }, [file]);

  useWebSocket(useCallback((type: string, data: any) => {
    if (type === 'log.line' && data.file === file) {
      setLines(prev => [...prev.slice(-999), data.line]);
    }
  }, [file]));

  useEffect(() => {
    if (autoScroll) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines, autoScroll]);

  const filtered = filter ? lines.filter(l => l.toLowerCase().includes(filter.toLowerCase())) : lines;

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-2xl font-bold">Logs</h2>
        <div className="flex gap-1 ml-4">
          {LOG_FILES.map(f => (
            <button key={f} onClick={() => setFile(f)}
              className={`px-3 py-1 rounded text-sm ${file === f ? 'bg-blue-600' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
              {f}
            </button>
          ))}
        </div>
        <input placeholder="Filter..." value={filter} onChange={e => setFilter(e.target.value)}
          className="px-3 py-1 bg-gray-800 border border-gray-700 rounded text-sm ml-auto w-48" />
        <button onClick={() => setAutoScroll(!autoScroll)}
          className={`px-3 py-1 rounded text-sm ${autoScroll ? 'bg-green-700' : 'bg-gray-800 text-gray-400'}`}>
          {autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
        </button>
      </div>
      <div className="flex-1 bg-gray-900 rounded-xl border border-gray-800 overflow-auto font-mono text-xs p-3">
        {filtered.map((line, i) => (
          <div key={i} className="py-0.5 hover:bg-gray-800/50 whitespace-pre-wrap">{line}</div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
