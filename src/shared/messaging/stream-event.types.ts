export interface StreamEvent {
  type: 'text_delta' | 'tool_use' | 'tool_result' | 'error' | 'done';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  error?: string;
}
