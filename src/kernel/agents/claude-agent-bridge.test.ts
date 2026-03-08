import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { YourBotError } from '../../shared/errors/yourbot-error';
import type { StreamEvent } from '../../shared/messaging/stream-event.types';
import { ClaudeAgentBridge } from './claude-agent-bridge';

/**
 * Helper: creates a mock Bun.spawn that simulates claude CLI stream-json output.
 */
function mockSpawn(events: string[], exitCode = 0) {
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const ev of events) {
        controller.enqueue(encoder.encode(`${ev}\n`));
      }
      controller.close();
    },
  });

  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

  return {
    stdout,
    stderr,
    exited: Promise.resolve(exitCode),
    kill: () => {},
  };
}

function makeInitEvent(): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'test-session',
    model: 'claude-haiku-4-5-20251001',
  });
}

function makeAssistantEvent(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
  });
}

function makeResultEvent(
  resultText: string,
  inputTokens = 100,
  outputTokens = 50,
  costUsd = 0.005,
): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: resultText,
    duration_ms: 1000,
    total_cost_usd: costUsd,
    num_turns: 1,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    modelUsage: {
      'claude-haiku-4-5-20251001': {
        inputTokens,
        outputTokens,
        costUSD: costUsd,
      },
    },
  });
}

function makeToolUseEvent(name: string, id: string, input: unknown): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name, id, input }],
    },
  });
}

function makeToolResultEvent(toolUseId: string, content: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
  });
}

describe('ClaudeAgentBridge', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    spawnSpy?.mockRestore();
  });

  describe('execute（基本调用）', () => {
    test('应该 spawn claude CLI 并解析 stream-json 结果', async () => {
      const events = [
        makeInitEvent(),
        makeAssistantEvent('你好！'),
        makeResultEvent('你好！', 100, 50, 0.005),
      ];

      spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(mockSpawn(events) as never);

      const bridge = new ClaudeAgentBridge();
      const result = await bridge.execute({
        sessionId: 'sess_001',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(result.content).toBe('你好！');
      expect(result.usage.inputTokens).toBe(100);
      expect(result.usage.outputTokens).toBe(50);
      expect(result.usage.costUsd).toBe(0.005);
      expect(result.turns).toBe(1);
    });

    test('应该在 CLI 返回非零退出码时抛错', async () => {
      const stderrContent = 'Error: authentication failed';
      const stderr = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stderrContent));
          controller.close();
        },
      });

      const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });

      spawnSpy = spyOn(Bun, 'spawn').mockReturnValue({
        stdout,
        stderr,
        exited: Promise.resolve(1),
        kill: () => {},
      } as never);

      const bridge = new ClaudeAgentBridge();

      try {
        await bridge.execute({
          sessionId: 'sess_001',
          messages: [{ role: 'user', content: 'Hi' }],
        });
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(YourBotError);
        expect((error as YourBotError).code).toBe('LLM_API_ERROR');
      }
    });
  });

  describe('execute（流式）', () => {
    test('应该通过 onStream 回调转发 text_delta 事件', async () => {
      const events = [
        makeInitEvent(),
        makeAssistantEvent('Hello'),
        makeAssistantEvent(' World'),
        makeResultEvent('Hello World', 80, 30, 0.003),
      ];

      spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(mockSpawn(events) as never);

      const bridge = new ClaudeAgentBridge();
      const streamEvents: StreamEvent[] = [];

      const result = await bridge.execute({
        sessionId: 'sess_001',
        messages: [{ role: 'user', content: 'Hello' }],
        onStream: (event) => streamEvents.push(event),
      });

      expect(result.content).toBe('Hello World');
      expect(streamEvents.length).toBeGreaterThanOrEqual(3);
      expect(streamEvents[0]).toEqual({ type: 'text_delta', text: 'Hello' });
      expect(streamEvents[1]).toEqual({ type: 'text_delta', text: ' World' });
      expect(streamEvents[streamEvents.length - 1].type).toBe('done');
    });
  });

  describe('并发控制', () => {
    test('应该在达到并发上限时抛出 AGENT_BUSY', async () => {
      // Create bridge with max 2 concurrent
      const bridge = new ClaudeAgentBridge({ maxConcurrentSessions: 2 });

      // Mock spawn that never resolves — must create new streams per call
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
        () =>
          ({
            stdout: new ReadableStream<Uint8Array>({
              start() {
                /* never close */
              },
            }),
            stderr: new ReadableStream<Uint8Array>({
              start(c) {
                c.close();
              },
            }),
            exited: new Promise<number>(() => {}),
            kill: () => {},
          }) as never,
      );

      // Fill up 2 slots
      const _p1 = bridge
        .execute({ sessionId: 's1', messages: [{ role: 'user', content: 'a' }] })
        .catch(() => {});
      const _p2 = bridge
        .execute({ sessionId: 's2', messages: [{ role: 'user', content: 'b' }] })
        .catch(() => {});

      await new Promise((r) => setTimeout(r, 10));

      // 3rd should fail
      try {
        await bridge.execute({ sessionId: 's3', messages: [{ role: 'user', content: 'c' }] });
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(YourBotError);
        expect((error as YourBotError).code).toBe('AGENT_BUSY');
      }
    });

    test('完成后应该释放并发槽位', async () => {
      const events = [makeInitEvent(), makeAssistantEvent('ok'), makeResultEvent('ok')];
      spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(mockSpawn(events) as never);

      const bridge = new ClaudeAgentBridge();
      await bridge.execute({ sessionId: 's1', messages: [{ role: 'user', content: 'a' }] });
      expect(bridge.getActiveSessions()).toBe(0);
    });
  });

  describe('会话续接 (resume)', () => {
    test('应该使用 --resume 参数续接已有会话', async () => {
      const events = [makeInitEvent(), makeAssistantEvent('resumed'), makeResultEvent('resumed')];
      spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(mockSpawn(events) as never);

      const bridge = new ClaudeAgentBridge();
      const result = await bridge.execute({
        sessionId: 's1',
        messages: [
          { role: 'user', content: 'first msg' },
          { role: 'user', content: 'follow up' },
        ],
        claudeSessionId: 'claude-sess-123',
      });

      expect(result.content).toBe('resumed');
      const [args] = spawnSpy.mock.calls[0] as [string[]];
      expect(args).toContain('--resume');
      expect(args).toContain('claude-sess-123');
      // In resume mode, only last message is sent
      const pIdx = args.indexOf('-p');
      expect(args[pIdx + 1]).toBe('follow up');
    });

    test('应该在续接失败时回退到全量 prompt 模式', async () => {
      let callCount = 0;
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First attempt fails (resume)
          return mockSpawn([], 1) as never;
        }
        // Fallback attempt succeeds
        const events = [
          makeInitEvent(),
          makeAssistantEvent('fallback ok'),
          makeResultEvent('fallback ok'),
        ];
        return mockSpawn(events) as never;
      });

      const bridge = new ClaudeAgentBridge();
      const result = await bridge.execute({
        sessionId: 's1',
        messages: [{ role: 'user', content: 'hello' }],
        claudeSessionId: 'old-session',
      });

      expect(result.content).toBe('fallback ok');
      expect(callCount).toBe(2);
    });
  });

  describe('abort signal', () => {
    test('executeWithoutResume 中 abort signal 应该 kill 子进程', async () => {
      const controller = new AbortController();
      let killed = false;
      let callCount = 0;

      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call (resume) fails
          return mockSpawn([], 1) as never;
        }
        // Second call (fallback executeWithoutResume) — use a slow stream so abort fires in time
        const stdout = new ReadableStream<Uint8Array>({
          start(ctrl) {
            const enc = new TextEncoder();
            ctrl.enqueue(enc.encode(`${makeInitEvent()}\n`));
            // Delay remaining events so abort fires between listener registration and stream end
            setTimeout(() => {
              ctrl.enqueue(enc.encode(`${makeAssistantEvent('fallback')}\n`));
              ctrl.enqueue(enc.encode(`${makeResultEvent('fallback')}\n`));
              ctrl.close();
            }, 50);
          },
        });
        const stderr = new ReadableStream<Uint8Array>({
          start(c) {
            c.close();
          },
        });
        return {
          stdout,
          stderr,
          exited: Promise.resolve(0),
          kill: () => {
            killed = true;
          },
        } as never;
      });

      const bridge = new ClaudeAgentBridge();
      const promise = bridge.execute({
        sessionId: 's1',
        messages: [{ role: 'user', content: 'hello' }],
        claudeSessionId: 'old-session',
        signal: controller.signal,
      });

      // Delay abort so it fires after executeWithoutResume registers the listener
      setTimeout(() => controller.abort(), 20);
      await promise;
      expect(callCount).toBe(2);
      expect(killed).toBe(true);
    });

    test('应该在 abort 时 kill 子进程', async () => {
      const controller = new AbortController();
      let killed = false;
      const events = [makeInitEvent(), makeAssistantEvent('hi'), makeResultEvent('hi')];

      spawnSpy = spyOn(Bun, 'spawn').mockReturnValue({
        ...mockSpawn(events),
        kill: () => {
          killed = true;
        },
      } as never);

      const bridge = new ClaudeAgentBridge();
      const promise = bridge.execute({
        sessionId: 's1',
        messages: [{ role: 'user', content: 'hello' }],
        signal: controller.signal,
      });

      controller.abort();
      await promise;
      expect(killed).toBe(true);
    });
  });

  describe('tool_use events', () => {
    test('应该捕获 tool_use 事件', async () => {
      const events = [
        makeInitEvent(),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Read' },
              { type: 'text', text: 'result' },
            ],
          },
        }),
        makeResultEvent('result'),
      ];

      spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(mockSpawn(events) as never);

      const bridge = new ClaudeAgentBridge();
      const result = await bridge.execute({
        sessionId: 's1',
        messages: [{ role: 'user', content: 'hello' }],
      });

      expect(result.toolsUsed).toContain('Read');
    });

    test('tool_use 块应该通过 onStream 发送 tool_use 事件', async () => {
      const events = [
        makeInitEvent(),
        makeToolUseEvent('Bash', 'toolu_001', { command: 'ls -la' }),
        makeAssistantEvent('done'),
        makeResultEvent('done'),
      ];

      spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(mockSpawn(events) as never);

      const bridge = new ClaudeAgentBridge();
      const streamEvents: StreamEvent[] = [];

      await bridge.execute({
        sessionId: 's1',
        messages: [{ role: 'user', content: 'hello' }],
        onStream: (event) => streamEvents.push(event),
      });

      const toolUseEvents = streamEvents.filter((e) => e.type === 'tool_use');
      expect(toolUseEvents).toHaveLength(1);
      expect(toolUseEvents[0]).toEqual({
        type: 'tool_use',
        toolName: 'Bash',
        toolInput: { command: 'ls -la' },
      });
    });

    test('tool_result 应该通过 onStream 发送 tool_result 事件', async () => {
      const events = [
        makeInitEvent(),
        makeToolUseEvent('Bash', 'toolu_001', { command: 'echo hi' }),
        makeToolResultEvent('toolu_001', 'hi\n'),
        makeAssistantEvent('done'),
        makeResultEvent('done'),
      ];

      spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(mockSpawn(events) as never);

      const bridge = new ClaudeAgentBridge();
      const streamEvents: StreamEvent[] = [];

      await bridge.execute({
        sessionId: 's1',
        messages: [{ role: 'user', content: 'hello' }],
        onStream: (event) => streamEvents.push(event),
      });

      const toolResultEvents = streamEvents.filter((e) => e.type === 'tool_result');
      expect(toolResultEvents).toHaveLength(1);
      expect(toolResultEvents[0]).toEqual({
        type: 'tool_result',
        toolName: 'Bash',
        text: 'hi\n',
      });
    });

    test('tool_use_id 映射应能跨事件正确解析工具名', async () => {
      const events = [
        makeInitEvent(),
        makeToolUseEvent('Read', 'toolu_aaa', { file_path: '/tmp/x' }),
        makeToolResultEvent('toolu_aaa', 'file content'),
        makeToolUseEvent('Bash', 'toolu_bbb', { command: 'pwd' }),
        makeToolResultEvent('toolu_bbb', '/home'),
        makeAssistantEvent('ok'),
        makeResultEvent('ok'),
      ];

      spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(mockSpawn(events) as never);

      const bridge = new ClaudeAgentBridge();
      const streamEvents: StreamEvent[] = [];

      await bridge.execute({
        sessionId: 's1',
        messages: [{ role: 'user', content: 'hello' }],
        onStream: (event) => streamEvents.push(event),
      });

      const toolResults = streamEvents.filter((e) => e.type === 'tool_result');
      expect(toolResults).toHaveLength(2);
      expect(toolResults[0].toolName).toBe('Read');
      expect(toolResults[0].text).toBe('file content');
      expect(toolResults[1].toolName).toBe('Bash');
      expect(toolResults[1].text).toBe('/home');
    });
  });

  describe('session_id capture', () => {
    test('应该捕获 result 事件中的 session_id', async () => {
      const events = [
        makeInitEvent(),
        makeAssistantEvent('ok'),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          session_id: 'new-session-id',
          total_cost_usd: 0.001,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ];

      spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(mockSpawn(events) as never);

      const bridge = new ClaudeAgentBridge();
      const result = await bridge.execute({
        sessionId: 's1',
        messages: [{ role: 'user', content: 'hello' }],
      });

      expect(result.claudeSessionId).toBe('new-session-id');
    });
  });

  describe('prompt truncation', () => {
    test('应该在超出 token 预算时截断旧消息', async () => {
      const events = [makeInitEvent(), makeAssistantEvent('ok'), makeResultEvent('ok')];
      spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(mockSpawn(events) as never);

      const bridge = new ClaudeAgentBridge();
      // Create many messages to exceed budget
      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (let i = 0; i < 500; i++) {
        messages.push({ role: 'user', content: 'a'.repeat(1000) });
        messages.push({ role: 'assistant', content: 'b'.repeat(1000) });
      }
      messages.push({ role: 'user', content: 'final question' });

      await bridge.execute({ sessionId: 's1', messages });

      const [args] = spawnSpy.mock.calls[0] as [string[]];
      const pIdx = args.indexOf('-p');
      const prompt = args[pIdx + 1];
      // Should contain truncation notice
      expect(prompt).toContain('已省略');
      expect(prompt).toContain('final question');
    });
  });

  describe('命令行参数构建', () => {
    test('应该传递正确的 CLI 参数', async () => {
      const events = [makeInitEvent(), makeAssistantEvent('hi'), makeResultEvent('hi')];
      spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(mockSpawn(events) as never);

      const bridge = new ClaudeAgentBridge({
        claudePath: '/usr/local/bin/claude',
        defaultModel: 'haiku',
      });
      await bridge.execute({
        sessionId: 's1',
        messages: [{ role: 'user', content: 'test' }],
        systemPrompt: '你是测试助手',
      });

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const [args] = spawnSpy.mock.calls[0] as [string[]];
      expect(args[0]).toBe('/usr/local/bin/claude');
      expect(args).toContain('-p');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--model');
      expect(args).toContain('haiku');
      expect(args).toContain('--system-prompt');
      expect(args).toContain('你是测试助手');
    });

    test('单条消息应该直接作为 prompt', async () => {
      const events = [makeInitEvent(), makeAssistantEvent('ok'), makeResultEvent('ok')];
      spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(mockSpawn(events) as never);

      const bridge = new ClaudeAgentBridge();
      await bridge.execute({
        sessionId: 's1',
        messages: [{ role: 'user', content: '你好' }],
      });

      const [args] = spawnSpy.mock.calls[0] as [string[]];
      const pIdx = args.indexOf('-p');
      expect(args[pIdx + 1]).toBe('你好');
    });

    test('多轮消息应该格式化为对话', async () => {
      const events = [makeInitEvent(), makeAssistantEvent('ok'), makeResultEvent('ok')];
      spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(mockSpawn(events) as never);

      const bridge = new ClaudeAgentBridge();
      await bridge.execute({
        sessionId: 's1',
        messages: [
          { role: 'user', content: '问题1' },
          { role: 'assistant', content: '回答1' },
          { role: 'user', content: '问题2' },
        ],
      });

      const [args] = spawnSpy.mock.calls[0] as [string[]];
      const pIdx = args.indexOf('-p');
      const prompt = args[pIdx + 1];
      expect(prompt).toContain('用户: 问题1');
      expect(prompt).toContain('助手: 回答1');
      expect(prompt).toContain('用户: 问题2');
    });
  });
});
