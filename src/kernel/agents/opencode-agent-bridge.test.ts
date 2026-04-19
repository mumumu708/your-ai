import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as child_process from 'node:child_process';
import { EventEmitter } from 'node:events';

import type { AgentExecuteParams } from './agent-bridge';
import { OpenCodeAgentBridge } from './opencode-agent-bridge';

/** Creates a mock child process with controllable streams */
function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof mock>;
    stdin: null;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = mock(() => {});
  proc.stdin = null;
  return proc;
}

function createBaseParams(overrides: Partial<AgentExecuteParams> = {}): AgentExecuteParams {
  return {
    systemPrompt: 'You are helpful.',
    prependContext: '',
    userMessage: 'Hello',
    sessionId: 'test-session',
    executionMode: 'sync',
    ...overrides,
  };
}

describe('OpenCodeAgentBridge', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    spawnSpy = spyOn(child_process, 'spawn');
  });

  afterEach(() => {
    logSpy.mockRestore();
    spawnSpy.mockRestore();
  });

  test('constructor uses default opencode path', () => {
    const bridge = new OpenCodeAgentBridge();
    expect(bridge).toBeDefined();
  });

  test('constructor accepts custom opencode path', () => {
    const bridge = new OpenCodeAgentBridge({ opencodePath: '/usr/local/bin/opencode' });
    expect(bridge).toBeDefined();
  });

  test('buildArgs includes --quiet and --prompt', () => {
    const bridge = new OpenCodeAgentBridge();
    const args = bridge.buildArgs(createBaseParams());

    expect(args).toContain('--quiet');
    expect(args).toContain('--prompt');
  });

  test('buildArgs combines system prompt, prepend context, and user message', () => {
    const bridge = new OpenCodeAgentBridge();
    const args = bridge.buildArgs(
      createBaseParams({
        systemPrompt: 'system',
        prependContext: 'context',
        userMessage: 'hello',
      }),
    );

    // The prompt argument should be after '--prompt'
    const promptIdx = args.indexOf('--prompt');
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    const prompt = args[promptIdx + 1];
    expect(prompt).toContain('system');
    expect(prompt).toContain('context');
    expect(prompt).toContain('hello');
  });

  test('buildArgs includes -C when workspacePath is set', () => {
    const bridge = new OpenCodeAgentBridge();
    const args = bridge.buildArgs(createBaseParams({ workspacePath: '/tmp/workspace' }));
    expect(args).toContain('-C');
    expect(args).toContain('/tmp/workspace');
  });

  test('buildArgs omits -C when workspacePath is not set', () => {
    const bridge = new OpenCodeAgentBridge();
    const args = bridge.buildArgs(createBaseParams());
    expect(args).not.toContain('-C');
  });

  test('execute resolves with content on success', async () => {
    const mockProc = createMockProcess();
    spawnSpy.mockReturnValue(mockProc as ReturnType<typeof child_process.spawn>);

    const bridge = new OpenCodeAgentBridge();
    const promise = bridge.execute(createBaseParams());

    mockProc.stdout.emit('data', Buffer.from('Hello from OpenCode'));
    mockProc.emit('close', 0);

    const result = await promise;
    expect(result.content).toBe('Hello from OpenCode');
    expect(result.handledBy).toBe('opencode');
    expect(result.finishedNaturally).toBe(true);
  });

  test('execute rejects on non-zero exit code', async () => {
    const mockProc = createMockProcess();
    spawnSpy.mockReturnValue(mockProc as ReturnType<typeof child_process.spawn>);

    const bridge = new OpenCodeAgentBridge();
    const promise = bridge.execute(createBaseParams());

    mockProc.stderr.emit('data', Buffer.from('error occurred'));
    mockProc.emit('close', 1);

    expect(promise).rejects.toThrow('OpenCode CLI exited with code 1');
  });

  test('execute rejects on process error', async () => {
    const mockProc = createMockProcess();
    spawnSpy.mockReturnValue(mockProc as ReturnType<typeof child_process.spawn>);

    const bridge = new OpenCodeAgentBridge();
    const promise = bridge.execute(createBaseParams());

    mockProc.emit('error', new Error('ENOENT: opencode not found'));

    expect(promise).rejects.toThrow('ENOENT');
  });

  test('execute streams chunks via streamCallback', async () => {
    const mockProc = createMockProcess();
    spawnSpy.mockReturnValue(mockProc as ReturnType<typeof child_process.spawn>);

    const chunks: string[] = [];
    const bridge = new OpenCodeAgentBridge();
    const promise = bridge.execute(
      createBaseParams({
        streamCallback: async (event) => {
          if (event.type === 'text_delta' && 'text' in event) {
            chunks.push(event.text);
          }
        },
      }),
    );

    mockProc.stdout.emit('data', Buffer.from('chunk1'));
    mockProc.stdout.emit('data', Buffer.from('chunk2'));
    mockProc.emit('close', 0);

    await promise;
    expect(chunks).toEqual(['chunk1', 'chunk2']);
  });

  test('execute kills process on abort signal', async () => {
    const mockProc = createMockProcess();
    spawnSpy.mockReturnValue(mockProc as ReturnType<typeof child_process.spawn>);

    const ac = new AbortController();
    const bridge = new OpenCodeAgentBridge();
    const promise = bridge.execute(createBaseParams({ signal: ac.signal }));

    ac.abort();
    expect(mockProc.kill).toHaveBeenCalled();

    // Close the process to resolve the promise (null exit code = killed)
    mockProc.emit('close', null);
    const result = await promise;
    expect(result.finishedNaturally).toBe(false);
  });

  test('execute uses custom opencode path', async () => {
    const mockProc = createMockProcess();
    spawnSpy.mockReturnValue(mockProc as ReturnType<typeof child_process.spawn>);

    const bridge = new OpenCodeAgentBridge({ opencodePath: '/custom/opencode' });
    const promise = bridge.execute(createBaseParams());

    mockProc.stdout.emit('data', Buffer.from('ok'));
    mockProc.emit('close', 0);

    await promise;
    expect(spawnSpy).toHaveBeenCalledWith(
      '/custom/opencode',
      expect.any(Array),
      expect.any(Object),
    );
  });
});
