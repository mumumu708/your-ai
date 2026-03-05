import { describe, expect, test } from 'bun:test';
import type { BotMessage, MessageHandler } from '../../shared/messaging';
import type { MessageMiddleware } from './middleware.types';
import { composeMiddleware, createMiddlewarePipeline } from './pipeline';

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

describe('composeMiddleware', () => {
  test('passes message through to base handler when no middlewares', async () => {
    const calls: string[] = [];
    const base: MessageHandler = async (msg) => {
      calls.push(`base:${msg.content}`);
    };

    const handler = composeMiddleware([], base);
    await handler(createTestMessage());

    expect(calls).toEqual(['base:hello']);
  });

  test('middlewares execute in order (first wraps outermost)', async () => {
    const calls: string[] = [];

    const mw1: MessageMiddleware = (next) => async (msg) => {
      calls.push('mw1:before');
      await next(msg);
      calls.push('mw1:after');
    };

    const mw2: MessageMiddleware = (next) => async (msg) => {
      calls.push('mw2:before');
      await next(msg);
      calls.push('mw2:after');
    };

    const base: MessageHandler = async () => {
      calls.push('base');
    };

    const handler = composeMiddleware([mw1, mw2], base);
    await handler(createTestMessage());

    expect(calls).toEqual(['mw1:before', 'mw2:before', 'base', 'mw2:after', 'mw1:after']);
  });

  test('middleware can short-circuit (not call next)', async () => {
    const calls: string[] = [];

    const blocker: MessageMiddleware = (_next) => async (_msg) => {
      calls.push('blocked');
      // Does not call next
    };

    const base: MessageHandler = async () => {
      calls.push('base');
    };

    const handler = composeMiddleware([blocker], base);
    await handler(createTestMessage());

    expect(calls).toEqual(['blocked']);
  });

  test('middleware can modify the message', async () => {
    let receivedContent = '';

    const transformer: MessageMiddleware = (next) => async (msg) => {
      await next({ ...msg, content: msg.content.toUpperCase() });
    };

    const base: MessageHandler = async (msg) => {
      receivedContent = msg.content;
    };

    const handler = composeMiddleware([transformer], base);
    await handler(createTestMessage({ content: 'hello' }));

    expect(receivedContent).toBe('HELLO');
  });

  test('errors propagate from middleware', async () => {
    const failing: MessageMiddleware = (_next) => async (_msg) => {
      throw new Error('middleware error');
    };

    const base: MessageHandler = async () => {};
    const handler = composeMiddleware([failing], base);

    expect(handler(createTestMessage())).rejects.toThrow('middleware error');
  });
});

describe('createMiddlewarePipeline', () => {
  test('returns a wrapping function', async () => {
    const calls: string[] = [];

    const mw: MessageMiddleware = (next) => async (msg) => {
      calls.push('mw');
      await next(msg);
    };

    const wrap = createMiddlewarePipeline([mw]);

    const base: MessageHandler = async () => {
      calls.push('base');
    };

    const handler = wrap(base);
    await handler(createTestMessage());

    expect(calls).toEqual(['mw', 'base']);
  });
});
