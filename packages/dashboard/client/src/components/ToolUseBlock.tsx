import { Panel } from './ui';

export function ToolUseBlock({ tool, input, output }: { tool: string; input?: string; output?: string }) {
  return (
    <Panel className="my-2 overflow-hidden">
      <div className="bg-[color:var(--sd-panel-raised)] px-3 py-2 font-mono text-sm">
        <span className="text-[color:var(--sd-warning-ink)]">Tool:</span> {tool}
      </div>
      {input && <pre className="max-h-48 overflow-auto whitespace-pre-wrap border-t border-[color:var(--sd-border)] px-3 py-2 text-xs text-[color:var(--sd-text)]">{input}</pre>}
      {output && <pre className="max-h-48 overflow-auto whitespace-pre-wrap border-t border-[color:var(--sd-border)] px-3 py-2 text-xs text-[color:var(--sd-muted)]">{output}</pre>}
    </Panel>
  );
}
