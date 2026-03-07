import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type * as lark from '@larksuiteoapi/node-sdk';
import { FeishuCardKitClient } from './feishu-cardkit-client';

function createMockClient() {
  return {
    cardkit: {
      v1: {
        card: {
          create: async () => ({ data: { card_id: 'card_test_001' } }),
          settings: async () => ({ code: 0 }),
        },
        cardElement: {
          content: async () => ({ code: 0 }),
          create: async () => ({ code: 0 }),
        },
      },
    },
    im: {
      message: {
        create: async () => ({ data: { message_id: 'msg_test_001' } }),
      },
    },
  } as unknown as lark.Client;
}

describe('FeishuCardKitClient', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('createStreamingCard 应该返回 card_id', async () => {
    const client = createMockClient();
    const cardKitClient = new FeishuCardKitClient(client);

    const cardId = await cardKitClient.createStreamingCard('思考中...');
    expect(cardId).toBe('card_test_001');
  });

  test('createStreamingCard 应该在无 card_id 时抛出错误', async () => {
    const client = createMockClient();
    client.cardkit.v1.card.create = async () =>
      ({ data: undefined }) as unknown as ReturnType<typeof client.cardkit.v1.card.create>;
    const cardKitClient = new FeishuCardKitClient(client);

    try {
      await cardKitClient.createStreamingCard('思考中...');
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain('card_id');
    }
  });

  test('sendCardMessage 应该调用 im.message.create 并返回 message_id', async () => {
    const client = createMockClient();
    const cardKitClient = new FeishuCardKitClient(client);

    const msgId = await cardKitClient.sendCardMessage('chat_001', 'card_001');
    expect(msgId).toBe('msg_test_001');
  });

  test('streamUpdateText 应该调用 cardElement.content', async () => {
    const client = createMockClient();
    let capturedPayload: unknown;
    client.cardkit.v1.cardElement.content = async (payload) => {
      capturedPayload = payload;
      return { code: 0 };
    };
    const cardKitClient = new FeishuCardKitClient(client);

    await cardKitClient.streamUpdateText('card_001', 'md_content', 'Hello World', 1);

    const p = capturedPayload as Record<string, unknown>;
    expect((p.data as Record<string, unknown>).content).toBe('Hello World');
    expect((p.data as Record<string, unknown>).sequence).toBe(1);
    expect((p.path as Record<string, unknown>).card_id).toBe('card_001');
    expect((p.path as Record<string, unknown>).element_id).toBe('md_content');
  });

  test('closeStreamingMode 应该调用 card.settings', async () => {
    const client = createMockClient();
    let capturedPayload: unknown;
    client.cardkit.v1.card.settings = async (payload) => {
      capturedPayload = payload;
      return { code: 0 };
    };
    const cardKitClient = new FeishuCardKitClient(client);

    await cardKitClient.closeStreamingMode('card_001', 5);

    const p = capturedPayload as Record<string, unknown>;
    const settings = JSON.parse((p.data as Record<string, unknown>).settings as string);
    expect(settings.config.streaming_mode).toBe(false);
    expect((p.path as Record<string, unknown>).card_id).toBe('card_001');
  });

  test('addActionButtons 应该调用 cardElement.create', async () => {
    const client = createMockClient();
    let capturedPayload: unknown;
    client.cardkit.v1.cardElement.create = async (payload) => {
      capturedPayload = payload;
      return { code: 0 };
    };
    const cardKitClient = new FeishuCardKitClient(client);

    await cardKitClient.addActionButtons('card_001', 'md_content', ['复制', '重新生成'], 3);

    const p = capturedPayload as Record<string, unknown>;
    expect((p.data as Record<string, unknown>).type).toBe('insert_after');
    expect((p.data as Record<string, unknown>).target_element_id).toBe('md_content');
    const elements = JSON.parse((p.data as Record<string, unknown>).elements as string);
    expect(elements[0].tag).toBe('action');
    expect(elements[0].actions.length).toBe(2);
  });
});
