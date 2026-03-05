export function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${timestamp}_${random}`;
}

export function generateTraceId(): string {
  return generateId('trace');
}

export function generateTaskId(): string {
  return generateId('task');
}

export function generateSessionId(): string {
  return generateId('sess');
}
