import { mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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

function isContextOverflowError(err: unknown): boolean {
  const msg = (err as Error)?.message?.toLowerCase() ?? '';
  return msg.includes('context length') ||
    msg.includes('too many tokens') ||
    msg.includes('prompt is too long') ||
    msg.includes('maximum context') ||
    msg.includes('context window');
}

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
  defaultModel?: string;
  userInputTimeoutMs?: number;
  getWorkspace?: (channelKey: string) => string | null;
  defaultWorkingDirectory?: string;
  compactSession?: (params: {
    sessionKey: string;
    userId: string;
    sessionId: string;
    platform: string;
    channelId: string;
  }) => Promise<{ newSdkSessionId: string; summary: string }>;
  compactionThreshold?: number;
  storeAgentEvent?: (params: { userId: string; sessionId: string; platform: string; eventType: string; content: string; toolInput?: string; toolOutput?: string }) => void;
}

const PLATFORM_CHAR_LIMITS: Record<string, number> = {
  discord: 2000,
  telegram: 4096,
  webchat: 100000,
};

const DEFAULT_CHAR_LIMIT = 2000;

export class Gateway {
  private adapters = new Map<string, PlatformAdapter>();
  private pendingReplies = new Map<string, (text: string) => void>();
  private readonly subscriptions: Array<{ dispose(): void }> = [];

  constructor(private deps: GatewayDeps) {
    // Subscribe to session conflict events for user notification
    this.subscriptions.push(
      deps.eventBus.subscribe('session.conflict', (event) => {
        const adapter = this.adapters.get(event.platform);
        if (adapter) {
          const msg = `Another session is using this directory — your request has been queued and will run when it's free.`;
          adapter.sendText(event.channelId, msg).catch((err) => {
            console.error(`[Gateway] Failed to send conflict notification:`, err);
          });
        }
      }),
    );

    // Store agent progress events for dashboard historical replay
    if (deps.storeAgentEvent) {
      this.subscriptions.push(
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
        }),
      );
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
    for (const sub of this.subscriptions) sub.dispose();
    this.subscriptions.length = 0;
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
      const session = this.deps.sessionStore.getOrCreate(
        sessionKey, isGroupChannel, msg.platform, msg.channelId, user.name,
      );
      isNewSession = session.isNew;
      if (session.isNew) {
        sdkSessionId = session.sdkSessionId;
        // Publish session.started event for notifications
        void this.deps.eventBus.publish('session.started', {
          userId: user.name,
          platform: msg.platform,
          channelId: msg.channelId,
          sessionKey,
          timestamp: Date.now(),
        });
      } else {
        resumeSessionId = session.sdkSessionId;
      }
    }

    // 3d. Resolve model for this session
    let sessionModel: string | undefined;
    if (this.deps.sessionStore) {
      const storeModel = this.deps.sessionStore.getModel(sessionKey);
      if (storeModel) {
        sessionModel = storeModel;
      }
    }
    const effectiveModel = sessionModel ?? this.deps.defaultModel;

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

    // 6b. Resolve working directory for this channel
    const channelKey = `${msg.platform}-${msg.channelId}`;
    const workingDirectory = this.deps.getWorkspace?.(channelKey) ?? this.deps.defaultWorkingDirectory;

    // 7. Build agent request
    const request: AgentRequest = {
      prompt: msg.text,
      userId: user.name,
      sessionId,
      channelId: msg.channelId,
      platform: msg.platform,
      model: effectiveModel,
      memoryContext,
      attachments: msg.attachments.length > 0 ? msg.attachments : undefined,
      // UserConfig only allows 'admin' | 'trusted' | 'chat' roles; 'system' is internal-only
      permissionLevel: user.role === 'admin' ? 'admin' : user.role === 'trusted' ? 'trusted' : 'chat',
      workingDirectory,
      sdkSessionId,
      resumeSessionId,
      requestUserInput: async (questions, signal) => {
        return this.presentUserQuestions(msg, user, questions, signal);
      },
    };

    // 7b. Build model awareness system prompt
    if (effectiveModel) {
      const modelPrompt = `You are currently running on model: ${effectiveModel}.\n\nYou have access to \`switch_model\` and \`get_current_model\` tools.\n\nWhen to switch to a more powerful model (e.g., opus[1m]):\n- Multi-file refactors or architectural changes\n- Complex debugging requiring deep reasoning\n- Tasks involving unfamiliar or intricate code patterns\n- When you feel uncertain about your approach\n\nWhen to switch back to the default model (e.g., sonnet):\n- After completing the complex portion of work\n- For simple questions, status checks, casual conversation\n\nYou may also be asked by the user to switch models — just call switch_model.`;
      request.systemPrompt = modelPrompt;
    }

    // 7c. Transcribe voice attachments
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

    const requestOutboundDir = request.outboundMediaDir
      ?? this.createRequestOutboundDir(sessionKey, msg.channelId);
    const requestWithOutbound: AgentRequest = requestOutboundDir
      ? { ...request, outboundMediaDir: requestOutboundDir }
      : request;

    console.log(`[Gateway] executeAndRoute: channel=${msg.channelId} isMention=${msg.isMention} text="${msg.text.slice(0, 50)}"`);
    await adapter.setTypingIndicator(msg.channelId, true);

    // Streaming state — thinking and response use separate messages
    let thinkingBuffer = '';  // 💭 thinking + 🔧 tool_use indicators
    let thinkingMessageId: string | undefined;
    let thinkingSuffix = ''; // Transient tool indicator
    let responseBuffer = ''; // Final response text
    let responseMessageId: string | undefined;
    let streamInterval: ReturnType<typeof setInterval> | undefined;
    let inResponsePhase = false; // True once text events start arriving
    let isFlushing = false; // Guard against concurrent flushes
    let flushPromise: Promise<void> = Promise.resolve(); // Track in-flight flush
    const canStream = !!adapter.editMessage && !voiceInput;
    const charLimit = PLATFORM_CHAR_LIMITS[msg.platform] ?? DEFAULT_CHAR_LIMIT;

    /** Flush the active stream message (thinking or response phase). */
    const flushStreamInner = async () => {
      if (!adapter.editMessage) return;
      if (isFlushing) return; // Prevent overlapping flushes (interval races)
      isFlushing = true;
      try {
        // Snapshot state at flush start so concurrent mutations don't cause inconsistency
        const phase = inResponsePhase;
        if (!phase) {
          // Thinking phase — edit thinking message
          const display = thinkingBuffer + thinkingSuffix;
          if (!display) return;
          if (thinkingMessageId) {
            if (display.length <= charLimit - 100) {
              await adapter.editMessage(msg.channelId, thinkingMessageId, display);
            }
          } else {
            const id = await adapter.sendText(msg.channelId, display);
            if (typeof id === 'string') thinkingMessageId = id;
          }
        } else {
          // Response phase — edit response message
          const text = responseBuffer;
          if (!text) return;
          if (responseMessageId) {
            if (text.length <= charLimit - 100) {
              await adapter.editMessage(msg.channelId, responseMessageId, text);
            }
          } else {
            const id = await adapter.sendText(msg.channelId, text);
            if (typeof id === 'string') responseMessageId = id;
          }
        }
      } catch (err) {
        console.warn('[Gateway] Stream flush error:', (err as Error).message);
      } finally {
        isFlushing = false;
      }
    };
    // Track the in-flight flush so `complete` can await it before sending
    const flushStream = () => {
      flushPromise = flushStreamInner();
      return flushPromise;
    };

    /** Finalize the thinking message and switch to response phase. */
    const finalizeThinking = async () => {
      if (inResponsePhase) return;
      inResponsePhase = true;
      if (thinkingMessageId && adapter.editMessage) {
        // Final edit of thinking message — remove tool suffix, cap at char limit
        // If thinkingBuffer is empty (only had tool indicators), use a placeholder
        // because Discord rejects edits to empty strings, leaving stale content visible
        const finalThinking = !thinkingBuffer.trim()
          ? '*✅ Done thinking*'
          : thinkingBuffer.length <= charLimit - 100
            ? thinkingBuffer
            : thinkingBuffer.slice(0, charLimit - 100);
        try {
          await adapter.editMessage(msg.channelId, thinkingMessageId, finalThinking);
        } catch { /* best effort */ }
        // If thinking overflowed, send rest as additional messages
        if (thinkingBuffer.length > charLimit - 100) {
          const overflow = thinkingBuffer.slice(charLimit - 100);
          const chunks = chunkMessage(overflow, charLimit);
          for (const chunk of chunks) await adapter.sendText(msg.channelId, chunk);
        }
      }
    };

    try {
      let eventCount = 0;
      for await (const event of this.deps.executeAgentRequest(requestWithOutbound)) {
        eventCount++;
        console.log(`[Gateway] Agent event #${eventCount}: type=${event.type} channel=${msg.channelId}`);
        switch (event.type) {
          case 'text': {
            if (canStream) {
              // First text event → finalize thinking, start response phase
              if (!inResponsePhase) {
                await finalizeThinking();
                // Add response header if there was visible thinking/tool content
                if (thinkingMessageId && msg.platform !== 'webchat') {
                  responseBuffer = '**💬 Response:**\n';
                }
              }
              responseBuffer += event.content;
              if (!streamInterval) {
                streamInterval = setInterval(flushStream, 1000);
                await flushStream();
              }
            }
            break;
          }
          case 'thinking': {
            if (canStream) {
              thinkingSuffix = ''; // Clear tool indicator
              // Webchat handles thinking via agent.progress events — don't mix into stream
              if (msg.platform !== 'webchat') {
                thinkingBuffer += `*💭 Thinking...*\n${event.content}\n\n`;
              }
              if (!streamInterval) {
                streamInterval = setInterval(flushStream, 1000);
                if (thinkingBuffer) await flushStream();
              }
            }
            break;
          }
          case 'tool_use': {
            if (canStream) {
              // Webchat handles tool_use via agent.progress events — don't mix into stream
              if (msg.platform !== 'webchat') {
                thinkingSuffix = `\n*🔧 Using ${event.tool}...*`;
              }
              if (!streamInterval) {
                streamInterval = setInterval(flushStream, 1000);
              }
              if (msg.platform !== 'webchat') await flushStream();
            }
            break;
          }
          case 'complete': {
            // Update SessionStore if the backend returned a different session ID
            // (e.g., Codex thread IDs are generated by Codex, not by CCBuddy)
            if (
              event.sdkSessionId &&
              sessionKey &&
              this.deps.sessionStore &&
              event.sdkSessionId !== request.sdkSessionId &&
              event.sdkSessionId !== request.resumeSessionId
            ) {
              this.deps.sessionStore.updateSdkSessionId?.(sessionKey, event.sdkSessionId);
            }

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
              // Clear streaming interval and wait for any in-flight flush to finish
              // (prevents race where flush is creating responseMessageId while we check it)
              if (streamInterval) clearInterval(streamInterval);
              await flushPromise;

              if ((thinkingMessageId || responseMessageId) && adapter.editMessage) {
                // Was streaming — finalize thinking if not yet done
                if (!inResponsePhase && thinkingBuffer) {
                  await finalizeThinking();
                }

                // Use the SDK's final result text — not the accumulated responseBuffer
                // which contains intermediate narration between tool calls
                const finalResponse = thinkingMessageId && msg.platform !== 'webchat'
                  ? `**💬 Response:**\n${event.response}`
                  : event.response;

                // Final flush of response message
                if (finalResponse.length <= charLimit - 100) {
                  // Fits in one message — final edit
                  if (responseMessageId) {
                    try { await adapter.editMessage(msg.channelId, responseMessageId, finalResponse); } catch { /* best effort */ }
                  } else if (finalResponse) {
                    await adapter.sendText(msg.channelId, finalResponse);
                  }
                } else {
                  // Response overflowed — edit to limit, send rest as new messages
                  const editPortion = finalResponse.slice(0, charLimit - 100);
                  if (responseMessageId) {
                    try { await adapter.editMessage(msg.channelId, responseMessageId, editPortion); } catch { /* best effort */ }
                  } else {
                    await adapter.sendText(msg.channelId, editPortion);
                  }
                  const overflow = finalResponse.slice(charLimit - 100);
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
            await this.deliverRequestOutboundMedia(adapter, msg.channelId, requestOutboundDir);
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
            // Session-not-found during resume — retry as a new session
            if (
              request.resumeSessionId &&
              event.error.includes('No conversation found') &&
              sessionKey &&
              this.deps.sessionStore
            ) {
              console.warn(`[Gateway] Resume returned session-not-found for ${request.resumeSessionId}, retrying as new session`);
              this.deps.sessionStore.archive(sessionKey);
              const newSession = this.deps.sessionStore.getOrCreate(
                sessionKey, msg.channelType === 'group', msg.platform, msg.channelId, request.userId,
              );
              const retryRequest: AgentRequest = {
                ...request,
                resumeSessionId: undefined,
                sdkSessionId: newSession.sdkSessionId,
                memoryContext: this.deps.assembleContext(request.userId, request.sessionId),
              };
              await this.executeAndRoute(retryRequest, msg, voiceInput, sessionKey);
              return;
            }
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

      // Proactive compaction — check if session is getting long
      if (sessionKey && this.deps.sessionStore && this.deps.compactSession && this.deps.compactionThreshold) {
        const turns = this.deps.sessionStore.incrementTurns(sessionKey);
        if (turns >= this.deps.compactionThreshold) {
          try {
            console.log(`[Gateway] Proactive compaction triggered for ${sessionKey} at ${turns} turns`);
            await this.deps.compactSession({
              sessionKey,
              userId: request.userId,
              sessionId: request.sessionId,
              platform: msg.platform,
              channelId: msg.channelId,
            });
            await adapter.sendText(msg.channelId, '*(conversation compacted — continuing)*');
          } catch (compactErr) {
            console.error('[Gateway] Proactive compaction failed:', compactErr);
          }
        }
      }
    } catch (err) {
      if (streamInterval) clearInterval(streamInterval);
      console.error(`[Gateway] executeAndRoute error: channel=${msg.channelId}`, err);

      // Reactive compaction — catch context overflow errors
      if (isContextOverflowError(err) && sessionKey && this.deps.compactSession && this.deps.sessionStore) {
        console.warn(`[Gateway] Context overflow detected for ${sessionKey}, compacting`);
        try {
          const result = await this.deps.compactSession({
            sessionKey,
            userId: request.userId,
            sessionId: request.sessionId,
            platform: msg.platform,
            channelId: msg.channelId,
          });
          const retryRequest: AgentRequest = {
            ...request,
            resumeSessionId: undefined,
            sdkSessionId: result.newSdkSessionId,
            memoryContext: result.summary,
          };
          await this.executeAndRoute(retryRequest, msg, voiceInput, sessionKey);
          await adapter.sendText(msg.channelId, '*(conversation compacted — continuing)*');
          return;
        } catch (compactErr) {
          console.error('[Gateway] Reactive compaction failed:', compactErr);
          // Fall through to normal error handling
        }
      }

      // Publish agent.error event for notifications
      void this.deps.eventBus.publish('agent.error', {
        userId: request.userId,
        platform: msg.platform,
        channelId: msg.channelId,
        error: (err as Error).message ?? String(err),
        timestamp: Date.now(),
      });
      // If this was a session resume that failed, retry as a new session
      if (request.resumeSessionId && sessionKey && this.deps.sessionStore) {
        console.warn(`[Gateway] Resume failed for session ${request.resumeSessionId}, retrying as new session`);
        this.deps.sessionStore.archive(sessionKey);
        const newSession = this.deps.sessionStore.getOrCreate(
          sessionKey, msg.channelType === 'group', msg.platform, msg.channelId, request.userId,
        );
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

  private createRequestOutboundDir(sessionKey: string | undefined, channelId: string): string | undefined {
    const root = this.deps.outboundMediaDir;
    if (!root) return undefined;

    const requestId = `${sessionKey ?? channelId}-${randomUUID()}`;
    const requestDir = join(root, requestId);
    mkdirSync(requestDir, { recursive: true });
    return requestDir;
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

  private async deliverRequestOutboundMedia(adapter: PlatformAdapter, channelId: string, requestDir?: string): Promise<void> {
    if (!requestDir) return;

    let files: string[];
    try {
      files = readdirSync(requestDir).filter(f => !f.startsWith('.'));
    } catch {
      return;
    }

    for (const file of files) {
      const filePath = join(requestDir, file);
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

    try {
      rmdirSync(requestDir);
    } catch {
      console.warn(`[Gateway] Outbound request directory not empty after delivery: ${requestDir}`);
    }
  }
}
