import type { Server, ServerWebSocket } from 'bun';
import { ERROR_CODES } from '../../shared/errors/error-codes';
import { YourBotError } from '../../shared/errors/yourbot-error';
import type { BotMessage, BotResponse, ChannelType, StreamEvent } from '../../shared/messaging';
import { generateId } from '../../shared/utils/crypto';
import type { AuthContext } from '../middleware/middleware.types';
import { BaseChannel } from './base-channel';

export interface WebChannelConfig {
  port: number;
  path?: string;
  wsAuthHandler?: (req: Request) => Promise<AuthContext | null>;
}

interface WebSocketData {
  connectionId: string;
  userId: string;
  authContext?: AuthContext;
}

export class WebChannel extends BaseChannel {
  readonly type: ChannelType = 'web';
  readonly name = 'web';

  private server: Server | null = null;
  private readonly config: WebChannelConfig;
  private readonly connections: Map<string, ServerWebSocket<WebSocketData>> = new Map();

  constructor(config: WebChannelConfig) {
    super('WebChannel');
    this.config = config;
  }

  async initialize(): Promise<void> {
    const wsPath = this.config.path ?? '/ws';
    this.logger.info('Web 通道初始化', { port: this.config.port, path: wsPath });

    this.server = Bun.serve<WebSocketData>({
      port: this.config.port,
      fetch: async (req, server) => {
        const url = new URL(req.url);
        if (url.pathname === wsPath) {
          // WebSocket auth: verify before upgrading
          let authContext: AuthContext | undefined;
          if (this.config.wsAuthHandler) {
            const result = await this.config.wsAuthHandler(req);
            if (!result) {
              return new Response('Unauthorized', { status: 401 });
            }
            authContext = result;
          }

          const userId =
            authContext?.userId ?? url.searchParams.get('userId') ?? generateId('anon');
          const upgraded = server.upgrade(req, {
            data: { connectionId: generateId('ws'), userId, authContext },
          });
          if (upgraded) return undefined as unknown as Response;
          return new Response('WebSocket upgrade failed', { status: 400 });
        }
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open: (ws) => this.handleOpen(ws),
        message: (ws, message) => this.handleWsMessage(ws, message),
        close: (ws) => this.handleClose(ws),
      },
    });

    this.logger.info('Web 通道已启动', { port: this.config.port });
  }

  async shutdown(): Promise<void> {
    this.logger.info('Web 通道关闭中');
    for (const [id, ws] of this.connections) {
      try {
        ws.close(1000, 'server shutdown');
      } catch {
        // connection may already be closed
      }
      this.connections.delete(id);
    }
    this.server?.stop();
    this.server = null;
    this.logger.info('Web 通道已关闭');
  }

  async sendMessage(userId: string, content: BotResponse): Promise<void> {
    const ws = this.findConnectionByUserId(userId);
    if (!ws) {
      throw new YourBotError(ERROR_CODES.NOT_FOUND, 'WebSocket 连接未找到', { userId });
    }
    ws.send(JSON.stringify({ type: 'message', data: content }));
  }

  async updateMessage(messageId: string, content: BotResponse): Promise<void> {
    // For web channel, broadcast update to all connections or the specific one
    // messageId format: "connectionId:originalMessageId"
    const [connectionId] = messageId.split(':');
    const ws = connectionId ? this.connections.get(connectionId) : undefined;
    if (!ws) {
      throw new YourBotError(ERROR_CODES.NOT_FOUND, 'WebSocket 连接未找到', { messageId });
    }
    ws.send(JSON.stringify({ type: 'update', messageId, data: content }));
  }

  async sendStreamChunk(userId: string, chunk: StreamEvent): Promise<void> {
    const ws = this.findConnectionByUserId(userId);
    if (!ws) {
      this.logger.warn('流式推送: 连接未找到', { userId });
      return;
    }
    ws.send(JSON.stringify({ type: 'stream', data: chunk }));
  }

  async transformToStandardMessage(rawMessage: unknown): Promise<BotMessage> {
    const data = rawMessage as Record<string, unknown>;
    const contentType = (data.contentType as BotMessage['contentType']) ?? 'text';
    const metadata = (data.metadata as Record<string, unknown>) ?? {};

    // Support base64 file upload: { contentType: 'file', fileName: '...', fileContent: '<base64>' }
    if (contentType === 'file' && data.fileName) {
      metadata.fileName = data.fileName as string;
      metadata.fileContentBase64 = (data.fileContent as string) ?? '';
    }

    return {
      id: (data.id as string) ?? generateId('wmsg'),
      channel: 'web',
      userId: (data.userId as string) ?? 'unknown',
      userName: (data.userName as string) ?? 'Web User',
      conversationId: (data.conversationId as string) ?? generateId('wconv'),
      content: contentType === 'file' ? `[文件: ${(data.fileName as string) ?? 'unknown'}]` : ((data.content as string) ?? ''),
      contentType,
      timestamp: (data.timestamp as number) ?? Date.now(),
      metadata,
    };
  }

  handleOpen(ws: ServerWebSocket<WebSocketData>): void {
    const { connectionId, userId } = ws.data;
    this.connections.set(connectionId, ws);
    this.logger.info('WebSocket 连接建立', { connectionId, userId });
    ws.send(JSON.stringify({ type: 'connected', connectionId }));
  }

  async handleWsMessage(
    ws: ServerWebSocket<WebSocketData>,
    message: string | Buffer,
  ): Promise<void> {
    const raw = typeof message === 'string' ? message : message.toString();
    try {
      const parsed = JSON.parse(raw);
      // Inject userId from connection data
      parsed.userId = parsed.userId ?? ws.data.userId;
      const botMessage = await this.transformToStandardMessage(parsed);
      // Inject authContext from WebSocket upgrade
      if (ws.data.authContext) {
        botMessage.metadata.authContext = ws.data.authContext;
      }
      await this.emitMessage(botMessage);
    } catch (error) {
      this.logger.error('WebSocket 消息解析失败', {
        connectionId: ws.data.connectionId,
        error: error instanceof Error ? error.message : String(error),
      });
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  }

  handleClose(ws: ServerWebSocket<WebSocketData>): void {
    const { connectionId, userId } = ws.data;
    this.connections.delete(connectionId);
    this.logger.info('WebSocket 连接关闭', { connectionId, userId });
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  private findConnectionByUserId(userId: string): ServerWebSocket<WebSocketData> | undefined {
    for (const ws of this.connections.values()) {
      if (ws.data.userId === userId) {
        return ws;
      }
    }
    return undefined;
  }
}
