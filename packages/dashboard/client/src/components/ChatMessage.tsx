export function ChatMessage({ role, content }: { role: string; content: string }) {
  const isUser = role === 'user';
  return (
    <div className={`my-3 p-3 rounded-lg ${isUser ? 'bg-blue-900/30 border border-blue-800/50' : 'bg-gray-800/50 border border-gray-700/50'}`}>
      <div className="text-xs font-medium mb-1 text-gray-400">{isUser ? 'User' : 'Assistant'}</div>
      <div className="text-sm whitespace-pre-wrap">{content}</div>
    </div>
  );
}
