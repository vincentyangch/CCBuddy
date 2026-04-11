import { useEffect, useState, useRef, useCallback } from 'react';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { Button, PageHeader, Panel } from '../components/ui';

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
      <PageHeader
        domain="Operations"
        title="Logs"
        description="Process output for startup, adapters, and agent work."
        actions={(
          <>
            <div className="flex flex-wrap gap-1">
              {LOG_FILES.map(f => (
                <Button
                  key={f}
                  onClick={() => setFile(f)}
                  variant={file === f ? 'primary' : 'secondary'}
                  className="px-3 py-1 text-sm"
                >
                  {f}
                </Button>
              ))}
            </div>
            <input
              placeholder="Filter..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
              className="sd-input w-48 text-sm"
            />
            <Button onClick={() => setAutoScroll(!autoScroll)} variant={autoScroll ? 'primary' : 'secondary'} className="px-3 py-1 text-sm">
              {autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
            </Button>
          </>
        )}
      />
      <Panel className="flex-1 overflow-auto p-3 font-mono text-xs">
        {filtered.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap py-0.5 hover:bg-[color:var(--sd-panel-raised)]">{line}</div>
        ))}
        <div ref={endRef} />
      </Panel>
    </div>
  );
}
