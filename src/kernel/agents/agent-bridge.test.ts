import { describe, expect, test } from 'bun:test';
import type {
  AgentBridge,
  AgentExecuteParams,
  AgentResult,
  ExecutionMode,
  McpConfig,
  McpServerConfig,
} from './agent-bridge';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<AgentExecuteParams> = {}): AgentExecuteParams {
  return {
    systemPrompt: 'You are a helpful assistant.',
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

// ---------------------------------------------------------------------------
// AgentExecuteParams — type contract tests
// ---------------------------------------------------------------------------

describe('AgentExecuteParams', () => {
  test('最小必需字段构造成功', () => {
    const params = makeParams();
    expect(params.systemPrompt).toBe('You are a helpful assistant.');
    expect(params.prependContext).toBe('');
    expect(params.userMessage).toBe('hello');
    expect(params.sessionId).toBe('sess-1');
    expect(params.executionMode).toBe('sync');
  });

  test('可选字段默认为 undefined', () => {
    const params = makeParams();
    expect(params.claudeSessionId).toBeUndefined();
    expect(params.workspacePath).toBeUndefined();
    expect(params.mcpConfig).toBeUndefined();
    expect(params.toolWhitelist).toBeUndefined();
    expect(params.signal).toBeUndefined();
    expect(params.streamCallback).toBeUndefined();
    expect(params.maxTurns).toBeUndefined();
    expect(params.classifyResult).toBeUndefined();
  });

  test('所有可选字段可正常赋值', async () => {
    const ac = new AbortController();
    const streamEvents: string[] = [];
    const params = makeParams({
      claudeSessionId: 'claude-sess-1',
      workspacePath: '/tmp/workspace',
      mcpConfig: { mcpServers: [{ name: 'fs', command: 'mcp-fs', args: ['--root', '/'] }] },
      toolWhitelist: ['read', 'write'],
      signal: ac.signal,
      streamCallback: async (ev) => {
        streamEvents.push(ev.type);
      },
      maxTurns: 5,
      executionMode: 'long-horizon',
      classifyResult: { intent: 'coding' },
    });

    expect(params.claudeSessionId).toBe('claude-sess-1');
    expect(params.workspacePath).toBe('/tmp/workspace');
    expect(params.mcpConfig!.mcpServers).toHaveLength(1);
    expect(params.toolWhitelist).toEqual(['read', 'write']);
    expect(params.signal).toBe(ac.signal);
    expect(params.maxTurns).toBe(5);
    expect(params.executionMode).toBe('long-horizon');
    expect(params.classifyResult).toEqual({ intent: 'coding' });

    // streamCallback 可正常调用
    await params.streamCallback!({ type: 'text_delta', text: 'hi' });
    expect(streamEvents).toEqual(['text_delta']);
  });

  test('executionMode 覆盖三种合法值', () => {
    const modes: ExecutionMode[] = ['sync', 'async', 'long-horizon'];
    for (const mode of modes) {
      const p = makeParams({ executionMode: mode });
      expect(p.executionMode).toBe(mode);
    }
  });

  test('空字符串字段正常处理', () => {
    const params = makeParams({
      systemPrompt: '',
      prependContext: '',
      userMessage: '',
      sessionId: '',
    });
    expect(params.systemPrompt).toBe('');
    expect(params.userMessage).toBe('');
    expect(params.sessionId).toBe('');
  });
});

// ---------------------------------------------------------------------------
// AgentResult — type contract tests
// ---------------------------------------------------------------------------

describe('AgentResult', () => {
  test('最小必需字段构造成功', () => {
    const result = makeResult();
    expect(result.content).toBe('response');
    expect(result.tokenUsage.inputTokens).toBe(10);
    expect(result.tokenUsage.outputTokens).toBe(5);
    expect(result.finishedNaturally).toBe(true);
    expect(result.handledBy).toBe('claude');
  });

  test('可选字段默认为 undefined', () => {
    const result = makeResult();
    expect(result.toolsUsed).toBeUndefined();
    expect(result.claudeSessionId).toBeUndefined();
    expect(result.turnsUsed).toBeUndefined();
  });

  test('所有可选字段可正常赋值', () => {
    const result = makeResult({
      toolsUsed: ['read', 'write', 'bash'],
      claudeSessionId: 'cs-123',
      turnsUsed: 3,
    });
    expect(result.toolsUsed).toEqual(['read', 'write', 'bash']);
    expect(result.claudeSessionId).toBe('cs-123');
    expect(result.turnsUsed).toBe(3);
  });

  test('handledBy 覆盖三种合法值', () => {
    const handlers = ['claude', 'codex', 'gateway'] as const;
    for (const h of handlers) {
      const r = makeResult({ handledBy: h });
      expect(r.handledBy).toBe(h);
    }
  });

  test('tokenUsage 为零值', () => {
    const result = makeResult({
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(result.tokenUsage.inputTokens).toBe(0);
    expect(result.tokenUsage.outputTokens).toBe(0);
  });

  test('空内容结果', () => {
    const result = makeResult({ content: '' });
    expect(result.content).toBe('');
  });
});

// ---------------------------------------------------------------------------
// McpServerConfig / McpConfig — type contract tests
// ---------------------------------------------------------------------------

describe('McpServerConfig / McpConfig', () => {
  test('最小配置只需 name + command', () => {
    const cfg: McpServerConfig = { name: 'fs', command: 'mcp-fs' };
    expect(cfg.name).toBe('fs');
    expect(cfg.command).toBe('mcp-fs');
    expect(cfg.args).toBeUndefined();
    expect(cfg.env).toBeUndefined();
  });

  test('完整配置包含 args 和 env', () => {
    const cfg: McpServerConfig = {
      name: 'db',
      command: 'mcp-db',
      args: ['--host', 'localhost'],
      env: { DB_PORT: '5432' },
    };
    expect(cfg.args).toEqual(['--host', 'localhost']);
    expect(cfg.env).toEqual({ DB_PORT: '5432' });
  });

  test('McpConfig 包含多个 server', () => {
    const config: McpConfig = {
      mcpServers: [
        { name: 'fs', command: 'mcp-fs' },
        { name: 'db', command: 'mcp-db', args: ['--ro'] },
      ],
    };
    expect(config.mcpServers).toHaveLength(2);
    expect(config.mcpServers[0].name).toBe('fs');
    expect(config.mcpServers[1].args).toEqual(['--ro']);
  });

  test('空 mcpServers 数组', () => {
    const config: McpConfig = { mcpServers: [] };
    expect(config.mcpServers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AgentBridge — interface conformance tests
// ---------------------------------------------------------------------------

describe('AgentBridge interface', () => {
  test('最小实现只需 execute 方法', async () => {
    const bridge: AgentBridge = {
      execute: async (_params) => makeResult(),
    };

    const result = await bridge.execute(makeParams());
    expect(result.content).toBe('response');
    expect(result.finishedNaturally).toBe(true);
  });

  test('完整实现包含 appendMessage 和 abort', async () => {
    const calls: string[] = [];
    const bridge: AgentBridge = {
      execute: async (params) => {
        calls.push(`execute:${params.userMessage}`);
        return makeResult({ content: params.userMessage });
      },
      appendMessage: async (sessionKey, content) => {
        calls.push(`append:${sessionKey}:${content}`);
      },
      abort: async (sessionKey) => {
        calls.push(`abort:${sessionKey}`);
      },
    };

    const result = await bridge.execute(makeParams({ userMessage: 'test' }));
    await bridge.appendMessage!('sess-1', 'follow-up');
    await bridge.abort!('sess-1');

    expect(result.content).toBe('test');
    expect(calls).toEqual(['execute:test', 'append:sess-1:follow-up', 'abort:sess-1']);
  });

  test('execute 传递 streamCallback 并接收事件', async () => {
    const events: string[] = [];
    const bridge: AgentBridge = {
      execute: async (params) => {
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: 'chunk1' });
          await params.streamCallback({ type: 'done' });
        }
        return makeResult();
      },
    };

    await bridge.execute(
      makeParams({
        streamCallback: async (ev) => {
          events.push(ev.type);
        },
      }),
    );

    expect(events).toEqual(['text_delta', 'done']);
  });

  test('execute 抛出错误可被捕获', async () => {
    const bridge: AgentBridge = {
      execute: async () => {
        throw new Error('provider unavailable');
      },
    };

    await expect(bridge.execute(makeParams())).rejects.toThrow('provider unavailable');
  });

  test('execute 支持 AbortSignal 取消', async () => {
    const ac = new AbortController();
    const bridge: AgentBridge = {
      execute: async (params) => {
        if (params.signal?.aborted) {
          throw new Error('aborted');
        }
        return makeResult();
      },
    };

    ac.abort();
    await expect(bridge.execute(makeParams({ signal: ac.signal }))).rejects.toThrow('aborted');
  });
});
