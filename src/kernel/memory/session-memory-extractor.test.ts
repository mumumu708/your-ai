import { describe, expect, test } from 'bun:test';
import type { ConversationMessage } from '../../shared/agents/agent-instance.types';
import { SessionMemoryExtractor } from './session-memory-extractor';

function msg(role: 'user' | 'assistant', content: string, ts?: number): ConversationMessage {
  return { role, content, timestamp: ts ?? Date.now() };
}

describe('SessionMemoryExtractor', () => {
  const extractor = new SessionMemoryExtractor();

  test('should return empty summary for no messages', async () => {
    const result = await extractor.extract('sess_001', 'user_001', []);
    expect(result.summary).toBe('空会话');
    expect(result.messageCount).toBe(0);
    expect(result.keywords).toHaveLength(0);
  });

  test('should extract keywords from conversation', async () => {
    const messages = [
      msg('user', 'TypeScript 项目中如何配置 ESLint'),
      msg('assistant', '你可以在 TypeScript 项目中安装 eslint 和相关插件'),
      msg('user', '如何配置 prettier 和 ESLint 一起使用'),
      msg('assistant', '安装 eslint-config-prettier 插件即可'),
    ];

    const result = await extractor.extract('sess_002', 'user_001', messages);
    expect(result.keywords.length).toBeGreaterThan(0);
    // Should include typescript and/or eslint as top keywords
    const keywordsLower = result.keywords.map((k) => k.toLowerCase());
    expect(keywordsLower.some((k) => k.includes('eslint') || k.includes('typescript'))).toBe(true);
  });

  test('should extract action items from user messages', async () => {
    const messages = [
      msg('user', '帮我创建一个新的 React 组件'),
      msg('assistant', '好的，我来帮你创建'),
      msg('user', '请把文件保存到 components 目录'),
      msg('assistant', '已保存'),
    ];

    const result = await extractor.extract('sess_003', 'user_001', messages);
    expect(result.actionItems.length).toBeGreaterThan(0);
  });

  test('should extract user preferences', async () => {
    const messages = [
      msg('user', '我喜欢使用 Tailwind CSS'),
      msg('assistant', '好的，noted'),
      msg('user', '不要使用 class 组件，我偏好函数组件'),
      msg('assistant', '明白'),
    ];

    const result = await extractor.extract('sess_004', 'user_001', messages);
    expect(result.preferences.length).toBeGreaterThan(0);
  });

  test('should build summary with first message and keywords', async () => {
    const messages = [
      msg('user', '如何在 Node.js 中使用 WebSocket'),
      msg('assistant', '可以使用 ws 库来实现 WebSocket 服务端'),
      msg('user', '客户端怎么连接'),
      msg('assistant', '使用浏览器原生 WebSocket API 即可'),
    ];

    const result = await extractor.extract('sess_005', 'user_001', messages);
    expect(result.summary).toContain('WebSocket');
    expect(result.summary).toContain('4轮对话');
    expect(result.messageCount).toBe(4);
  });

  test('should record session timestamps', async () => {
    const t1 = 1000;
    const t2 = 2000;
    const messages = [msg('user', 'hello', t1), msg('assistant', 'hi', t2)];

    const result = await extractor.extract('sess_006', 'user_001', messages);
    expect(result.startedAt).toBe(1000);
    expect(result.endedAt).toBe(2000);
    expect(result.sessionId).toBe('sess_006');
    expect(result.userId).toBe('user_001');
  });

  test('should use LLM extract when available and enough messages', async () => {
    const ext = new SessionMemoryExtractor();
    ext.setLlmExtract(async () => '用户讨论了如何部署 Docker 容器');

    // Need >= 5 messages to trigger LLM
    const messages = [
      msg('user', 'Docker 怎么用'),
      msg('assistant', '使用 docker run 命令'),
      msg('user', '如何写 Dockerfile'),
      msg('assistant', '使用 FROM 指令开始'),
      msg('user', '如何推送镜像'),
      msg('assistant', '使用 docker push'),
    ];

    const result = await ext.extract('sess_007', 'user_001', messages);
    expect(result.summary).toBe('用户讨论了如何部署 Docker 容器');
  });

  test('should fall back to rule summary when LLM fails', async () => {
    const ext = new SessionMemoryExtractor();
    ext.setLlmExtract(async () => {
      throw new Error('LLM unavailable');
    });

    const messages = [
      msg('user', 'Python 基础语法'),
      msg('assistant', '变量声明很简单'),
      msg('user', '循环怎么写'),
      msg('assistant', '使用 for 循环'),
      msg('user', '函数定义'),
      msg('assistant', '使用 def 关键字'),
    ];

    const result = await ext.extract('sess_008', 'user_001', messages);
    // Should still produce a summary (rule-based)
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.summary).not.toBe('空会话');
  });

  describe('extractKeywords', () => {
    test('should extract frequent terms', () => {
      const text = 'React React React Vue Vue Angular';
      const keywords = extractor.extractKeywords(text, 3);
      expect(keywords[0]).toBe('react');
      expect(keywords[1]).toBe('vue');
      expect(keywords[2]).toBe('angular');
    });

    test('should filter stop words', () => {
      const text = 'the a an is are TypeScript and JavaScript';
      const keywords = extractor.extractKeywords(text);
      expect(keywords).not.toContain('the');
      expect(keywords).not.toContain('is');
      expect(keywords.some((k) => k.includes('typescript'))).toBe(true);
    });
  });

  describe('extractPatterns', () => {
    test('should extract Chinese action items', () => {
      const text = '帮我创建一个配置文件\n需要添加数据库连接';
      const patterns = [/(?:帮我|请|需要|要|得)(.{5,40})/g];
      const items = extractor.extractPatterns(text, patterns);
      expect(items.length).toBeGreaterThan(0);
    });

    test('should extract English preferences', () => {
      const text = 'I prefer using TypeScript over JavaScript';
      const patterns = [/(?:i (?:prefer|like|always|usually|want))(.{3,60})/gi];
      const items = extractor.extractPatterns(text, patterns);
      expect(items.length).toBeGreaterThan(0);
    });
  });
});
