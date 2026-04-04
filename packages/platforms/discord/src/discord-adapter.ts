import { Client, GatewayIntentBits, ChannelType, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import type { Message, SendableChannels } from 'discord.js';
import type { PlatformAdapter, IncomingMessage, Attachment, MediaConfig } from '@ccbuddy/core';
import { fetchAttachment, validateAttachment } from '@ccbuddy/core';

export interface DiscordAdapterConfig {
  token: string;
  mediaConfig: MediaConfig;
}

export class DiscordAdapter implements PlatformAdapter {
  readonly platform = 'discord';
  private client: Client;
  private messageHandler?: (msg: IncomingMessage) => void;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private config: DiscordAdapterConfig) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    this.client.once('clientReady', () => {
      console.log(`[Discord] Bot ready as ${this.client.user?.tag}`);
    });

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
    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }

  async sendText(channelId: string, text: string): Promise<string | undefined> {
    const channel = await this.fetchTextChannel(channelId);
    if (!channel) return undefined;
    // Discord's limit is 2000 chars; truncate as a safety net (gateway should chunk first)
    const safe = text.length > 2000 ? text.slice(0, 1997) + '...' : text;
    const msg = await channel.send(safe);
    return msg.id;
  }

  async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
    const channel = await this.fetchTextChannel(channelId);
    if (!channel) return;
    const safe = text.length > 2000 ? text.slice(0, 1997) + '...' : text;
    try {
      const message = await channel.messages.fetch(messageId);
      await message.edit(safe);
    } catch {
      // Message may have been deleted
    }
  }

  async sendImage(channelId: string, image: Buffer, caption?: string): Promise<void> {
    const channel = await this.fetchTextChannel(channelId);
    if (channel) {
      await channel.send({
        ...(caption ? { content: caption } : {}),
        files: [{ attachment: image, name: 'image.png' }],
      });
    }
  }

  async sendFile(channelId: string, file: Buffer, filename: string): Promise<void> {
    const channel = await this.fetchTextChannel(channelId);
    if (channel) {
      await channel.send({
        files: [{ attachment: file, name: filename }],
      });
    }
  }

  async sendVoice(channelId: string, audio: Buffer): Promise<void> {
    const channel = await this.fetchTextChannel(channelId);
    if (channel) {
      await channel.send({
        files: [{ attachment: audio, name: 'voice.ogg' }],
      });
    }
  }

  async setTypingIndicator(channelId: string, active: boolean): Promise<void> {
    if (active) {
      // Clear any existing interval first to prevent leaks on repeated calls
      const existing = this.typingIntervals.get(channelId);
      if (existing) clearInterval(existing);

      // Send immediately, then renew every 8 seconds (Discord typing lasts ~10s)
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        try { await (channel as any).sendTyping(); } catch {}
        const interval = setInterval(async () => {
          try { await (channel as any).sendTyping(); } catch {}
        }, 8000);
        this.typingIntervals.set(channelId, interval);
      }
    } else {
      const interval = this.typingIntervals.get(channelId);
      if (interval) {
        clearInterval(interval);
        this.typingIntervals.delete(channelId);
      }
    }
  }

  async sendButtons(
    channelId: string,
    text: string,
    buttons: Array<{ id: string; label: string }>,
    options: { timeoutMs: number; userId?: string; signal?: AbortSignal },
  ): Promise<string | null> {
    const channel = await this.fetchTextChannel(channelId);
    if (!channel) return null;

    // Build button rows (max 5 buttons per row, max 5 rows = 25 buttons)
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < Math.min(buttons.length, 25); i += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      const slice = buttons.slice(i, i + 5);
      for (const btn of slice) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(btn.id)
            .setLabel(btn.label.slice(0, 80))
            .setStyle(ButtonStyle.Primary),
        );
      }
      rows.push(row);
    }

    const message = await channel.send({ content: text, components: rows });

    // Helper to disable all buttons
    const disableButtons = async () => {
      try {
        await message.edit({
          components: rows.map(r => {
            const disabled = ActionRowBuilder.from<ButtonBuilder>(r);
            disabled.components.forEach(c => c.setDisabled(true));
            return disabled;
          }),
        });
      } catch { /* message may have been deleted */ }
    };

    try {
      // Set up abort signal listener
      let abortHandler: (() => void) | undefined;
      const abortPromise = options.signal ? new Promise<never>((_, reject) => {
        abortHandler = () => reject(new Error('aborted'));
        options.signal!.addEventListener('abort', abortHandler, { once: true });
      }) : null;

      const componentPromise = message.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: options.timeoutMs,
        filter: (i) => !options.userId || i.user.id === options.userId,
      });

      const interaction = await (abortPromise
        ? Promise.race([componentPromise, abortPromise])
        : componentPromise);

      // Clean up abort listener
      if (abortHandler && options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }

      // Acknowledge the interaction and disable buttons
      await interaction.update({
        components: rows.map(r => {
          const disabled = ActionRowBuilder.from<ButtonBuilder>(r);
          disabled.components.forEach(c => c.setDisabled(true));
          return disabled;
        }),
      });

      // Find the label for the clicked button
      const clicked = buttons.find(b => b.id === interaction.customId);
      return clicked?.label ?? null;
    } catch {
      // Timeout or abort — disable buttons
      await disableButtons();
      return null;
    }
  }

  async resolveDMChannel(platformUserId: string): Promise<string | null> {
    try {
      const user = await this.client.users.fetch(platformUserId);
      const dm = await user.createDM();
      return dm.id;
    } catch {
      return null;
    }
  }

  private async fetchTextChannel(channelId: string): Promise<SendableChannels | null> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel?.isSendable()) return channel;
    return null;
  }

  private async normalizeMessage(msg: Message): Promise<IncomingMessage | null> {
    const isDm = msg.channel?.type === ChannelType.DM;
    const isMention = msg.mentions.has(this.client.user!);

    const attachments: Attachment[] = [];
    for (const [, att] of msg.attachments) {
      try {
        const data = await fetchAttachment(att.url, {
          maxBytes: this.config.mediaConfig.max_file_size_mb * 1024 * 1024,
        });
        const mimeType = att.contentType ?? 'application/octet-stream';
        const attachmentType = mimeType.startsWith('image/') ? 'image'
          : mimeType.startsWith('audio/') ? 'voice'
          : 'file';
        const attachment: Attachment = {
          type: attachmentType,
          mimeType,
          data,
          filename: att.name ?? undefined,
        };
        const validation = validateAttachment(attachment, this.config.mediaConfig);
        if (validation.valid) {
          attachments.push(attachment);
        } else {
          console.warn(`[DiscordAdapter] Attachment skipped: ${validation.reason}`);
        }
      } catch (err) {
        console.warn(`[DiscordAdapter] Failed to download attachment: ${(err as Error).message}`);
      }
    }

    return {
      platform: 'discord',
      platformUserId: msg.author.id,
      channelId: msg.channelId,
      channelType: isDm ? 'dm' : 'group',
      text: msg.content ?? '',
      attachments,
      isMention: isDm || isMention,
      replyToMessageId: msg.reference?.messageId ?? undefined,
      raw: msg,
    };
  }
}
