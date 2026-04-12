import type { AgentBridge, AgentExecuteParams, AgentResult } from './agent-bridge';
import type { ClaudeAgentBridge } from './claude-agent-bridge';

/**
 * ClaudeBridgeAdapter — 将旧 ClaudeAgentBridge 适配为新 AgentBridge 接口。
 *
 * 不修改 ClaudeAgentBridge 本身，通过适配器模式桥接两套接口。
 */
export class ClaudeBridgeAdapter implements AgentBridge {
  constructor(private readonly bridge: ClaudeAgentBridge) {}

  async execute(params: AgentExecuteParams): Promise<AgentResult> {
    const oldResult = await this.bridge.execute({
      sessionId: params.sessionId,
      messages: params.userMessage ? [{ role: 'user', content: params.userMessage }] : [],
      systemPrompt: params.systemPrompt,
      cwd: params.workspacePath,
      claudeSessionId: params.claudeSessionId,
      signal: params.signal,
      onStream: params.streamCallback
        ? (event) => {
            // Fire-and-forget: bridge uses sync callback, gateway uses async
            void params.streamCallback?.(event);
          }
        : undefined,
    });

    return {
      content: oldResult.content,
      tokenUsage: {
        inputTokens: oldResult.usage.inputTokens,
        outputTokens: oldResult.usage.outputTokens,
      },
      toolsUsed: oldResult.toolsUsed,
      claudeSessionId: oldResult.claudeSessionId,
      turnsUsed: oldResult.turns,
      finishedNaturally: true,
      handledBy: 'claude',
    };
  }
}
