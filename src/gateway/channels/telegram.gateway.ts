import { Telegraf } from 'telegraf';
import { ERROR_CODES } from '../../shared/errors/error-codes';
import { YourBotError } from '../../shared/errors/yourbot-error';
import type { BotMessage, BotResponse, ChannelType, StreamEvent } from '../../shared/messaging';
import { generateId } from '../../shared/utils/crypto';
import { BaseChannel } from './base-channel';

export interface TelegramConfig {
  botToken: string;
}

export class TelegramChannel extends BaseChannel {
  readonly type: ChannelType = 'telegram';
  readonly name = 'telegram';

  private bot!: Telegraf;
  private readonly config: TelegramConfig;
  /** Accumulated stream text per userId for message updates */
  private readonly streamBuffers: Map<string, { text: string; chatId: number; messageId: number }> =
    new Map();

  constructor(config: TelegramConfig) {
    super('TelegramChannel');
    this.config = config;
  }

  async initialize(): Promise<void> {
    this.logger.info('Telegram 通道初始化');

    this.bot = new Telegraf(this.config.botToken);

    this.bot.on('message', async (ctx) => {
      try {
        const message = await this.transformToStandardMessage(ctx.message);
        message.metadata.rawEvent = ctx.message;
        await this.emitMessage(message);
      } catch (error) {
        this.logger.error('Telegram 消息处理失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    await this.bot.launch();
    this.logger.info('Telegram 通道已启动');
  }

  async shutdown(): Promise<void> {
    this.logger.info('Telegram 通道关闭中');
    this.streamBuffers.clear();
    this.bot.stop('shutdown');
    this.logger.info('Telegram 通道已关闭');
  }

  async sendMessage(userId: string, content: BotResponse): Promise<void> {
    const text = content.text ?? JSON.stringify(content.payload ?? '');
    const chatId = Number(userId);
    try {
      await this.bot.telegram.sendMessage(chatId, text);
    } catch (error) {
      this.logger.error('Telegram 发送消息失败', { userId, error: String(error) });
      throw new YourBotError(ERROR_CODES.INVALID_CHANNEL, 'Telegram 发送消息失败', {
        userId,
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async updateMessage(messageId: string, content: BotResponse): Promise<void> {
    const text = content.text ?? JSON.stringify(content.payload ?? '');
    // messageId format: "chatId:messageId"
    const [chatIdStr, msgIdStr] = messageId.split(':');
    const chatId = Number(chatIdStr);
    const msgId = Number(msgIdStr);

    try {
      await this.bot.telegram.editMessageText(chatId, msgId, undefined, text);
    } catch (error) {
      this.logger.error('Telegram 更新消息失败', { messageId, error: String(error) });
      throw new YourBotError(ERROR_CODES.INVALID_CHANNEL, 'Telegram 更新消息失败', {
        messageId,
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async sendStreamChunk(userId: string, chunk: StreamEvent): Promise<void> {
    const chatId = Number(userId);

    if (chunk.type === 'text_delta' && chunk.text) {
      const buffer = this.streamBuffers.get(userId);
      if (buffer) {
        buffer.text += chunk.text;
        try {
          await this.bot.telegram.editMessageText(
            buffer.chatId,
            buffer.messageId,
            undefined,
            buffer.text,
          );
        } catch (error) {
          this.logger.warn('Telegram 流式更新失败', { userId, error: String(error) });
        }
      } else {
        // First chunk: send new message
        try {
          const sent = await this.bot.telegram.sendMessage(chatId, chunk.text);
          this.streamBuffers.set(userId, {
            text: chunk.text,
            chatId,
            messageId: sent.message_id,
          });
        } catch (error) {
          this.logger.error('Telegram 流式初始消息失败', { userId, error: String(error) });
        }
      }
    }

    if (chunk.type === 'done' || chunk.type === 'error') {
      this.streamBuffers.delete(userId);
    }
  }

  async transformToStandardMessage(rawMessage: unknown): Promise<BotMessage> {
    const msg = rawMessage as Record<string, unknown>;
    const from = msg.from as Record<string, unknown> | undefined;
    const chat = msg.chat as Record<string, unknown> | undefined;

    const userId = String(from?.id ?? 'unknown');
    const firstName = (from?.first_name as string) ?? '';
    const lastName = (from?.last_name as string) ?? '';
    const userName = `${firstName} ${lastName}`.trim() || userId;
    const chatId = String(chat?.id ?? 'unknown');
    const messageId = String(msg.message_id ?? generateId('tmsg'));

    // Extract text content
    let textContent = '';
    if (typeof msg.text === 'string') {
      textContent = msg.text;
    } else if (msg.caption && typeof msg.caption === 'string') {
      textContent = msg.caption;
    }

    let contentType: BotMessage['contentType'] = 'text';
    if (msg.photo) contentType = 'image';
    else if (msg.document || msg.audio || msg.voice || msg.video) contentType = 'file';

    return {
      id: `tg_${messageId}`,
      channel: 'telegram',
      userId,
      userName,
      conversationId: chatId,
      content: textContent,
      contentType,
      timestamp: ((msg.date as number) ?? Math.floor(Date.now() / 1000)) * 1000,
      metadata: {
        chatType: chat?.type ?? 'private',
        telegramMessageId: msg.message_id,
      },
    };
  }
}
