/**
 * 集成测试: LightLLM 真实 API 调用
 *
 * 需要环境变量 LIGHT_LLM_API_KEY 才能运行。
 * 验证:
 *   1. LightLLMClient.complete() 能拿到非空响应
 *   2. TaskClassifier 的 JSON 分类 prompt 能被 LLM 正确响应
 *   3. stream() 能正常产出 chunk
 */
import { describe, expect, test } from 'bun:test';
import { LightLLMClient } from '../kernel/agents/light-llm-client';
import { TaskClassifier } from '../kernel/classifier/task-classifier';

const HAS_API_KEY = !!process.env.LIGHT_LLM_API_KEY;

describe.skipIf(!HAS_API_KEY)('LightLLM 集成测试 (真实 API)', () => {
  const client = new LightLLMClient();

  test(
    'complete: 简单对话应返回非空内容',
    async () => {
      const result = await client.complete({
        messages: [
          { role: 'system', content: '用一句话回答。' },
          { role: 'user', content: '1+1等于几？' },
        ],
        maxTokens: 1024,
        temperature: 0,
      });

      expect(result.content).toBeTruthy();
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.model).toBeTruthy();
      console.log('[集成测试] complete 响应:', result.content.slice(0, 100));
    },
    { timeout: 60_000 },
  );

  test(
    'complete: JSON 格式 prompt 应返回可解析的 JSON',
    async () => {
      const result = await client.complete({
        messages: [
          {
            role: 'system',
            content:
              '你是一个任务分类器。根据用户消息判断：\n1. taskType: "chat"(对话/问答/工程任务) | "scheduled"(定时提醒/取消定时/查看定时) | "automation"(批量自动化) | "system"(系统命令)\n2. complexity: "simple"(简单问答/闲聊) | "complex"(需要工具/代码/多步推理)\n3. subIntent: 当 taskType 为 "scheduled" 时必填 — "create"(创建/设置定时任务) | "cancel"(取消/删除定时任务) | "list"(查看/列出定时任务)\n只回复 JSON: {"taskType":"...","complexity":"...","subIntent":"...","reason":"..."}',
          },
          { role: 'user', content: '今天天气怎么样？' },
        ],
        maxTokens: 1024,
        temperature: 0,
      });

      expect(result.content).toBeTruthy();
      console.log('[集成测试] 分类原始响应:', result.content);

      // 尝试解析 JSON（与 TaskClassifier.extractJson 同逻辑）
      const trimmed = result.content.trim();
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            parsed = JSON.parse(jsonMatch[0]);
          } catch {
            // give up
          }
        }
      }

      expect(parsed).not.toBeNull();
      expect(parsed).toHaveProperty('taskType');
      expect(parsed).toHaveProperty('complexity');
      console.log('[集成测试] 解析结果:', parsed);
    },
    { timeout: 60_000 },
  );

  test(
    'TaskClassifier.classify: 真实 LLM 分类应返回有效结果',
    async () => {
      const classifier = new TaskClassifier(client);
      const result = await classifier.classify('帮我写一个 Python 脚本读取 CSV 文件', {
        userId: 'integration-test',
      });

      expect(result.taskType).toBe('chat');
      expect(result.complexity).toBe('complex');
      expect(result.classifiedBy).toBeOneOf(['rule', 'llm']);
      console.log('[集成测试] 分类结果:', result);
    },
    { timeout: 60_000 },
  );

  test(
    'stream: 应能产出至少一个非空 chunk',
    async () => {
      const chunks: string[] = [];
      for await (const chunk of client.stream({
        messages: [
          { role: 'system', content: '用一句话回答。' },
          { role: 'user', content: '中国的首都是哪里？' },
        ],
        maxTokens: 1024,
        temperature: 0,
      })) {
        if (chunk.content) {
          chunks.push(chunk.content);
        }
      }

      const fullContent = chunks.join('');
      expect(fullContent.length).toBeGreaterThan(0);
      console.log('[集成测试] stream 完整响应:', fullContent.slice(0, 100));
    },
    { timeout: 60_000 },
  );
});
