# 第11章 安全与多用户系统
> **本章目标**：设计六层纵深防御体系，实现 RBAC 权限控制、容器安全隔离、数据加密和审计日志。
## 11.1 安全架构总览
六层纵深防御：


| 层级 | 名称 | 职责 |
| --- | --- | --- |
| L1 | 认证层 | 签名验证、Token 校验、API Key |
| L2 | 授权层 | RBAC 权限检查、资源访问控制 |
| L3 | 容器隔离 | Docker 文件系统隔离、网络限制 |
| L4 | 数据加密 | AES-256-GCM 加密存储 |
| L5 | 审计日志 | 全操作记录、异常检测 |
| L6 | 速率限制 | 多级限流、配额管理 |


## 11.2 RBAC 权限模型
```typescript
export type Role = 'admin' | 'power_user' | 'standard' | 'guest';

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ['*'],
  power_user: [
    'agent:create', 'agent:execute', 'agent:configure',
    'tool:all', 'file:all', 'memory:all', 'skill:all',
  ],
  standard: [
    'agent:execute', 'tool:safe', 'file:own', 'memory:own', 'skill:use',
  ],
  guest: [
    'agent:execute', 'tool:readonly', 'file:read',
  ],
};
```

## 11.3 用户认证
支持多种认证方式：


| 通道 | 认证方式 | 实现 |
| --- | --- | --- |
| 飞书 | 事件签名验证 | Lark SDK Signature |
| Telegram | Bot Token + User ID | Telegraf Context |
| Web | JWT + Refresh Token | Hono JWT Middleware |
| API | API Key + HMAC | Custom Middleware |


## 11.4 进程级安全隔离
> **安全模型**：基于独立 `cwd` 工作目录 + 环境变量隔离 + Claude CLI 内置权限控制 + 可选 cgroup 资源限制，实现多租户安全隔离。
```typescript
export const PROCESS_SECURITY_CONFIG = {
  /** 工作目录隔离 — 每用户独立目录 */
  workspaceIsolation: true,
  workspaceRoot: '/data/workspaces',
  workspacePermissions: 0o700,  // 仅所有者可读写

  /** 环境变量安全 — 最小化注入原则 */
  envIsolation: true,
  allowedEnvVars: ['ANTHROPIC_API_KEY', 'YOURBOT_SESSION_ID', 'NODE_ENV'],

  /** Claude CLI 权限控制 */
  permissionMode: 'default',  // 'strict' | 'default' | 'permissive'
  disallowedTools: ['computer'],  // 禁止桌面控制工具

  /** 资源限制（可选，需 Linux cgroup v2） */
  resourceLimits: {
    enabled: false,
    maxMemoryMB: 512,
    maxCpuPercent: 50,
    maxProcesses: 100,
    maxOpenFiles: 1024,
  },

  /** 网络策略 */
  networkPolicy: {
    allowOutbound: true,  // Claude CLI 需要访问 Anthropic API
    allowedDomains: ['api.anthropic.com', 'api.openai.com', 'api.moonshot.cn'],
  },
};
```

**隔离架构示意**
```plaintext
┌─────────────────────────────────────────────────┐
│                  Kernel 主进程                    │
│                                                   │
│  ┌─────────────┐  ┌─────────────┐                │
│  │ Session A   │  │ Session B   │  ...           │
│  │ Bun.spawn   │  │ Bun.spawn   │                │
│  └──────┬──────┘  └──────┬──────┘                │
│         │                │                        │
└─────────┼────────────────┼────────────────────────┘
          │                │
   ┌──────▼──────┐  ┌──────▼──────┐
   │ Claude CLI  │  │ Claude CLI  │
   │ PID: 1234   │  │ PID: 1235   │
   │ cwd: /data/ │  │ cwd: /data/ │
   │  ws/userA/  │  │  ws/userB/  │
   │ env: 独立   │  │ env: 独立   │
   └─────────────┘  └─────────────┘

```

**安全检查清单**


| 检查项 | 状态 | 说明 |
| --- | --- | --- |
| 工作目录权限 0700 | 必须 | 防止跨用户文件读取 |
| API Key 仅 env 注入 | 必须 | 不写入 `.env` 文件或配置文件 |
| 子进程超时终止 | 必须 | 防止僵死进程占用资源 |
| `--permission-mode` 配置 | 推荐 | 限制 Agent 可调用的工具范围 |
| cgroup 资源限制 | 可选 | 生产环境建议开启，防止单进程耗尽系统资源 |
| 网络出站白名单 | 可选 | 通过 iptables/nftables 限制出站域名 |


## 11.5 数据加密
采用 AES-256-GCM 加密敏感数据：
```typescript
export class CryptoManager {
  async encrypt(data: string, userId: string): Promise<EncryptedData> {
    const key = await this.deriveKey(userId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key, new TextEncoder().encode(data)
    );
    return { ciphertext: Buffer.from(encrypted), iv, algorithm: 'AES-256-GCM' };
  }
}
```

## 11.6 审计日志系统
所有操作自动记录：
```typescript
export interface AuditLog {
  timestamp: number;
  userId: string;
  action: string;
  resource: string;
  result: 'success' | 'denied' | 'error';
  details: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}
```

## 11.7 速率限制


| 级别 | 对象 | 限制 |
| --- | --- | --- |
| 全局 | 所有请求 | 1000 req/min |
| 用户级 | 单用户 | 60 req/min |
| API 级 | 单 API Key | 100 req/min |
| Agent 级 | 单 Agent | 10 req/min |


---
