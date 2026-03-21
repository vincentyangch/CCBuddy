import { useState, useRef } from 'react';

interface ChatInputProps {
  onSend: (text: string, attachments: Array<{ data: string; mimeType: string; filename: string }>) => void;
  disabled?: boolean;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Array<{ data: string; mimeType: string; filename: string }>>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const [recording, setRecording] = useState(false);

  const handleSend = () => {
    if (!text.trim() && attachments.length === 0) return;
    onSend(text, attachments);
    setText('');
    setAttachments([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      const data = await fileToBase64(file);
      setAttachments(prev => [...prev, { data, mimeType: file.type, filename: file.name }]);
    }
    e.target.value = '';
  };

  const toggleRecording = async () => {
    if (recording && mediaRef.current) {
      mediaRef.current.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunks, { type: mimeType });
        const data = await blobToBase64(blob);
        setAttachments(prev => [...prev, { data, mimeType, filename: `voice.${mimeType.split('/')[1]}` }]);
      };
      recorder.start();
      mediaRef.current = recorder;
      setRecording(true);
    } catch {
      // Microphone access denied or unavailable
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="border-t border-gray-800 p-3">
      {attachments.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {attachments.map((a, i) => (
            <div key={i} className="flex items-center gap-1 bg-gray-800 rounded px-2 py-1 text-xs text-gray-400">
              <span>{a.filename}</span>
              <button onClick={() => removeAttachment(i)} className="text-gray-600 hover:text-red-400">×</button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          disabled={disabled}
          rows={1}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 resize-none disabled:opacity-50 focus:outline-none focus:border-blue-600"
        />
        <input ref={fileRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
        <button onClick={() => fileRef.current?.click()} className="w-8 h-8 flex items-center justify-center bg-gray-800 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700" title="Attach file">
          📎
        </button>
        <button onClick={toggleRecording} className={`w-8 h-8 flex items-center justify-center rounded-lg ${recording ? 'bg-red-600 text-white animate-pulse' : 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700'}`} title="Record voice">
          🎤
        </button>
        <button onClick={handleSend} disabled={disabled || (!text.trim() && attachments.length === 0)} className="w-8 h-8 flex items-center justify-center bg-blue-600 rounded-lg text-white disabled:opacity-50 hover:bg-blue-500">
          →
        </button>
      </div>
    </div>
  );
}

function fileToBase64(file: File | Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.readAsDataURL(file);
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return fileToBase64(blob);
}
