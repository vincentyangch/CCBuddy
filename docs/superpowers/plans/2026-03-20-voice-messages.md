# Voice Messages Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bidirectional voice messages — STT (OpenAI Whisper) transcribes inbound voice, TTS (OpenAI TTS) synthesizes outbound voice replies mirroring the input modality.

**Architecture:** `TranscriptionService` and `SpeechService` live in `@ccbuddy/core`. Gateway orchestrates voice: transcribes inbound voice attachments, mirrors voice input with voice output (≤500 chars). Platform adapters add `sendVoice` and voice message detection. Feature gated by `voice_enabled` config (default: false).

**Tech Stack:** TypeScript, OpenAI Whisper API, OpenAI TTS API, vitest

**Spec:** `docs/superpowers/specs/2026-03-20-voice-messages-design.md`

---

## Chunk 1: Config + Core Services

### Task 1: Update MediaConfig and PlatformAdapter interface

**Files:**
- Modify: `packages/core/src/config/schema.ts`
- Modify: `packages/core/src/types/platform.ts`

- [ ] **Step 1: Add voice fields to MediaConfig**

In `packages/core/src/config/schema.ts`, update `MediaConfig`:

```typescript
export interface MediaConfig {
  max_file_size_mb: number;
  allowed_mime_types: string[];
  voice_enabled: boolean;
  tts_max_chars: number;
}
```

Update `DEFAULT_CONFIG.media`:

```typescript
  media: {
    max_file_size_mb: 10,
    allowed_mime_types: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'],
    voice_enabled: false,
    tts_max_chars: 500,
  },
```

- [ ] **Step 2: Add sendVoice to PlatformAdapter**

In `packages/core/src/types/platform.ts`, add optional method:

```typescript
export interface PlatformAdapter {
  readonly platform: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
  sendText(channelId: string, text: string): Promise<void>;
  sendImage(channelId: string, image: Buffer, caption?: string): Promise<void>;
  sendFile(channelId: string, file: Buffer, filename: string): Promise<void>;
  sendVoice?(channelId: string, audio: Buffer): Promise<void>;
  setTypingIndicator(channelId: string, active: boolean): Promise<void>;
}
```

- [ ] **Step 3: Build to verify**

Run: `npm run build -w packages/core`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/config/schema.ts packages/core/src/types/platform.ts
git commit -m "feat(core): add voice_enabled config and sendVoice to PlatformAdapter"
```

---

### Task 2: Implement TranscriptionService

**Files:**
- Create: `packages/core/src/media/transcription.ts`
- Create: `packages/core/src/media/__tests__/transcription.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/media/__tests__/transcription.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { TranscriptionService } from '../transcription.js';

describe('TranscriptionService', () => {
  let service: TranscriptionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TranscriptionService('test-api-key');
  });

  it('calls OpenAI Whisper API with correct endpoint and auth', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Hello world' }),
    });

    await service.transcribe(Buffer.from('audio-data'), 'audio/ogg');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/transcriptions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-api-key',
        }),
      }),
    );
  });

  it('returns transcript text', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Hello world' }),
    });

    const result = await service.transcribe(Buffer.from('audio'), 'audio/ogg');
    expect(result).toBe('Hello world');
  });

  it('sends audio as multipart form data with correct filename extension', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'test' }),
    });

    await service.transcribe(Buffer.from('audio'), 'audio/mp4');

    const call = mockFetch.mock.calls[0];
    const body = call[1].body as FormData;
    expect(body).toBeInstanceOf(FormData);
  });

  it('throws on API error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    await expect(service.transcribe(Buffer.from('audio'), 'audio/ogg'))
      .rejects.toThrow('Transcription failed');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/media/__tests__/transcription.test.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement TranscriptionService**

Create `packages/core/src/media/transcription.ts`:

```typescript
const MIME_TO_EXT: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/webm': 'webm',
};

export class TranscriptionService {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    const ext = MIME_TO_EXT[mimeType] ?? 'ogg';
    const blob = new Blob([audio], { type: mimeType });

    const form = new FormData();
    form.append('file', blob, `audio.${ext}`);
    form.append('model', 'whisper-1');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: form,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Transcription failed (${response.status}): ${text}`);
    }

    const data = await response.json() as { text: string };
    return data.text;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/media/__tests__/transcription.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/media/transcription.ts packages/core/src/media/__tests__/transcription.test.ts
git commit -m "feat(core): implement TranscriptionService with OpenAI Whisper"
```

---

### Task 3: Implement SpeechService

**Files:**
- Create: `packages/core/src/media/speech.ts`
- Create: `packages/core/src/media/__tests__/speech.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/media/__tests__/speech.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { SpeechService } from '../speech.js';

describe('SpeechService', () => {
  let service: SpeechService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SpeechService('test-api-key');
  });

  it('calls OpenAI TTS API with correct parameters', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(100),
    });

    await service.synthesize('Hello world');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/speech',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-api-key',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          model: 'tts-1',
          input: 'Hello world',
          voice: 'alloy',
          response_format: 'opus',
        }),
      }),
    );
  });

  it('returns audio buffer', async () => {
    const audioData = new Uint8Array([1, 2, 3, 4]);
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => audioData.buffer,
    });

    const result = await service.synthesize('test');
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(4);
  });

  it('accepts custom voice parameter', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(10),
    });

    await service.synthesize('test', 'nova');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.voice).toBe('nova');
  });

  it('throws on API error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Server Error',
    });

    await expect(service.synthesize('test')).rejects.toThrow('Speech synthesis failed');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/media/__tests__/speech.test.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SpeechService**

Create `packages/core/src/media/speech.ts`:

```typescript
export class SpeechService {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async synthesize(text: string, voice = 'alloy'): Promise<Buffer> {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice,
        response_format: 'opus',
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Speech synthesis failed (${response.status}): ${text}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/media/__tests__/speech.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Export both services**

Add to the core package exports (find the media exports file or `packages/core/src/index.ts`):

```typescript
export { TranscriptionService } from './media/transcription.js';
export { SpeechService } from './media/speech.js';
```

- [ ] **Step 6: Build**

Run: `npm run build -w packages/core`
Expected: Clean build

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/media/speech.ts packages/core/src/media/__tests__/speech.test.ts packages/core/src/index.ts
git commit -m "feat(core): implement SpeechService with OpenAI TTS"
```

---

## Chunk 2: Platform Adapters + Gateway + Bootstrap

### Task 4: Add voice support to Discord adapter

**Files:**
- Modify: `packages/platform-discord/src/discord-adapter.ts`
- Test: `packages/platform-discord/src/__tests__/discord-adapter.test.ts`

- [ ] **Step 1: Read existing adapter code**

Read `packages/platform-discord/src/discord-adapter.ts` to understand how attachments are processed and how `sendImage`/`sendFile` work.

- [ ] **Step 2: Add voice detection in attachment processing**

In the attachment normalization code, detect audio MIME types and set `type: 'voice'`:

```typescript
// Existing: mimeType.startsWith('image/') ? 'image' : 'file'
// Updated:
const attachmentType = mimeType.startsWith('image/') ? 'image'
  : mimeType.startsWith('audio/') ? 'voice'
  : 'file';
```

- [ ] **Step 3: Implement sendVoice**

Add `sendVoice` method to `DiscordAdapter`:

```typescript
  async sendVoice(channelId: string, audio: Buffer): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;
    const textChannel = channel as import('discord.js').TextChannel;
    await textChannel.send({
      files: [{ attachment: audio, name: 'voice.ogg' }],
    });
  }
```

- [ ] **Step 4: Add test for sendVoice**

Add test to `packages/platform-discord/src/__tests__/discord-adapter.test.ts` (follow existing patterns for `sendImage`/`sendFile`).

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/platform-discord/ --reporter=verbose`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/platform-discord/src/discord-adapter.ts packages/platform-discord/src/__tests__/discord-adapter.test.ts
git commit -m "feat(discord): add voice message detection and sendVoice"
```

---

### Task 5: Add voice support to Telegram adapter

**Files:**
- Modify: `packages/platform-telegram/src/telegram-adapter.ts`
- Test: `packages/platform-telegram/src/__tests__/telegram-adapter.test.ts`

- [ ] **Step 1: Read existing adapter code**

Read `packages/platform-telegram/src/telegram-adapter.ts` to understand how photo/document listeners work.

- [ ] **Step 2: Add `message:voice` listener**

Following the pattern of the existing `message:photo` and `message:document` listeners, add a `message:voice` listener:

```typescript
    this.bot.on('message:voice', async (ctx) => {
      if (!this.messageHandler) return;

      const voice = ctx.message.voice;
      const file = await ctx.api.getFile(voice.file_id);
      const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;

      try {
        const data = await fetchAttachment(url, this.mediaConfig.max_file_size_mb * 1024 * 1024);
        const attachment: Attachment = {
          type: 'voice',
          mimeType: voice.mime_type ?? 'audio/ogg',
          data,
          filename: `voice.ogg`,
        };

        const msg: IncomingMessage = {
          platform: 'telegram',
          platformUserId: String(ctx.from?.id ?? ''),
          channelId: String(ctx.chat.id),
          channelType: ctx.chat.type === 'private' ? 'dm' : 'group',
          text: '',
          attachments: [attachment],
          isMention: false,
          raw: ctx,
        };

        await this.messageHandler(msg);
      } catch (err) {
        console.error('[TelegramAdapter] Failed to download voice:', (err as Error).message);
      }
    });
```

- [ ] **Step 3: Implement sendVoice**

```typescript
  async sendVoice(channelId: string, audio: Buffer): Promise<void> {
    await this.bot.api.sendVoice(channelId, new InputFile(audio, 'voice.ogg'));
  }
```

Add `InputFile` import from grammY if not already imported.

- [ ] **Step 4: Add tests**

Add tests for the voice listener and sendVoice to the Telegram test file.

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/platform-telegram/ --reporter=verbose`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/platform-telegram/src/telegram-adapter.ts packages/platform-telegram/src/__tests__/telegram-adapter.test.ts
git commit -m "feat(telegram): add voice message listener and sendVoice"
```

---

### Task 6: Add voice orchestration to Gateway

**Files:**
- Modify: `packages/gateway/src/gateway.ts`
- Test: `packages/gateway/src/__tests__/gateway.test.ts`

- [ ] **Step 1: Update GatewayDeps**

Add optional voice services to `GatewayDeps`:

```typescript
export interface GatewayDeps {
  // ... existing fields ...
  transcriptionService?: TranscriptionService;
  speechService?: SpeechService;
  voiceConfig?: { enabled: boolean; ttsMaxChars: number };
}
```

Add imports:
```typescript
import { TranscriptionService } from '@ccbuddy/core';
import { SpeechService } from '@ccbuddy/core';
```

- [ ] **Step 2: Add voice transcription in handleIncomingMessage**

After building the agent request (step 7 in the existing code), before calling `executeAndRoute`:

```typescript
    // 7b. Transcribe voice attachments
    let voiceInput = false;
    if (this.deps.transcriptionService && msg.attachments.some(a => a.type === 'voice')) {
      for (const att of msg.attachments) {
        if (att.type === 'voice' && !att.transcript) {
          try {
            att.transcript = await this.deps.transcriptionService.transcribe(att.data, att.mimeType);
          } catch (err) {
            console.error('[Gateway] Transcription failed:', (err as Error).message);
          }
        }
      }

      // Use transcript as prompt if original text is empty
      const transcripts = msg.attachments
        .filter(a => a.type === 'voice' && a.transcript)
        .map(a => a.transcript!);
      if (transcripts.length > 0) {
        const transcriptText = transcripts.join(' ');
        request.prompt = msg.text
          ? `${msg.text}\n\n[Voice message] ${transcriptText}`
          : `[Voice message] ${transcriptText}`;
        voiceInput = true;

        // Update stored message with transcript
        this.deps.storeMessage({
          userId: user.name,
          sessionId,
          platform: msg.platform,
          content: request.prompt,
          role: 'user',
          attachments: attachmentMeta,
        });
      }
    }
```

Note: The user message was already stored earlier with the original text. This second store call updates it with the transcript. Alternatively, move the storeMessage call to after transcription. Read the code carefully and pick the cleaner approach.

- [ ] **Step 3: Update executeAndRoute for voice mirroring**

Modify the method signature to accept the voice flag:

```typescript
  private async executeAndRoute(request: AgentRequest, msg: IncomingMessage, voiceInput = false): Promise<void> {
```

In the `case 'complete'` block, after storing the message and publishing the event, replace the text sending logic:

```typescript
          case 'complete': {
            // ... existing store + publish ...

            // Voice mirror logic
            if (voiceInput && this.deps.speechService && adapter.sendVoice) {
              const maxChars = this.deps.voiceConfig?.ttsMaxChars ?? 500;
              if (event.response.length <= maxChars) {
                // Short response: send as voice only
                try {
                  const audio = await this.deps.speechService.synthesize(event.response);
                  await adapter.sendVoice(msg.channelId, audio);
                } catch (err) {
                  console.error('[Gateway] TTS failed, falling back to text:', (err as Error).message);
                  const chunks = chunkMessage(event.response, limit);
                  for (const chunk of chunks) await adapter.sendText(msg.channelId, chunk);
                }
              } else {
                // Long response: voice for first part, text for rest
                const voicePart = event.response.slice(0, maxChars);
                const textPart = event.response.slice(maxChars);
                try {
                  const audio = await this.deps.speechService.synthesize(voicePart);
                  await adapter.sendVoice(msg.channelId, audio);
                } catch (err) {
                  console.error('[Gateway] TTS failed:', (err as Error).message);
                }
                const chunks = chunkMessage(textPart, limit);
                for (const chunk of chunks) await adapter.sendText(msg.channelId, chunk);
              }
            } else {
              // Normal text response
              const chunks = chunkMessage(event.response, limit);
              for (const chunk of chunks) await adapter.sendText(msg.channelId, chunk);
            }

            await this.deliverOutboundMedia(adapter, msg.channelId);
            break;
          }
```

- [ ] **Step 4: Update the executeAndRoute call site**

In `handleIncomingMessage`, pass the `voiceInput` flag:

```typescript
    await this.executeAndRoute(request, msg, voiceInput);
```

- [ ] **Step 5: Add tests**

Add to `packages/gateway/src/__tests__/gateway.test.ts`:

```typescript
describe('voice message handling', () => {
  // Test: voice attachment triggers transcription
  // Test: transcript prepended to prompt
  // Test: voice input → voice response (short)
  // Test: voice input → voice + text response (long)
  // Test: text input → text response (no TTS)
  // Test: no transcription when service not provided
  // Test: TTS failure falls back to text
});
```

Follow the existing test patterns — mock the adapter, transcription service, speech service.

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/gateway/ --reporter=verbose`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/gateway.ts packages/gateway/src/__tests__/gateway.test.ts
git commit -m "feat(gateway): add voice transcription and TTS mirror logic"
```

---

### Task 7: Bootstrap wiring

**Files:**
- Modify: `packages/main/src/bootstrap.ts`

- [ ] **Step 1: Add voice service creation**

After the gateway deps setup, before creating the Gateway, add:

```typescript
  // Voice services (optional)
  let transcriptionService: TranscriptionService | undefined;
  let speechService: SpeechService | undefined;
  if (config.media.voice_enabled) {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      throw new Error('voice_enabled is true but OPENAI_API_KEY is not set');
    }
    transcriptionService = new TranscriptionService(openaiKey);
    speechService = new SpeechService(openaiKey);
  }
```

Add imports:
```typescript
import { TranscriptionService, SpeechService } from '@ccbuddy/core';
```

- [ ] **Step 2: Pass to Gateway deps**

Add to the Gateway constructor call:

```typescript
    transcriptionService,
    speechService,
    voiceConfig: { enabled: config.media.voice_enabled, ttsMaxChars: config.media.tts_max_chars },
```

- [ ] **Step 3: Build and test**

Run: `npm run build && npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/main/src/bootstrap.ts
git commit -m "feat(main): wire voice services into bootstrap when voice_enabled"
```

---

### Task 8: Enable and smoke test

- [ ] **Step 1: Add OPENAI_API_KEY to launchd plist**

Add to `~/Library/LaunchAgents/com.ccbuddy.agent.plist` EnvironmentVariables:
```xml
<key>OPENAI_API_KEY</key>
<string>YOUR_KEY_HERE</string>
```

- [ ] **Step 2: Enable voice in local.yaml**

Add to `config/local.yaml` under `ccbuddy:`:
```yaml
  media:
    voice_enabled: true
```

- [ ] **Step 3: Restart CCBuddy**

```bash
launchctl stop com.ccbuddy.agent && sleep 3 && launchctl start com.ccbuddy.agent
```

- [ ] **Step 4: Test on Discord**

Send a voice message to CCBuddy. Verify:
- Transcription works (CCBuddy understands the voice content)
- Reply comes back as voice message (for short responses)
- Long responses split into voice + text
