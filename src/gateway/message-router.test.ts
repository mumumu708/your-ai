import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { CentralController } from '../kernel/central-controller';
import { ERROR_CODES } from '../shared/errors/error-codes';
import { YourBotError } from '../shared/errors/yourbot-error';
import type { BotMessage } from '../shared/messaging';
import type { TaskResult } from '../shared/tasking/task-result.types';
import { MessageRouter } from './message-router';

function createTestMessage(overrides?: Partial<BotMessage>): BotMessage {
  return {
    id: 'msg_test',
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

function createTestResult(content = 'response text'): TaskResult {
  return {
    success: true,
    taskId: 'task_1',
    data: { content },
    completedAt: Date.now(),
  };
}

describe('MessageRouter', () => {
  let controller: CentralController;

  beforeEach(() => {
    CentralController.resetInstance();
    controller = CentralController.getInstance();
  });

  afterEach(() => {
    CentralController.resetInstance();
  });

  test('createHandler returns a function', () => {
    const router = new MessageRouter(controller);
    const handler = router.createHandler();
    expect(typeof handler).toBe('function');
  });

  test('handler forwards message to controller', async () => {
    const mockHandle = mock(() => Promise.resolve(createTestResult()));
    controller.handleIncomingMessage = mockHandle;

    const router = new MessageRouter(controller);
    const handler = router.createHandler();
    const msg = createTestMessage();

    await handler(msg);
    expect(mockHandle).toHaveBeenCalledTimes(1);
    expect(mockHandle).toHaveBeenCalledWith(msg);
  });

  test('handler dispatches response back to channel', async () => {
    controller.handleIncomingMessage = mock(() => Promise.resolve(createTestResult('hello back')));

    const dispatched: Array<{ channel: string; userId: string; content: unknown }> = [];
    const router = new MessageRouter(controller);
    router.setResponseDispatcher(async (channel, userId, content) => {
      dispatched.push({ channel, userId, content });
    });

    const handler = router.createHandler();
    await handler(createTestMessage());

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].channel).toBe('web');
    expect(dispatched[0].userId).toBe('user_1');
    expect((dispatched[0].content as { text: string }).text).toBe('hello back');
  });

  test('handler wraps non-YourBotError in YourBotError', async () => {
    controller.handleIncomingMessage = mock(() => Promise.reject(new Error('some failure')));

    const router = new MessageRouter(controller);
    const handler = router.createHandler();

    try {
      await handler(createTestMessage());
      expect(true).toBe(false); // should not reach
    } catch (error) {
      expect(error).toBeInstanceOf(YourBotError);
      expect((error as YourBotError).code).toBe(ERROR_CODES.UNKNOWN);
    }
  });

  test('handler re-throws YourBotError as-is', async () => {
    const originalError = new YourBotError(ERROR_CODES.INVALID_MESSAGE, 'bad msg');
    controller.handleIncomingMessage = mock(() => Promise.reject(originalError));

    const router = new MessageRouter(controller);
    const handler = router.createHandler();

    try {
      await handler(createTestMessage());
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBe(originalError);
    }
  });

  test('handler sends error response when processing fails', async () => {
    controller.handleIncomingMessage = mock(() => Promise.reject(new Error('processing error')));

    const dispatched: Array<{ content: unknown }> = [];
    const router = new MessageRouter(controller);
    router.setResponseDispatcher(async (_ch, _uid, content) => {
      dispatched.push({ content });
    });

    const handler = router.createHandler();

    try {
      await handler(createTestMessage());
    } catch {
      // Expected
    }

    expect(dispatched).toHaveLength(1);
    expect((dispatched[0].content as { text: string }).text).toContain('processing error');
  });
});
