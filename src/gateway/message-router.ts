import { CentralController } from '../kernel/central-controller';
import { ERROR_CODES } from '../shared/errors/error-codes';
import { YourBotError } from '../shared/errors/yourbot-error';
import { Logger } from '../shared/logging/logger';
import type { BotMessage, BotResponse, ChannelType, MessageHandler } from '../shared/messaging';
import type { TaskResult } from '../shared/tasking/task-result.types';

export type ResponseDispatcher = (
  channel: ChannelType,
  userId: string,
  content: BotResponse,
) => Promise<void>;

export class MessageRouter {
  private readonly logger = new Logger('MessageRouter');
  private readonly controller: CentralController;
  private responseDispatcher?: ResponseDispatcher;

  constructor(controller?: CentralController) {
    this.controller = controller ?? CentralController.getInstance();
  }

  /**
   * Set the callback for dispatching responses back to channels.
   */
  setResponseDispatcher(dispatcher: ResponseDispatcher): void {
    this.responseDispatcher = dispatcher;
  }

  /** Returns a MessageHandler function suitable for IChannel.onMessage() */
  createHandler(): MessageHandler {
    return async (message: BotMessage): Promise<void> => {
      this.logger.info('路由消息', {
        messageId: message.id,
        channel: message.channel,
        userId: message.userId,
      });

      try {
        const result = await this.controller.handleIncomingMessage(message);

        // Dispatch response back to the originating channel
        if (result && this.responseDispatcher) {
          const data = result.data as Record<string, unknown> | undefined;
          if (data?.streamed) {
            this.logger.info('响应已通过流式通道发送，跳过二次分发', {
              messageId: message.id,
            });
          } else {
            const content = this.extractContent(result);
            if (content) {
              await this.responseDispatcher(message.channel, message.userId, content);
            }
          }
        }
      } catch (error) {
        this.logger.error('消息路由失败', {
          messageId: message.id,
          channel: message.channel,
          error: error instanceof Error ? error.message : String(error),
        });

        // Send error response back to user
        if (this.responseDispatcher) {
          await this.responseDispatcher(message.channel, message.userId, {
            type: 'text',
            text: `处理失败: ${error instanceof Error ? error.message : '未知错误'}`,
          }).catch(() => {});
        }

        if (error instanceof YourBotError) {
          throw error;
        }
        throw new YourBotError(ERROR_CODES.UNKNOWN, '消息路由失败', {
          messageId: message.id,
          originalError: error instanceof Error ? error.message : String(error),
        });
      }
    };
  }

  private extractContent(result: TaskResult): BotResponse | null {
    if (!result.success || !result.data) return null;

    const data = result.data as Record<string, unknown>;
    const text = (data.content as string) ?? (data.response as string);
    if (!text) return null;

    return { type: 'text', text };
  }
}
