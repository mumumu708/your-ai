import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as child_process from 'node:child_process';
import { EventEmitter } from 'node:events';

import type { AgentExecuteParams } from './agent-bridge';
import { CodexAgentBridge } from './codex-agent-bridge';

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

describe('CodexAgentBridge', () => {
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

  test('constructor creates instance', () => {
    const bridge = new CodexAgentBridge();
    expect(bridge).toBeDefined();
  });

  test('buildArgs includes --full-auto and --json', () => {
    const bridge = new CodexAgentBridge();
    const args = bridge.buildArgs(createBaseParams());

    expect(args).toContain('exec');
    expect(args).toContain('--full-auto');
    expect(args).toContain('--json');
  });

  test('buildArgs includes workspace path with -C flag', () => {
    const bridge = new CodexAgentBridge();
    const args = bridge.buildArgs(createBaseParams({ workspacePath: '/tmp/workspace' }));

    expect(args).toContain('-C');
    expect(args).toContain('/tmp/workspace');
  });

  test('buildArgs concatenates system prompt, prepend context, and user message', () => {
    const bridge = new CodexAgentBridge();
    const args = bridge.buildArgs(
      createBaseParams({
        systemPrompt: 'SYS',
        prependContext: 'CTX',
        userMessage: 'MSG',
      }),
    );

    const prompt = args[args.length - 1];
    expect(prompt).toContain('SYS');
    expect(prompt).toContain('CTX');
    expect(prompt).toContain('MSG');
  });

  test('buildArgs filters out empty strings from prompt parts', () => {
    const bridge = new CodexAgentBridge();
    const args = bridge.buildArgs(
      createBaseParams({
        systemPrompt: 'SYS',
        prependContext: '',
        userMessage: 'MSG',
      }),
    );

    const prompt = args[args.length - 1];
    expect(prompt).toBe('SYS\n\nMSG');
  });

  test('extractContent parses last assistant message from JSONL', () => {
    const bridge = new CodexAgentBridge();
    const jsonl = [
      JSON.stringify({ type: 'message', role: 'user', content: 'hello' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'first reply' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'final reply' }),
    ].join('\n');

    expect(bridge.extractContent(jsonl)).toBe('final reply');
  });

  test('extractContent returns raw output when no assistant message found', () => {
    const bridge = new CodexAgentBridge();
    const output = 'plain text output';

    expect(bridge.extractContent(output)).toBe('plain text output');
  });

  test('extractContent handles empty content gracefully', () => {
    const bridge = new CodexAgentBridge();
    const jsonl = JSON.stringify({ type: 'message', role: 'assistant', content: '' });

    // content is empty string → falsy → falls through to raw trim
    expect(bridge.extractContent(jsonl)).toBe(jsonl.trim());
  });

  test('extractContent ignores non-JSON lines', () => {
    const bridge = new CodexAgentBridge();
    const jsonl = [
      'not json',
      JSON.stringify({ type: 'message', role: 'assistant', content: 'good' }),
      '{invalid json',
    ].join('\n');

    expect(bridge.extractContent(jsonl)).toBe('good');
  });

  test('execute resolves with content on success', async () => {
    const bridge = new CodexAgentBridge();
    const mockProc = createMockProcess();

    spawnSpy.mockReturnValue(mockProc as unknown as child_process.ChildProcess);

    const resultPromise = bridge.execute(createBaseParams());

    // Simulate JSONL output
    mockProc.stdout.emit(
      'data',
      Buffer.from(`${JSON.stringify({ type: 'message', role: 'assistant', content: 'Done!' })}\n`),
    );
    mockProc.emit('close', 0);

    const result = await resultPromise;
    expect(result.content).toBe('Done!');
    expect(result.handledBy).toBe('codex');
    expect(result.finishedNaturally).toBe(true);
    expect(result.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  test('execute rejects on non-zero exit code', async () => {
    const bridge = new CodexAgentBridge();
    const mockProc = createMockProcess();

    spawnSpy.mockReturnValue(mockProc as unknown as child_process.ChildProcess);

    const resultPromise = bridge.execute(createBaseParams());

    mockProc.stderr.emit('data', Buffer.from('some error'));
    mockProc.emit('close', 1);

    await expect(resultPromise).rejects.toThrow('Codex CLI exited with code 1: some error');
  });

  test('execute rejects on spawn error', async () => {
    const bridge = new CodexAgentBridge();
    const mockProc = createMockProcess();

    spawnSpy.mockReturnValue(mockProc as unknown as child_process.ChildProcess);

    const resultPromise = bridge.execute(createBaseParams());

    mockProc.emit('error', new Error('ENOENT'));

    await expect(resultPromise).rejects.toThrow('ENOENT');
  });

  test('execute streams text_delta events via streamCallback', async () => {
    const bridge = new CodexAgentBridge();
    const mockProc = createMockProcess();
    const streamEvents: Array<{ type: string; text?: string }> = [];

    spawnSpy.mockReturnValue(mockProc as unknown as child_process.ChildProcess);

    const resultPromise = bridge.execute(
      createBaseParams({
        streamCallback: async (event) => {
          streamEvents.push(event);
        },
      }),
    );

    // Emit assistant message
    mockProc.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({ type: 'message', role: 'assistant', content: 'streaming...' })}\n`,
      ),
    );
    mockProc.emit('close', 0);

    await resultPromise;
    expect(streamEvents.length).toBe(2);
    expect(streamEvents[0]).toEqual({ type: 'text_delta', text: 'streaming...' });
    expect(streamEvents[1]).toEqual({ type: 'done' });
  });

  test('execute ignores non-assistant messages in stream', async () => {
    const bridge = new CodexAgentBridge();
    const mockProc = createMockProcess();
    const streamEvents: Array<{ type: string; text?: string }> = [];

    spawnSpy.mockReturnValue(mockProc as unknown as child_process.ChildProcess);

    const resultPromise = bridge.execute(
      createBaseParams({
        streamCallback: async (event) => {
          streamEvents.push(event);
        },
      }),
    );

    // Emit user message (should be ignored)
    mockProc.stdout.emit(
      'data',
      Buffer.from(`${JSON.stringify({ type: 'message', role: 'user', content: 'ignored' })}\n`),
    );
    // Emit non-JSON (should be ignored)
    mockProc.stdout.emit('data', Buffer.from('not json\n'));
    mockProc.emit('close', 0);

    await resultPromise;
    // Only the done event should be present (user/non-JSON messages are ignored)
    expect(streamEvents.length).toBe(1);
    expect(streamEvents[0]).toEqual({ type: 'done' });
  });

  test('execute handles AbortSignal', async () => {
    const bridge = new CodexAgentBridge();
    const mockProc = createMockProcess();
    const controller = new AbortController();

    spawnSpy.mockReturnValue(mockProc as unknown as child_process.ChildProcess);

    const resultPromise = bridge.execute(
      createBaseParams({
        signal: controller.signal,
      }),
    );

    // Abort
    controller.abort();

    // Verify kill was called
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');

    // Close to resolve
    mockProc.emit('close', 0);
    await resultPromise;
  });

  test('execute uses workspacePath as cwd', async () => {
    const bridge = new CodexAgentBridge();
    const mockProc = createMockProcess();

    spawnSpy.mockReturnValue(mockProc as unknown as child_process.ChildProcess);

    const resultPromise = bridge.execute(createBaseParams({ workspacePath: '/custom/workspace' }));

    expect(spawnSpy).toHaveBeenCalledWith(
      'codex',
      expect.any(Array),
      expect.objectContaining({ cwd: '/custom/workspace' }),
    );

    mockProc.emit('close', 0);
    await resultPromise;
  });

  test('execute uses process.cwd() when no workspacePath', async () => {
    const bridge = new CodexAgentBridge();
    const mockProc = createMockProcess();

    spawnSpy.mockReturnValue(mockProc as unknown as child_process.ChildProcess);

    const resultPromise = bridge.execute(createBaseParams({ workspacePath: undefined }));

    expect(spawnSpy).toHaveBeenCalledWith(
      'codex',
      expect.any(Array),
      expect.objectContaining({ cwd: process.cwd() }),
    );

    mockProc.emit('close', 0);
    await resultPromise;
  });
});
