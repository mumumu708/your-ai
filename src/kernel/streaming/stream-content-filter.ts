import type { StreamEvent } from '../../shared/messaging/stream-event.types';

/**
 * Filtered stream event ready for channel adapters.
 * - append=true: append text to content buffer
 * - append=false: replace status line (tool progress indicator)
 */
export interface FilteredStreamEvent {
  type: 'content' | 'status' | 'error' | 'done';
  text: string;
  append: boolean;
}

/**
 * Filters raw StreamEvents into adapter-friendly FilteredStreamEvents.
 *
 * Responsibilities:
 * - text_delta → content (append)
 * - tool_use → status line with emoji summary (replace)
 * - tool_result → null (suppressed)
 * - error → error content (append)
 * - done → done signal
 *
 * Stateful: tracks current tool status line per stream session.
 */
export class StreamContentFilter {
  private toolStatusLine: string | null;

  constructor() {
    this.toolStatusLine = null;
  }

  filter(event: StreamEvent): FilteredStreamEvent | null {
    switch (event.type) {
      case 'text_delta': {
        // Text content clears any active tool status
        this.toolStatusLine = null;
        if (!event.text) return null;
        return { type: 'content', text: event.text, append: true };
      }

      case 'tool_use': {
        const status = this.summarizeToolStart(event.toolName);
        this.toolStatusLine = status;
        return { type: 'status', text: status, append: false };
      }

      case 'tool_result': {
        // Suppress tool results — content will follow via text_delta
        return null;
      }

      case 'error': {
        this.toolStatusLine = null;
        return {
          type: 'error',
          text: event.error ?? 'Unknown error',
          append: true,
        };
      }

      case 'done': {
        this.toolStatusLine = null;
        return { type: 'done', text: '', append: false };
      }

      case 'stream_reset': {
        this.toolStatusLine = null;
        return { type: 'content', text: '', append: false }; // pass through as content reset
      }

      default:
        return null;
    }
  }

  /** Current tool status line, or null if no tool is active. */
  getToolStatusLine(): string | null {
    return this.toolStatusLine;
  }

  private summarizeToolStart(toolName?: string): string {
    if (!toolName) return '🔧 正在处理...';

    const toolStatusMap: Record<string, string> = {
      memory_search: '🔍 正在搜索记忆...',
      memory_store: '💾 正在保存记忆...',
      session_search: '🔍 正在搜索历史会话...',
      skill_view: '📖 正在加载 Skill...',
      web_search: '🌐 正在搜索网络...',
      Read: '📄 正在读取文件...',
      Edit: '✏️ 正在编辑文件...',
      Write: '✏️ 正在编辑文件...',
      Bash: '⚡ 正在执行命令...',
      Glob: '🔍 正在搜索文件...',
      Grep: '🔍 正在搜索文件...',
    };

    return toolStatusMap[toolName] ?? `🔧 正在使用 ${toolName}...`;
  }
}
