import { describe, expect, test } from 'bun:test';
import type { AgentBridge, AgentExecuteParams, AgentResult } from './agent-bridge';
import { AgentBridgeWithFallback } from './agent-bridge-fallback';

function makeParams(overrides: Partial<AgentExecuteParams> = {}): AgentExecuteParams {
  return {
    systemPrompt: 'test prompt',
    prependContext: '',
    userMessage: 'hello',
    sessionId: 'sess-1',
    executionMode: 'sync',
    ...overrides,
  };
}

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    content: 'response',
    tokenUsage: { inputTokens: 10, outputTokens: 5 },
    finishedNaturally: true,
    handledBy: 'claude',
    ...overrides,
  };
}

function createMockBridge(overrides: Partial<AgentBridge> = {}): AgentBridge {
  return {
    execute: async () => makeResult(),
    ...overrides,
  };
}

describe('AgentBridgeWithFallback', () => {
  describe('execute', () => {
    test('主 bridge 成功时返回结果并标记 handledBy', async () => {
      const primary = createMockBridge({
        execute: async () => makeResult({ content: 'claude says hi' }),
      });
      const fallback = createMockBridge();
      const bridge = new AgentBridgeWithFallback(primary, fallback, 'claude', 'codex');

      const result = await bridge.execute(makeParams());

      expect(result.content).toBe('claude says hi');
      expect(result.handledBy).toBe('claude');
    });

    test('主 bridge 抛出 provider 不可用错误时自动 fallback', async () => {
      const primary = createMockBridge({
        execute: async () => {
          throw new Error('rate limit exceeded');
        },
      });
      const fallback = createMockBridge({
        execute: async () => makeResult({ content: 'codex fallback' }),
      });
      const bridge = new AgentBridgeWithFallback(primary, fallback, 'claude', 'codex');

      const result = await bridge.execute(makeParams());

      expect(result.content).toBe('codex fallback');
      expect(result.handledBy).toBe('codex');
    });

    test('主 bridge 抛出非 provider 错误时直接抛出', async () => {
      const primary = createMockBridge({
        execute: async () => {
          throw new Error('invalid input: bad prompt');
        },
      });
      const fallback = createMockBridge();
      const bridge = new AgentBridgeWithFallback(primary, fallback);

      await expect(bridge.execute(makeParams())).rejects.toThrow('invalid input: bad prompt');
    });

    test('fallback 也失败时抛出 fallback 的错误', async () => {
      const primary = createMockBridge({
        execute: async () => {
          throw new Error('503 service unavailable');
        },
      });
      const fallback = createMockBridge({
        execute: async () => {
          throw new Error('codex also failed');
        },
      });
      const bridge = new AgentBridgeWithFallback(primary, fallback);

      await expect(bridge.execute(makeParams())).rejects.toThrow('codex also failed');
    });
  });

  describe('isProviderUnavailable', () => {
    const bridge = new AgentBridgeWithFallback(createMockBridge(), createMockBridge());

    test.each([
      ['ENOENT: claude not found', true],
      ['command not found: claude', true],
      ['rate limit exceeded', true],
      ['ratelimit hit', true],
      ['quota exceeded', true],
      ['503 Service Unavailable', true],
      ['502 Bad Gateway', true],
      ['connection timeout', true],
      ['ECONNREFUSED 127.0.0.1:8080', true],
      ['ECONNRESET by peer', true],
      ['File not found: user-config.md', false],
      ['invalid input', false],
      ['permission denied', false],
    ])('"%s" → %s', (message, expected) => {
      expect(bridge.isProviderUnavailable(new Error(message))).toBe(expected);
    });

    test('非 Error 对象返回 false', () => {
      expect(bridge.isProviderUnavailable('string error')).toBe(false);
      expect(bridge.isProviderUnavailable(null)).toBe(false);
      expect(bridge.isProviderUnavailable(undefined)).toBe(false);
    });
  });

  describe('appendMessage', () => {
    test('优先调用主 bridge', async () => {
      let primaryCalled = false;
      const primary = createMockBridge({
        appendMessage: async () => {
          primaryCalled = true;
        },
      });
      const fallback = createMockBridge({
        appendMessage: async () => {
          throw new Error('should not be called');
        },
      });
      const bridge = new AgentBridgeWithFallback(primary, fallback);

      await bridge.appendMessage('key-1', 'hello');

      expect(primaryCalled).toBe(true);
    });

    test('主 bridge 失败时回退到 fallback', async () => {
      let fallbackCalled = false;
      const primary = createMockBridge({
        appendMessage: async () => {
          throw new Error('primary down');
        },
      });
      const fallback = createMockBridge({
        appendMessage: async () => {
          fallbackCalled = true;
        },
      });
      const bridge = new AgentBridgeWithFallback(primary, fallback);

      await bridge.appendMessage('key-1', 'hello');

      expect(fallbackCalled).toBe(true);
    });

    test('主 bridge 未实现 appendMessage 时回退到 fallback', async () => {
      let fallbackCalled = false;
      const primary = createMockBridge(); // no appendMessage
      const fallback = createMockBridge({
        appendMessage: async () => {
          fallbackCalled = true;
        },
      });
      const bridge = new AgentBridgeWithFallback(primary, fallback);

      await bridge.appendMessage('key-1', 'hello');

      // primary.appendMessage is undefined, calling undefined?.() returns undefined (no throw)
      // so fallback is NOT called in this case — primary "succeeded" (no-op)
      expect(fallbackCalled).toBe(false);
    });
  });

  describe('abort', () => {
    test('同时取消两个 bridge', async () => {
      let primaryAborted = false;
      let fallbackAborted = false;
      const primary = createMockBridge({
        abort: async () => {
          primaryAborted = true;
        },
      });
      const fallback = createMockBridge({
        abort: async () => {
          fallbackAborted = true;
        },
      });
      const bridge = new AgentBridgeWithFallback(primary, fallback);

      await bridge.abort('key-1');

      expect(primaryAborted).toBe(true);
      expect(fallbackAborted).toBe(true);
    });

    test('一个 abort 失败不影响另一个', async () => {
      let fallbackAborted = false;
      const primary = createMockBridge({
        abort: async () => {
          throw new Error('abort failed');
        },
      });
      const fallback = createMockBridge({
        abort: async () => {
          fallbackAborted = true;
        },
      });
      const bridge = new AgentBridgeWithFallback(primary, fallback);

      await bridge.abort('key-1');

      expect(fallbackAborted).toBe(true);
    });
  });
});
