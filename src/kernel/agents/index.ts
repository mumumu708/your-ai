// Agent Bridge — 统一接口
export type {
  ExecutionMode,
  McpServerConfig,
  McpConfig,
  AgentExecuteParams,
  AgentResult,
  AgentBridge,
} from './agent-bridge';

// Fallback 容错包装
export { AgentBridgeWithFallback } from './agent-bridge-fallback';

// Intelligence Gateway — Layer 1 快速预处理
export { IntelligenceGateway } from './intelligence-gateway';
export type { LightLlmCompletable, GatewayHandleParams } from './intelligence-gateway';

// Task Guidance Builder
export { TaskGuidanceBuilder } from './task-guidance-builder';
export type { TaskGuidanceBuildParams } from './task-guidance-builder';

// MCP Config Builder
export { McpConfigBuilder } from './mcp-config-builder';
export type { McpConfigBuildParams } from './mcp-config-builder';
