import { describe, expect, mock, test } from 'bun:test';
import type { AgentExecuteParams } from './agent-bridge';
import type {
  AgentBridgeParams,
  AgentBridgeResult,
  ClaudeAgentBridge,
} from './claude-agent-bridge';
import { ClaudeBridgeAdapter } from './claude-bridge-adapter';

function makeParams(overrides: Partial<AgentExecuteParams> = {}): AgentExecuteParams {
  return {
    systemPrompt: 'test system prompt',
    prependContext: '',
    userMessage: 'hello world',
    sessionId: 'sess-1',
    executionMode: 'sync',
    ...overrides,
  };
}

function makeBridgeResult(overrides: Partial<AgentBridgeResult> = {}): AgentBridgeResult {
  return {
    content: 'bridge response',
    toolsUsed: ['Read', 'Write'],
    turns: 3,
    usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
    claudeSessionId: 'claude-sess-1',
    ...overrides,
  };
}

function createMockBridge(result?: AgentBridgeResult): ClaudeAgentBridge {
  return {
    execute: mock(async () => result ?? makeBridgeResult()),
    getActiveSessions: () => 0,
  } as unknown as ClaudeAgentBridge;
}

describe('ClaudeBridgeAdapter', () => {
  test('将 AgentExecuteParams 正确转换为 AgentBridgeParams', async () => {
    const mockBridge = createMockBridge();
    const adapter = new ClaudeBridgeAdapter(mockBridge);

    await adapter.execute(
      makeParams({
        systemPrompt: 'my system prompt',
        userMessage: 'user says hi',
        sessionId: 'sess-42',
        workspacePath: '/tmp/workspace',
        claudeSessionId: 'claude-99',
      }),
    );

    const call = (mockBridge.execute as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as AgentBridgeParams;
    expect(call.sessionId).toBe('sess-42');
    expect(call.systemPrompt).toBe('my system prompt');
    expect(call.messages).toEqual([{ role: 'user', content: 'user says hi' }]);
    expect(call.cwd).toBe('/tmp/workspace');
    expect(call.claudeSessionId).toBe('claude-99');
  });

  test('空 userMessage 时 messages 为空数组', async () => {
    const mockBridge = createMockBridge();
    const adapter = new ClaudeBridgeAdapter(mockBridge);

    await adapter.execute(makeParams({ userMessage: '' }));

    const call = (mockBridge.execute as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as AgentBridgeParams;
    expect(call.messages).toEqual([]);
  });

  test('将 AgentBridgeResult 正确映射为 AgentResult', async () => {
    const adapter = new ClaudeBridgeAdapter(
      createMockBridge(
        makeBridgeResult({
          content: 'done',
          toolsUsed: ['Bash'],
          turns: 5,
          usage: { inputTokens: 200, outputTokens: 100, costUsd: 0.05 },
          claudeSessionId: 'cls-1',
        }),
      ),
    );

    const result = await adapter.execute(makeParams());

    expect(result.content).toBe('done');
    expect(result.tokenUsage).toEqual({ inputTokens: 200, outputTokens: 100 });
    expect(result.toolsUsed).toEqual(['Bash']);
    expect(result.claudeSessionId).toBe('cls-1');
    expect(result.turnsUsed).toBe(5);
    expect(result.finishedNaturally).toBe(true);
    expect(result.handledBy).toBe('claude');
  });

  test('signal 正确传递', async () => {
    const mockBridge = createMockBridge();
    const adapter = new ClaudeBridgeAdapter(mockBridge);
    const controller = new AbortController();

    await adapter.execute(makeParams({ signal: controller.signal }));

    const call = (mockBridge.execute as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as AgentBridgeParams;
    expect(call.signal).toBe(controller.signal);
  });

  test('streamCallback 正确桥接', async () => {
    const mockBridge = {
      execute: mock(async (params: AgentBridgeParams) => {
        // Simulate a stream event
        params.onStream?.({ type: 'text_delta', text: 'chunk' });
        return makeBridgeResult();
      }),
      getActiveSessions: () => 0,
    } as unknown as ClaudeAgentBridge;

    const adapter = new ClaudeBridgeAdapter(mockBridge);
    const streamEvents: unknown[] = [];
    const streamCallback = mock(async (event: unknown) => {
      streamEvents.push(event);
    });

    await adapter.execute(makeParams({ streamCallback }));

    expect(streamEvents).toEqual([{ type: 'text_delta', text: 'chunk' }]);
  });

  test('无 streamCallback 时 onStream 为 undefined', async () => {
    const mockBridge = createMockBridge();
    const adapter = new ClaudeBridgeAdapter(mockBridge);

    await adapter.execute(makeParams({ streamCallback: undefined }));

    const call = (mockBridge.execute as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as AgentBridgeParams;
    expect(call.onStream).toBeUndefined();
  });

  test('bridge 抛出错误时直接传播', async () => {
    const mockBridge = {
      execute: mock(async () => {
        throw new Error('CLI not found');
      }),
      getActiveSessions: () => 0,
    } as unknown as ClaudeAgentBridge;

    const adapter = new ClaudeBridgeAdapter(mockBridge);
    await expect(adapter.execute(makeParams())).rejects.toThrow('CLI not found');
  });
});
