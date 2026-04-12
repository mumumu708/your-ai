import { describe, expect, it } from 'bun:test';

import type { StreamEvent } from '../../shared/messaging/stream-event.types';
import { StreamContentFilter } from './stream-content-filter';

describe('StreamContentFilter', () => {
  it('text_delta → content with append=true', () => {
    const filter = new StreamContentFilter();
    const event: StreamEvent = { type: 'text_delta', text: 'Hello' };

    const result = filter.filter(event);

    expect(result).toEqual({ type: 'content', text: 'Hello', append: true });
  });

  it('text_delta with empty text → null', () => {
    const filter = new StreamContentFilter();
    const event: StreamEvent = { type: 'text_delta', text: '' };

    expect(filter.filter(event)).toBeNull();
  });

  it('text_delta with undefined text → null', () => {
    const filter = new StreamContentFilter();
    const event: StreamEvent = { type: 'text_delta' };

    expect(filter.filter(event)).toBeNull();
  });

  it('tool_use → status with emoji summary', () => {
    const filter = new StreamContentFilter();
    const event: StreamEvent = { type: 'tool_use', toolName: 'memory_search' };

    const result = filter.filter(event);

    expect(result).toEqual({ type: 'status', text: '🔍 正在搜索记忆...', append: false });
  });

  it('tool_use maps known tool names to user-friendly messages', () => {
    const filter = new StreamContentFilter();

    const cases: Array<[string, string]> = [
      ['memory_search', '🔍 正在搜索记忆...'],
      ['memory_store', '💾 正在保存记忆...'],
      ['session_search', '🔍 正在搜索历史会话...'],
      ['skill_view', '📖 正在加载 Skill...'],
      ['web_search', '🌐 正在搜索网络...'],
      ['Read', '📄 正在读取文件...'],
      ['Edit', '✏️ 正在编辑文件...'],
      ['Write', '✏️ 正在编辑文件...'],
      ['Bash', '⚡ 正在执行命令...'],
      ['Glob', '🔍 正在搜索文件...'],
      ['Grep', '🔍 正在搜索文件...'],
    ];

    for (const [toolName, expected] of cases) {
      const result = filter.filter({ type: 'tool_use', toolName });
      expect(result?.text).toBe(expected);
    }
  });

  it('memory_store → save memory status', () => {
    const filter = new StreamContentFilter();
    const result = filter.filter({ type: 'tool_use', toolName: 'memory_store' });
    expect(result).toEqual({ type: 'status', text: '💾 正在保存记忆...', append: false });
  });

  it('session_search → search history status', () => {
    const filter = new StreamContentFilter();
    const result = filter.filter({ type: 'tool_use', toolName: 'session_search' });
    expect(result).toEqual({ type: 'status', text: '🔍 正在搜索历史会话...', append: false });
  });

  it('tool_use with unknown tool name → default message', () => {
    const filter = new StreamContentFilter();
    const event: StreamEvent = { type: 'tool_use', toolName: 'custom_tool' };

    const result = filter.filter(event);

    expect(result).toEqual({ type: 'status', text: '🔧 正在使用 custom_tool...', append: false });
  });

  it('tool_use with no tool name → generic message', () => {
    const filter = new StreamContentFilter();
    const event: StreamEvent = { type: 'tool_use' };

    const result = filter.filter(event);

    expect(result).toEqual({ type: 'status', text: '🔧 正在处理...', append: false });
  });

  it('tool_result → null (suppressed)', () => {
    const filter = new StreamContentFilter();
    const event: StreamEvent = { type: 'tool_result', text: 'some result' };

    expect(filter.filter(event)).toBeNull();
  });

  it('error → error content with append=true', () => {
    const filter = new StreamContentFilter();
    const event: StreamEvent = { type: 'error', error: 'Something failed' };

    const result = filter.filter(event);

    expect(result).toEqual({ type: 'error', text: 'Something failed', append: true });
  });

  it('error with no error message → "Unknown error"', () => {
    const filter = new StreamContentFilter();
    const event: StreamEvent = { type: 'error' };

    const result = filter.filter(event);

    expect(result).toEqual({ type: 'error', text: 'Unknown error', append: true });
  });

  it('done → done signal', () => {
    const filter = new StreamContentFilter();
    const event: StreamEvent = { type: 'done' };

    const result = filter.filter(event);

    expect(result).toEqual({ type: 'done', text: '', append: false });
  });

  it('multiple tool_use events → only last status line kept', () => {
    const filter = new StreamContentFilter();

    filter.filter({ type: 'tool_use', toolName: 'Read' });
    expect(filter.getToolStatusLine()).toBe('📄 正在读取文件...');

    filter.filter({ type: 'tool_use', toolName: 'Bash' });
    expect(filter.getToolStatusLine()).toBe('⚡ 正在执行命令...');
  });

  it('text_delta after tool_use → clears status line', () => {
    const filter = new StreamContentFilter();

    filter.filter({ type: 'tool_use', toolName: 'Read' });
    expect(filter.getToolStatusLine()).toBe('📄 正在读取文件...');

    filter.filter({ type: 'text_delta', text: 'Response text' });
    expect(filter.getToolStatusLine()).toBeNull();
  });

  it('error clears status line', () => {
    const filter = new StreamContentFilter();

    filter.filter({ type: 'tool_use', toolName: 'Bash' });
    expect(filter.getToolStatusLine()).not.toBeNull();

    filter.filter({ type: 'error', error: 'fail' });
    expect(filter.getToolStatusLine()).toBeNull();
  });

  it('done clears status line', () => {
    const filter = new StreamContentFilter();

    filter.filter({ type: 'tool_use', toolName: 'Bash' });
    expect(filter.getToolStatusLine()).not.toBeNull();

    filter.filter({ type: 'done' });
    expect(filter.getToolStatusLine()).toBeNull();
  });

  it('unknown event type → null (default branch)', () => {
    const filter = new StreamContentFilter();
    // Cast to bypass type-checking — exercises the default branch of the switch
    const event = { type: 'unknown_event_type' } as unknown as Parameters<typeof filter.filter>[0];

    expect(filter.filter(event)).toBeNull();
  });

  it('full stream session: text → tool → tool_result → text → done', () => {
    const filter = new StreamContentFilter();
    const results: Array<ReturnType<typeof filter.filter>> = [];

    // Initial text
    results.push(filter.filter({ type: 'text_delta', text: 'Let me check...' }));
    // Tool call
    results.push(filter.filter({ type: 'tool_use', toolName: 'memory_search' }));
    // Tool result (suppressed)
    results.push(filter.filter({ type: 'tool_result', text: 'found 3 memories' }));
    // Response text
    results.push(filter.filter({ type: 'text_delta', text: 'Based on your memories...' }));
    // Done
    results.push(filter.filter({ type: 'done' }));

    expect(results).toEqual([
      { type: 'content', text: 'Let me check...', append: true },
      { type: 'status', text: '🔍 正在搜索记忆...', append: false },
      null,
      { type: 'content', text: 'Based on your memories...', append: true },
      { type: 'done', text: '', append: false },
    ]);
  });
});
