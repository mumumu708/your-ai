import { Logger } from '../../shared/logging/logger';
import type { StreamEvent } from '../../shared/messaging/stream-event.types';
import type { AgentBridge, AgentExecuteParams, AgentProviderId, AgentResult } from './agent-bridge';

/**
 * AgentBridgeWithFallback — 容错包装。
 *
 * 包装一个主 AgentBridge（Claude）和一个备用 AgentBridge（Codex）。
 * 当主 provider 因不可用错误（rate limit / 超时 / 进程找不到等）失败时，
 * 自动切换到备用 provider。
 *
 * 流式安全：primary 部分流式后崩溃时，丢弃 primary 的 partial 输出，
 * 用 fallback 的完整输出替代（通过 stream-reset 信号通知上游清空缓冲区）。
 */
export class AgentBridgeWithFallback implements AgentBridge {
  private readonly logger = new Logger('AgentBridgeWithFallback');

  constructor(
    private readonly primary: AgentBridge,
    private readonly fallback: AgentBridge,
    private readonly primaryName: AgentProviderId = 'claude',
    private readonly fallbackName: AgentProviderId = 'codex',
  ) {}

  async execute(params: AgentExecuteParams): Promise<AgentResult> {
    // Wrap streamCallback to intercept and discard primary's partial output on fallback
    let primaryStreamed = false;
    const originalCallback = params.streamCallback;

    const trackingCallback: typeof params.streamCallback = originalCallback
      ? async (event: StreamEvent) => {
          if (event.type === 'text_delta' || event.type === 'tool_use') {
            primaryStreamed = true;
          }
          return originalCallback(event);
        }
      : undefined;

    try {
      const result = await this.primary.execute({ ...params, streamCallback: trackingCallback });
      return { ...result, handledBy: this.primaryName };
    } catch (error) {
      if (this.isProviderUnavailable(error)) {
        this.logger.warn('主 agent 不可用，切换到备用', {
          error: error instanceof Error ? error.message : String(error),
          fallback: this.fallbackName,
          sessionId: params.sessionId,
        });

        // If primary partially streamed, send stream_reset to discard partial content
        if (primaryStreamed && originalCallback) {
          this.logger.warn('主 agent 部分流式后崩溃，发送 stream_reset 清空缓冲区');
          await originalCallback({ type: 'stream_reset' } as StreamEvent);
        }

        const result = await this.fallback.execute(params);
        return { ...result, handledBy: this.fallbackName };
      }
      throw error;
    }
  }

  async appendMessage(sessionKey: string, content: string): Promise<void> {
    try {
      await this.primary.appendMessage?.(sessionKey, content);
    } catch {
      await this.fallback.appendMessage?.(sessionKey, content);
    }
  }

  async abort(sessionKey: string): Promise<void> {
    await Promise.allSettled([this.primary.abort?.(sessionKey), this.fallback.abort?.(sessionKey)]);
  }

  /**
   * 判断错误是否属于 provider 不可用（应触发 fallback）。
   * 仅匹配基础设施层面的不可用，业务错误不触发。
   */
  isProviderUnavailable(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return /ENOENT|command not found|rate.?limit|quota|503|502|timeout|ECONNREFUSED|ECONNRESET|exited with code/i.test(
      error.message,
    );
  }
}
