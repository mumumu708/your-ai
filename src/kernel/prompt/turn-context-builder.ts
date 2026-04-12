import {
  type RetrievedMemory,
  type TurnContext,
  type TurnContextBuildParams,
  estimateTokens,
} from './prompt-types';

/**
 * Builds per-turn injection context.
 *
 * Injected into user message prefix each turn. Contains:
 * - <memory-context>: retrieved memories relevant to current query
 * - <task-guidance>: execution hints based on classify result
 * - <invoked-skills>: post-compaction skill recovery hints
 * - <mcp-delta>: MCP server connection changes
 */
export function buildTurnContext(params: TurnContextBuildParams): TurnContext {
  const parts: string[] = [];

  // ── Memory Context ──
  const memorySection = buildMemorySection(params.memories);
  if (memorySection) {
    parts.push(memorySection);
  }

  // ── Task Guidance ──
  // 优先使用外部注入的 taskGuidance（TaskGuidanceBuilder 生成），否则回退到内部 hardcoded 逻辑
  const guidanceSection = params.taskGuidance
    ? `<task-guidance>\n${params.taskGuidance}\n</task-guidance>`
    : buildTaskGuidance(params.executionMode, params.taskType);
  if (guidanceSection) {
    parts.push(guidanceSection);
  }

  // ── Invoked Skills (post-compaction recovery) ──
  if (params.postCompaction && params.invokedSkills && params.invokedSkills.length > 0) {
    parts.push(buildInvokedSkillsSection(params.invokedSkills));
  }

  // ── MCP Delta ──
  const mcpDelta = buildMcpDelta(params.mcpServers);
  if (mcpDelta) {
    parts.push(mcpDelta);
  }

  const content = parts.join('\n');
  return { content, totalTokens: estimateTokens(content) };
}

function buildMemorySection(memories?: RetrievedMemory[]): string | null {
  if (!memories || memories.length === 0) return null;

  const lines: string[] = ['<memory-context>', '## 相关记忆'];
  for (const m of memories) {
    const dateStr = new Date(m.updatedAt).toISOString().split('T')[0];
    lines.push(`- [${dateStr}] ${m.content}`);
  }
  lines.push('</memory-context>');
  return lines.join('\n');
}

function buildTaskGuidance(executionMode?: string, taskType?: string): string | null {
  if (!executionMode && !taskType) return null;

  const lines: string[] = ['<task-guidance>'];

  if (executionMode) {
    const modeHints: Record<string, string> = {
      sync: '同步执行模式：直接回复用户，保持简洁。',
      async: '异步执行模式：任务将在后台执行，先确认收到再处理。',
      'long-horizon': '长周期执行模式：分步执行复杂任务，定期��告进度。',
    };
    const hint = modeHints[executionMode];
    if (hint) {
      lines.push(`执行模式: ${hint}`);
    }
  }

  if (taskType) {
    const typeHints: Record<string, string> = {
      chat: '对话任务：自然交流，关注用户意图。',
      harness: '工程任务：严格遵循工程规范，运行检查。',
      scheduled: '定时任务：按计划执行，记录结果。',
      automation: '自动化任务：按规则执行，异常��通知用户。',
      system: '系统任务：内部维护操作���',
    };
    const hint = typeHints[taskType];
    if (hint) {
      lines.push(`任务类型: ${hint}`);
    }
  }

  lines.push('</task-guidance>');
  // If only tags and no real content, skip
  return lines.length > 2 ? lines.join('\n') : null;
}

function buildInvokedSkillsSection(skills: string[]): string {
  const lines: string[] = [
    '<invoked-skills>',
    '以下 skills 在本会话中已被使用。上下文压缩后完整内容已移除。',
    '如需再次使用，请通过 skill_view 重新加载：',
  ];
  for (const skill of skills) {
    lines.push(`- ${skill}`);
  }
  lines.push('</invoked-skills>');
  return lines.join('\n');
}

function buildMcpDelta(mcpServers?: { current: string[]; previous: string[] }): string | null {
  if (!mcpServers) return null;

  const current = new Set(mcpServers.current);
  const previous = new Set(mcpServers.previous);

  const added = mcpServers.current.filter((s) => !previous.has(s));
  const removed = mcpServers.previous.filter((s) => !current.has(s));

  if (added.length === 0 && removed.length === 0) return null;

  const lines: string[] = ['<mcp-delta>'];
  for (const s of added) {
    lines.push(`MCP server connected: ${s}`);
  }
  for (const s of removed) {
    lines.push(`MCP server disconnected: ${s}`);
  }
  lines.push('</mcp-delta>');
  return lines.join('\n');
}
