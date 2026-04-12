import type { ExecutionMode } from './agent-bridge';

/** TaskGuidanceBuilder 的输入参数 */
export interface TaskGuidanceBuildParams {
  /** 任务类型 */
  taskType: string;
  /** 执行模式 */
  executionMode: ExecutionMode;
  /** 工作目录（harness 场景） */
  workspacePath?: string;
  /** 匹配到的 skill 列表 */
  matchedSkills?: string[];
}

/**
 * TaskGuidanceBuilder — 根据任务分类生成 `<task-guidance>` 内容。
 *
 * 生成的文本会注入到 Agent 的 prependContext 中，
 * 通过 context engineering 驱动 Agent 行为差异化。
 */
export class TaskGuidanceBuilder {
  build(params: TaskGuidanceBuildParams): string {
    const parts: string[] = [];

    parts.push(`任务类型：${params.taskType}（${params.executionMode}）`);

    switch (params.executionMode) {
      case 'sync':
        parts.push('简洁直接回答。');
        break;
      case 'async':
        parts.push('这是后台任务。完成后结果将推送给用户。');
        break;
      case 'long-horizon':
        parts.push('这是长时间任务。定期输出进展，用户可能中途追加指令。');
        parts.push('建议：先分解步骤，逐步执行，必要时 delegate 子任务。');
        break;
    }

    if (params.matchedSkills && params.matchedSkills.length > 0) {
      parts.push(`推荐 skill: ${params.matchedSkills.join(', ')}。请先 skill_view 加载。`);
    }

    if (params.taskType === 'harness' && params.workspacePath) {
      parts.push(`工作目录：${params.workspacePath}`);
      parts.push('完成后运行项目检查命令验证。');
    }

    return parts.join('\n');
  }
}
