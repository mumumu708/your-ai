export interface StreamEvent {
  type: 'text_delta' | 'tool_use' | 'tool_result' | 'error' | 'done' | 'stream_reset';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  error?: string;
}
