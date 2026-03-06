import { describe, expect, test } from 'bun:test';
import type { BotMessage, MessageHandler } from '../../shared/messaging';
import { createTransformMiddleware } from './transform.middleware';

function createTestMessage(overrides: Partial<BotMessage> = {}): BotMessage {
  return {
    id: 'test_1',
    channel: 'web',
    userId: 'user_1',
    userName: 'Test User',
    conversationId: 'conv_1',
    content: 'hello',
    contentType: 'text',
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

describe('createTransformMiddleware', () => {
  test('trims content whitespace', async () => {
    const middleware = createTransformMiddleware();
    let receivedMsg: BotMessage | null = null;
    const next: MessageHandler = async (msg) => {
      receivedMsg = msg;
    };

    const handler = middleware(next);
    await handler(createTestMessage({ content: '  hello world  ' }));

    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg?.content).toBe('hello world');
  });

  test('generates message ID if missing', async () => {
    const middleware = createTransformMiddleware();
    let receivedMsg: BotMessage | null = null;
    const next: MessageHandler = async (msg) => {
      receivedMsg = msg;
    };

    const handler = middleware(next);
    await handler(createTestMessage({ id: '' }));

    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg?.id).toBeTruthy();
    expect(receivedMsg?.id.startsWith('msg_')).toBe(true);
  });

  test('preserves existing message ID', async () => {
    const middleware = createTransformMiddleware();
    let receivedMsg: BotMessage | null = null;
    const next: MessageHandler = async (msg) => {
      receivedMsg = msg;
    };

    const handler = middleware(next);
    await handler(createTestMessage({ id: 'my-id' }));

    expect(receivedMsg?.id).toBe('my-id');
  });

  test('ensures timestamp exists', async () => {
    const middleware = createTransformMiddleware();
    let receivedMsg: BotMessage | null = null;
    const next: MessageHandler = async (msg) => {
      receivedMsg = msg;
    };

    const handler = middleware(next);
    await handler(createTestMessage({ timestamp: 0 }));

    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg?.timestamp).toBeGreaterThan(0);
  });

  test('adds traceId to metadata', async () => {
    const middleware = createTransformMiddleware();
    let receivedMsg: BotMessage | null = null;
    const next: MessageHandler = async (msg) => {
      receivedMsg = msg;
    };

    const handler = middleware(next);
    await handler(createTestMessage());

    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg?.metadata.traceId).toBeDefined();
    expect((receivedMsg?.metadata.traceId as string).startsWith('trace_')).toBe(true);
  });

  test('preserves existing traceId', async () => {
    const middleware = createTransformMiddleware();
    let receivedMsg: BotMessage | null = null;
    const next: MessageHandler = async (msg) => {
      receivedMsg = msg;
    };

    const handler = middleware(next);
    await handler(createTestMessage({ metadata: { traceId: 'existing-trace' } }));

    expect(receivedMsg?.metadata.traceId).toBe('existing-trace');
  });

  test('sanitizes userId - removes special characters', async () => {
    const middleware = createTransformMiddleware();
    let receivedMsg: BotMessage | null = null;
    const next: MessageHandler = async (msg) => {
      receivedMsg = msg;
    };

    const handler = middleware(next);
    await handler(createTestMessage({ userId: 'user<script>alert(1)</script>' }));

    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg?.userId).toBe('userscriptalert1script');
  });

  test('preserves clean userId', async () => {
    const middleware = createTransformMiddleware();
    let receivedMsg: BotMessage | null = null;
    const next: MessageHandler = async (msg) => {
      receivedMsg = msg;
    };

    const handler = middleware(next);
    await handler(createTestMessage({ userId: 'user_123-abc.xyz' }));

    expect(receivedMsg?.userId).toBe('user_123-abc.xyz');
  });

  test('calls next handler', async () => {
    const middleware = createTransformMiddleware();
    let nextCalled = false;
    const next: MessageHandler = async () => {
      nextCalled = true;
    };

    const handler = middleware(next);
    await handler(createTestMessage());

    expect(nextCalled).toBe(true);
  });
});
