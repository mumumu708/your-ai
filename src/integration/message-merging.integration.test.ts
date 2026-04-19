/**
 * 集成测试: 消息合并 (DD-017 debounce)
 *
 * 测试快速连续发送多条消息时的合并行为:
 *   MessageRouter → CentralController (debounce) → QueueAggregator → AgentRuntime
 *
 * 所有 LLM 后端均使用 mock，不产生真实 API 调用。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { MessageRouter } from '../gateway/message-router';
import { AgentRuntime } from '../kernel/agents/agent-runtime';
import { CentralController } from '../kernel/central-controller';
import type { BotMessage } from '../shared/messaging';
import { createMockOVDeps } from '../test-utils/mock-ov-deps';

function createMessage(overrides?: Partial<BotMessage>): BotMessage {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    channel: 'web',
    userId: 'user_merge_test',
    userName: 'Merge Tester',
    conversationId: 'conv_merge_test',
    content: 'hello',
    contentType: 'text',
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

describe('消息合并集成测试', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    CentralController.resetInstance();
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    CentralController.resetInstance();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('MessageRouter → CentralController 消息合并', () => {
    test('快速连续发送多条噪声消息应被合并，只产生一次 agent 调用', async () => {
      const agentRuntime = new AgentRuntime();
      let resolveFirst: (() => void) | undefined;
      const firstBlocked = new Promise<void>((r) => {
        resolveFirst = r;
      });

      let executeCount = 0;
      spyOn(agentRuntime, 'execute').mockImplementation(async () => {
        executeCount++;
        if (executeCount === 1) {
          await firstBlocked;
        }
        return {
          content: `reply-${executeCount}`,
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          complexity: 'simple',
          channel: 'agent_sdk',
          classificationCostUsd: 0,
        };
      });

      const controller = CentralController.getInstance({
        agentRuntime,
        ...createMockOVDeps(),
      });

      const dispatched: Array<{ channel: ChannelType; userId: string; content: BotResponse }> = [];
      const router = new MessageRouter(controller);
      router.setResponseDispatcher(async (channel, userId, content) => {
        dispatched.push({ channel, userId, content });
      });

      const handler = router.createHandler();

      // First message: meaningful
      const p1 = handler(createMessage({ content: '帮我查一下天气' }));
      await new Promise((r) => setTimeout(r, 50));

      // Rapid noise messages while first is processing
      const p2 = handler(createMessage({ content: '123' }));
      const p3 = handler(createMessage({ content: '456' }));
      const p4 = handler(createMessage({ content: '789' }));

      // Release first message
      resolveFirst?.();

      await Promise.all([p1, p2, p3, p4]);

      // Only 1 agent call for the first meaningful message.
      // Noise messages (123, 456, 789) should be filtered by QueueAggregator.
      expect(executeCount).toBe(1);
    });

    test('快速连续发送有意义消息应被合并为一个任务', async () => {
      const agentRuntime = new AgentRuntime();
      let resolveFirst: (() => void) | undefined;
      const firstBlocked = new Promise<void>((r) => {
        resolveFirst = r;
      });

      let executeCount = 0;
      spyOn(agentRuntime, 'execute').mockImplementation(async () => {
        executeCount++;
        if (executeCount === 1) {
          await firstBlocked;
        }
        return {
          content: `reply-${executeCount}`,
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          complexity: 'simple',
          channel: 'agent_sdk',
          classificationCostUsd: 0,
        };
      });

      const controller = CentralController.getInstance({
        agentRuntime,
        ...createMockOVDeps(),
      });

      const handler = new MessageRouter(controller).createHandler();

      // First message
      const p1 = handler(createMessage({ content: '帮我查天气' }));
      await new Promise((r) => setTimeout(r, 50));

      // Override pattern: user corrects themselves
      const p2 = handler(createMessage({ content: '不是，我是说帮我查机票' }));

      resolveFirst?.();
      await Promise.all([p1, p2]);

      // Agent called twice: once for first message, once for merged/override second
      expect(executeCount).toBe(2);
    });

    test('不同会话的消息不应互相影响', async () => {
      const agentRuntime = new AgentRuntime();

      let executeCount = 0;
      spyOn(agentRuntime, 'execute').mockImplementation(async () => {
        executeCount++;
        return {
          content: `reply-${executeCount}`,
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          complexity: 'simple',
          channel: 'agent_sdk',
          classificationCostUsd: 0,
        };
      });

      const controller = CentralController.getInstance({
        agentRuntime,
        ...createMockOVDeps(),
      });

      const handler = new MessageRouter(controller).createHandler();

      // User A and User B send messages — different sessions, both processed independently
      await handler(createMessage({ userId: 'userA', conversationId: 'convA', content: '你好' }));
      await handler(createMessage({ userId: 'userB', conversationId: 'convB', content: '世界' }));

      // Both should be processed independently (no merging across sessions)
      expect(executeCount).toBe(2);
    });

    test('混合噪声和有意义消息应只保留有意义的', async () => {
      const agentRuntime = new AgentRuntime();
      let resolveFirst: (() => void) | undefined;
      const firstBlocked = new Promise<void>((r) => {
        resolveFirst = r;
      });

      let executeCount = 0;
      spyOn(agentRuntime, 'execute').mockImplementation(async () => {
        executeCount++;
        if (executeCount === 1) {
          await firstBlocked;
        }
        return {
          content: `reply-${executeCount}`,
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          complexity: 'simple',
          channel: 'agent_sdk',
          classificationCostUsd: 0,
        };
      });

      const controller = CentralController.getInstance({
        agentRuntime,
        ...createMockOVDeps(),
      });

      const handler = new MessageRouter(controller).createHandler();

      // First meaningful message
      const p1 = handler(createMessage({ content: '帮我写一封邮件' }));
      await new Promise((r) => setTimeout(r, 50));

      // Mix of noise and meaningful
      const p2 = handler(createMessage({ content: '123' }));
      const p3 = handler(createMessage({ content: '请用正式语气' }));
      const p4 = handler(createMessage({ content: '456' }));

      resolveFirst?.();
      await Promise.all([p1, p2, p3, p4]);

      // First message processed normally, then merged buffer should process '请用正式语气'
      // (123 and 456 are noise, filtered out)
      expect(executeCount).toBe(2);
    });
  });
});
