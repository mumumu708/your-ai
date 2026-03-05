import * as lark from '@larksuiteoapi/node-sdk';
import { ERROR_CODES } from '../../shared/errors/error-codes';
import { YourBotError } from '../../shared/errors/yourbot-error';
import type { BotMessage, BotResponse, ChannelType, StreamEvent } from '../../shared/messaging';
import { generateId } from '../../shared/utils/crypto';
import { BaseChannel } from './base-channel';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
}

export class FeishuChannel extends BaseChannel {
  readonly type: ChannelType = 'feishu';
  readonly name = 'feishu';

  private client!: lark.Client;
  private wsClient!: lark.WSClient;
  private readonly config: FeishuConfig;
  /** Accumulated stream text per userId for card updates */
  private readonly streamBuffers: Map<string, { text: string; messageId: string }> = new Map();
  /** Whether the long connection is established */
  private connected = false;

  constructor(config: FeishuConfig) {
    super('FeishuChannel');
    this.config = config;
  }

  /** Whether the Feishu long connection is established */
  isConnected(): boolean {
    return this.connected;
  }

  async initialize(): Promise<void> {
    this.logger.info('飞书通道初始化', { appId: this.config.appId });

    this.client = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    // Build eventDispatcher with im.message.receive_v1 handler
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        try {
          const message = await this.transformToStandardMessage(data);
          message.metadata.rawEvent = data;
          await this.emitMessage(message);
        } catch (error) {
          this.logger.error('飞书消息处理失败', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });

    // Create WSClient (no eventDispatcher in constructor per new SDK API)
    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      autoReconnect: true,
    });

    // start() internally: pullConnectConfig → WebSocket connect → resolve
    // On success the SDK logs "[ws] ws client ready"
    try {
      await this.wsClient.start({ eventDispatcher });
      this.connected = true;
      this.logger.info('飞书长连接已建立');
    } catch (error) {
      this.connected = false;
      this.logger.error('飞书长连接建立失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new YourBotError(ERROR_CODES.INVALID_CHANNEL, '飞书长连接建立失败', {
        appId: this.config.appId,
        originalError: error instanceof Error ? error.message : String(error),
      });
    }

    this.logger.info('飞书通道已启动');
  }

  async shutdown(): Promise<void> {
    this.logger.info('飞书通道关闭中');
    this.streamBuffers.clear();
    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true });
        this.connected = false;
        this.logger.info('飞书长连接已断开');
      } catch (error) {
        this.logger.error('飞书长连接关闭失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.logger.info('飞书通道已关闭');
  }

  async sendMessage(userId: string, content: BotResponse): Promise<void> {
    const text = content.text ?? JSON.stringify(content.payload ?? '');
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: userId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    } catch (error) {
      this.logger.error('飞书发送消息失败', { userId, error: String(error) });
      throw new YourBotError(ERROR_CODES.INVALID_CHANNEL, '飞书发送消息失败', {
        userId,
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async updateMessage(messageId: string, content: BotResponse): Promise<void> {
    const text = content.text ?? JSON.stringify(content.payload ?? '');
    try {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify({ text }) },
      });
    } catch (error) {
      this.logger.error('飞书更新消息失败', { messageId, error: String(error) });
      throw new YourBotError(ERROR_CODES.INVALID_CHANNEL, '飞书更新消息失败', {
        messageId,
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async sendStreamChunk(userId: string, chunk: StreamEvent): Promise<void> {
    if (chunk.type === 'text_delta' && chunk.text) {
      const buffer = this.streamBuffers.get(userId);
      if (buffer) {
        buffer.text += chunk.text;
        await this.updateMessage(buffer.messageId, { type: 'text', text: buffer.text });
      } else {
        // First chunk: send initial message and store messageId
        const response = await this.client.im.message.create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: userId,
            msg_type: 'text',
            content: JSON.stringify({ text: chunk.text }),
          },
        });
        const messageId =
          ((response as Record<string, unknown>)?.message_id as string) ?? generateId('fmsg');
        this.streamBuffers.set(userId, { text: chunk.text, messageId });
      }
    }

    if (chunk.type === 'done' || chunk.type === 'error') {
      this.streamBuffers.delete(userId);
    }
  }

  async transformToStandardMessage(rawMessage: unknown): Promise<BotMessage> {
    const data = rawMessage as Record<string, unknown>;
    const sender = data.sender as Record<string, unknown> | undefined;
    const message = data.message as Record<string, unknown> | undefined;

    const openId = ((sender?.sender_id as Record<string, unknown>)?.open_id as string) ?? 'unknown';
    const msgContent = (message?.content as string) ?? '{}';
    const chatId = (message?.chat_id as string) ?? 'unknown';
    const messageId = (message?.message_id as string) ?? generateId('fmsg');
    const msgType = (message?.message_type as string) ?? 'text';

    let textContent = '';
    let fileKey: string | undefined;
    let fileName: string | undefined;

    try {
      const parsed = JSON.parse(msgContent);
      if (msgType === 'file') {
        fileKey = parsed.file_key;
        fileName = parsed.file_name;
        textContent = `[文件: ${fileName ?? 'unknown'}]`;
      } else {
        textContent = parsed.text ?? msgContent;
      }
    } catch {
      textContent = msgContent;
    }

    return {
      id: messageId,
      channel: 'feishu',
      userId: openId,
      userName: ((sender?.sender_id as Record<string, unknown>)?.union_id as string) ?? openId,
      conversationId: chatId,
      content: textContent,
      contentType: msgType === 'text' ? 'text' : 'file',
      timestamp: Date.now(),
      metadata: {
        rawType: msgType,
        chatId,
        ...(fileKey ? { fileKey } : {}),
        ...(fileName ? { fileName } : {}),
      },
    };
  }

  async downloadFile(messageId: string, fileKey: string): Promise<Buffer> {
    try {
      const resp = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'file' },
      });

      // resp is a ReadableStream or Buffer depending on SDK version
      if (Buffer.isBuffer(resp)) {
        return resp;
      }
      if (resp && typeof (resp as Record<string, unknown>).arrayBuffer === 'function') {
        const ab = await (resp as unknown as Response).arrayBuffer();
        return Buffer.from(ab);
      }
      // Fallback: try reading as stream
      const chunks: Uint8Array[] = [];
      const reader = (resp as unknown as ReadableStream).getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      this.logger.error('飞书文件下载失败', {
        messageId,
        fileKey,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new YourBotError(ERROR_CODES.INVALID_CHANNEL, '飞书文件下载失败', {
        messageId,
        fileKey,
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
