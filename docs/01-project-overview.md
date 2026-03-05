# 第1章 项目概览与愿景
> **本章目标**：全面阐述 YourBot 项目的定位、核心能力、设计哲学、技术选型决策过程，以及与市场现有方案的对比分析。为后续所有技术章节奠定上下文基础。
## 1.1 项目定位与愿景
YourBot 是一个**企业级 AI 助手平台**，旨在通过多通道即时通讯集成（飞书、Telegram、Web），为团队和个人提供具备自主执行能力的 AI Agent 服务。与传统的聊天机器人不同，YourBot 中的每个 Agent 都是一个拥有完整工作空间、持久记忆、可扩展工具集的"数字同事"。
### 1.1.1 核心愿景
"让每个团队成员都拥有一个永不下线、持续学习、跨平台协作的 AI 助手"
### 1.1.2 核心能力矩阵


| 能力维度 | 具体能力 | 技术实现 | 优先级 |
| --- | --- | --- | --- |
| **多通道接入** | 飞书群聊/私聊、Telegram Bot、Web 聊天界面 | Channel 适配器模式 | P0 |
| **智能对话** | 上下文感知的多轮对话、意图理解 | Claude API + 上下文窗口管理 | P0 |
| **自主执行** | 代码编写、文件操作、Shell 命令执行 | Claude CLI 子进程沙箱 + MCP Server | P0 |
| **持久记忆** | 跨会话记忆、用户偏好学习 | Markdown 文件 + AIEOS 协议 | P0 |
| **流式响应** | 实时打字机效果、多平台流式适配 | SSE + 卡片更新 + WebSocket | P1 |
| **工具扩展** | MCP Server 动态加载、自定义工具注册 | Model Context Protocol | P1 |
| **安全隔离** | 每用户独立容器、权限分级 | 进程级 Workspace-Per-User 隔离 | P0 |
| **进程管理** | 零停机部署、自动重启、集群模式 | PM2 Ecosystem | P1 |
| **自我进化** | 自主学习新技能、更新自身配置 | SOUL.md + Skills 系统 | P2 |


## 1.2 核心设计哲学
YourBot 的设计建立在六个核心哲学之上，这些哲学贯穿每一个技术决策。
### 1.2.1 Agent as Process
每个 Agent 实例都是一个独立的执行单元，拥有独立的工作空间（文件系统）、独立的工具集（MCP Server 实例）、独立的记忆存储（Markdown 文件）、独立的生命周期（创建 → 运行 → 休眠 → 销毁）。就像操作系统中的进程一样，Agent 之间互不干扰，可以独立调度、独立扩缩容。
```typescript
// Agent 生命周期状态
type AgentLifecycleState =
  | 'initializing' | 'ready' | 'processing'
  | 'tool_executing' | 'streaming' | 'idle'
  | 'suspended' | 'terminated';

// Agent 实例核心接口
interface AgentProcess {
  readonly pid: string;
  readonly userId: string;
  readonly channelId: string;
  readonly mode: 'host' | 'container';
  state: AgentLifecycleState;
  workspace: WorkspaceHandle;
  tools: ToolRegistry;
  memory: MemoryStore;
  createdAt: Date;
  lastActiveAt: Date;
}


```

### 1.2.2 Markdown-First 记忆
所有持久化数据都以 Markdown 文件存储：零依赖（不需要数据库）、人类可读、AI 友好、Git 友好、可移植。
```typescript
// AIEOS 身份文件系统
const AIEOS_FILES = {
  'IDENTITY.md': '定义 Agent 基本身份',
  'SOUL.md': '定义 Agent 性格和行为准则',
  'USER.md': '记录用户偏好和交互历史',
  'AGENTS.md': 'Agent 能力注册表'
};


```

### 1.2.3 Multi-Channel IM Unification
Agent Runtime 完全不感知消息来源。所有平台差异在通道适配器层被消化，Runtime 只处理标准化的 BotMessage 对象。
```typescript
interface BotMessage {
  id: string;
  channelType: 'feishu' | 'telegram' | 'web';
  userId: string;
  conversationId: string;
  content: MessageContent;
  timestamp: number;
}


```

### 1.2.4 Self-Evolution（自我进化）
Agent 可以通过修改自身的配置文件来"进化"：修改 SOUL.md 调整行为模式，更新 AGENTS.md 注册新能力，创建新的 Skill 文件扩展技能。进化边界由权限系统严格控制。
### 1.2.5 Minimal Dependency Surface
整个系统仅依赖 Bun Runtime 和文件系统，核心运行时依赖仅 12 个包，无 Docker 依赖。
### 1.2.6 Defense in Depth
安全贯穿每一层：Layer 1 网关层（请求校验、速率限制）→ Layer 2 控制平面（用户认证、权限检查）→ Layer 3 Agent Runtime（工具白名单、命令过滤）→ Layer 4 进程隔离层（工作目录隔离、资源配额）。
## 1.3 技术选型详细分析
### 1.3.1 运行时：Bun vs Node.js


| 对比维度 | Bun | Node.js | 选择理由 |
| --- | --- | --- | --- |
| **启动速度** | ~50ms | ~200-500ms | Agent 子进程快速启动 |
| **TypeScript** | 原生支持 | 需要 tsx/ts-node | 零配置开发 |
| **文件 I/O** | 快 10x | 标准 | Markdown-First 受益 |
| **WebSocket** | 内置 | 需要 ws 库 | Web 通道原生支持 |
| **兼容性** | Node.js API 兼容 | 生态成熟 | 可用 npm 生态 |


### 1.3.2 Web 框架：Hono
选择 Hono 的关键理由：零依赖（核心 < 14KB gzip）、多运行时支持、完整 TypeScript 类型推导、性能卓越。
### 1.3.3 任务队列：Bunqueue
Bun 原生、内存队列无需 Redis、精确并发控制、优先级支持、超时管理。
### 1.3.4 进程管理：PM2
支持 fork/cluster 模式、内存限制自动重启、定时重启、日志管理。
## 1.4 竞品对比分析


| 特性 | YourBot | Dify | Coze | FastGPT |
| --- | --- | --- | --- | --- |
| **部署** | 私有化 | SaaS/私有化 | SaaS | SaaS/私有化 |
| **通道** | 飞书/TG/Web | API | 飞书/微信/Web | API/飞书 |
| **隔离** | Container-Per-User | 共享进程 | 共享进程 | 共享进程 |
| **记忆** | Markdown 文件 | 向量数据库 | 向量数据库 | 向量数据库 |
| **扩展** | MCP + 技能文件 | 插件市场 | 插件市场 | 插件系统 |
| **自进化** | AIEOS 协议 | 无 | 无 | 无 |
