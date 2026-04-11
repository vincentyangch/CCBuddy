import { useState, useRef } from 'react';
import { Button } from './ui';

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
    <div className="border-t border-[color:var(--sd-border)] p-3">
      {attachments.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {attachments.map((a, i) => (
            <div key={i} className="flex items-center gap-1 rounded-[var(--sd-radius)] border border-[color:var(--sd-border)] bg-[color:var(--sd-panel-raised)] px-2 py-1 text-xs text-[color:var(--sd-muted)]">
              <span>{a.filename}</span>
              <button onClick={() => removeAttachment(i)} className="text-[color:var(--sd-subtle)] hover:text-[color:var(--sd-danger)]">×</button>
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
          className="sd-input flex-1 resize-none text-sm placeholder:text-[color:var(--sd-subtle)]"
        />
        <input ref={fileRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
        <Button onClick={() => fileRef.current?.click()} variant="secondary" className="h-10 w-10 min-h-0 p-0" title="Attach file">
          📎
        </Button>
        <Button onClick={toggleRecording} variant="secondary" className={`h-10 w-10 min-h-0 p-0 ${recording ? 'animate-pulse border-[color:var(--sd-danger)] bg-[color:var(--sd-danger)] text-white' : ''}`} title="Record voice">
          🎤
        </Button>
        <Button onClick={handleSend} disabled={disabled || (!text.trim() && attachments.length === 0)} className="h-10 w-10 min-h-0 p-0">
          →
        </Button>
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
