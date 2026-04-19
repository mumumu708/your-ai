import { describe, expect, test } from 'bun:test';
import { REFLECTION_SYSTEM_PROMPT, ReflectionPromptBuilder } from './reflection-prompt-builder';

describe('ReflectionPromptBuilder', () => {
  const builder = new ReflectionPromptBuilder();

  test('REFLECTION_SYSTEM_PROMPT contains 4 phases', () => {
    expect(REFLECTION_SYSTEM_PROMPT).toContain('Orient');
    expect(REFLECTION_SYSTEM_PROMPT).toContain('Gather');
    expect(REFLECTION_SYSTEM_PROMPT).toContain('Consolidate');
    expect(REFLECTION_SYSTEM_PROMPT).toContain('Prune');
  });

  test('builds message with memory snapshot and sessions', () => {
    const result = builder.buildUserMessage({
      sessionSummaries: [
        {
          id: 'sess-1',
          summary: '讨论了项目架构',
          startedAt: new Date('2026-04-10T10:00:00Z').getTime(),
          channel: 'feishu',
        },
      ],
      currentMemorySnapshot: '- 用户偏好简洁回复',
    });

    expect(result).toContain('## 当前记忆状态');
    expect(result).toContain('- 用户偏好简洁回复');
    expect(result).toContain('### 会话 sess-1（2026-04-10，feishu）');
    expect(result).toContain('讨论了项目架构');
    expect(result).toContain('请按照 4 阶段流程处理以上会话历史');
  });

  test('builds message without memory snapshot', () => {
    const result = builder.buildUserMessage({
      sessionSummaries: [
        {
          id: 'sess-2',
          summary: '修复了 bug',
          startedAt: new Date('2026-04-11T14:00:00Z').getTime(),
          channel: 'telegram',
        },
      ],
    });

    expect(result).not.toContain('## 当前记忆状态');
    expect(result).toContain('### 会话 sess-2（2026-04-11，telegram）');
    expect(result).toContain('修复了 bug');
  });

  test('handles multiple sessions', () => {
    const result = builder.buildUserMessage({
      sessionSummaries: [
        {
          id: 'a',
          summary: 'first',
          startedAt: new Date('2026-04-09').getTime(),
          channel: 'web',
        },
        {
          id: 'b',
          summary: 'second',
          startedAt: new Date('2026-04-10').getTime(),
          channel: 'feishu',
        },
        {
          id: 'c',
          summary: 'third',
          startedAt: new Date('2026-04-11').getTime(),
          channel: 'telegram',
        },
      ],
    });

    expect(result).toContain('### 会话 a');
    expect(result).toContain('### 会话 b');
    expect(result).toContain('### 会话 c');
    expect(result).toContain('first');
    expect(result).toContain('second');
    expect(result).toContain('third');
  });

  test('handles empty summary with fallback text', () => {
    const result = builder.buildUserMessage({
      sessionSummaries: [
        {
          id: 'empty',
          summary: '',
          startedAt: new Date('2026-04-10').getTime(),
          channel: 'web',
        },
      ],
    });

    expect(result).toContain('（无摘要）');
  });

  test('formats dates correctly from timestamps', () => {
    // Use a specific UTC timestamp to ensure consistent date extraction
    const timestamp = Date.UTC(2026, 0, 15, 12, 0, 0); // 2026-01-15T12:00:00Z
    const result = builder.buildUserMessage({
      sessionSummaries: [
        {
          id: 'date-test',
          summary: 'test',
          startedAt: timestamp,
          channel: 'web',
        },
      ],
    });

    expect(result).toContain('2026-01-15');
  });
});
