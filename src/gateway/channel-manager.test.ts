import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CentralController } from '../kernel/central-controller';
import { YourBotError } from '../shared/errors/yourbot-error';
import type {
  BotResponse,
  ChannelType,
  IChannel,
  MessageHandler,
  StreamEvent,
} from '../shared/messaging';
import { ChannelManager } from './channel-manager';
import { MessageRouter } from './message-router';

class MockChannel implements IChannel {
  readonly type: ChannelType;
  readonly name: string;
  initialized = false;
  shutdownCalled = false;
  handler?: MessageHandler;

  constructor(type: ChannelType, name: string) {
    this.type = type;
    this.name = name;
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalled = true;
  }

  async sendMessage(_userId: string, _content: BotResponse): Promise<void> {}
  async updateMessage(_messageId: string, _content: BotResponse): Promise<void> {}
  async sendStreamChunk(_userId: string, _chunk: StreamEvent): Promise<void> {}

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }
}

describe('ChannelManager', () => {
  let controller: CentralController;
  let router: MessageRouter;
  let manager: ChannelManager;

  beforeEach(() => {
    CentralController.resetInstance();
    controller = CentralController.getInstance();
    router = new MessageRouter(controller);
    manager = new ChannelManager(router);
  });

  afterEach(() => {
    CentralController.resetInstance();
  });

  test('registerChannel initializes and stores the channel', async () => {
    const channel = new MockChannel('web', 'web');
    await manager.registerChannel(channel);

    expect(channel.initialized).toBe(true);
    expect(channel.handler).toBeDefined();
    expect(manager.getChannel('web')).toBe(channel);
  });

  test('registerChannel throws on duplicate type', async () => {
    const channel1 = new MockChannel('web', 'web-1');
    const channel2 = new MockChannel('web', 'web-2');

    await manager.registerChannel(channel1);

    try {
      await manager.registerChannel(channel2);
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(YourBotError);
      expect((error as YourBotError).message).toContain('已注册');
    }
  });

  test('getChannel returns undefined for unregistered type', () => {
    expect(manager.getChannel('feishu')).toBeUndefined();
  });

  test('getRegisteredTypes returns all registered channel types', async () => {
    await manager.registerChannel(new MockChannel('web', 'web'));
    await manager.registerChannel(new MockChannel('feishu', 'feishu'));

    const types = manager.getRegisteredTypes();
    expect(types).toContain('web');
    expect(types).toContain('feishu');
    expect(types.length).toBe(2);
  });

  test('shutdownAll calls shutdown on all channels and clears', async () => {
    const web = new MockChannel('web', 'web');
    const feishu = new MockChannel('feishu', 'feishu');

    await manager.registerChannel(web);
    await manager.registerChannel(feishu);

    await manager.shutdownAll();

    expect(web.shutdownCalled).toBe(true);
    expect(feishu.shutdownCalled).toBe(true);
    expect(manager.getRegisteredTypes().length).toBe(0);
  });

  test('shutdownAll handles errors gracefully', async () => {
    const channel = new MockChannel('web', 'web');
    channel.shutdown = () => Promise.reject(new Error('shutdown error'));

    await manager.registerChannel(channel);
    // Should not throw
    await manager.shutdownAll();
    expect(manager.getRegisteredTypes().length).toBe(0);
  });

  test('healthCheck returns healthy with channels', async () => {
    await manager.registerChannel(new MockChannel('web', 'web'));

    const health = await manager.healthCheck();
    expect(health.status).toBe('healthy');
    expect(health.details?.web).toBeDefined();
  });

  test('healthCheck returns degraded with no channels', async () => {
    const health = await manager.healthCheck();
    expect(health.status).toBe('degraded');
  });
});
