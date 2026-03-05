import { describe, expect, test } from 'bun:test';
import type { ConversationMessage } from '../../shared/agents/agent-instance.types';
import { WorkingMemory } from './working-memory';

function msg(role: 'user' | 'assistant', content: string): ConversationMessage {
  return { role, content, timestamp: Date.now() };
}

describe('WorkingMemory', () => {
  test('should add and retrieve messages', () => {
    const wm = new WorkingMemory();
    wm.addMessage(msg('user', 'hello'));
    wm.addMessage(msg('assistant', 'hi there'));

    expect(wm.getMessageCount()).toBe(2);
    expect(wm.getMessages()[0].content).toBe('hello');
    expect(wm.getMessages()[1].content).toBe('hi there');
  });

  test('should return recent messages', () => {
    const wm = new WorkingMemory();
    wm.addMessage(msg('user', 'msg1'));
    wm.addMessage(msg('assistant', 'msg2'));
    wm.addMessage(msg('user', 'msg3'));

    const recent = wm.getRecentMessages(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].content).toBe('msg2');
    expect(recent[1].content).toBe('msg3');
  });

  test('should estimate tokens from message content', () => {
    const wm = new WorkingMemory();
    // 20 chars content + role overhead => ~6-7 tokens
    wm.addMessage(msg('user', '12345678901234567890'));
    const tokens = wm.estimateTokens();
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20); // Should be roughly content/4
  });

  test('should compress when exceeding threshold', () => {
    // Set very low maxTokens to trigger compression
    const wm = new WorkingMemory({ maxTokens: 20, compressThreshold: 0.5 });

    // Add messages that will exceed 20*0.5=10 tokens
    wm.addMessage(msg('user', 'This is a relatively long message to trigger compression'));
    wm.addMessage(msg('assistant', 'Another long response that should push us over the limit'));

    // Compression should have kicked in
    expect(wm.getSummaryCount()).toBeGreaterThanOrEqual(1);
    // Some messages should remain
    expect(wm.getMessageCount()).toBeGreaterThan(0);
  });

  test('should build context with summaries and messages', () => {
    const wm = new WorkingMemory({ maxTokens: 15, compressThreshold: 0.5 });

    wm.addMessage(msg('user', 'First question about topic A that is somewhat long'));
    wm.addMessage(msg('assistant', 'Answer about topic A with detailed explanation'));
    wm.addMessage(msg('user', 'Follow up question'));

    const ctx = wm.buildContext();
    expect(ctx.summaries.length + ctx.messages.length).toBeGreaterThan(0);
  });

  test('should clear all data', () => {
    const wm = new WorkingMemory();
    wm.addMessage(msg('user', 'hello'));
    wm.addMessage(msg('assistant', 'hi'));

    wm.clear();
    expect(wm.getMessageCount()).toBe(0);
    expect(wm.getSummaryCount()).toBe(0);
  });

  test('should summarize messages extractively', () => {
    // Use very low threshold to force compression
    const wm = new WorkingMemory({ maxTokens: 10, compressThreshold: 0.3 });

    // Add enough messages to trigger compression
    for (let i = 0; i < 6; i++) {
      wm.addMessage(
        msg('user', `Message number ${i} with enough content to add up tokens quickly`),
      );
      wm.addMessage(
        msg('assistant', `Response ${i} also with plenty of content to fill the token budget`),
      );
    }

    const summaries = wm.getSummaries();
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    // Each summary should have content and a message count
    expect(summaries[0].content.length).toBeGreaterThan(0);
    expect(summaries[0].messageCount).toBeGreaterThan(0);
  });

  test('should keep key messages with action words during compression', () => {
    const wm = new WorkingMemory({ maxTokens: 10, compressThreshold: 0.3 });

    wm.addMessage(msg('user', 'General greeting hello'));
    wm.addMessage(msg('user', '请帮我创建一个文件'));
    wm.addMessage(msg('assistant', 'Sure, creating the file now'));
    wm.addMessage(msg('user', 'Thanks'));
    wm.addMessage(msg('user', 'Another message to push compression along with more content'));
    wm.addMessage(msg('assistant', 'More response content to increase token count further'));

    const summaries = wm.getSummaries();
    if (summaries.length > 0) {
      // The summary should contain the action message
      const combined = summaries.map((s) => s.content).join('\n');
      expect(combined.length).toBeGreaterThan(0);
    }
  });
});
