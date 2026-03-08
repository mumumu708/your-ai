import type {
  FileEntry,
  FindOptions,
  FindResponse,
  FindResult,
  OVConfig,
  OVResponse,
  OVSession,
  Relation,
} from './types';

export class OVError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'OVError';
  }
}

export class OpenVikingClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;
  private readonly retries: number;

  constructor(config: OVConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.timeout = config.timeout ?? 30_000;
    this.retries = config.retries ?? 2;
    this.headers = {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { 'X-API-Key': config.apiKey } : {}),
    };
  }

  // ─── Core request with retry + exponential backoff ─────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
    maxRetries?: number,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    let lastError: Error | null = null;

    const retries = maxRetries ?? this.retries;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);

        const res = await fetch(url.toString(), {
          method,
          headers: this.headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timer);
        const json = (await res.json()) as OVResponse<T>;

        if (json.status === 'error') {
          throw new OVError(
            json.error?.code ?? 'UNKNOWN',
            json.error?.message ?? 'Unknown error',
            res.status,
          );
        }

        return json.result as T;
      } catch (err) {
        lastError = err as Error;
        // Don't retry 4xx client errors
        if (err instanceof OVError && err.status && err.status < 500) {
          throw err;
        }
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 2 ** attempt * 200));
        }
      }
    }

    throw lastError ?? new Error('Request failed');
  }

  // ─── Core request for non-OVResponse endpoints ────────────

  private async requestRaw<T>(method: string, path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, { method, headers: this.headers });
    return (await res.json()) as T;
  }

  // ─── System ────────────────────────────────────────────────

  async health(): Promise<{ status: string }> {
    return this.requestRaw('GET', '/health');
  }

  async ready(): Promise<{ status: string; checks: Record<string, string> }> {
    return this.requestRaw('GET', '/ready');
  }

  async status(): Promise<Record<string, unknown>> {
    return this.request('GET', '/api/v1/system/status');
  }

  async waitProcessed(timeoutSec = 60): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutSec * 1000) {
      try {
        const readiness = await this.ready();
        if (readiness.status === 'ready') return;
      } catch {
        // Server not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new OVError('TIMEOUT', 'Wait for processing timed out');
  }

  // ─── Resources ─────────────────────────────────────────────

  async addResource(
    content: string,
    options?: { uri?: string; format?: string },
  ): Promise<{ uri: string }> {
    return this.request('POST', '/api/v1/resources', { content, ...options });
  }

  // ─── File System ───────────────────────────────────────────

  async abstract(uri: string): Promise<string> {
    return this.request('GET', '/api/v1/content/abstract', undefined, { uri });
  }

  async overview(uri: string): Promise<string> {
    return this.request('GET', '/api/v1/content/overview', undefined, { uri });
  }

  async read(uri: string): Promise<string> {
    return this.request('GET', '/api/v1/content/read', undefined, { uri });
  }

  /** Read a file, returning null if not found (no retries, no throw) */
  async tryRead(uri: string): Promise<string | null> {
    try {
      return await this.request('GET', '/api/v1/content/read', undefined, { uri }, 0);
    } catch {
      return null;
    }
  }

  async ls(uri: string): Promise<FileEntry[]> {
    return this.request('GET', '/api/v1/fs/ls', undefined, { uri });
  }

  async tree(uri: string, depth = 3): Promise<string> {
    return this.request('GET', '/api/v1/fs/tree', undefined, {
      uri,
      depth: String(depth),
    });
  }

  async stat(uri: string): Promise<Record<string, unknown>> {
    return this.request('GET', '/api/v1/fs/stat', undefined, { uri });
  }

  async mkdir(uri: string): Promise<void> {
    try {
      await this.request('POST', '/api/v1/fs/mkdir', { uri }, undefined, 0);
    } catch (err) {
      // "already exists" is expected for idempotent mkdir — swallow it
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes('already exist')) {
        throw err;
      }
    }
  }

  async write(uri: string, content: string): Promise<void> {
    await this.request('POST', '/api/v1/resources', { content, uri });
  }

  async rm(uri: string): Promise<void> {
    await this.request('DELETE', '/api/v1/fs', undefined, { uri });
  }

  async mv(fromUri: string, toUri: string): Promise<void> {
    await this.request('POST', '/api/v1/fs/mv', { from: fromUri, to: toUri });
  }

  // ─── Search ────────────────────────────────────────────────

  async find(options: FindOptions): Promise<FindResult[]> {
    const resp = await this.request<FindResponse>('POST', '/api/v1/search/find', {
      query: options.query,
      target_uri: options.target_uri ?? 'viking://',
      limit: options.limit ?? 10,
      score_threshold: options.score_threshold,
    });
    return [...(resp.memories ?? []), ...(resp.resources ?? []), ...(resp.skills ?? [])];
  }

  async search(options: FindOptions): Promise<FindResult[]> {
    const resp = await this.request<FindResponse>('POST', '/api/v1/search/search', {
      query: options.query,
      target_uri: options.target_uri ?? 'viking://',
      limit: options.limit ?? 10,
    });
    return [...(resp.memories ?? []), ...(resp.resources ?? []), ...(resp.skills ?? [])];
  }

  async grep(pattern: string, scope?: string): Promise<{ uri: string; matches: string[] }[]> {
    return this.request('POST', '/api/v1/search/grep', {
      pattern,
      target_uri: scope ?? 'viking://',
    });
  }

  // ─── Relations ─────────────────────────────────────────────

  async link(fromUri: string, uris: string[], reason: string): Promise<void> {
    await this.request('POST', '/api/v1/relations/link', {
      from_uri: fromUri,
      uris,
      reason,
    });
  }

  async relations(uri: string): Promise<Relation[]> {
    return this.request('GET', '/api/v1/relations', undefined, { uri });
  }

  async unlink(fromUri: string, uris: string[]): Promise<void> {
    await this.request('DELETE', '/api/v1/relations/link', {
      from_uri: fromUri,
      uris,
    });
  }

  // ─── Sessions ──────────────────────────────────────────────

  async createSession(properties?: Record<string, unknown>): Promise<OVSession> {
    return this.request('POST', '/api/v1/sessions', { properties });
  }

  async listSessions(): Promise<OVSession[]> {
    return this.request('GET', '/api/v1/sessions');
  }

  async getSession(id: string): Promise<OVSession> {
    return this.request('GET', `/api/v1/sessions/${id}`);
  }

  async deleteSession(id: string): Promise<void> {
    await this.request('DELETE', `/api/v1/sessions/${id}`);
  }

  async addMessage(
    sessionId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
  ): Promise<void> {
    await this.request('POST', `/api/v1/sessions/${sessionId}/messages`, {
      role,
      content,
    });
  }

  async commit(sessionId: string): Promise<{ memories_extracted: number }> {
    return this.request('POST', `/api/v1/sessions/${sessionId}/commit`);
  }
}
