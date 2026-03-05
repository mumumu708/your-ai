import { ERROR_CODES } from '../shared/errors/error-codes';
import { YourBotError } from '../shared/errors/yourbot-error';
import { Logger } from '../shared/logging/logger';
import type { ChannelType, IChannel, LayerHealth } from '../shared/messaging';
import type { MessageMiddleware } from './middleware/middleware.types';
import { composeMiddleware } from './middleware/pipeline';
import type { MessageRouter } from './message-router';

export class ChannelManager {
  private readonly channels: Map<ChannelType, IChannel> = new Map();
  private readonly logger = new Logger('ChannelManager');
  private readonly router: MessageRouter;
  private readonly middlewares: MessageMiddleware[];

  constructor(router: MessageRouter, middlewares?: MessageMiddleware[]) {
    this.router = router;
    this.middlewares = middlewares ?? [];
  }

  async registerChannel(channel: IChannel): Promise<void> {
    if (this.channels.has(channel.type)) {
      throw new YourBotError(ERROR_CODES.INVALID_CHANNEL, `通道 ${channel.type} 已注册`, {
        channelType: channel.type,
      });
    }

    this.logger.info('注册通道', { type: channel.type, name: channel.name });

    const baseHandler = this.router.createHandler();
    const wrappedHandler = composeMiddleware(this.middlewares, baseHandler);
    channel.onMessage(wrappedHandler);
    await channel.initialize();

    this.channels.set(channel.type, channel);
    this.logger.info('通道注册完成', { type: channel.type });
  }

  getChannel(type: ChannelType): IChannel | undefined {
    return this.channels.get(type);
  }

  getRegisteredTypes(): ChannelType[] {
    return Array.from(this.channels.keys());
  }

  async shutdownAll(): Promise<void> {
    this.logger.info('关闭所有通道', { count: this.channels.size });
    const shutdownPromises: Promise<void>[] = [];

    for (const [type, channel] of this.channels) {
      shutdownPromises.push(
        channel.shutdown().catch((error) => {
          this.logger.error(`通道 ${type} 关闭失败`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );
    }

    await Promise.all(shutdownPromises);
    this.channels.clear();
    this.logger.info('所有通道已关闭');
  }

  async healthCheck(): Promise<LayerHealth> {
    const details: Record<string, unknown> = {};
    let overallStatus: LayerHealth['status'] = 'healthy';

    for (const [type, channel] of this.channels) {
      try {
        // Channels are considered healthy if they're registered and initialized
        details[type] = { status: 'healthy', name: channel.name };
      } catch {
        details[type] = { status: 'unhealthy' };
        overallStatus = 'degraded';
      }
    }

    if (this.channels.size === 0) {
      overallStatus = 'degraded';
      details.note = 'No channels registered';
    }

    return {
      status: overallStatus,
      timestamp: Date.now(),
      details,
    };
  }
}
