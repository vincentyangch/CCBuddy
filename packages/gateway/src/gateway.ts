import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EventBus,
  User,
  IncomingMessage,
  AgentRequest,
  AgentEvent,
  PlatformAdapter,
  PlatformConfig,
  GatewayConfig,
} from '@ccbuddy/core';
import type { SessionStore } from '@ccbuddy/agent';

/** Minimal transcription interface — satisfied by TranscriptionService from @ccbuddy/core */
export interface Transcriber {
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
}

/** Minimal TTS interface — satisfied by SpeechService from @ccbuddy/core */
export interface Synthesizer {
  synthesize(text: string, voice?: string): Promise<Buffer>;
}
import { chunkMessage } from './chunker.js';
import { shouldRespond } from './activation.js';

export interface StoreMessageParams {
  userId: string;
  sessionId: string;
  platform: string;
  content: string;
  role: 'user' | 'assistant';
  attachments?: string;
}

export interface GatewayDeps {
  eventBus: EventBus;
  findUser: (platform: string, platformId: string) => User | undefined;
  buildSessionId: (userName: string, platform: string, channelId: string) => string;
  executeAgentRequest: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
  assembleContext: (userId: string, sessionId: string) => string;
  storeMessage: (params: StoreMessageParams) => void;
  gatewayConfig: GatewayConfig;
  platformsConfig: PlatformConfig;
  outboundMediaDir?: string;
  transcriptionService?: Transcriber;
  speechService?: Synthesizer;
  voiceConfig?: { enabled: boolean; ttsMaxChars: number };
  sessionStore?: SessionStore;
  userInputTimeoutMs?: number;
  storeAgentEvent?: (params: { userId: string; sessionId: string; platform: string; eventType: string; content: string; toolInput?: string; toolOutput?: string }) => void;
}

const PLATFORM_CHAR_LIMITS: Record<string, number> = {
  discord: 2000,
  telegram: 4096,
};

const DEFAULT_CHAR_LIMIT = 2000;

export class Gateway {
  private adapters = new Map<string, PlatformAdapter>();
  private pendingReplies = new Map<string, (text: string) => void>();

  constructor(private deps: GatewayDeps) {
    // Subscribe to session conflict events for user notification
    deps.eventBus.subscribe('session.conflict', (event) => {
      const adapter = this.adapters.get(event.platform);
      if (adapter) {
        const msg = `Another session is using this directory — your request has been queued and will run when it's free.`;
        adapter.sendText(event.channelId, msg).catch((err) => {
          console.error(`[Gateway] Failed to send conflict notification:`, err);
        });
      }
    });

    // Store agent progress events for dashboard historical replay
    if (deps.storeAgentEvent) {
      deps.eventBus.subscribe('agent.progress', (event) => {
        deps.storeAgentEvent!({
          userId: event.userId,
          sessionId: event.sessionId,
          platform: event.platform,
          eventType: event.type,
          content: event.content,
          toolInput: event.toolInput ? JSON.stringify(event.toolInput) : undefined,
          toolOutput: event.toolOutput,
        });
      });
    }
  }

  registerAdapter(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter);
    adapter.onMessage((msg) => {
      // Return the promise so tests can await it via simulateMessage
      return this.handleIncomingMessage(msg).catch((err) => {
        console.error(`[Gateway] Error handling message on ${adapter.platform}:`, err);
      });
    });
  }

  getAdapter(platform: string): PlatformAdapter | undefined {
    return this.adapters.get(platform);
  }

  async start(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.start();
    }
  }

  async stop(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }

  private async handleIncomingMessage(msg: IncomingMessage): Promise<void> {
    // Check for pending follow-up reply (interactive follow-ups)
    const replyKey = `${msg.platform}:${msg.channelId}:${msg.platformUserId}`;
    const pendingReply = this.pendingReplies.get(replyKey);
    if (pendingReply) {
      pendingReply(msg.text);
      return; // Consumed by the pending follow-up, don't process as new message
    }

    // 1. Identify user
    const user = this.deps.findUser(msg.platform, msg.platformUserId);
    if (!user) {
      if (this.deps.gatewayConfig.unknown_user_reply) {
        const adapter = this.adapters.get(msg.platform);
        await adapter?.sendText(
          msg.channelId,
          "I don't recognize you. Ask the admin to add you.",
        );
      }
      return;
    }

    // 2. Check activation mode
    if (!shouldRespond(msg, this.deps.platformsConfig)) {
      return;
    }

    console.log(`[Gateway] Incoming: platform=${msg.platform} user=${msg.platformUserId} channel=${msg.channelId}`);

    // 3. Build routing info
    const sessionId = this.deps.buildSessionId(user.name, msg.platform, msg.channelId);

    // 3b. Compute session key for SDK session lookup (shared for groups, per-user for DMs)
    const isGroupChannel = msg.channelType === 'group';
    const sessionKey = isGroupChannel
      ? `${msg.platform}-${msg.channelId}`
      : `${user.name}-${msg.platform}-${msg.channelId}`;

    // 3c. Look up or create SDK session
    let sdkSessionId: string | undefined;
    let resumeSessionId: string | undefined;
    let isNewSession = true;
    if (this.deps.sessionStore) {
      const session = this.deps.sessionStore.getOrCreate(sessionKey, isGroupChannel);
      isNewSession = session.isNew;
      if (session.isNew) {
        sdkSessionId = session.sdkSessionId;
      } else {
        resumeSessionId = session.sdkSessionId;
      }
    }

    // 4. Publish incoming event
    await this.deps.eventBus.publish('message.incoming', {
      userId: user.name,
      sessionId,
      channelId: msg.channelId,
      platform: msg.platform,
      text: msg.text,
      attachments: msg.attachments,
      isMention: msg.isMention,
      replyToMessageId: msg.replyToMessageId,
      timestamp: Date.now(),
    });

    // 5. Store user message (with attachment metadata if present)
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

    // 6. Assemble memory context (only for new sessions — resumed sessions already have conversation history)
    const memoryContext = isNewSession ? this.deps.assembleContext(user.name, sessionId) : undefined;

    // 7. Build agent request
    const request: AgentRequest = {
      prompt: msg.text,
      userId: user.name,
      sessionId,
      channelId: msg.channelId,
      platform: msg.platform,
      memoryContext,
      attachments: msg.attachments.length > 0 ? msg.attachments : undefined,
      // UserConfig only allows 'admin' | 'chat' roles; 'system' is internal-only
      permissionLevel: user.role === 'admin' ? 'admin' : 'chat',
      sdkSessionId,
      resumeSessionId,
      requestUserInput: async (questions, signal) => {
        return this.presentUserQuestions(msg, user, questions, signal);
      },
    };

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

      const transcripts = msg.attachments
        .filter(a => a.type === 'voice' && a.transcript)
        .map(a => a.transcript!);
      if (transcripts.length > 0) {
        const transcriptText = transcripts.join(' ');
        request.prompt = msg.text
          ? `${msg.text}\n\n[Voice message] ${transcriptText}`
          : `[Voice message] ${transcriptText}`;
        voiceInput = true;
      }
    }

    // 8. Execute and route response
    await this.executeAndRoute(request, msg, voiceInput, sessionKey);
  }

  private async executeAndRoute(request: AgentRequest, msg: IncomingMessage, voiceInput = false, sessionKey?: string): Promise<void> {
    const adapter = this.adapters.get(msg.platform);
    if (!adapter) { console.warn('[Gateway] No adapter for platform:', msg.platform); return; }

    // Snapshot outbound dir before execution so we only deliver files produced by THIS request
    const preExistingFiles = this.snapshotOutboundDir();

    console.log(`[Gateway] executeAndRoute: channel=${msg.channelId} isMention=${msg.isMention} text="${msg.text.slice(0, 50)}"`);
    await adapter.setTypingIndicator(msg.channelId, true);

    // Streaming state — progressively edit Discord message as text arrives
    let streamBuffer = '';
    let toolSuffix = ''; // Transient tool indicator — replaced on next tool, cleared on text
    let streamMessageId: string | undefined;
    let streamInterval: ReturnType<typeof setInterval> | undefined;
    const canStream = !!adapter.editMessage && !voiceInput;
    const charLimit = PLATFORM_CHAR_LIMITS[msg.platform] ?? DEFAULT_CHAR_LIMIT;

    const flushStream = async () => {
      const display = streamBuffer + toolSuffix;
      if (!display || !adapter.editMessage) return;
      try {
        if (streamMessageId) {
          if (display.length <= charLimit - 100) {
            await adapter.editMessage(msg.channelId, streamMessageId, display);
          }
        } else {
          const id = await adapter.sendText(msg.channelId, display);
          if (typeof id === 'string') streamMessageId = id;
        }
      } catch (err) {
        console.warn('[Gateway] Stream flush error:', (err as Error).message);
      }
    };

    try {
      let eventCount = 0;
      for await (const event of this.deps.executeAgentRequest(request)) {
        eventCount++;
        console.log(`[Gateway] Agent event #${eventCount}: type=${event.type} channel=${msg.channelId}`);
        switch (event.type) {
          case 'text': {
            if (canStream) {
              toolSuffix = ''; // Clear tool indicator — text is arriving
              streamBuffer += event.content;
              if (!streamInterval) {
                streamInterval = setInterval(flushStream, 1000);
                await flushStream();
              }
            }
            break;
          }
          case 'thinking': {
            if (canStream) {
              toolSuffix = ''; // Clear tool indicator
              streamBuffer += `*💭 Thinking...*\n${event.content}\n\n`;
              if (!streamInterval) {
                streamInterval = setInterval(flushStream, 1000);
                await flushStream();
              }
            }
            break;
          }
          case 'tool_use': {
            if (canStream) {
              // Transient indicator — shows current tool, gets replaced by next tool or cleared by text
              toolSuffix = `\n*🔧 Using ${event.tool}...*`;
              if (!streamInterval) {
                streamInterval = setInterval(flushStream, 1000);
              }
              await flushStream();
            }
            break;
          }
          case 'complete': {
            this.deps.storeMessage({
              userId: request.userId,
              sessionId: request.sessionId,
              platform: request.platform,
              content: event.response,
              role: 'assistant',
            });

            await this.deps.eventBus.publish('message.outgoing', {
              userId: request.userId,
              sessionId: request.sessionId,
              channelId: request.channelId,
              platform: request.platform,
              text: event.response,
            });

            // Voice mirror logic
            if (voiceInput && this.deps.speechService && adapter.sendVoice) {
              const maxChars = this.deps.voiceConfig?.ttsMaxChars ?? 500;
              if (event.response.length <= maxChars) {
                try {
                  const audio = await this.deps.speechService.synthesize(event.response);
                  await adapter.sendVoice(msg.channelId, audio);
                } catch (err) {
                  console.error('[Gateway] TTS failed, falling back to text:', (err as Error).message);
                  const limit = PLATFORM_CHAR_LIMITS[msg.platform] ?? DEFAULT_CHAR_LIMIT;
                  const chunks = chunkMessage(event.response, limit);
                  for (const chunk of chunks) await adapter.sendText(msg.channelId, chunk);
                }
              } else {
                const voicePart = event.response.slice(0, maxChars);
                const textPart = event.response.slice(maxChars);
                try {
                  const audio = await this.deps.speechService.synthesize(voicePart);
                  await adapter.sendVoice(msg.channelId, audio);
                } catch (err) {
                  console.error('[Gateway] TTS failed:', (err as Error).message);
                }
                const limit = PLATFORM_CHAR_LIMITS[msg.platform] ?? DEFAULT_CHAR_LIMIT;
                const chunks = chunkMessage(textPart, limit);
                for (const chunk of chunks) await adapter.sendText(msg.channelId, chunk);
              }
            } else {
              // Clear streaming interval
              if (streamInterval) clearInterval(streamInterval);

              if (streamMessageId && adapter.editMessage) {
                // Was streaming — final flush without tool suffix
                toolSuffix = '';
                await flushStream();
                // If buffer overflowed the char limit, send remaining as new messages
                if (streamBuffer.length > charLimit - 100) {
                  const overflow = streamBuffer.slice(charLimit - 100);
                  const chunks = chunkMessage(overflow, charLimit);
                  for (const chunk of chunks) await adapter.sendText(msg.channelId, chunk);
                }
              } else {
                // Not streaming — send full response as before
                const limit = PLATFORM_CHAR_LIMITS[msg.platform] ?? DEFAULT_CHAR_LIMIT;
                const chunks = chunkMessage(event.response, limit);
                for (const chunk of chunks) await adapter.sendText(msg.channelId, chunk);
              }
            }

            // Deliver any outbound media files (written by skills to data/outbound/)
            await this.deliverOutboundMedia(adapter, msg.channelId, preExistingFiles);
            break;
          }
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
          case 'error':
            await adapter.sendText(
              msg.channelId,
              `Sorry, something went wrong: ${event.error}`,
            );
            break;
          // text and tool_use progress events are published by AgentService directly
        }
      }
      console.log(`[Gateway] Agent done: ${eventCount} events for channel=${msg.channelId}`);
      // Touch SDK session on success
      if (sessionKey && this.deps.sessionStore) {
        this.deps.sessionStore.touch(sessionKey);
      }
    } catch (err) {
      if (streamInterval) clearInterval(streamInterval);
      console.error(`[Gateway] executeAndRoute error: channel=${msg.channelId}`, err);
      // If this was a session resume that failed, retry as a new session
      if (request.resumeSessionId && sessionKey && this.deps.sessionStore) {
        console.warn(`[Gateway] Resume failed for session ${request.resumeSessionId}, retrying as new session`);
        this.deps.sessionStore.remove(sessionKey);
        const newSession = this.deps.sessionStore.getOrCreate(sessionKey, msg.channelType === 'group');
        const retryRequest: AgentRequest = {
          ...request,
          resumeSessionId: undefined,
          sdkSessionId: newSession.sdkSessionId,
          memoryContext: this.deps.assembleContext(request.userId, request.sessionId),
        };
        try {
          await this.executeAndRoute(retryRequest, msg, voiceInput, sessionKey);
          return;
        } catch (retryErr) {
          console.error(`[Gateway] Retry also failed:`, retryErr);
          // Fall through to error message below
        }
      }
      await adapter.sendText(
        msg.channelId,
        'Sorry, something went wrong processing your message.',
      );
    } finally {
      await adapter.setTypingIndicator(msg.channelId, false);
    }
  }

  private snapshotOutboundDir(): Set<string> {
    const dir = this.deps.outboundMediaDir;
    if (!dir) return new Set();
    try {
      return new Set(readdirSync(dir));
    } catch {
      return new Set();
    }
  }

  private async presentUserQuestions(
    msg: IncomingMessage,
    user: { name: string; role: string },
    questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }>,
    signal?: AbortSignal,
  ): Promise<Record<string, string> | null> {
    const adapter = this.adapters.get(msg.platform);
    if (!adapter) return null;

    const timeoutMs = this.deps.userInputTimeoutMs ?? 300_000;
    const answers: Record<string, string> = {};

    // Stop typing — Po is waiting for input, not working
    await adapter.setTypingIndicator(msg.channelId, false);

    for (const q of questions) {
      const text = `**${q.header}**\n${q.question}`;

      if (adapter.sendButtons && !q.multiSelect) {
        // Use buttons for single-select questions
        const buttons = [
          ...q.options.map((opt, i) => ({ id: `opt_${i}`, label: opt.label })),
          { id: 'opt_other', label: 'Other' },
        ];
        const selected = await adapter.sendButtons(msg.channelId, text, buttons, {
          timeoutMs,
          userId: msg.platformUserId,
          signal,
        });

        if (selected === null) return null; // timeout or abort

        if (selected === 'Other') {
          // Ask for free-form text input
          await adapter.sendText(msg.channelId, 'Type your answer:');
          const textAnswer = await this.awaitTextReply(msg, timeoutMs, signal);
          if (textAnswer === null) return null;
          answers[q.question] = textAnswer;
        } else {
          answers[q.question] = selected;
        }
      } else {
        // Fallback: text-based interaction (multiSelect or no sendButtons support)
        const optionsText = q.options.map((o, i) => `${i + 1}. **${o.label}** — ${o.description}`).join('\n');
        await adapter.sendText(msg.channelId, `${text}\n\n${optionsText}\n\nReply with your choice:`);
        const textAnswer = await this.awaitTextReply(msg, timeoutMs, signal);
        if (textAnswer === null) return null;
        answers[q.question] = textAnswer;
      }
    }

    // Restart typing — agent is resuming
    await adapter.setTypingIndicator(msg.channelId, true);

    return answers;
  }

  private awaitTextReply(
    msg: IncomingMessage,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const key = `${msg.platform}:${msg.channelId}:${msg.platformUserId}`;
      let done = false;

      const finish = (result: string | null) => {
        if (done) return;
        done = true;
        this.pendingReplies.delete(key);
        clearTimeout(timer);
        resolve(result);
      };

      this.pendingReplies.set(key, (text) => finish(text));

      const timer = setTimeout(() => finish(null), timeoutMs);

      if (signal) {
        signal.addEventListener('abort', () => finish(null), { once: true });
      }
    });
  }

  private async deliverOutboundMedia(adapter: PlatformAdapter, channelId: string, preExisting: Set<string>): Promise<void> {
    const dir = this.deps.outboundMediaDir;
    if (!dir) return;

    let files: string[];
    try {
      files = readdirSync(dir).filter(f => !f.startsWith('.') && !preExisting.has(f));
    } catch {
      return; // dir doesn't exist yet — no media to send
    }

    for (const file of files) {
      const filePath = join(dir, file);
      try {
        const data = readFileSync(filePath);
        const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(file);
        if (isImage) {
          await adapter.sendImage(channelId, data, file);
        } else {
          await adapter.sendFile(channelId, data, file);
        }
        unlinkSync(filePath); // clean up after delivery
      } catch (err) {
        console.warn(`[Gateway] Failed to deliver outbound media ${file}:`, (err as Error).message);
      }
    }
  }
}
