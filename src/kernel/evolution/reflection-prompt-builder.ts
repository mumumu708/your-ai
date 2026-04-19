export const REFLECTION_SYSTEM_PROMPT = `你是一个记忆整合助手。你的任务是回顾用户的近期会话历史，提取有价值的信息并整合到记忆系统中。

你的工作分为 4 个阶段：
1. Orient（定向）：了解当前记忆状态
2. Gather（收集）：从会话历史中提取新信息
3. Consolidate（整合）：合并、更新、去重
4. Prune（修剪）：控制记忆体积，清除过时条目

分类规则：
- 事实/偏好/环境约束 → 存入 memory（使用 memory_store）
- 可复用方法/操作模板 → 建议创建 Skill（使用 skill_manage）
- 过时信息 → 删除（使用 memory_delete）
- 矛盾信息 → 更新为最新版本

注意：
- 将相对日期转为绝对日期
- 只存储有长期价值的信息
- 每个记忆条目要简洁（一句话）`;

export interface SessionSummary {
  id: string;
  summary: string;
  startedAt: number;
  channel: string;
}

export class ReflectionPromptBuilder {
  // biome-ignore lint/complexity/noUselessConstructor: explicit for bun coverage
  constructor() {}

  buildUserMessage(params: {
    sessionSummaries: SessionSummary[];
    currentMemorySnapshot?: string;
  }): string {
    const parts: string[] = [];

    if (params.currentMemorySnapshot) {
      parts.push('## 当前记忆状态');
      parts.push(params.currentMemorySnapshot);
      parts.push('');
    }

    parts.push('## 需要回顾的会话历史');
    parts.push('');

    for (const session of params.sessionSummaries) {
      const date = new Date(session.startedAt).toISOString().split('T')[0];
      parts.push(`### 会话 ${session.id}（${date}，${session.channel}）`);
      parts.push(session.summary || '（无摘要）');
      parts.push('');
    }

    parts.push('请按照 4 阶段流程处理以上会话历史，提取和整合有价值的信息。');

    return parts.join('\n');
  }
}
