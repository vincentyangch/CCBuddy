# Media Handling Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable CCBuddy to receive images/documents from users and send media back via skills, across Discord and Telegram.

**Architecture:** Shared utilities in `@ccbuddy/core` (download, validate, convert) used by platform adapters to fetch attachment data and by agent backends to convert to Claude content blocks. Outbound media flows through a new `AgentMediaEvent` in the event stream, detected by agent backends from skill tool results and routed by the gateway to platform adapters.

**Tech Stack:** TypeScript, discord.js v14, grammY v1, @anthropic-ai/claude-agent-sdk, vitest

**Spec:** `docs/superpowers/specs/2026-03-19-media-handling-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/core/src/media/download.ts` | Create | Shared download helper (URL → Buffer with timeout + size limit) |
| `packages/core/src/media/validator.ts` | Create | Shared attachment validator (size + mime check) |
| `packages/core/src/media/conversion.ts` | Create | Attachment → Claude content block conversion |
| `packages/core/src/media/index.ts` | Create | Barrel export for media utilities |
| `packages/core/src/media/__tests__/download.test.ts` | Create | Download helper tests |
| `packages/core/src/media/__tests__/validator.test.ts` | Create | Validator tests |
| `packages/core/src/media/__tests__/conversion.test.ts` | Create | Conversion helper tests |
| `packages/core/src/index.ts` | Modify | Re-export media utilities |
| `packages/core/src/types/agent.ts` | Modify | Add `AgentMediaEvent` to `AgentEvent` union |
| `packages/platforms/discord/src/discord-adapter.ts` | Modify | Async normalizeMessage, download attachments, validate |
| `packages/platforms/telegram/src/telegram-adapter.ts` | Modify | Listen for photo/document, download, validate |
| `packages/agent/src/backends/sdk-backend.ts` | Modify | Build SDKUserMessage with content blocks |
| `packages/agent/src/backends/cli-backend.ts` | Modify | Metadata-only fallback with warning |
| `packages/gateway/src/gateway.ts` | Modify | Add attachments to StoreMessageParams, handle media events |
| `packages/main/src/bootstrap.ts` | Modify | Pass attachments in storeMessage closure |
| `packages/skills/src/types.ts` | Modify | Add `media?` to SkillOutput |

---

## Chunk 1: Shared Media Utilities

### Task 1: Download helper

**Files:**
- Create: `packages/core/src/media/download.ts`
- Create: `packages/core/src/media/__tests__/download.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/src/media/__tests__/download.test.ts
import { describe, it, expect, vi, afterAll, beforeAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fetchAttachment } from '../download.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/image.png') {
      const data = Buffer.from('fake-image-data');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.byteLength });
      res.end(data);
    } else if (req.url === '/large') {
      // Send 2MB of data
      const data = Buffer.alloc(2 * 1024 * 1024, 'x');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(data);
    } else if (req.url === '/slow') {
      // Never respond — tests timeout
    } else if (req.url === '/error') {
      res.writeHead(500);
      res.end('Internal Server Error');
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' ? addr!.port : 0}`;
      resolve();
    });
  });
});

afterAll(() => { server?.close(); });

describe('fetchAttachment', () => {
  it('downloads binary data from a URL', async () => {
    const buf = await fetchAttachment(`${baseUrl}/image.png`);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.toString()).toBe('fake-image-data');
  });

  it('throws on HTTP error', async () => {
    await expect(fetchAttachment(`${baseUrl}/error`)).rejects.toThrow();
  });

  it('throws on 404', async () => {
    await expect(fetchAttachment(`${baseUrl}/missing`)).rejects.toThrow();
  });

  it('enforces maxBytes limit', async () => {
    await expect(
      fetchAttachment(`${baseUrl}/large`, { maxBytes: 1024 })
    ).rejects.toThrow(/exceeded/i);
  });

  it('enforces timeout', async () => {
    await expect(
      fetchAttachment(`${baseUrl}/slow`, { timeoutMs: 500 })
    ).rejects.toThrow();
  }, 5000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/media/__tests__/download.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement download helper**

```typescript
// packages/core/src/media/download.ts

export interface FetchAttachmentOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

export async function fetchAttachment(
  url: string,
  opts: FetchAttachmentOptions = {},
): Promise<Buffer> {
  const { timeoutMs = 30_000, maxBytes } = opts;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Failed to download attachment: HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for await (const chunk of response.body) {
    totalBytes += chunk.byteLength;
    if (maxBytes && totalBytes > maxBytes) {
      throw new Error(`Attachment size exceeded limit of ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/media/__tests__/download.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/media/download.ts packages/core/src/media/__tests__/download.test.ts
git commit -m "feat(core): add fetchAttachment download helper with timeout and size limit"
```

---

### Task 2: Attachment validator

**Files:**
- Create: `packages/core/src/media/validator.ts`
- Create: `packages/core/src/media/__tests__/validator.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/src/media/__tests__/validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateAttachment } from '../validator.js';
import type { Attachment } from '../../types/agent.js';
import type { MediaConfig } from '../../config/schema.js';

const config: MediaConfig = {
  max_file_size_mb: 10,
  allowed_mime_types: ['image/png', 'image/jpeg', 'application/pdf'],
};

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    type: 'image',
    mimeType: 'image/png',
    data: Buffer.alloc(1024), // 1KB
    filename: 'test.png',
    ...overrides,
  };
}

describe('validateAttachment', () => {
  it('accepts valid attachment', () => {
    const result = validateAttachment(makeAttachment(), config);
    expect(result.valid).toBe(true);
  });

  it('rejects oversized attachment', () => {
    const big = makeAttachment({ data: Buffer.alloc(11 * 1024 * 1024) }); // 11MB
    const result = validateAttachment(big, config);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/size/i);
  });

  it('rejects disallowed mime type', () => {
    const svg = makeAttachment({ mimeType: 'image/svg+xml' });
    const result = validateAttachment(svg, config);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/mime/i);
  });

  it('accepts PDF', () => {
    const pdf = makeAttachment({ type: 'file', mimeType: 'application/pdf', filename: 'doc.pdf' });
    const result = validateAttachment(pdf, config);
    expect(result.valid).toBe(true);
  });

  it('accepts attachment exactly at size limit', () => {
    const exact = makeAttachment({ data: Buffer.alloc(10 * 1024 * 1024) }); // exactly 10MB
    const result = validateAttachment(exact, config);
    expect(result.valid).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/media/__tests__/validator.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement validator**

```typescript
// packages/core/src/media/validator.ts
import type { Attachment } from '../types/agent.js';
import type { MediaConfig } from '../config/schema.js';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateAttachment(
  attachment: Attachment,
  config: MediaConfig,
): ValidationResult {
  const maxBytes = config.max_file_size_mb * 1024 * 1024;
  if (attachment.data.byteLength > maxBytes) {
    return {
      valid: false,
      reason: `File size ${Math.round(attachment.data.byteLength / 1024)}KB exceeds limit of ${config.max_file_size_mb}MB`,
    };
  }

  if (!config.allowed_mime_types.includes(attachment.mimeType)) {
    return {
      valid: false,
      reason: `MIME type "${attachment.mimeType}" is not allowed`,
    };
  }

  return { valid: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/media/__tests__/validator.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/media/validator.ts packages/core/src/media/__tests__/validator.test.ts
git commit -m "feat(core): add attachment validator for size and mime type"
```

---

### Task 3: Conversion helper

**Files:**
- Create: `packages/core/src/media/conversion.ts`
- Create: `packages/core/src/media/__tests__/conversion.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/src/media/__tests__/conversion.test.ts
import { describe, it, expect } from 'vitest';
import { attachmentsToContentBlocks } from '../conversion.js';
import type { Attachment } from '../../types/agent.js';

describe('attachmentsToContentBlocks', () => {
  it('converts image attachment to image content block', () => {
    const att: Attachment = {
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from('fake-png-data'),
    };
    const blocks = attachmentsToContentBlocks([att]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: Buffer.from('fake-png-data').toString('base64'),
      },
    });
  });

  it('converts PDF attachment to document content block', () => {
    const att: Attachment = {
      type: 'file',
      mimeType: 'application/pdf',
      data: Buffer.from('fake-pdf-data'),
      filename: 'doc.pdf',
    };
    const blocks = attachmentsToContentBlocks([att]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: Buffer.from('fake-pdf-data').toString('base64'),
      },
    });
  });

  it('skips unsupported types', () => {
    const att: Attachment = {
      type: 'voice',
      mimeType: 'audio/ogg',
      data: Buffer.from('audio-data'),
    };
    const blocks = attachmentsToContentBlocks([att]);
    expect(blocks).toHaveLength(0);
  });

  it('handles multiple attachments', () => {
    const atts: Attachment[] = [
      { type: 'image', mimeType: 'image/jpeg', data: Buffer.from('jpg') },
      { type: 'file', mimeType: 'application/pdf', data: Buffer.from('pdf') },
      { type: 'voice', mimeType: 'audio/ogg', data: Buffer.from('ogg') },
    ];
    const blocks = attachmentsToContentBlocks(atts);
    expect(blocks).toHaveLength(2); // image + pdf, voice skipped
  });

  it('returns empty array for empty input', () => {
    expect(attachmentsToContentBlocks([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/media/__tests__/conversion.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement conversion helper**

```typescript
// packages/core/src/media/conversion.ts
import type { Attachment } from '../types/agent.js';

export interface ImageContentBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

export interface DocumentContentBlock {
  type: 'document';
  source: { type: 'base64'; media_type: string; data: string };
}

export type AttachmentContentBlock = ImageContentBlock | DocumentContentBlock;

export function attachmentsToContentBlocks(attachments: Attachment[]): AttachmentContentBlock[] {
  const blocks: AttachmentContentBlock[] = [];

  for (const att of attachments) {
    if (att.mimeType.startsWith('image/')) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: att.mimeType,
          data: att.data.toString('base64'),
        },
      });
    } else if (att.mimeType === 'application/pdf') {
      blocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: att.data.toString('base64'),
        },
      });
    }
    // voice and other types skipped — extensible later
  }

  return blocks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/media/__tests__/conversion.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Create barrel export and wire into core index**

```typescript
// packages/core/src/media/index.ts
export { fetchAttachment, type FetchAttachmentOptions } from './download.js';
export { validateAttachment, type ValidationResult } from './validator.js';
export {
  attachmentsToContentBlocks,
  type AttachmentContentBlock,
  type ImageContentBlock,
  type DocumentContentBlock,
} from './conversion.js';
```

In `packages/core/src/index.ts`, add:
```typescript
export * from './media/index.js';
```

- [ ] **Step 6: Build core package**

Run: `npx turbo build --filter=@ccbuddy/core`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/media/ packages/core/src/index.ts
git commit -m "feat(core): add media utilities — download, validator, content block conversion"
```

---

### Task 4: Add AgentMediaEvent and SkillMediaOutput types

**Files:**
- Modify: `packages/core/src/types/agent.ts`
- Modify: `packages/skills/src/types.ts`

- [ ] **Step 1: Add AgentMediaEvent to AgentEvent union**

In `packages/core/src/types/agent.ts`, update the `AgentEvent` type:

```typescript
export type AgentEvent =
  | AgentEventBase & { type: 'text'; content: string }
  | AgentEventBase & { type: 'tool_use'; tool: string }
  | AgentEventBase & { type: 'complete'; response: string }
  | AgentEventBase & { type: 'error'; error: string }
  | AgentEventBase & { type: 'media'; media: Array<{ data: Buffer; mimeType: string; filename?: string }> };
```

- [ ] **Step 2: Add SkillMediaOutput to SkillOutput**

In `packages/skills/src/types.ts`, add:

```typescript
export interface SkillMediaOutput {
  data: string;      // base64-encoded
  mimeType: string;
  filename?: string;
}
```

Update `SkillOutput`:

```typescript
export interface SkillOutput {
  success: boolean;
  result?: unknown;
  error?: string;
  media?: SkillMediaOutput[];
}
```

- [ ] **Step 3: Build and verify**

Run: `npx turbo build`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types/agent.ts packages/skills/src/types.ts
git commit -m "feat(core): add AgentMediaEvent and SkillMediaOutput types"
```

---

## Chunk 2: Inbound — Platform Adapters and Gateway

### Task 5: Discord adapter — download attachments

**Files:**
- Modify: `packages/platforms/discord/src/discord-adapter.ts`
- Modify: `packages/platforms/discord/src/__tests__/discord-adapter.test.ts`

- [ ] **Step 1: Write failing test — attachments are downloaded**

Add a test in the Discord adapter test file that verifies the download helper is called for attachments and the data buffer is populated. You'll need to mock `fetchAttachment` from `@ccbuddy/core`.

```typescript
it('downloads attachment data from URL', async () => {
  // Mock fetchAttachment to return fake data
  // Set up a message with an attachment that has a URL
  // Verify the normalized message has Attachment.data populated (not empty buffer)
});
```

The implementing agent should design the test based on the existing test patterns in the file — the `messageCreate` handler captures events, and the mock discord.js Client is already set up. Key: mock `fetchAttachment` at the module level, create a fake discord.js Message with `attachments` Map containing an entry with `contentType`, `name`, and `url`.

- [ ] **Step 2: Refactor normalizeMessage to async**

Change `private normalizeMessage(msg: Message): IncomingMessage | null` to `private async normalizeMessage(msg: Message): Promise<IncomingMessage | null>`.

Update the call site in the `messageCreate` handler:
```typescript
this.client.on('messageCreate', (msg: Message) => {
  if (msg.author.bot) return;
  if (!this.messageHandler) return;
  this.normalizeMessage(msg).then((normalized) => {
    if (normalized) {
      Promise.resolve(this.messageHandler!(normalized)).catch((err) => {
        console.error('[DiscordAdapter] Unhandled error in message handler:', err);
      });
    }
  }).catch((err) => {
    console.error('[DiscordAdapter] Error normalizing message:', err);
  });
});
```

- [ ] **Step 3: Download attachment data in normalizeMessage**

Replace the `Buffer.alloc(0)` with actual download. Import `fetchAttachment` and `validateAttachment` from `@ccbuddy/core`. The adapter needs `MediaConfig` — add it as a constructor parameter.

```typescript
// In the attachment loop:
for (const [, att] of msg.attachments) {
  try {
    const data = await fetchAttachment(att.url, {
      maxBytes: this.mediaConfig.max_file_size_mb * 1024 * 1024,
    });
    const attachment: Attachment = {
      type: att.contentType?.startsWith('image/') ? 'image' : 'file',
      mimeType: att.contentType ?? 'application/octet-stream',
      data,
      filename: att.name ?? undefined,
    };
    const validation = validateAttachment(attachment, this.mediaConfig);
    if (validation.valid) {
      attachments.push(attachment);
    } else {
      console.warn(`[DiscordAdapter] Attachment skipped: ${validation.reason}`);
    }
  } catch (err) {
    console.warn(`[DiscordAdapter] Failed to download attachment: ${(err as Error).message}`);
  }
}
```

- [ ] **Step 4: Update DiscordAdapterConfig and constructor**

```typescript
export interface DiscordAdapterConfig {
  token: string;
  mediaConfig: MediaConfig;
}
```

Update the bootstrap to pass `mediaConfig: config.media` when creating the Discord adapter.

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/platforms/discord`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/platforms/discord/src/ packages/main/src/bootstrap.ts
git commit -m "feat(discord): download and validate attachments"
```

---

### Task 6: Telegram adapter — photo and document support

**Files:**
- Modify: `packages/platforms/telegram/src/telegram-adapter.ts`
- Modify: `packages/platforms/telegram/src/__tests__/telegram-adapter.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests for photo and document message handling. The implementing agent should check existing Telegram test patterns and add:

- Test that `message:photo` events produce an IncomingMessage with an image attachment
- Test that `message:document` events produce an IncomingMessage with a file attachment
- Test that captions are used as text content

- [ ] **Step 2: Add photo and document listeners**

The adapter currently only calls `this.bot.on('message:text', ...)`. Add parallel handlers for `'message:photo'` and `'message:document'` that:

1. Extract the photo/document file ID
2. Call `ctx.api.getFile(fileId)` to get the file path
3. Download via `fetchAttachment(telegramFileUrl)`
4. Construct and validate the `Attachment`
5. Build `IncomingMessage` with `text: ctx.message.caption ?? ''` and the attachment
6. Call the message handler

The Telegram file URL format is: `https://api.telegram.org/file/bot${this.config.token}/${filePath}`

- [ ] **Step 3: Update TelegramAdapterConfig**

Add `mediaConfig: MediaConfig` like the Discord adapter. Update bootstrap wiring.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/platforms/telegram`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/platforms/telegram/src/ packages/main/src/bootstrap.ts
git commit -m "feat(telegram): add photo and document attachment support"
```

---

### Task 7: Gateway — store attachment metadata

**Files:**
- Modify: `packages/gateway/src/gateway.ts`
- Modify: `packages/main/src/bootstrap.ts`

- [ ] **Step 1: Add `attachments?` to StoreMessageParams**

In `packages/gateway/src/gateway.ts`:

```typescript
export interface StoreMessageParams {
  userId: string;
  sessionId: string;
  platform: string;
  content: string;
  role: 'user' | 'assistant';
  attachments?: string;
}
```

- [ ] **Step 2: Serialize and pass attachment metadata when storing user messages**

In `handleIncomingMessage`, when calling `storeMessage` for the user message, add:

```typescript
const attachmentMeta = msg.attachments.length > 0
  ? JSON.stringify(msg.attachments.map(a => ({
      type: a.type,
      mimeType: a.mimeType,
      filename: a.filename,
      bytes: a.data.byteLength,
    })))
  : undefined;

this.deps.storeMessage({
  userId: user.name,
  sessionId,
  platform: msg.platform,
  content: msg.text,
  role: 'user',
  attachments: attachmentMeta,
});
```

- [ ] **Step 3: Update bootstrap storeMessage closure**

In `packages/main/src/bootstrap.ts`, update the `storeMessage` closure to pass `attachments`:

```typescript
storeMessage: (params) => {
  messageStore.add({
    userId: params.userId,
    sessionId: params.sessionId,
    platform: params.platform,
    content: params.content,
    role: params.role,
    attachments: params.attachments,
  });
},
```

- [ ] **Step 4: Build and run tests**

Run: `npx turbo build && npx vitest run packages/gateway packages/main`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/gateway.ts packages/main/src/bootstrap.ts
git commit -m "feat(gateway): store attachment metadata in message store"
```

---

## Chunk 3: Inbound — Agent Backends

### Task 8: SDK backend — content blocks for attachments

**Files:**
- Modify: `packages/agent/src/backends/sdk-backend.ts`
- Test: `packages/agent/src/__tests__/sdk-backend.test.ts`

- [ ] **Step 1: Write failing test**

Add a test that when `request.attachments` contains an image, the SDK `query()` is called with an `AsyncIterable<SDKUserMessage>` prompt containing content blocks instead of a plain string.

The implementing agent should check the existing SDK backend test patterns. The key assertion: when attachments are present, `query()` receives a non-string prompt, and the content blocks match the expected format.

- [ ] **Step 2: Implement attachment handling**

Import `attachmentsToContentBlocks` from `@ccbuddy/core`. In the `execute()` method, check for attachments:

```typescript
if (request.attachments && request.attachments.length > 0) {
  const contentBlocks = attachmentsToContentBlocks(request.attachments);
  // Build SDKUserMessage with content blocks + text
  const userMessage = {
    type: 'user' as const,
    message: {
      role: 'user' as const,
      content: [
        ...contentBlocks,
        { type: 'text' as const, text: fullPrompt },
      ],
    },
  };
  // Pass as async iterable
  async function* messageStream() { yield userMessage; }
  const result = query({ prompt: messageStream(), options });
  // ... process result same as before
} else {
  // Existing string prompt path
  const result = query({ prompt: fullPrompt, options });
  // ...
}
```

Note: The exact `SDKUserMessage` type depends on the agent SDK. The implementing agent should check the actual type definition and adapt the structure to match. The `query()` function accepts `prompt: string | AsyncIterable<SDKUserMessage>`.

- [ ] **Step 3: Run tests**

Run: `npx vitest run packages/agent`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/backends/sdk-backend.ts packages/agent/src/__tests__/
git commit -m "feat(agent): SDK backend passes image/document content blocks to Claude"
```

---

### Task 9: CLI backend — metadata fallback

**Files:**
- Modify: `packages/agent/src/backends/cli-backend.ts`
- Test: `packages/agent/src/__tests__/cli-backend.test.ts`

- [ ] **Step 1: Write failing test**

Add a test that when `request.attachments` is present, the CLI backend includes attachment metadata in the prompt text and logs a warning.

- [ ] **Step 2: Implement metadata fallback**

In `execute()`, before building the prompt, check for attachments:

```typescript
let attachmentNote = '';
if (request.attachments && request.attachments.length > 0) {
  console.warn('[CliBackend] Attachments not supported in CLI mode — including metadata only');
  attachmentNote = request.attachments.map(a => {
    const sizeKB = Math.round(a.data.byteLength / 1024);
    return `[Attached: ${a.mimeType} "${a.filename ?? 'unnamed'}" (${sizeKB}KB)]`;
  }).join('\n') + '\n\n';
}
const fullPrompt = attachmentNote + [request.memoryContext, request.systemPrompt, request.prompt]
  .filter(Boolean).join('\n\n');
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run packages/agent`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/backends/cli-backend.ts packages/agent/src/__tests__/
git commit -m "feat(agent): CLI backend includes attachment metadata in prompt text"
```

---

## Chunk 4: Outbound Media Pipeline

### Task 10: Gateway — handle media events

**Files:**
- Modify: `packages/gateway/src/gateway.ts`
- Test: `packages/gateway/src/__tests__/gateway.test.ts`

- [ ] **Step 1: Write failing test**

Add a test that when an `AgentEvent` with `type: 'media'` is yielded from `executeAgentRequest`, the gateway calls `adapter.sendImage()` for image media and `adapter.sendFile()` for other types.

- [ ] **Step 2: Add media event handling to executeAndRoute**

In the `switch (event.type)` block in `executeAndRoute()`, add:

```typescript
case 'media': {
  for (const item of event.media) {
    if (item.mimeType.startsWith('image/')) {
      await adapter.sendImage(msg.channelId, item.data, item.filename);
    } else {
      await adapter.sendFile(msg.channelId, item.data, item.filename ?? 'file');
    }
  }
  break;
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run packages/gateway`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/gateway.ts packages/gateway/src/__tests__/
git commit -m "feat(gateway): route media events to platform adapters"
```

---

### Task 11: Full build, test, and smoke test

- [ ] **Step 1: Build all packages**

Run: `npx turbo build`
Expected: ALL 10 packages build successfully

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`
Expected: ALL tests pass

- [ ] **Step 3: Smoke test on Discord**

Start CCBuddy, send an image via Discord DM. Verify:
- Logs show attachment downloaded and validated
- Agent responds acknowledging the image content (vision working)
- No errors in stderr

- [ ] **Step 4: Fix any issues and commit**
