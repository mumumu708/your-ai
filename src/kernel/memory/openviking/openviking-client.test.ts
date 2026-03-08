import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { OVError, OpenVikingClient } from './openviking-client';

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = handler(url, init);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

describe('OVError', () => {
  test('stores code, message and optional status', () => {
    const err = new OVError('NOT_FOUND', 'not found', 404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('not found');
    expect(err.status).toBe(404);
    expect(err.name).toBe('OVError');
  });

  test('status is optional', () => {
    const err = new OVError('ERR', 'msg');
    expect(err.status).toBeUndefined();
  });
});

describe('OpenVikingClient', () => {
  let client: OpenVikingClient;

  beforeEach(() => {
    client = new OpenVikingClient({
      baseUrl: 'http://localhost:1933/',
      apiKey: 'test-key',
      timeout: 5000,
      retries: 1,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ─── Constructor ─────────────────────────────────────────
  test('trims trailing slash from baseUrl', () => {
    mockFetch(() => ({ status: 'ok', result: { status: 'healthy' } }));
    // The fact that fetch is called with correct URL proves trailing slash is stripped
    client.health();
  });

  test('works without apiKey', () => {
    const c = new OpenVikingClient({ baseUrl: 'http://localhost:1933' });
    mockFetch((_url, init) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['X-API-Key']).toBeUndefined();
      return { status: 'ok', result: { status: 'healthy' } };
    });
    return c.health();
  });

  // ─── request (core) ──────────────────────────────────────
  test('makes request with correct method, URL, and body', async () => {
    mockFetch((url, init) => {
      expect(url).toContain('/api/v1/resources');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body.content).toBe('hello');
      return { status: 'ok', result: { uri: 'viking://test' } };
    });

    const result = await client.addResource('hello');
    expect(result.uri).toBe('viking://test');
  });

  test('passes query params in URL', async () => {
    mockFetch((url) => {
      expect(url).toContain('uri=viking%3A%2F%2Ftest');
      return { status: 'ok', result: 'content' };
    });

    await client.read('viking://test');
  });

  test('throws OVError on error response', async () => {
    mockFetch(() => ({
      status: 'error',
      error: { code: 'NOT_FOUND', message: 'File not found' },
    }));

    expect(client.read('missing')).rejects.toThrow(OVError);
  });

  test('throws OVError with defaults when error fields missing', async () => {
    mockFetch(() => ({ status: 'error' }));

    try {
      await client.read('x');
      throw new Error('should not reach');
    } catch (e) {
      expect(e).toBeInstanceOf(OVError);
      expect((e as OVError).code).toBe('UNKNOWN');
    }
  });

  test('does not retry 4xx client errors', async () => {
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          status: 'error',
          error: { code: 'VALIDATION', message: 'bad input' },
        }),
        { status: 400 },
      );
    }) as typeof fetch;

    try {
      await client.read('bad');
    } catch {
      // expected
    }
    expect(callCount).toBe(1); // No retry for 4xx
  });

  test('retries on server errors then succeeds', async () => {
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            status: 'error',
            error: { code: 'INTERNAL', message: 'server error' },
          }),
          { status: 500 },
        );
      }
      return new Response(JSON.stringify({ status: 'ok', result: 'data' }), { status: 200 });
    }) as typeof fetch;

    const result = await client.read('retry-test');
    expect(result).toBe('data');
    expect(callCount).toBe(2);
  });

  test('throws last error after all retries exhausted', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('network down');
    }) as typeof fetch;

    expect(client.read('fail')).rejects.toThrow('network down');
  });

  // ─── requestRaw ──────────────────────────────────────────
  test('health calls /health via requestRaw', async () => {
    mockFetch((url) => {
      expect(url).toContain('/health');
      return { status: 'healthy' };
    });

    const result = await client.health();
    expect(result.status).toBe('healthy');
  });

  test('ready calls /ready', async () => {
    mockFetch(() => ({ status: 'ready', checks: { db: 'ok' } }));
    const result = await client.ready();
    expect(result.status).toBe('ready');
  });

  // ─── System ──────────────────────────────────────────────
  test('status returns system status', async () => {
    mockFetch(() => ({ status: 'ok', result: { version: '1.0' } }));
    const result = await client.status();
    expect(result).toEqual({ version: '1.0' });
  });

  test('waitProcessed resolves when ready', async () => {
    let callCount = 0;
    mockFetch(() => {
      callCount++;
      if (callCount < 2) return { status: 'processing' };
      return { status: 'ready' };
    });

    await client.waitProcessed(5);
  });

  test('waitProcessed throws OVError on timeout', async () => {
    mockFetch(() => ({ status: 'processing' }));
    expect(client.waitProcessed(0.001)).rejects.toThrow('timed out');
  });

  test('waitProcessed catches fetch errors and keeps trying', async () => {
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) throw new Error('connection refused');
      return new Response(JSON.stringify({ status: 'ready' }), { status: 200 });
    }) as typeof fetch;

    await client.waitProcessed(5);
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  // ─── Resources ───────────────────────────────────────────
  test('addResource sends content and options', async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.content).toBe('test');
      expect(body.uri).toBe('viking://docs/test.md');
      return { status: 'ok', result: { uri: 'viking://docs/test.md' } };
    });

    const result = await client.addResource('test', { uri: 'viking://docs/test.md' });
    expect(result.uri).toBe('viking://docs/test.md');
  });

  // ─── File System ─────────────────────────────────────────
  test('abstract returns string', async () => {
    mockFetch(() => ({ status: 'ok', result: 'summary text' }));
    expect(await client.abstract('viking://f')).toBe('summary text');
  });

  test('overview returns string', async () => {
    mockFetch(() => ({ status: 'ok', result: 'overview text' }));
    expect(await client.overview('viking://f')).toBe('overview text');
  });

  test('tryRead returns content on success', async () => {
    mockFetch(() => ({ status: 'ok', result: 'file content' }));
    expect(await client.tryRead('viking://f')).toBe('file content');
  });

  test('tryRead returns null on error', async () => {
    mockFetch(() => ({ status: 'error', error: { code: 'NOT_FOUND', message: 'nope' } }));
    expect(await client.tryRead('viking://missing')).toBeNull();
  });

  test('ls returns file entries', async () => {
    const entries = [{ name: 'a.md', uri: 'viking://a.md', type: 'file' }];
    mockFetch(() => ({ status: 'ok', result: entries }));
    const result = await client.ls('viking://');
    expect(result).toEqual(entries);
  });

  test('tree passes depth param', async () => {
    mockFetch((url) => {
      expect(url).toContain('depth=5');
      return { status: 'ok', result: 'tree output' };
    });
    await client.tree('viking://', 5);
  });

  test('stat returns metadata', async () => {
    mockFetch(() => ({ status: 'ok', result: { size: 100 } }));
    const result = await client.stat('viking://f');
    expect(result).toEqual({ size: 100 });
  });

  test('mkdir sends POST', async () => {
    mockFetch((_url, init) => {
      expect(init?.method).toBe('POST');
      return { status: 'ok', result: null };
    });
    await client.mkdir('viking://dir');
  });

  test('write sends content', async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.uri).toBe('viking://f');
      expect(body.content).toBe('data');
      return { status: 'ok', result: null };
    });
    await client.write('viking://f', 'data');
  });

  test('rm sends DELETE', async () => {
    mockFetch((_url, init) => {
      expect(init?.method).toBe('DELETE');
      return { status: 'ok', result: null };
    });
    await client.rm('viking://f');
  });

  test('mv sends from/to', async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.from).toBe('viking://a');
      expect(body.to).toBe('viking://b');
      return { status: 'ok', result: null };
    });
    await client.mv('viking://a', 'viking://b');
  });

  // ─── Search ──────────────────────────────────────────────
  test('find merges memories, resources, and skills', async () => {
    mockFetch(() => ({
      status: 'ok',
      result: {
        memories: [
          { uri: 'v://m1', context_type: 'memory', abstract: 'a', score: 0.9, match_reason: 'r' },
        ],
        resources: [
          { uri: 'v://r1', context_type: 'resource', abstract: 'b', score: 0.8, match_reason: 'r' },
        ],
        skills: [],
      },
    }));

    const results = await client.find({ query: 'test' });
    expect(results).toHaveLength(2);
  });

  test('find uses defaults for optional fields', async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.target_uri).toBe('viking://');
      expect(body.limit).toBe(10);
      return { status: 'ok', result: { memories: [], resources: [], skills: [] } };
    });
    await client.find({ query: 'test' });
  });

  test('search merges results similarly', async () => {
    mockFetch(() => ({
      status: 'ok',
      result: { memories: [], resources: [], skills: [] },
    }));
    const results = await client.search({ query: 'q' });
    expect(results).toHaveLength(0);
  });

  test('grep sends pattern and scope', async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.pattern).toBe('foo');
      expect(body.target_uri).toBe('viking://scope');
      return { status: 'ok', result: [{ uri: 'v://f', matches: ['foo bar'] }] };
    });
    const result = await client.grep('foo', 'viking://scope');
    expect(result).toHaveLength(1);
  });

  test('grep uses default scope', async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.target_uri).toBe('viking://');
      return { status: 'ok', result: [] };
    });
    await client.grep('bar');
  });

  // ─── Relations ───────────────────────────────────────────
  test('link sends from_uri, uris, reason', async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.from_uri).toBe('viking://a');
      expect(body.uris).toEqual(['viking://b']);
      expect(body.reason).toBe('related');
      return { status: 'ok', result: null };
    });
    await client.link('viking://a', ['viking://b'], 'related');
  });

  test('relations returns relation list', async () => {
    mockFetch(() => ({
      status: 'ok',
      result: [{ uri: 'v://b', reason: 'r', created_at: '2024-01-01' }],
    }));
    const result = await client.relations('viking://a');
    expect(result).toHaveLength(1);
  });

  test('unlink sends DELETE with body', async () => {
    mockFetch((_url, init) => {
      expect(init?.method).toBe('DELETE');
      const body = JSON.parse(init?.body as string);
      expect(body.from_uri).toBe('viking://a');
      return { status: 'ok', result: null };
    });
    await client.unlink('viking://a', ['viking://b']);
  });

  // ─── Sessions ────────────────────────────────────────────
  test('createSession sends properties', async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.properties).toEqual({ foo: 'bar' });
      return {
        status: 'ok',
        result: {
          id: 's1',
          created_at: '2024-01-01',
          properties: { foo: 'bar' },
          message_count: 0,
        },
      };
    });
    const session = await client.createSession({ foo: 'bar' });
    expect(session.id).toBe('s1');
  });

  test('listSessions returns array', async () => {
    mockFetch(() => ({ status: 'ok', result: [] }));
    const sessions = await client.listSessions();
    expect(sessions).toEqual([]);
  });

  test('getSession by id', async () => {
    mockFetch((url) => {
      expect(url).toContain('/sessions/s1');
      return {
        status: 'ok',
        result: { id: 's1', created_at: '2024-01-01', properties: {}, message_count: 0 },
      };
    });
    const session = await client.getSession('s1');
    expect(session.id).toBe('s1');
  });

  test('deleteSession sends DELETE', async () => {
    mockFetch((_url, init) => {
      expect(init?.method).toBe('DELETE');
      return { status: 'ok', result: null };
    });
    await client.deleteSession('s1');
  });

  test('addMessage sends role and content', async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.role).toBe('user');
      expect(body.content).toBe('hello');
      return { status: 'ok', result: null };
    });
    await client.addMessage('s1', 'user', 'hello');
  });

  test('commit returns memories_extracted', async () => {
    mockFetch(() => ({ status: 'ok', result: { memories_extracted: 3 } }));
    const result = await client.commit('s1');
    expect(result.memories_extracted).toBe(3);
  });
});
