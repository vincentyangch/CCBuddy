# Voice Messages Design

## Overview

Add bidirectional voice message support: inbound STT (OpenAI Whisper) transcribes user voice messages to text, outbound TTS (OpenAI TTS) synthesizes voice replies. Voice input mirrors voice output — if you speak, CCBuddy speaks back. Gated by `voice_enabled` config flag (default: false).

## Config

Add to `MediaConfig` in `packages/core/src/config/schema.ts`:

```typescript
export interface MediaConfig {
  max_file_size_mb: number;
  allowed_mime_types: string[];
  voice_enabled: boolean;   // default: false
  tts_max_chars: number;    // default: 500
}
```

- `voice_enabled: false` by default — no voice processing unless explicitly turned on
- When enabled, requires `OPENAI_API_KEY` environment variable
- If `voice_enabled: true` and `OPENAI_API_KEY` is not set, throw at bootstrap with a clear error message
- Audio MIME types (`audio/ogg`, `audio/mp4`, `audio/wav`, `audio/mpeg`, `audio/webm`) are accepted for voice processing when `voice_enabled: true`, independent of `allowed_mime_types` (which governs document/image attachments)
- Voice messages exceeding `max_file_size_mb` are rejected with a user-facing message

## STT Pipeline (Inbound Voice)

### TranscriptionService

`packages/core/src/media/transcription.ts`:

```typescript
class TranscriptionService {
  constructor(apiKey: string)
  transcribe(audio: Buffer, mimeType: string): Promise<string>
}
```

- Calls `https://api.openai.com/v1/audio/transcriptions` with `model: 'whisper-1'`
- Sends audio as multipart form data with appropriate file extension based on MIME type
- Accepts: `audio/ogg`, `audio/mp4`, `audio/wav`, `audio/mpeg`, `audio/webm`
- Returns transcript text string

### Platform Adapter Changes

Adapters remain thin transport layers — they detect and download voice messages but do **not** transcribe. Transcription happens in the Gateway.

**Discord:** In attachment processing, detect `audio/*` MIME types. Set `type: 'voice'`. Download audio data into `Attachment.data`. No transcription here.

**Telegram:** Add `message:voice` event listener. Telegram sends voice messages as OGG/Opus. Download via `getFile` API, create attachment with `type: 'voice'`. No transcription here.

Both adapters: if `voice_enabled` is false, voice messages are ignored (not forwarded to Gateway).

### PlatformAdapter Interface Update

Add optional `sendVoice` to the `PlatformAdapter` interface in `packages/core/src/types/platform.ts`:

```typescript
export interface PlatformAdapter {
  // ... existing methods ...
  sendVoice?(channelId: string, audio: Buffer): Promise<void>;
}
```

Optional so non-voice-capable adapters remain valid.

### Gateway Voice Processing

All voice orchestration lives in the Gateway, in `handleIncomingMessage`:

1. Check if any attachment has `type: 'voice'`
2. If yes and `transcriptionService` is available:
   - Call `transcriptionService.transcribe(attachment.data, attachment.mimeType)`
   - Set `attachment.transcript` with the result
   - Track `voiceInput = true` as a local variable
3. Prepend transcript to prompt: `[Voice message] {transcript}`
4. Store the transcript-enhanced text as the message content (for memory consistency)
5. Pass `voiceInput` flag through to `executeAndRoute`

### Gateway Mirror Logic (in `executeAndRoute`)

On agent `complete` event, check the `voiceInput` flag:

- **Voice input + response ≤ `tts_max_chars` (500):** Call `speechService.synthesize(responseText)`, send via `adapter.sendVoice(channelId, audioBuffer)`. Do not send text.
- **Voice input + response > `tts_max_chars`:** Synthesize first `tts_max_chars` characters as voice, send remainder as text message.
- **Text input:** Send as text (no TTS)

If `adapter.sendVoice` is not available (adapter doesn't support voice output), fall back to text.

## TTS Pipeline (Outbound Voice)

### SpeechService

`packages/core/src/media/speech.ts`:

```typescript
class SpeechService {
  constructor(apiKey: string)
  synthesize(text: string, voice?: string): Promise<Buffer>
}
```

- Calls `https://api.openai.com/v1/audio/speech` with `model: 'tts-1'`, `response_format: 'opus'`
- Returns OGG/Opus buffer — natively supported by Discord and Telegram
- Default voice: `'alloy'`

### Platform Adapter Additions

**Discord:** Implement `sendVoice(channelId, audio)` — sends as message attachment with `.ogg` extension via Discord.js `channel.send({ files: [...] })`.

**Telegram:** Implement `sendVoice(channelId, audio)` — uses grammY `ctx.api.sendVoice(channelId, ...)`.

## Bootstrap Wiring

In `packages/main/src/bootstrap.ts`:

1. If `config.media.voice_enabled`:
   - Read `OPENAI_API_KEY` from `process.env`
   - If not set, throw: `"voice_enabled is true but OPENAI_API_KEY is not set"`
   - Create `TranscriptionService(apiKey)` and `SpeechService(apiKey)`
   - Pass to Gateway deps as `transcriptionService` and `speechService` (new optional fields on `GatewayDeps`)
   - Pass `voice_enabled` flag to adapter constructors so they know to listen for voice messages

## Known Limitations

- Voice responses are not reflected in `OutgoingMessageEvent` metadata (no `voiceAttached` flag). Can be added later if memory/logging needs this distinction.
- No separate rate limiting for voice API calls — relies on existing per-user rate limits.

## Testing Strategy

### TranscriptionService (unit)
- Mock fetch — verify correct OpenAI endpoint, model, multipart form body
- Test transcript extraction from response JSON
- Test error handling (API error, invalid response)

### SpeechService (unit)
- Mock fetch — verify correct endpoint, model, voice, response_format
- Test audio buffer returned
- Test error handling

### Platform Adapters (unit)
- Discord: audio attachment detected as `type: 'voice'`
- Telegram: `message:voice` listener fires, downloads audio
- Both: `sendVoice` sends audio buffer correctly
- Both: voice ignored when `voice_enabled: false`

### Gateway (unit)
- Voice attachment transcribed via TranscriptionService
- Transcript prepended to prompt
- Mirror: voice input → voice response (≤500 chars)
- Mirror: voice input → voice + text (>500 chars)
- Text input → text response (no TTS)
- No transcription when transcriptionService not provided

### Integration
- Manual smoke test on Discord: send voice message, verify transcription + voice reply
