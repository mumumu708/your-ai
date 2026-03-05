export interface TaskResult {
  success: boolean;
  taskId: string;
  data?: unknown;
  error?: string;
  completedAt: number;
}
