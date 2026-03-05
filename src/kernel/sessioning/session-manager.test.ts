import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { SessionManager } from './session-manager';

describe('SessionManager', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('应该为未知的 user/channel/conversation 组合创建新会话', async () => {
    const manager = new SessionManager();
    const session = await manager.resolveSession('user_001', 'web', 'conv_001');

    expect(session.id).toMatch(/^sess_/);
    expect(session.userId).toBe('user_001');
    expect(session.channel).toBe('web');
    expect(session.conversationId).toBe('conv_001');
    expect(session.status).toBe('active');
  });

  test('应该为相同 key 复用已存在的活跃会话', async () => {
    const manager = new SessionManager();
    const session1 = await manager.resolveSession('user_001', 'web', 'conv_001');
    const session2 = await manager.resolveSession('user_001', 'web', 'conv_001');

    expect(session1.id).toBe(session2.id);
  });

  test('应该在已有会话过期时创建新会话', async () => {
    const manager = new SessionManager({ sessionTimeoutMs: 1 });
    const session1 = await manager.resolveSession('user_001', 'web', 'conv_001');

    // 等待超时
    await new Promise((resolve) => setTimeout(resolve, 10));

    const session2 = await manager.resolveSession('user_001', 'web', 'conv_001');
    expect(session1.id).not.toBe(session2.id);
  });

  test('应该在会话复用时更新 lastActiveAt', async () => {
    const manager = new SessionManager();
    const session1 = await manager.resolveSession('user_001', 'web', 'conv_001');
    const firstActive = session1.lastActiveAt;

    await new Promise((resolve) => setTimeout(resolve, 10));

    const session2 = await manager.resolveSession('user_001', 'web', 'conv_001');
    expect(session2.lastActiveAt).toBeGreaterThan(firstActive);
  });

  test('应该返回正确的活跃会话计数', async () => {
    const manager = new SessionManager();
    expect(manager.getActiveSessionCount()).toBe(0);

    await manager.resolveSession('user_001', 'web', 'conv_001');
    expect(manager.getActiveSessionCount()).toBe(1);

    await manager.resolveSession('user_002', 'feishu', 'conv_002');
    expect(manager.getActiveSessionCount()).toBe(2);
  });

  test('新建会话应该初始化空消息数组', async () => {
    const manager = new SessionManager();
    const session = await manager.resolveSession('user_001', 'web', 'conv_001');
    expect(session.messages).toEqual([]);
  });

  describe('addMessage', () => {
    test('应该通过 sessionKey 添加消息到会话', async () => {
      const manager = new SessionManager();
      await manager.resolveSession('user_001', 'web', 'conv_001');

      manager.addMessage('user_001:web:conv_001', {
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      });

      const session = manager.getSessionByKey('user_001:web:conv_001');
      expect(session?.messages.length).toBe(1);
      expect(session?.messages[0].content).toBe('Hello');
    });

    test('应该通过 sessionId 添加消息到会话', async () => {
      const manager = new SessionManager();
      const session = await manager.resolveSession('user_001', 'web', 'conv_001');

      manager.addMessage(session.id, {
        role: 'assistant',
        content: 'Hi there',
        timestamp: Date.now(),
      });

      expect(session.messages.length).toBe(1);
      expect(session.messages[0].content).toBe('Hi there');
    });
  });

  describe('getRecentMessages', () => {
    test('应该返回最近的 N 条消息', async () => {
      const manager = new SessionManager();
      const _session = await manager.resolveSession('user_001', 'web', 'conv_001');
      const key = 'user_001:web:conv_001';

      for (let i = 0; i < 5; i++) {
        manager.addMessage(key, {
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now() + i,
        });
      }

      const recent = manager.getRecentMessages(key, 3);
      expect(recent.length).toBe(3);
      expect(recent[0].content).toBe('Message 2');
      expect(recent[2].content).toBe('Message 4');
    });

    test('消息不足时应该返回所有消息', async () => {
      const manager = new SessionManager();
      await manager.resolveSession('user_001', 'web', 'conv_001');
      const key = 'user_001:web:conv_001';

      manager.addMessage(key, {
        role: 'user',
        content: 'Only one',
        timestamp: Date.now(),
      });

      const recent = manager.getRecentMessages(key, 10);
      expect(recent.length).toBe(1);
    });

    test('不存在的 key 应该返回空数组', () => {
      const manager = new SessionManager();
      const recent = manager.getRecentMessages('nonexistent', 5);
      expect(recent).toEqual([]);
    });
  });

  describe('markToolUsed', () => {
    test('应该标记会话已使用工具', async () => {
      const manager = new SessionManager();
      const session = await manager.resolveSession('user_001', 'web', 'conv_001');
      const key = 'user_001:web:conv_001';

      expect(session.hasRecentToolUse).toBeUndefined();

      manager.markToolUsed(key);

      expect(session.hasRecentToolUse).toBe(true);
    });
  });

  describe('closeSession', () => {
    test('应该关闭会话并提取记忆摘要', async () => {
      const manager = new SessionManager();
      const key = 'user_001:web:conv_001';
      await manager.resolveSession('user_001', 'web', 'conv_001');

      manager.addMessage(key, {
        role: 'user',
        content: '帮我配置 TypeScript 项目',
        timestamp: 1000,
      });
      manager.addMessage(key, {
        role: 'assistant',
        content: '好的，我来帮你配置',
        timestamp: 2000,
      });

      const summary = await manager.closeSession(key);

      expect(summary).not.toBeNull();
      expect(summary?.sessionId).toMatch(/^sess_/);
      expect(summary?.userId).toBe('user_001');
      expect(summary?.messageCount).toBe(2);
      expect(summary?.keywords.length).toBeGreaterThan(0);
    });

    test('应该在关闭时调用 onSessionClose 回调', async () => {
      const manager = new SessionManager();
      const key = 'user_001:web:conv_001';
      await manager.resolveSession('user_001', 'web', 'conv_001');

      manager.addMessage(key, { role: 'user', content: 'Hello', timestamp: 1000 });
      manager.addMessage(key, { role: 'assistant', content: 'Hi', timestamp: 2000 });

      let captured: unknown = null;
      manager.setOnSessionClose((summary) => {
        captured = summary;
      });

      await manager.closeSession(key);
      expect(captured).not.toBeNull();
    });

    test('空会话关闭应该返回 null', async () => {
      const manager = new SessionManager();
      const key = 'user_001:web:conv_001';
      await manager.resolveSession('user_001', 'web', 'conv_001');

      const summary = await manager.closeSession(key);
      expect(summary).toBeNull();
    });

    test('不存在的 key 关闭应该返回 null', async () => {
      const manager = new SessionManager();
      const summary = await manager.closeSession('nonexistent');
      expect(summary).toBeNull();
    });
  });
});
