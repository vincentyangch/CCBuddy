export function ToolUseBlock({ tool, input, output }: { tool: string; input?: string; output?: string }) {
  return (
    <div className="my-2 border border-gray-700 rounded-lg overflow-hidden">
      <div className="px-3 py-2 text-sm bg-gray-800/50 font-mono">
        <span className="text-yellow-400">Tool:</span> {tool}
      </div>
      {input && <pre className="px-3 py-2 text-xs text-gray-300 border-t border-gray-700 whitespace-pre-wrap max-h-48 overflow-auto">{input}</pre>}
      {output && <pre className="px-3 py-2 text-xs text-gray-400 border-t border-gray-700 whitespace-pre-wrap max-h-48 overflow-auto">{output}</pre>}
    </div>
  );
}
