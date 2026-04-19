import { describe, expect, test } from 'bun:test';
import type { AnalysisItem } from './analysis-router';
import { routeAnalysis } from './analysis-router';

describe('routeAnalysis', () => {
  test('routes facts to memories', () => {
    const items: AnalysisItem[] = [{ content: '用户在字节跳动工作', type: 'fact' }];
    const result = routeAnalysis(items);
    expect(result.memories).toHaveLength(1);
    expect(result.skillCandidates).toHaveLength(0);
    expect(result.memories[0].type).toBe('fact');
  });

  test('routes preferences to memories', () => {
    const items: AnalysisItem[] = [{ content: '偏好简洁回复', type: 'preference' }];
    const result = routeAnalysis(items);
    expect(result.memories).toHaveLength(1);
    expect(result.skillCandidates).toHaveLength(0);
  });

  test('routes constraints to memories', () => {
    const items: AnalysisItem[] = [{ content: '项目使用 Bun', type: 'constraint' }];
    const result = routeAnalysis(items);
    expect(result.memories).toHaveLength(1);
    expect(result.skillCandidates).toHaveLength(0);
  });

  test('routes lessons to memories', () => {
    const items: AnalysisItem[] = [{ content: '飞书 API 需要解包', type: 'lesson' }];
    const result = routeAnalysis(items);
    expect(result.memories).toHaveLength(1);
    expect(result.skillCandidates).toHaveLength(0);
  });

  test('routes methods to skill candidates', () => {
    const items: AnalysisItem[] = [{ content: 'RSS 处理流程', type: 'method' }];
    const result = routeAnalysis(items);
    expect(result.memories).toHaveLength(0);
    expect(result.skillCandidates).toHaveLength(1);
    expect(result.skillCandidates[0].type).toBe('method');
  });

  test('routes templates to skill candidates', () => {
    const items: AnalysisItem[] = [{ content: '部署流程模板', type: 'template' }];
    const result = routeAnalysis(items);
    expect(result.memories).toHaveLength(0);
    expect(result.skillCandidates).toHaveLength(1);
  });

  test('routes troubleshooting to skill candidates', () => {
    const items: AnalysisItem[] = [{ content: 'TS 类型错误排查', type: 'troubleshooting' }];
    const result = routeAnalysis(items);
    expect(result.memories).toHaveLength(0);
    expect(result.skillCandidates).toHaveLength(1);
  });

  test('handles empty input', () => {
    const result = routeAnalysis([]);
    expect(result.memories).toHaveLength(0);
    expect(result.skillCandidates).toHaveLength(0);
  });

  test('routes mixed types correctly', () => {
    const items: AnalysisItem[] = [
      { content: '用户是工程师', type: 'fact' },
      { content: '偏好中文', type: 'preference' },
      { content: 'RSS 处理方法', type: 'method' },
      { content: '部署模板', type: 'template' },
      { content: '环境限制', type: 'constraint' },
      { content: '经验教训', type: 'lesson' },
      { content: '排查步骤', type: 'troubleshooting' },
    ];

    const result = routeAnalysis(items);
    expect(result.memories).toHaveLength(4); // fact, preference, constraint, lesson
    expect(result.skillCandidates).toHaveLength(3); // method, template, troubleshooting
  });
});
