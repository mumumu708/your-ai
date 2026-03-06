# AI 助手记忆系统设计 v2.4 — 基于 OpenViking + Bun/TypeScript + AIEOS 协议的渐进式增强方案

## 一、项目概述

### 1.1 设计目标

构建一个从零开始的 AI 助手记忆系统，使其具备跨会话的长期记忆能力。系统以 OpenViking Server 作为记忆基座，Bun + Hono + TypeScript 作为核心运行时，通过自研轻量 TypeScript SDK 与 OpenViking HTTP API 交互，结合 AIEOS 协议文件管理实现持久化身份与记忆，在其上扩展记忆进化引擎与轻量图谱。

### 1.2 核心原则

| 原则 | 说明 |
|------|------|
| **OpenViking 基座** | 复用 OpenViking 的存储、检索、会话管理能力，通过 HTTP API 集成 |
| **Bun + TypeScript** | 核心服务使用 Bun 运行时 + Hono 框架，全链路 TypeScript |
| **AIEOS 协议** | 文件优先的身份管理——SOUL.md / IDENTITY.md / USER.md / AGENTS.md |
| **单机轻量** | 纯本地部署，不引入外部服务依赖 |
| **远程模型服务** | 火山引擎豆包 Embedding/VLM/Rerank，零 GPU 门槛 |
| **ROI 驱动** | 渐进式实现，每阶段交付可用能力 |
| **从零构建** | 不依赖第三方 Agent 框架，OpenClaw 等仅作调研参考 |

### 1.3 核心技术栈

| 技术 | 选型 | 用途 |
|------|------|------|
| **Runtime** | Bun | 高性能 TypeScript 运行时，原生 TS 支持，~50ms 启动 |
| **Web 框架** | Hono | 零依赖（<14KB），多运行时支持，完整类型推导 |
| **AI 引擎** | Claude API (Anthropic) | 多轮对话推理，Agent SDK 集成 |
| **记忆基座** | OpenViking Server | HTTP API 模式，独立进程运行 |
| **Embedding** | doubao-embedding-vision (火山引擎) | 远程多模态 Dense 向量，1024 维 |
| **VLM (摘要)** | doubao-seed-1-8 (火山引擎) | 远程旗舰模型，L0/L1 摘要生成 |
| **Reranker** | doubao-rerank (火山引擎) | 远程检索精排 |
| **身份管理** | AIEOS 协议 | 4 个 Markdown 文件定义身份、规则、用户画像 |
| **任务队列** | Bunqueue | Bun 原生内存队列，记忆进化异步任务 |
| **进程管理** | PM2 | fork/cluster 模式，管理全部 3 个进程 |

### 1.4 调研背景

本设计综合参考了以下系统的核心思路：

- **OpenClaw**：文件优先理念、AIEOS 协议文件管理、Pre-Compaction Memory Flush 机制
- **Mem0 / Zep / Letta**：记忆分层、图谱增强、上下文压缩的工业实践
- **A-Mem（NeurIPS 2025）**：Zettelkasten 原子化记忆、自进化网络、动态链接
- **OpenViking**：文件系统范式、L0/L1/L2 三层上下文、层级递归检索、会话记忆自动提取
- **AGENTS.md 开放标准**：AI Agent 指令文件管理的行业实践

以上均为调研输入，本系统从零构建，不直接依赖上述项目代码。

---

## 二、系统架构

### 2.1 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│              AI Assistant (Bun + Hono + TypeScript)           │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Hono Routes · Claude API · Agent SDK · Bunqueue      │  │
│  └─────────────────────────┬─────────────────────────────┘  │
│  ┌─────────────────────────▼─────────────────────────────┐  │
│  │         AIEOS Protocol Layer（自研 TS）                 │  │
│  │  ┌────────────┬──────────┬──────────┬───────────────┐ │  │
│  │  │ SOUL.md    │IDENTITY  │ USER.md  │ AGENTS.md     │ │  │
│  │  │ 内核宪法    │.md 人格   │ 用户画像  │ 运行手册      │ │  │
│  │  └────────────┴──────────┴──────────┴───────────────┘ │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │         Memory Evolution Layer（自研 TS）               │  │
│  │  ┌──────────┬──────────┬──────────┬─────────────┐    │  │
│  │  │ Reflect  │  Link    │ Evolve   │  Compress   │    │  │
│  │  │ 反思提炼  │ 关联发现  │ 合并进化  │ 上下文压缩  │    │  │
│  │  └──────────┴──────────┴──────────┴─────────────┘    │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │         Light Graph Extension（自研 TS）                │  │
│  │  ┌──────────────────────────────────────────────┐    │  │
│  │  │  Entity · Relation · Entity-Memory Links     │    │  │
│  │  └──────────────────────────────────────────────┘    │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │     openviking-client（自研 TypeScript SDK）           │  │
│  │  ┌──────────────────────────────────────────────┐    │  │
│  │  │  HTTP 封装 · 类型安全 · 错误处理 · 重试       │    │  │
│  │  └──────────────────────┬───────────────────────┘    │  │
│  └─────────────────────────┼─────────────────────────────┘  │
└─────────────────────────────┼───────────────────────────────┘
                              │ HTTP (localhost:1933)
┌─────────────────────────────▼───────────────────────────────┐
│              OpenViking Server（独立 Python 进程）            │
│  ┌────────────┬────────────┬────────────┬─────────────┐    │
│  │  VikingFS  │  Session   │  Retrieval │  Extract    │    │
│  │  虚拟文件   │  会话管理   │  混合检索   │  资源解析   │    │
│  │  L0/L1/L2  │  记忆提取   │  Dense+    │  AST提取   │    │
│  │  AGFS      │  去重决策   │  Sparse+   │  多格式    │    │
│  │            │            │  Rerank    │            │    │
│  └────────────┴────────────┴────────────┴─────────────┘    │
│  ┌────────────────────┬───────────────────────────────┐    │
│  │ AGFS (LocalFS)     │ VectorDB (Local sqlite-vec)   │    │
│  └────────────────────┴───────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │ HTTPS (ark.cn-beijing.volces.com)
┌─────────────────────────────▼───────────────────────────────┐
│         火山引擎 Ark API（远程模型服务）                       │
│  ┌───────────────┬────────────────┬───────────────────┐   │
│  ┌──────────────────────────────────────────────────┐   │
│  │  火山引擎 Ark API (Cloud)                         │   │
│  │  Embedding + VLM + Rerank                         │   │
│  │  Embedding 模型   │  语义摘要生成                    │   │
│  └──────────────────┴──────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 进程架构（PM2）

三个进程通过 localhost HTTP 通信，PM2 统一管理：

```javascript
// ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "ai-assistant",
      script: "bun",
      args: "run src/index.ts",
      cwd: "./ai-assistant",
      env: {
        PORT: "3000",
        OPENVIKING_URL: "http://localhost:1933",
        VOLCENGINE_API_KEY: process.env.VOLCENGINE_API_KEY
      }
    },
    {
      name: "openviking",
      script: "openviking",
      args: "serve --host 0.0.0.0 --port 1933 --config ./ov.conf",
      cwd: "./openviking-data"
    },
    {
      // Ollama 已移除 — v2.4 使用火山引擎远程 API
      // name: "ollama",
      // script: "ollama",
      env: {
        OLLAMA_HOST: "0.0.0.0:11434"
      }
    }
  ]
};
```

**启动命令**：

```bash
pm2 start ecosystem.config.cjs
pm2 status   # 查看三个进程状态
pm2 logs     # 查看聚合日志
```

### 2.3 架构分层职责

| 层级 | 职责 | 语言/框架 | 通信方式 |
|------|------|-----------|----------|
| **应用层** | 对话管理、Prompt 编排、工具调用 | TypeScript / Bun + Hono | — |
| **AIEOS 协议层** | 身份定义、用户画像、运行规则 | TypeScript + Markdown 文件 | 进程内 |
| **记忆进化层** | Reflect / Link / Evolve / Compress | TypeScript | 进程内 |
| **轻量图谱层** | 实体/关系/Entity-Memory 关联 | TypeScript | 进程内 |
| **OpenViking SDK** | HTTP Client 封装，类型安全 | TypeScript | HTTP → OpenViking |
| **OpenViking Server** | 存储、检索、会话、记忆提取 | Python (独立进程) | HTTP :1933 |
| **火山引擎 Ark API** | Embedding + VLM + Rerank | 远程服务 | HTTPS :443 |

### 2.4 数据流

```
用户请求 (HTTP :3000)
    │
    ▼
┌──────────────────────────────────┐
│  Hono Router (TypeScript)        │
│  解析请求 → 路由到对话处理器       │
└──────────────┬───────────────────┘
               │
    ┌──────────▼──────────┐
    │  AIEOS ConfigLoader  │
    │  加载 SOUL/IDENTITY  │
    │  /USER/AGENTS        │
    └──────────┬──────────┘
               │
    ┌──────────▼──────────┐
    │  Session Manager     │
    │  创建/恢复会话        │
    └──────────┬──────────┘
               │
    ┌──────────▼──────────┐      HTTP      ┌──────────────────┐
    │  Memory Retriever    │ ──────────────▶│  OpenViking      │
    │  检索相关记忆         │ ◀──────────────│  find() / search()│
    └──────────┬──────────┘               └──────────────────┘
               │
    ┌──────────▼──────────┐
    │  Context Builder     │
    │  AIEOS + 记忆 + 对话  │
    │  Token 预算管理       │
    └──────────┬──────────┘
               │
    ┌──────────▼──────────┐      HTTP      ┌──────────────────┐
    │  Claude API          │ ──────────────▶│  Anthropic API   │
    │  多轮对话推理         │ ◀──────────────│                  │
    └──────────┬──────────┘               └──────────────────┘
               │
    ┌──────────▼──────────┐      HTTP      ┌──────────────────┐
    │  Session Commit      │ ──────────────▶│  OpenViking      │
    │  ov.commit()         │ ◀──────────────│  记忆提取+去重     │
    └──────────┬──────────┘               └──────────────────┘
               │
    ┌──────────▼──────────┐
    │  Bunqueue (异步)     │
    │  记忆进化: Reflect    │
    │  关联发现: Link       │
    │  冲突处理: Evolve     │
    └─────────────────────┘
```

---

## 三、OpenViking Server 集成方案

### 3.1 为什么选择 Server 模式

| 方案 | 可行性 | 说明 |
|------|--------|------|
| ~~Standalone 嵌入~~ | ❌ 不可行 | 仅支持 Python import，与 Bun/TS 技术栈不兼容 |
| **Server HTTP 模式** | ✅ 推荐 | OpenViking 提供完整 REST API（约 37 个端点），语言无关 |

**HTTP Server 模式的优势**：

1. **语言无关** — TypeScript 通过标准 fetch 调用，零适配成本
2. **进程隔离** — OpenViking 崩溃不影响主服务，PM2 自动重启
3. **功能完整** — 全部 37 个 API 端点，覆盖所有功能
4. **延迟极低** — localhost HTTP 仅 ~1-5ms 额外开销

### 3.2 OpenViking Server 配置

#### ov.conf

```json
{
  "storage": {
    "workspace": "./memory-data",
    "agfs": {
      "mode": "binding-client",
      "backend": "local"
    },
    "vectordb": {
      "backend": "local",
      "name": "memory_context",
      "distance_metric": "cosine"
    }
  },
  "embedding": {
    "max_concurrent": 10,
    "dense": {
      "provider": "volcengine",
      "api_key": "${VOLCENGINE_API_KEY}",
      "api_base": "https://ark.cn-beijing.volces.com/api/v3",
      "model": "doubao-embedding-vision-250615",
      "dimension": 1024,
      "input": "multimodal"
    },
    "sparse": {
      "provider": "volcengine",
      "api_key": "${VOLCENGINE_API_KEY}",
      "model": "bm25-sparse-v1"
    }
  },
  "vlm": {
    "provider": "volcengine",
    "api_key": "${VOLCENGINE_API_KEY}",
    "api_base": "https://ark.cn-beijing.volces.com/api/v3",
    "model": "doubao-seed-1-8-251228",
    "temperature": 0.1,
    "max_retries": 3,
    "max_concurrent": 100
  },
  "rerank": {
    "provider": "volcengine",
    "api_key": "${VOLCENGINE_API_KEY}",
    "model": "doubao-rerank-250615"
  },
  "code": {
    "code_summary_mode": "ast"
  },
  "server": {
    "host": "127.0.0.1",
    "port": 1933
  }
}
```

**配置要点**：

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `server.host` | `127.0.0.1` | 仅监听本地，不暴露外网 |
| `server.port` | `1933` | OpenViking 默认端口 |
| `embedding.dense.provider` | `volcengine` | 使用火山引擎远程 Embedding |
| `embedding.dense.model` | `doubao-embedding-vision-250615` | 多模态 Embedding 模型，1024 维 |
| `vlm.provider` | `volcengine` | 使用火山引擎远程 VLM |
| `rerank.provider` | `volcengine` | 使用火山引擎远程 Reranker |
| `agfs.backend` | `local` | 纯本地文件系统 |
| `vectordb.backend` | `local` | sqlite-vec 本地向量库 |
| `embedding.dense` | doubao-embedding-vision via 火山引擎 | 远程多模态 Embedding API |

#### 启动命令

```bash
# 安装 OpenViking
pip install openviking

# 启动 Server
openviking serve --host 127.0.0.1 --port 1933 --config ./ov.conf

# 健康检查
curl http://localhost:1933/health
# {"status": "ok"}
```

### 3.3 OpenViking HTTP API 全览

| 类别 | 方法 | 端点 | 说明 |
|------|------|------|------|
| **系统** | GET | `/health` | 存活探针 |
| | GET | `/ready` | 就绪探针（含异步任务状态） |
| | GET | `/api/v1/status` | 系统详细状态 |
| **资源** | POST | `/api/v1/resources` | 添加资源（自动生成 L0/L1/L2） |
| **文件系统** | GET | `/api/v1/fs/abstract` | 读取 L0 摘要 |
| | GET | `/api/v1/fs/overview` | 读取 L1 概览 |
| | GET | `/api/v1/fs/read` | 读取 L2 完整内容 |
| | GET | `/api/v1/fs/ls` | 列出目录内容 |
| | GET | `/api/v1/fs/tree` | 递归目录树 |
| | GET | `/api/v1/fs/stat` | 文件/目录元信息 |
| | POST | `/api/v1/fs/mkdir` | 创建目录 |
| | DELETE | `/api/v1/fs` | 删除文件/目录 |
| | POST | `/api/v1/fs/mv` | 移动/重命名 |
| **检索** | POST | `/api/v1/search/find` | 语义搜索（意图分析+层级递归+Rerank） |
| | POST | `/api/v1/search/search` | 直接向量搜索 |
| | POST | `/api/v1/search/grep` | 正则搜索 |
| | POST | `/api/v1/search/glob` | 模式匹配 |
| **关系** | GET | `/api/v1/fs/relations` | 查询关联关系 |
| | POST | `/api/v1/fs/link` | 创建关联 |
| | POST | `/api/v1/fs/unlink` | 解除关联 |
| **会话** | POST | `/api/v1/sessions` | 创建会话 |
| | GET | `/api/v1/sessions` | 列出会话 |
| | GET | `/api/v1/sessions/:id` | 获取会话详情 |
| | DELETE | `/api/v1/sessions/:id` | 删除会话 |
| | POST | `/api/v1/sessions/:id/messages` | 添加消息 |
| | POST | `/api/v1/sessions/:id/commit` | 提交会话（触发记忆提取） |

### 3.4 Viking URI 目录规划

```
viking://
├── agent/
│   ├── config/                 # AIEOS 协议文件
│   │   ├── SOUL.md
│   │   ├── IDENTITY.md
│   │   ├── USER.md
│   │   └── AGENTS.md
│   ├── skills/                 # Agent 技能
│   └── graph/                  # 轻量图谱数据（自研扩展）
│       ├── entities/           # 实体文件
│       └── relations/          # 关系索引
├── user/
│   └── memories/               # 记忆存储（核心）
│       ├── facts/              # 事实记忆
│       ├── preferences/        # 偏好记忆
│       ├── procedures/         # 流程记忆
│       ├── episodic/           # 情景记忆
│       ├── semantic/           # 语义记忆
│       └── meta/               # 元记忆
├── resources/                  # 用户上传的知识库资源
│   ├── docs/
│   ├── code/
│   └── media/
└── sessions/                   # 会话历史
```

---

## 四、自研 TypeScript SDK（openviking-client）

### 4.1 设计目标

| 目标 | 说明 |
|------|------|
| 类型安全 | 全部请求/响应有 TypeScript 类型定义 |
| 零依赖 | 仅使用 Bun 原生 fetch，无第三方 HTTP 库 |
| 错误处理 | 统一异常类，区分网络错误/业务错误 |
| 可重试 | 内置指数退避重试（可选） |
| 体积 | ~300-500 行 TypeScript |

### 4.2 类型定义

```typescript
// types.ts

/** OpenViking 客户端配置 */
export interface OVConfig {
  baseUrl: string;           // 默认 http://localhost:1933
  apiKey?: string;           // 可选，开发模式不需要
  timeout?: number;          // 请求超时(ms)，默认 30000
  retries?: number;          // 重试次数，默认 2
}

/** 统一响应 */
export interface OVResponse<T> {
  status: "ok" | "error";
  result?: T;
  error?: { code: string; message: string };
  time: number;
}

/** 检索选项 */
export interface FindOptions {
  query: string;
  target_uri?: string;       // 搜索范围，默认 viking://
  limit?: number;            // 返回数量，默认 10
  score_threshold?: number;  // 最低分数阈值
}

/** 检索结果 */
export interface FindResult {
  uri: string;
  context_type: "resource" | "memory" | "skill";
  abstract: string;
  score: number;
  match_reason: string;
}

/** 上下文匹配 */
export interface MatchedContext {
  uri: string;
  content: string;
  level: "L0" | "L1" | "L2";
  score: number;
}

/** 会话 */
export interface Session {
  id: string;
  created_at: string;
  properties: Record<string, unknown>;
  message_count: number;
}

/** 文件条目 */
export interface FileEntry {
  name: string;
  uri: string;
  type: "file" | "directory";
  size?: number;
  modified?: string;
}

/** 关系 */
export interface Relation {
  uri: string;
  reason: string;
  created_at: string;
}

/** 记忆类型 */
export type MemoryCategory =
  | "facts"
  | "preferences"
  | "procedures"
  | "episodic"
  | "semantic"
  | "meta";
```

### 4.3 客户端实现

```typescript
// openviking-client.ts

import type {
  OVConfig, OVResponse, FindOptions, FindResult,
  Session, FileEntry, Relation,
} from "./types";

export class OVError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "OVError";
  }
}

export class OpenVikingClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeout: number;
  private retries: number;

  constructor(config: OVConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.timeout = config.timeout ?? 30_000;
    this.retries = config.retries ?? 2;
    this.headers = {
      "Content-Type": "application/json",
      ...(config.apiKey ? { "X-API-Key": config.apiKey } : {}),
    };
  }

  // ─── 底层请求 ───────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);

        const res = await fetch(url.toString(), {
          method,
          headers: this.headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timer);
        const json = (await res.json()) as OVResponse<T>;

        if (json.status === "error") {
          throw new OVError(
            json.error?.code ?? "UNKNOWN",
            json.error?.message ?? "Unknown error",
            res.status,
          );
        }

        return json.result as T;
      } catch (err) {
        lastError = err as Error;
        if (err instanceof OVError && err.status && err.status < 500) {
          throw err; // 4xx 不重试
        }
        if (attempt < this.retries) {
          await new Promise((r) =>
            setTimeout(r, Math.pow(2, attempt) * 200),
          );
        }
      }
    }

    throw lastError ?? new Error("Request failed");
  }

  // ─── 系统 ───────────────────────────────────────

  async health(): Promise<{ status: string }> {
    return this.request("GET", "/health");
  }

  async ready(): Promise<{ ready: boolean; pending: number }> {
    return this.request("GET", "/ready");
  }

  async status(): Promise<Record<string, unknown>> {
    return this.request("GET", "/api/v1/status");
  }

  async waitProcessed(timeoutSec = 60): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutSec * 1000) {
      const { ready, pending } = await this.ready();
      if (ready && pending === 0) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new OVError("TIMEOUT", "Wait for processing timed out");
  }

  // ─── 资源 ───────────────────────────────────────

  async addResource(
    content: string,
    options?: { uri?: string; format?: string },
  ): Promise<{ uri: string }> {
    return this.request("POST", "/api/v1/resources", { content, ...options });
  }

  // ─── 文件系统 ───────────────────────────────────

  async abstract(uri: string): Promise<string> {
    return this.request("GET", "/api/v1/fs/abstract", undefined, { uri });
  }

  async overview(uri: string): Promise<string> {
    return this.request("GET", "/api/v1/fs/overview", undefined, { uri });
  }

  async read(uri: string): Promise<string> {
    return this.request("GET", "/api/v1/fs/read", undefined, { uri });
  }

  async ls(uri: string): Promise<FileEntry[]> {
    return this.request("GET", "/api/v1/fs/ls", undefined, { uri });
  }

  async tree(uri: string, depth = 3): Promise<string> {
    return this.request("GET", "/api/v1/fs/tree", undefined, {
      uri, depth: String(depth),
    });
  }

  async stat(uri: string): Promise<Record<string, unknown>> {
    return this.request("GET", "/api/v1/fs/stat", undefined, { uri });
  }

  async mkdir(uri: string): Promise<void> {
    await this.request("POST", "/api/v1/fs/mkdir", { uri });
  }

  async write(uri: string, content: string): Promise<void> {
    await this.request("POST", "/api/v1/resources", { content, uri });
  }

  async rm(uri: string): Promise<void> {
    await this.request("DELETE", "/api/v1/fs", undefined, { uri });
  }

  async mv(fromUri: string, toUri: string): Promise<void> {
    await this.request("POST", "/api/v1/fs/mv", { from: fromUri, to: toUri });
  }

  // ─── 检索 ───────────────────────────────────────

  async find(options: FindOptions): Promise<FindResult[]> {
    return this.request("POST", "/api/v1/search/find", {
      query: options.query,
      target_uri: options.target_uri ?? "viking://",
      limit: options.limit ?? 10,
      score_threshold: options.score_threshold,
    });
  }

  async search(options: FindOptions): Promise<FindResult[]> {
    return this.request("POST", "/api/v1/search/search", {
      query: options.query,
      target_uri: options.target_uri ?? "viking://",
      limit: options.limit ?? 10,
    });
  }

  async grep(
    pattern: string, scope?: string,
  ): Promise<{ uri: string; matches: string[] }[]> {
    return this.request("POST", "/api/v1/search/grep", {
      pattern, target_uri: scope ?? "viking://",
    });
  }

  // ─── 关系 ───────────────────────────────────────

  async link(
    fromUri: string, uris: string[], reason: string,
  ): Promise<void> {
    await this.request("POST", "/api/v1/fs/link", {
      from_uri: fromUri, uris, reason,
    });
  }

  async relations(uri: string): Promise<Relation[]> {
    return this.request("GET", "/api/v1/fs/relations", undefined, { uri });
  }

  async unlink(fromUri: string, uris: string[]): Promise<void> {
    await this.request("POST", "/api/v1/fs/unlink", {
      from_uri: fromUri, uris,
    });
  }

  // ─── 会话 ───────────────────────────────────────

  async createSession(
    properties?: Record<string, unknown>,
  ): Promise<Session> {
    return this.request("POST", "/api/v1/sessions", { properties });
  }

  async listSessions(): Promise<Session[]> {
    return this.request("GET", "/api/v1/sessions");
  }

  async getSession(id: string): Promise<Session> {
    return this.request("GET", `/api/v1/sessions/${id}`);
  }

  async deleteSession(id: string): Promise<void> {
    await this.request("DELETE", `/api/v1/sessions/${id}`);
  }

  async addMessage(
    sessionId: string,
    role: "user" | "assistant" | "system",
    content: string,
  ): Promise<void> {
    await this.request(
      "POST",
      `/api/v1/sessions/${sessionId}/messages`,
      { role, content },
    );
  }

  async commit(sessionId: string): Promise<{ memories_extracted: number }> {
    return this.request("POST", `/api/v1/sessions/${sessionId}/commit`);
  }
}
```

### 4.4 使用示例

```typescript
import { OpenVikingClient } from "./openviking-client";

const ov = new OpenVikingClient({ baseUrl: "http://localhost:1933" });

// 健康检查
await ov.health(); // { status: "ok" }

// 创建会话 → 添加消息 → 提交 → 自动记忆提取
const session = await ov.createSession({ topic: "记忆系统设计" });
await ov.addMessage(session.id, "user", "帮我设计一个记忆系统");
await ov.addMessage(session.id, "assistant", "好的，我来帮你设计...");
const result = await ov.commit(session.id);
console.log(`提取了 ${result.memories_extracted} 条记忆`);

// 检索记忆
const memories = await ov.find({
  query: "记忆系统架构",
  target_uri: "viking://user/memories",
  limit: 10,
});

// 渐进式加载
for (const m of memories) {
  const l0 = await ov.abstract(m.uri);  // ~100 tokens
  const l1 = await ov.overview(m.uri);  // ~2k tokens
  const l2 = await ov.read(m.uri);      // 完整内容
}
```

---
## 五、远程模型服务：Embedding、VLM、Reranker 的统一接入

> **v2.4 重大变更**：v2.3 采用 Ollama 本地部署 BGE-M3/Qwen3:8B 等模型，v2.4 改为**火山引擎远程模型服务**——Embedding 使用 `doubao-embedding-vision-250615`，VLM 使用 `doubao-seed-1-8-251228`，Reranker 使用 `doubao-rerank-250615`。本地不再需要部署 Ollama 和任何模型，大幅降低硬件要求。

### 5.1 为什么改用远程模型

| 维度 | 本地 Ollama 方案（v2.3） | 火山引擎远程方案（v2.4） |
|------|--------------------------|-------------------------|
| **硬件要求** | 16 GB+ VRAM / GPU 必备 | 无 GPU 要求，普通服务器即可 |
| **部署复杂度** | 需安装 Ollama + 下载 3 个模型（~8 GB） | 零部署，开通 API 即用 |
| **维护成本** | 需管理 Ollama 进程、模型更新、资源竞争 | 零维护，火山引擎自动扩缩容 |
| **推理延迟** | GPU: ~5-15ms/条，CPU: ~50-200ms/条 | API: ~30-80ms/条（网络延迟） |
| **并发能力** | 受限于本地 GPU 显存 | 弹性扩展，`max_concurrent` 可达 100 |
| **模型能力** | BGE-M3 (568M)、Qwen3:8B | 豆包 Embedding（多模态）、Doubao-Seed-1.8（更强） |
| **多模态** | ❌ BGE-M3 不支持图片 | ✅ `doubao-embedding-vision` 支持文本+图片混合 Embedding |
| **成本结构** | 前期硬件投入高，运行时免费 | 按量付费，前期零投入 |
| **离线可用** | ✅ 完全离线 | ❌ 需网络连接 |

**选择远程方案的核心理由**：

1. **零 GPU 门槛** — 不需要购买和维护 GPU 硬件，任何能上网的服务器均可运行
2. **模型更强** — 豆包模型持续迭代，能力优于本地小模型
3. **多模态 Embedding** — `doubao-embedding-vision` 可同时处理文本和图片，未来可扩展图片记忆
4. **运维为零** — 不再需要管理 Ollama 进程、处理 OOM、调整模型加载策略
5. **架构简化** — PM2 从管理 3 个进程简化为 2 个（去掉 Ollama）

### 5.2 火山引擎模型服务概览

OpenViking 原生支持火山引擎（`provider: "volcengine"`），只需在 `ov.conf` 中配置 API Key 即可接入全部模型[[配置指南]](https://github.com/volcengine/OpenViking/blob/main/docs/zh/guides/01-configuration.md)。

#### 需要开通的模型

| 模型类型 | 模型 ID | 用途 | 输入类型 | 维度 |
|----------|---------|------|---------|------|
| **Embedding** | `doubao-embedding-vision-250615` | 向量化、语义检索 | 多模态（文本+图片） | 1024 |
| **Embedding (Sparse)** | `bm25-sparse-v1` | 稀疏向量、关键词匹配 | 文本 | — |
| **VLM** | `doubao-seed-1-8-251228` | L0/L1 摘要生成、语义提取 | 多模态 | — |
| **Reranker** | `doubao-rerank-250615` | 检索结果精排 | 文本 | — |

#### 开通步骤

详细购买流程参见[[火山引擎购买指南]](https://github.com/volcengine/OpenViking/blob/main/docs/zh/guides/02-volcengine-purchase-guide.md)，核心步骤：

1. 注册火山引擎账号 → [console.volcengine.com](https://console.volcengine.com)
2. 开通火山方舟 → 搜索"火山方舟"进入控制台
3. 创建 API Key → 左侧导航"API Key 管理" → "创建 API Key"
4. 开通 Embedding → 开通管理 → 向量模型 → `Doubao-Embedding-Vision` → 开通
5. 开通 VLM → 开通管理 → 语言模型 → `Doubao-Seed-1.8` → 开通
6. 开通 Reranker → 开通管理 → 相关模型 → `Doubao-Rerank` → 开通

> **免费额度**：火山引擎为新用户提供免费 Token 额度，足够完成开发和测试阶段的全部使用。

### 5.3 Embedding 模型：doubao-embedding-vision-250615

#### 在系统中的作用

Embedding 模型是整个记忆系统的**语义理解核心**，负责将自然语言文本（以及可选的图片）转换为高维向量，使系统能够进行**语义级别**的记忆检索和关联发现。

> **没有 Embedding 模型，系统只能做关键词匹配；有了 Embedding 模型，系统能理解语义——"TypeScript 框架"能匹配到关于"Hono"的记忆。**

#### Embedding 模型参与的全部环节

| 环节 | 触发时机 | Embedding 做什么 | 如果没有 Embedding |
|------|----------|------------------|-------------------|
| **记忆写入** | `ov.commit()` 提取记忆后 | 将记忆文本转为 1024 维向量，存入 sqlite-vec | 记忆只能以纯文本存储，无法语义检索 |
| **记忆检索** | `ov.find()` / `ov.search()` | 将用户查询转为向量 → 与记忆向量计算余弦相似度 | 只能用 `grep()` 做正则匹配，漏召回严重 |
| **资源索引** | `ov.addResource()` | 对上传文档分块、每块生成向量 | 文档只能做全文搜索，不支持语义召回 |
| **Link 关联** | 记忆进化 `linkMemory()` | 用新记忆向量搜索相似记忆 | 无法自动发现语义关联，图谱退化 |
| **L0/L1 摘要向量** | OpenViking 自动处理 | 对 abstract/overview 也生成向量索引 | 层级递归检索失效 |

#### 调用链路图（远程模式）

```
用户输入 "帮我回忆之前的记忆系统设计方案"
    │
    ▼
┌─────────────────────────────────────────┐
│  AI Assistant (TypeScript)               │
│  memory-retriever.ts                     │
│  ov.find({ query: "记忆系统设计方案" })   │
└──────────────────┬──────────────────────┘
                   │ HTTP POST /api/v1/search/find
                   │ body: { query: "记忆系统设计方案" }
                   ▼
┌─────────────────────────────────────────┐
│  OpenViking Server (Python :1933)        │
│  1. IntentAnalyzer: 分析查询意图          │
│  2. 调用火山引擎 Embedding API ─────────┐│
│  3. 向量检索 sqlite-vec                 ││
│  4. 调用火山引擎 Rerank API             ││
│  5. 返回 Top-K 结果                     ││
└───────────────────┬─────────────────────┘│
                    │                      │
                    │  HTTPS POST          │
                    │  ark.cn-beijing.volces.com/api/v3/embeddings
                    │  { model: "doubao-embedding-vision-250615",
                    │    input: "记忆系统设计方案" }
                    │                      │
                    │                      ▼
                    │    ┌───────────────────────────────────┐
                    │    │  火山引擎 Ark API (Cloud)          │
                    │    │  doubao-embedding-vision-250615    │
                    │    │  输出: [0.032, -0.018, ...]       │
                    │    │  1024 维 float32 向量              │
                    │    └───────────────────────────────────┘
                    │
                    ▼
           返回匹配的记忆列表
```

**关键变化**：不再需要本地 Ollama 进程。OpenViking Server 直接通过 HTTPS 调用火山引擎 Ark API，获取向量结果。

#### 模型特性

| 属性 | 值 |
|------|-----|
| **模型 ID** | `doubao-embedding-vision-250615` |
| **提供商** | 火山引擎（豆包） |
| **输入类型** | 多模态（文本 + 图片 PNG/JPG） |
| **向量维度** | 1024 |
| **计费方式** | 按文本长度计费 |
| **并发上限** | 由火山引擎配额决定，`max_concurrent` 默认 10 |
| **区域端点** | `https://ark.cn-beijing.volces.com/api/v3`（北京）或 `https://ark.cn-shanghai.volces.com/api/v3`（上海） |

**多模态能力亮点**：使用 `input: "multimodal"` 配置后，OpenViking 可以对文本、图片（PNG/JPG 等）及混合内容进行 Embedding[[配置指南]](https://github.com/volcengine/OpenViking/blob/main/docs/zh/guides/01-configuration.md)。这意味着未来可以扩展到**图片记忆**——截图、手绘草图等也能被语义检索。

#### 混合检索：Dense + Sparse

火山引擎同时支持稀疏向量模型 `bm25-sparse-v1`，可以与 Dense Embedding 组合实现混合检索：

| 检索模式 | 原理 | 擅长场景 | 示例 |
|----------|------|----------|------|
| **Dense** | 1024 维稠密向量，余弦相似度 | 语义相近但用词不同 | "TS 框架" → 匹配 "Hono web server" |
| **Sparse (BM25)** | 稀疏向量，词频权重 | 精确术语匹配 | "BGE-M3" → 精确匹配包含此词的记忆 |
| **Hybrid** | Dense + Sparse 加权融合 | 综合最优 | 兼顾语义和精确匹配 |

> v2.3 中的 BGE-M3 虽然单模型支持 Dense+Sparse+ColBERT 三种模式，但受限于本地 Ollama 的接口限制，实际仅使用了 Dense 模式。v2.4 通过火山引擎的 `bm25-sparse-v1` 实现了真正的 Dense+Sparse 混合检索。

### 5.4 VLM 模型：doubao-seed-1-8-251228

#### 在系统中做什么

VLM 是 OpenViking 三层上下文体系（L0/L1/L2）的核心驱动。当 `commit()` 提取出新记忆后，OpenViking 调用 VLM 自动生成：

- **L0 Abstract**（`.abstract.md`）—— 一句话摘要（~50-100 Token），用于快速预览
- **L1 Overview**（`.overview.md`）—— 结构化概述（~500-2000 Token），用于中等粒度上下文注入

没有 VLM，`commit()` 后的记忆只有 L2 原始内容，无法按需加载不同粒度的上下文。

#### 调用链路

```
ov.commit(sessionId)
    │
    ▼
OpenViking Server
    ├── 1. 提取记忆（IntentAnalyzer → CREATE/UPDATE/MERGE/SKIP）
    ├── 2. 调用火山引擎 Embedding API → 存入 sqlite-vec
    └── 3. 调用火山引擎 VLM API → 生成 L0/L1 摘要
              │
              │  HTTPS POST ark.cn-beijing.volces.com/api/v3/chat/completions
              │  { "model": "doubao-seed-1-8-251228",
              │    "messages": [{"role":"user","content":"请为以下内容生成摘要..."}] }
              │
              ▼
         火山引擎 Ark API
              │
              ▼
         返回摘要文本 → 写入 .abstract.md / .overview.md
```

#### 模型特性

| 属性 | 值 |
|------|-----|
| **模型 ID** | `doubao-seed-1-8-251228` |
| **提供商** | 火山引擎（豆包 Seed 1.8） |
| **能力** | 内容理解、语义生成、摘要提炼 |
| **推荐用于** | 语义提取（L0/L1 摘要生成）[[配置指南]](https://github.com/volcengine/OpenViking/blob/main/docs/zh/guides/01-configuration.md) |
| **上下文长度** | 大（具体参见火山方舟控制台） |
| **计费方式** | 按输入/输出 Token 计费 |
| **thinking 模式** | 支持（`thinking: true`，仅部分火山模型生效） |
| **max_concurrent** | 默认 100（语义处理阶段 LLM 最大并发调用数） |

**相比 v2.3 的本地 Qwen3:8B**：
- 模型能力更强（豆包 Seed 1.8 为火山引擎旗舰模型）
- 无需本地 GPU，不占用硬件资源
- 支持更长的上下文
- 摘要质量更高

### 5.5 Reranker 模型：doubao-rerank-250615

#### 在系统中做什么

Reranker 是 `find()` 检索管线的**最后一道精排环节**。Embedding 模型完成向量检索后返回 Top-N 候选结果，Reranker 对这些候选进行**Cross-Encoder 级别的精细排序**，显著提升最终返回给用户的记忆质量。

#### 调用链路

```
ov.find({ query: "记忆系统设计" })
    │
    ▼
OpenViking Server
    ├── 1. IntentAnalyzer 分析意图
    ├── 2. 火山引擎 Embedding API → 向量检索 → Top-50 候选
    ├── 3. Dense + Sparse 分数加权融合
    └── 4. 火山引擎 Rerank API → 精排 → 返回 Top-K 最终结果
              │
              │  HTTPS POST ark.cn-beijing.volces.com/api/v3
              │  { "model": "doubao-rerank-250615", ... }
              │
              ▼
         火山引擎 Ark API → 返回重排序分数
```

#### 模型特性

| 属性 | 值 |
|------|-----|
| **模型 ID** | `doubao-rerank-250615` |
| **提供商** | 火山引擎（豆包） |
| **能力** | 搜索结果精排 |
| **配置** | `provider: "volcengine"` |

> 如果未配置 Rerank，OpenViking 的搜索仅使用向量相似度排序[[配置指南]](https://github.com/volcengine/OpenViking/blob/main/docs/zh/guides/01-configuration.md)。配置 Rerank 后检索精度预估提升 10-15%。

### 5.6 没有远程模型服务时的降级方案

| 能力 | 有 Embedding | 无 Embedding（降级） |
|------|-------------|---------------------|
| 语义检索 | ✅ "框架推荐" 能匹配 "Hono" | ❌ 只能匹配包含"框架推荐"字面的文本 |
| 跨语言检索 | ✅ 英文查询匹配中文记忆 | ❌ 不支持 |
| 多模态检索 | ✅ 可检索图片内容 | ❌ 不支持 |
| 模糊召回 | ✅ 近义词、同义表达均可召回 | ❌ 必须精确用词 |
| 检索精度 | ~85% Top-5 命中率 | ~40% 估计（纯 BM25） |
| 关联发现 | ✅ 自动发现语义相似记忆 | ❌ Link 操作失效 |
| 可用检索方法 | find / search / grep / glob | 仅 grep / glob |

**结论**：Embedding 模型是记忆系统的核心能力支撑，火山引擎 API 是必要依赖。

### 5.7 与 OpenViking 的对接配置

#### 推荐配置（Dense + Sparse + VLM + Rerank）

```json
{
  "embedding": {
    "max_concurrent": 10,
    "dense": {
      "provider": "volcengine",
      "api_key": "your-volcengine-api-key",
      "api_base": "https://ark.cn-beijing.volces.com/api/v3",
      "model": "doubao-embedding-vision-250615",
      "dimension": 1024,
      "input": "multimodal"
    },
    "sparse": {
      "provider": "volcengine",
      "api_key": "your-volcengine-api-key",
      "model": "bm25-sparse-v1"
    }
  },
  "vlm": {
    "provider": "volcengine",
    "api_key": "your-volcengine-api-key",
    "api_base": "https://ark.cn-beijing.volces.com/api/v3",
    "model": "doubao-seed-1-8-251228",
    "temperature": 0.1,
    "max_retries": 3,
    "max_concurrent": 100
  },
  "rerank": {
    "provider": "volcengine",
    "api_key": "your-volcengine-api-key",
    "model": "doubao-rerank-250615"
  },
  "storage": {
    "workspace": "./data",
    "vectordb": {
      "name": "context",
      "backend": "local"
    },
    "agfs": {
      "port": 1833,
      "log_level": "warn",
      "backend": "local"
    }
  },
  "server": {
    "host": "0.0.0.0",
    "port": 1933,
    "root_api_key": "your-secret-root-key"
  }
}
```

#### 配置说明

**Embedding 配置**：

| 字段 | 值 | 说明 |
|------|-----|------|
| `provider` | `"volcengine"` | 火山引擎 Embedding API |
| `api_key` | 真实 API Key | 在火山方舟控制台获取 |
| `api_base` | `https://ark.cn-beijing.volces.com/api/v3` | 北京区域端点（上海: `cn-shanghai`） |
| `model` | `"doubao-embedding-vision-250615"` | 推荐的多模态 Embedding 模型 |
| `dimension` | `1024` | 向量维度 |
| `input` | `"multimodal"` | 支持文本+图片混合输入 |
| `max_concurrent` | `10` | 并发 Embedding 请求数 |

**Sparse 配置**：

| 字段 | 值 | 说明 |
|------|-----|------|
| `provider` | `"volcengine"` | 火山引擎 Sparse API |
| `model` | `"bm25-sparse-v1"` | BM25 稀疏向量模型 |

**VLM 配置**：

| 字段 | 值 | 说明 |
|------|-----|------|
| `provider` | `"volcengine"` | 火山引擎 VLM API |
| `model` | `"doubao-seed-1-8-251228"` | 推荐语义提取模型 |
| `temperature` | `0.1` | 低温度确保摘要稳定性 |
| `max_retries` | `3` | 请求失败重试次数 |
| `max_concurrent` | `100` | 语义处理阶段最大并发 |

**Rerank 配置**：

| 字段 | 值 | 说明 |
|------|-----|------|
| `provider` | `"volcengine"` | 火山引擎 Rerank API |
| `model` | `"doubao-rerank-250615"` | 检索结果精排模型 |

#### 精简配置（仅 Dense + VLM，最小可用）

```json
{
  "embedding": {
    "dense": {
      "provider": "volcengine",
      "api_key": "your-volcengine-api-key",
      "api_base": "https://ark.cn-beijing.volces.com/api/v3",
      "model": "doubao-embedding-vision-250615",
      "dimension": 1024,
      "input": "multimodal"
    }
  },
  "vlm": {
    "provider": "volcengine",
    "api_key": "your-volcengine-api-key",
    "api_base": "https://ark.cn-beijing.volces.com/api/v3",
    "model": "doubao-seed-1-8-251228"
  }
}
```

> Sparse 和 Rerank 均为可选。不配置 Sparse 时仅使用 Dense 向量检索；不配置 Rerank 时仅使用向量相似度排序。

### 5.8 API Key 安全管理

由于改为远程 API，API Key 的安全管理变得重要：

```typescript
// 推荐方式：通过环境变量注入，不要硬编码在 ov.conf 中

// .env 文件（不要提交到 Git）
VOLCENGINE_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

// ov.conf 中引用环境变量（OpenViking 支持环境变量替换）
// 或在启动脚本中动态生成 ov.conf
```

```typescript
// src/setup/generate-ov-conf.ts — 启动前动态生成配置
const ovConf = {
  embedding: {
    max_concurrent: 10,
    dense: {
      provider: "volcengine",
      api_key: process.env.VOLCENGINE_API_KEY!,
      api_base: "https://ark.cn-beijing.volces.com/api/v3",
      model: "doubao-embedding-vision-250615",
      dimension: 1024,
      input: "multimodal",
    },
    sparse: {
      provider: "volcengine",
      api_key: process.env.VOLCENGINE_API_KEY!,
      model: "bm25-sparse-v1",
    },
  },
  vlm: {
    provider: "volcengine",
    api_key: process.env.VOLCENGINE_API_KEY!,
    api_base: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-1-8-251228",
    temperature: 0.1,
    max_retries: 3,
  },
  rerank: {
    provider: "volcengine",
    api_key: process.env.VOLCENGINE_API_KEY!,
    model: "doubao-rerank-250615",
  },
  storage: {
    workspace: "./openviking-data",
    vectordb: { name: "context", backend: "local" },
    agfs: { port: 1833, log_level: "warn", backend: "local" },
  },
  server: {
    host: "0.0.0.0",
    port: 1933,
    root_api_key: process.env.OV_ROOT_API_KEY || undefined,
  },
};

await Bun.write(
  `${process.env.HOME}/.openviking/ov.conf`,
  JSON.stringify(ovConf, null, 2),
);
console.log("ov.conf generated with environment API keys");
```

#### .gitignore 更新

```gitignore
# 新增：保护 API Key
.env
.env.local
openviking-data/
~/.openviking/ov.conf
```

### 5.9 费用估算

| 模型 | 计费单位 | 预估月用量（中等使用） | 预估月费 |
|------|---------|---------------------|---------|
| **Embedding** | 按文本长度 | ~100 万 Token | 较低（新用户有免费额度） |
| **VLM** | 输入/输出 Token | ~50 万 Token | 中等 |
| **Reranker** | 按调用次数 | ~1 万次 | 较低 |
| **合计** | — | — | **预估 ¥50-200/月**（视使用量） |

> 详细定价参见[[火山方舟定价说明]](https://www.volcengine.com/docs/82379)。新用户首次开通有赠送额度，开发测试阶段基本免费。

### 5.10 架构变更影响

#### PM2 进程管理简化

从 3 个进程简化为 2 个：

```javascript
// ecosystem.config.cjs — v2.4 更新
module.exports = {
  apps: [
    {
      name: "ai-assistant",
      script: "src/index.ts",
      interpreter: "bun",
      env: {
        PORT: 3000,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        VOLCENGINE_API_KEY: process.env.VOLCENGINE_API_KEY,
      },
    },
    {
      name: "openviking-server",
      script: "openviking-server",
      args: "--config ~/.openviking/ov.conf",
      env: {
        OPENVIKING_CONFIG_FILE: `${process.env.HOME}/.openviking/ov.conf`,
      },
    },
    // ❌ 不再需要 Ollama 进程
    // {
    //   name: "ollama",
    //   script: "ollama",
    //   args: "serve",
    // },
  ],
};
```

#### 项目目录变更

```
ai-assistant/
├── config/
│   ├── SOUL.md
│   ├── IDENTITY.md
│   ├── USER.md
│   └── AGENTS.md
├── src/
│   ├── index.ts
│   ├── openviking-client.ts
│   ├── config-loader.ts
│   ├── types.ts
│   ├── memory-retriever.ts
│   ├── context-manager.ts
│   ├── setup/
│   │   └── generate-ov-conf.ts    # 新增：动态生成 ov.conf
│   ├── setup/
│   │   └── generate-ov-conf.ts
│   ├── evolution/
│   │   ├── scheduler.ts
│   │   ├── reflect.ts
│   │   ├── link.ts
│   │   └── evolve.ts
│   ├── lessons/
│   │   ├── error-detector.ts
│   │   ├── lesson-extractor.ts
│   │   ├── lessons-updater.ts
│   │   └── manual-management.ts
│   ├── llm-router.ts
│   └── graph/
│       └── entity-manager.ts
├── openviking-data/               # OpenViking 本地存储
│   └── memory-data/
├── .env                           # 新增：API Key 环境变量（不提交 Git）
├── ecosystem.config.cjs           # 更新：2 个进程（去掉 Ollama）
├── package.json
└── tsconfig.json
```


---

## 六、AIEOS 协议文件管理

### 6.1 设计背景

AIEOS（AI Executive Operating System）是一种**文件优先的 AI 助手身份与记忆管理协议**。核心理念是：用 Markdown 文件作为 AI 助手的"认知源"——身份、规则、用户画像、记忆全部以人类可读的文件形式存在，而非隐藏在数据库或系统 prompt 中。

**为什么需要 AIEOS**：

| 问题 | 传统方式 | AIEOS 方式 |
|------|----------|-----------|
| AI 身份定义在哪？ | 硬编码在 system prompt 中 | `IDENTITY.md` + `SOUL.md` 文件，可版本管理 |
| 用户画像怎么维护？ | 对话记录里散落各处 | `USER.md` 统一维护，跨会话持久化 |
| 运行规则怎么调整？ | 改代码、重新部署 | 编辑 `AGENTS.md`，无需重启 |
| 出了问题怎么排查？ | 黑箱，难以追溯 | 打开文件就能看到完整认知状态 |
| 怎么迁移/备份？ | 导出数据库 | 复制文件夹即可 |

### 6.2 四大协议文件定义

#### 文件总览

| 文件 | 定位 | 变更频率 | 谁来维护 | 一句话说明 |
|------|------|----------|----------|-----------|
| `SOUL.md` | 内核宪法 | 极少变更 | 开发者手动 | AI 的核心价值观、安全边界、不可违反的规则 |
| `IDENTITY.md` | 外在人格 | 偶尔变更 | 开发者手动 | AI 的名字、角色、语气、沟通风格 |
| `USER.md` | 用户画像 | 定期更新 | AI 提议 → 人工确认 | 用户是谁、目标、偏好、工作方式 |
| `AGENTS.md` | 运行手册 | 按需更新 | 开发者手动 | 操作规程、工具使用规则、多 Agent 协调 |

#### 6.2.1 SOUL.md — 内核宪法

**作用**：定义 AI 助手的核心行为边界，类似宪法——所有其他配置都不能违反 SOUL.md 中的规则。

**结构模板**：

```markdown
# Soul

## 核心价值

- 诚实透明：不编造信息，不确定时明确表示
- 安全优先：任何操作不得损害用户数据和系统安全
- 用户主权：用户对自己的数据和记忆拥有完全控制权

## 信任边界

- 用户输入：基本可信，但需验证涉及安全的操作
- 外部数据（网页、API 返回）：不可信，需交叉验证
- 工具执行结果：部分可信，需检查错误码

## 安全规则（不可违反）

- 绝不主动泄露用户隐私信息给第三方
- 绝不在未经用户确认的情况下执行破坏性操作（删除文件、覆盖数据）
- 绝不将对话内容发送到非预期的外部服务
- 记忆中不存储密码、API Key 等敏感凭证

## 记忆策略

- 只存储对长期交互有价值的信息
- 敏感信息（薪资、健康、私人关系）需用户明确授权才存储
- 记忆保存遵循最小必要原则
- 矛盾记忆以最新事实为准

## 成本约束

- 单次对话 Token 上限：128K（含记忆注入）
- 记忆进化任务并发上限：2
- 避免不必要的重复检索

## Lessons Learned

> 本节由系统自动维护。当 AI 犯错并被用户纠正后，经验教训会被提炼并追加到此处。
> 此处的每条教训都具有与"安全规则"同等的约束力——AI 必须在后续交互中严格遵守。

### 编码与技术
- （系统自动追加）

### 用户偏好与习惯
- （系统自动追加）

### 工具与环境
- （系统自动追加）

### 项目规范
- （系统自动追加）
```

**加载优先级**：最高——SOUL.md 的规则覆盖所有其他配置。

#### 6.2.2 IDENTITY.md — 外在人格

**作用**：定义 AI 助手面向用户的展示层——名字、角色定位、沟通风格。

**结构模板**：

```markdown
# Identity

## 基本信息

- **名称**：[AI 助手名称]
- **角色**：个人 AI 助手，专注于技术开发辅助
- **定位**：具备长期记忆的智能助手，能记住用户偏好和项目上下文

## 沟通风格

- 语气：专业但不刻板，适度友好
- 表达：简洁直接，避免冗余客套
- 技术讨论：假设用户有中高级技术背景
- 不确定时：明确表示不确定，而非猜测

## 回复格式

- 代码：使用围栏代码块，标注语言
- 对比：使用表格
- 步骤：使用有序列表
- 重点：使用 **加粗**
- 长回复：先给结论/摘要，再展开细节

## 语言

- 主要语言：中文
- 技术术语：保持英文原词（如 TypeScript、Embedding）
- 代码注释：中文
```

#### 6.2.3 USER.md — 用户画像

**作用**：存储关于用户的**稳定信息**——不是对话日志，而是从多次对话中提炼的持久化画像。

**结构模板**：

```markdown
# User Profile

## 基本信息

- **角色**：[从对话中推断]
- **技术栈**：[从对话中推断]
- **工作领域**：[从对话中推断]

## 长期目标

- [从对话中提炼的用户长期目标]

## 技术偏好

- Runtime: Bun（偏好轻量快速）
- 语言: TypeScript
- 框架: Hono
- 风格: 偏好简洁方案，避免过度工程

## 沟通偏好

- 喜欢先看结论，再看细节
- 偏好表格做对比分析
- 代码示例需完整可运行

## 工作习惯

- [从对话中积累]

## 当前关注项目

- [从对话中推断的活跃项目]
```

**更新策略**：AI 提议更新 → 用户确认 → 写入。不允许自动静默修改。

#### 6.2.4 AGENTS.md — 运行手册

**作用**：定义 AI 助手的操作规程、工具使用规则、记忆系统交互协议。

**结构模板**：

```markdown
# Agents Protocol

## 记忆系统交互协议

### 读取规则
- 每次会话开始时，读取 SOUL.md → AGENTS.md → IDENTITY.md → USER.md
- 检索相关记忆注入上下文（Token 预算 4000）
- 优先 L0 摘要，按需展开 L1/L2

### 写入规则
- 会话结束/commit 时自动提取记忆
- 去重策略：CREATE / UPDATE / MERGE / SKIP
- USER.md 更新需用户确认
- SOUL.md / IDENTITY.md / AGENTS.md 不自动修改

## 工具使用规则

- 文件操作：删除/覆盖前必须确认
- 网络请求：仅访问白名单域名
- 代码执行：展示代码后等待用户确认

## 对话管理

- 上下文达 80% 容量时触发 Pre-Compaction
- 长对话自动 commit 保存中间记忆
- 会话超时（30 分钟无活动）自动 commit

## 错误处理

- OpenViking 不可用时：降级为无记忆模式，提示用户
- Embedding 服务不可用时：使用 grep 替代语义检索
- Claude API 限流时：排队等待，不丢弃请求
```

### 6.3 文件存储位置与 VikingFS 映射

AIEOS 文件存储在 VikingFS 的 `viking://agent/config/` 目录下：

```
viking://agent/config/
├── SOUL.md              # 内核宪法
├── IDENTITY.md          # 外在人格
├── USER.md              # 用户画像
└── AGENTS.md            # 运行手册
```

同时在本地文件系统中保持一份镜像，方便直接编辑：

```
ai-assistant/
├── config/
│   ├── SOUL.md
│   ├── IDENTITY.md
│   ├── USER.md
│   └── AGENTS.md
├── src/
│   └── ...
```

两份之间通过 `ConfigSyncManager` 保持同步。

### 6.4 读取生命周期

#### 6.4.1 会话启动时（每次对话开头）

```
新会话请求到达
    │
    ▼
┌─────────────────────────────────────────┐
│  ConfigLoader.loadAll()                  │
│                                          │
│  1. 读取 SOUL.md      → soulRules       │  ← 最高优先级
│  2. 读取 AGENTS.md     → agentProtocol   │
│  3. 读取 IDENTITY.md   → identity        │
│  4. 读取 USER.md       → userProfile     │
│  5. 组装为 System Prompt 的前缀部分       │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│  Memory Retriever                        │
│  根据用户消息检索相关记忆                  │
│  L0 → L1 → L2 渐进加载                   │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│  System Prompt 最终组装                   │
│                                          │
│  [SOUL 规则]                              │
│  [IDENTITY 人格]                          │
│  [USER 画像]                              │
│  [AGENTS 协议]                            │
│  [检索到的记忆上下文]                      │
│  [当前对话消息]                            │
└─────────────────────────────────────────┘
```

#### 6.4.2 System Prompt 模板

```typescript
function buildSystemPrompt(
  soul: string,
  identity: string,
  user: string,
  agents: string,
  memoryContext: string,
): string {
  return `${soul}

---

${identity}

---

## 用户信息
${user}

---

## 操作协议
${agents}

---

## 相关记忆
${memoryContext || "（暂无相关记忆）"}

基于以上身份定义、用户信息和相关记忆，回复用户的当前消息。`;
}
```

### 6.5 更新生命周期

| 文件 | 更新触发 | 更新方式 | 更新频率 |
|------|----------|----------|----------|
| `SOUL.md` | 开发者主动修改 | 手动编辑文件 → ConfigSync 同步到 VikingFS | 极少（月/季度级） |
| `IDENTITY.md` | 开发者主动修改 | 手动编辑文件 → ConfigSync 同步到 VikingFS | 偶尔（需求变更时） |
| `USER.md` | AI 检测到新的持久偏好 | AI 提议 → 用户确认 → 写入 | 定期（周级别） |
| `AGENTS.md` | 开发者调整运行策略 | 手动编辑文件 → ConfigSync 同步到 VikingFS | 按需 |

#### USER.md 自动更新流程

```
会话对话中识别到新的稳定偏好
（如："以后代码注释都用英文"）
    │
    ▼
┌─────────────────────────────────────────┐
│  UserProfileUpdater                      │
│                                          │
│  1. Claude 判断是否为持久偏好（vs 临时指令）│
│  2. 如果是持久偏好：                       │
│     a. 生成 USER.md diff                  │
│     b. 向用户展示变更提议                  │
│     c. 用户确认 → 写入 USER.md            │
│     d. ConfigSync → VikingFS              │
│  3. 如果是临时指令：                       │
│     仅在本次会话生效，不修改 USER.md       │
└─────────────────────────────────────────┘
```

### 6.6 ConfigLoader 实现

```typescript
// src/config-loader.ts

import { readFile, exists } from "fs/promises";
import type { OpenVikingClient } from "./openviking-client";

export interface AIEOSConfig {
  soul: string;
  identity: string;
  user: string;
  agents: string;
}

const CONFIG_DIR = "./config";
const VIKING_CONFIG_URI = "viking://agent/config";

export class ConfigLoader {
  private cache: AIEOSConfig | null = null;
  private lastLoad = 0;
  private cacheTTL = 60_000; // 1 分钟缓存

  constructor(private ov: OpenVikingClient) {}

  /** 加载全部 AIEOS 配置文件 */
  async loadAll(forceRefresh = false): Promise<AIEOSConfig> {
    const now = Date.now();
    if (!forceRefresh && this.cache && now - this.lastLoad < this.cacheTTL) {
      return this.cache;
    }

    const [soul, identity, user, agents] = await Promise.all([
      this.loadFile("SOUL.md"),
      this.loadFile("IDENTITY.md"),
      this.loadFile("USER.md"),
      this.loadFile("AGENTS.md"),
    ]);

    this.cache = { soul, identity, user, agents };
    this.lastLoad = now;
    return this.cache;
  }

  /** 优先从本地文件读取，本地不存在则从 VikingFS 读取 */
  private async loadFile(filename: string): Promise<string> {
    const localPath = `${CONFIG_DIR}/${filename}`;

    // 优先本地文件
    if (await exists(localPath)) {
      return readFile(localPath, "utf-8");
    }

    // 降级到 VikingFS
    try {
      return await this.ov.read(`${VIKING_CONFIG_URI}/${filename}`);
    } catch {
      return `<!-- ${filename} not found -->`;
    }
  }

  /** 更新 USER.md（需用户确认后调用） */
  async updateUserProfile(newContent: string): Promise<void> {
    // 写入本地文件
    await Bun.write(`${CONFIG_DIR}/USER.md`, newContent);
    // 同步到 VikingFS
    await this.ov.write(`${VIKING_CONFIG_URI}/USER.md`, newContent);
    // 清除缓存
    this.cache = null;
  }

  /** 使缓存失效 */
  invalidate(): void {
    this.cache = null;
  }
}
```

### 6.7 AIEOS 文件与记忆系统的关系

```
┌─────────────────────────────────────────────────────┐
│                    System Prompt                      │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │  AIEOS 协议文件（静态配置层）                      │ │
│  │  SOUL.md → IDENTITY.md → USER.md → AGENTS.md    │ │
│  │  定义"我是谁""怎么做"                             │ │
│  └─────────────────────┬───────────────────────────┘ │
│                        │                              │
│  ┌─────────────────────▼───────────────────────────┐ │
│  │  记忆系统（动态知识层）                            │ │
│  │  OpenViking memories → find() → L0/L1/L2         │ │
│  │  提供"我知道什么"                                  │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │  当前对话（实时交互层）                            │ │
│  │  用户消息 + 对话历史                               │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

**三层关系**：

| 层级 | 来源 | Token 占比 | 变化频率 |
|------|------|-----------|----------|
| **静态配置层** | AIEOS 4 个文件 | ~500-2000 tokens | 极低（天/周） |
| **动态知识层** | OpenViking 记忆检索 | ~1000-4000 tokens | 每次对话不同 |
| **实时交互层** | 当前对话消息 | 剩余 Token 预算 | 实时变化 |


---

### 6.8、Lessons Learned 机制：让 AI 不犯同样的错误

> **定位**：在 AIEOS 协议的 SOUL.md 中新增 `## Lessons Learned` section，建立一套**错误检测 → 经验提炼 → 自动更新 → 持续预防**的闭环机制，使 AI 从每一次错误中学习。

#### 6.8.1 设计动机

| 问题 | 表现 | 根因 | 解决方案 |
|------|------|------|---------|
| AI 重复犯错 | 同样的错误反复出现，每次都需要用户纠正 | 纠正信息散落在对话记忆中，难以稳定召回 | 将教训固化到 SOUL.md，每次对话必然加载 |
| 纠正信息权重低 | 记忆检索中，纠正类记忆容易被其他高频记忆淹没 | 记忆检索基于语义相似度，不区分"纠正"和"普通" | SOUL.md 在 System Prompt 中权重最高 |
| 经验无法积累 | 用户教了 10 遍同一件事，AI 还是可能忘记 | 对话记忆有时效性，可能被 evolve 合并/替代 | Lessons Learned 永久保留在 SOUL.md 中 |

**核心理念**：

> **把"记忆中的经验"升格为"宪法级规则"——写入 SOUL.md 的教训具有最高优先级，不会被记忆检索的不确定性所影响。**

#### 6.8.2 SOUL.md 新增 Section 结构

在 SOUL.md 的**末尾**新增 `## Lessons Learned` section：

```markdown
# Soul

## 核心价值
... (现有内容不变)

## 信任边界
... (现有内容不变)

## 安全规则（不可违反）
... (现有内容不变)

## 记忆策略
... (现有内容不变)

## 成本约束
... (现有内容不变)

## Lessons Learned

> 本节由系统自动维护。当 AI 犯错并被用户纠正后，经验教训会被提炼并追加到此处。
> 此处的每条教训都具有与"安全规则"同等的约束力——AI 必须在后续交互中严格遵守。

### 编码与技术
- [2025-01-15] Bun 中使用 `fetch` 发送 POST 请求时，body 必须是 `JSON.stringify()` 后的字符串，不能直接传对象
- [2025-01-18] TypeScript 中 `Map.get()` 返回 `T | undefined`，必须做空值检查，不能直接使用返回值
- [2025-02-03] PM2 的 ecosystem.config 必须使用 `.cjs` 后缀（CommonJS），不能用 `.ts` 或 `.mjs`

### 用户偏好与习惯
- [2025-01-20] 用户偏好简洁回复，不要过度解释已知概念。如果用户问"怎么做X"，直接给方案，不要先解释"X是什么"
- [2025-02-01] 代码示例必须使用 TypeScript 而非 JavaScript，且包含完整类型注解

### 工具与环境
- [2025-01-22] 用户的开发环境是 macOS + Bun + Neovim，不要推荐 VSCode 特定的配置或快捷键
- [2025-02-05] 用户使用 pnpm 而非 npm/yarn，所有包管理命令应使用 pnpm

### 项目规范
- [2025-01-25] 项目代码风格：不使用 semicolons，使用 double quotes，tab 缩进
- [2025-02-10] API 响应格式统一为 `{ success: boolean, data?: T, error?: string }`
```

#### Section 设计原则

| 原则 | 说明 |
|------|------|
| **分类组织** | 按领域分为子 section（编码、偏好、工具、规范），便于检索和维护 |
| **带时间戳** | 每条教训标注学习日期，用于追踪和清理过期信息 |
| **一句话原则** | 每条教训用一句话表达，清晰、无歧义、可执行 |
| **去重合并** | 相似教训合并为一条，避免 section 膨胀 |
| **容量上限** | 单个子 section 最多 20 条，总计不超过 80 条，超出时合并或淘汰旧条目 |

#### 6.8.3 错误检测机制

系统如何判断"AI 犯了错误"？通过以下多重信号：

```
用户消息分析
    │
    ▼
┌─────────────────────────────────────────────────────┐
│             ErrorSignalDetector                      │
│                                                      │
│  Signal 1: 显式纠正关键词                             │
│  ├── "不对" / "错了" / "不是这样" / "wrong"           │
│  ├── "我说的是..." / "应该是..." / "不要..."          │
│  └── "我之前说过" / "上次就说了" / "又犯了"           │
│                                                      │
│  Signal 2: 重复纠正模式                               │
│  ├── 同一 session 内纠正次数 ≥ 2                      │
│  └── 跨 session 对同一主题的纠正                      │
│                                                      │
│  Signal 3: LLM 辅助判断                              │
│  └── 将 [AI回复 + 用户反馈] 送入 LLM                  │
│      问："用户是否在纠正 AI 的错误？"                   │
│      输出：{ isCorrection: boolean,                   │
│              category: string,                        │
│              lesson: string }                         │
│                                                      │
│  Decision: any signal = true → 触发 Lesson 提取       │
└─────────────────────────────────────────────────────┘
```

#### 信号检测逻辑

| 信号 | 触发条件 | 置信度 | 成本 |
|------|---------|--------|------|
| **显式关键词** | 用户消息包含纠正类关键词 | 高 | 零（正则匹配） |
| **重复纠正** | 同主题纠正 ≥ 2 次 | 很高 | 零（计数器） |
| **LLM 辅助** | 上述两个信号均未触发时，用 LLM 判断 | 中 | 低（~100 Token） |

#### 6.8.4 经验提炼流程

当检测到错误信号后，系统自动提炼经验教训并更新 SOUL.md：

```
错误信号检测通过
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  LessonExtractor（LLM 调用）                         │
│                                                      │
│  输入：                                               │
│  • AI 的错误回复（assistant message）                  │
│  • 用户的纠正消息（user message）                      │
│  • 对话上下文（前 3 轮）                               │
│  • 现有 Lessons Learned 内容（用于去重）               │
│                                                      │
│  Prompt：                                             │
│  "分析以下 AI 错误和用户纠正，提炼出一条简洁的         │
│   经验教训。格式要求：                                 │
│   1. 用一句话表达，不超过 80 字                        │
│   2. 指明具体场景和正确做法                            │
│   3. 与现有教训去重，如果已有类似条目则输出 DUPLICATE   │
│   4. 分类到：编码与技术 / 用户偏好与习惯 /             │
│      工具与环境 / 项目规范 / 其他"                     │
│                                                      │
│  输出：                                               │
│  { action: "ADD" | "MERGE" | "DUPLICATE",             │
│    category: "编码与技术",                             │
│    lesson: "Bun 中 fetch POST 请求的 body 必须是...", │
│    mergeTarget?: "existing lesson text..." }          │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  LessonsLearnedUpdater                               │
│                                                      │
│  ADD → 追加新条目到对应子 section                      │
│  MERGE → 合并到已有条目，更新时间戳                     │
│  DUPLICATE → 跳过，不修改                              │
│                                                      │
│  更新路径：                                            │
│  1. 读取本地 config/SOUL.md                           │
│  2. 解析 ## Lessons Learned section                   │
│  3. 应用变更                                          │
│  4. 写回本地 config/SOUL.md                           │
│  5. 同步到 VikingFS: viking://config/SOUL.md          │
│  6. 清除 ConfigLoader 缓存 → 下次加载获取最新         │
└─────────────────────────────────────────────────────┘
```

#### 6.8.5 TypeScript 实现

#### 错误信号检测器

```typescript
// src/lessons/error-detector.ts

interface ErrorSignal {
  isCorrection: boolean;
  confidence: "high" | "medium" | "low";
  source: "keyword" | "repetition" | "llm";
}

// 纠正类关键词（中英文）
const CORRECTION_PATTERNS = [
  /不对|错了|不是这样|不要这样|搞错了|弄错了/,
  /应该是|我说的是|正确的是|实际上/,
  /我之前说过|上次就说了|又犯了|又错了|说了多少遍/,
  /wrong|incorrect|not right|that's not|no,?\s*(it|that|this)/i,
  /should be|actually|i (said|told|mentioned)/i,
];

// 重复纠正计数器
const correctionCounter = new Map<string, { count: number; lastTime: number }>();

export function detectErrorSignal(
  userMessage: string,
  sessionId: string,
  topic?: string,
): ErrorSignal {
  // Signal 1: 显式关键词匹配
  for (const pattern of CORRECTION_PATTERNS) {
    if (pattern.test(userMessage)) {
      // 更新计数器
      const key = topic || sessionId;
      const counter = correctionCounter.get(key) || { count: 0, lastTime: 0 };
      counter.count++;
      counter.lastTime = Date.now();
      correctionCounter.set(key, counter);

      return {
        isCorrection: true,
        confidence: counter.count >= 2 ? "high" : "medium",
        source: counter.count >= 2 ? "repetition" : "keyword",
      };
    }
  }

  // Signal 2: 检查历史重复纠正
  const key = topic || sessionId;
  const counter = correctionCounter.get(key);
  if (counter && counter.count >= 2 && Date.now() - counter.lastTime < 86400000) {
    return { isCorrection: true, confidence: "high", source: "repetition" };
  }

  return { isCorrection: false, confidence: "low", source: "keyword" };
}

// 当 keyword/repetition 未触发时，可选调用 LLM 辅助判断
export async function detectWithLLM(
  aiResponse: string,
  userFeedback: string,
  llmRouter: { chat: (messages: any[]) => Promise<string> },
): Promise<ErrorSignal> {
  const result = await llmRouter.chat([{
    role: "user",
    content: `判断用户是否在纠正 AI 的错误。仅回答 JSON。

AI 回复：${aiResponse.slice(0, 500)}
用户反馈：${userFeedback}

输出格式：{"isCorrection": true/false, "reason": "简要原因"}`,
  }]);

  try {
    const parsed = JSON.parse(result);
    return {
      isCorrection: parsed.isCorrection,
      confidence: "medium",
      source: "llm",
    };
  } catch {
    return { isCorrection: false, confidence: "low", source: "llm" };
  }
}
```

#### 经验提炼器

```typescript
// src/lessons/lesson-extractor.ts

interface ExtractedLesson {
  action: "ADD" | "MERGE" | "DUPLICATE";
  category: "编码与技术" | "用户偏好与习惯" | "工具与环境" | "项目规范" | "其他";
  lesson: string;
  mergeTarget?: string;  // MERGE 时，要合并到的已有条目
}

export async function extractLesson(
  aiResponse: string,
  userCorrection: string,
  context: string[],        // 前 3 轮对话
  existingLessons: string,  // 现有 Lessons Learned 内容
  llmRouter: { chat: (messages: any[]) => Promise<string> },
): Promise<ExtractedLesson> {
  const prompt = `你是一个经验提炼专家。分析以下 AI 错误和用户纠正，提炼出一条简洁的经验教训。

## 对话上下文
${context.join("\n")}

## AI 的错误回复
${aiResponse}

## 用户的纠正
${userCorrection}

## 现有教训（用于去重）
${existingLessons}

## 要求
1. 用一句话表达教训，不超过 80 字
2. 指明具体场景和正确做法
3. 如果与现有教训完全重复，action 输出 "DUPLICATE"
4. 如果与现有教训部分重叠可以合并，action 输出 "MERGE"，并在 mergeTarget 中给出要合并到的原始条目
5. 否则 action 输出 "ADD"

## 分类
- 编码与技术：代码、API、框架、语言特性相关
- 用户偏好与习惯：回复风格、格式、详略程度偏好
- 工具与环境：开发工具、操作系统、环境配置
- 项目规范：代码风格、命名约定、架构规范

## 输出格式（仅 JSON）
{
  "action": "ADD",
  "category": "编码与技术",
  "lesson": "一句话教训",
  "mergeTarget": null
}`;

  const result = await llmRouter.chat([{ role: "user", content: prompt }]);

  try {
    // 提取 JSON（处理可能的 markdown 代码块包裹）
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");
    return JSON.parse(jsonMatch[0]) as ExtractedLesson;
  } catch {
    // 降级：直接作为新教训添加
    return {
      action: "ADD",
      category: "其他",
      lesson: `用户纠正：${userCorrection.slice(0, 80)}`,
    };
  }
}
```

#### SOUL.md 更新器

```typescript
// src/lessons/lessons-updater.ts

import type { OpenVikingClient } from "../openviking-client";
import type { ConfigLoader } from "../config-loader";
import type { ExtractedLesson } from "./lesson-extractor";

const CONFIG_DIR = "./config";
const VIKING_CONFIG_URI = "viking://config";
const MAX_LESSONS_PER_CATEGORY = 20;
const MAX_TOTAL_LESSONS = 80;

// 子 section 标题映射
const CATEGORY_HEADERS: Record<string, string> = {
  "编码与技术": "### 编码与技术",
  "用户偏好与习惯": "### 用户偏好与习惯",
  "工具与环境": "### 工具与环境",
  "项目规范": "### 项目规范",
  "其他": "### 其他",
};

export class LessonsLearnedUpdater {
  constructor(
    private ov: OpenVikingClient,
    private configLoader: ConfigLoader,
  ) {}

  /**
   * 应用一条提炼后的教训到 SOUL.md
   */
  async applyLesson(lesson: ExtractedLesson): Promise<boolean> {
    if (lesson.action === "DUPLICATE") {
      return false; // 跳过重复
    }

    // 1. 读取当前 SOUL.md
    const soulPath = `${CONFIG_DIR}/SOUL.md`;
    const soulContent = await Bun.file(soulPath).text();

    // 2. 解析 Lessons Learned section
    const parsed = this.parseLessonsSection(soulContent);

    // 3. 应用变更
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    if (lesson.action === "ADD") {
      const entry = `- [${today}] ${lesson.lesson}`;
      parsed.categories[lesson.category] =
        parsed.categories[lesson.category] || [];
      parsed.categories[lesson.category].push(entry);
    } else if (lesson.action === "MERGE" && lesson.mergeTarget) {
      // 在对应分类中找到 mergeTarget 并替换
      const category = parsed.categories[lesson.category] || [];
      const idx = category.findIndex((l) =>
        l.includes(lesson.mergeTarget!)
      );
      if (idx >= 0) {
        category[idx] = `- [${today}] ${lesson.lesson}`;
      } else {
        category.push(`- [${today}] ${lesson.lesson}`);
      }
      parsed.categories[lesson.category] = category;
    }

    // 4. 容量控制
    this.enforceCapacity(parsed);

    // 5. 重新生成 SOUL.md
    const newContent = this.rebuildSoulMd(
      parsed.beforeSection,
      parsed.categories,
    );

    // 6. 写回本地 + 同步 VikingFS
    await Bun.write(soulPath, newContent);
    await this.ov.write(`${VIKING_CONFIG_URI}/SOUL.md`, newContent);

    // 7. 清除缓存
    this.configLoader.invalidateCache();

    return true;
  }

  /**
   * 解析 SOUL.md 中的 Lessons Learned section
   */
  private parseLessonsSection(content: string): {
    beforeSection: string;
    categories: Record<string, string[]>;
  } {
    const sectionStart = content.indexOf("## Lessons Learned");

    if (sectionStart === -1) {
      // 没有 Lessons Learned section，需要创建
      return {
        beforeSection: content.trimEnd(),
        categories: {},
      };
    }

    const beforeSection = content.slice(0, sectionStart).trimEnd();
    const sectionContent = content.slice(sectionStart);

    // 解析各子分类
    const categories: Record<string, string[]> = {};
    let currentCategory = "";

    for (const line of sectionContent.split("\n")) {
      if (line.startsWith("### ")) {
        currentCategory = line.replace("### ", "").trim();
        categories[currentCategory] = categories[currentCategory] || [];
      } else if (line.startsWith("- [") && currentCategory) {
        categories[currentCategory].push(line);
      }
    }

    return { beforeSection, categories };
  }

  /**
   * 容量控制：确保不超过上限
   */
  private enforceCapacity(
    parsed: { categories: Record<string, string[]> },
  ): void {
    let totalCount = 0;

    for (const [category, lessons] of Object.entries(parsed.categories)) {
      // 单分类上限：保留最新的 MAX_LESSONS_PER_CATEGORY 条
      if (lessons.length > MAX_LESSONS_PER_CATEGORY) {
        parsed.categories[category] = lessons.slice(
          lessons.length - MAX_LESSONS_PER_CATEGORY,
        );
      }
      totalCount += parsed.categories[category].length;
    }

    // 总量上限：如果总数超过 MAX_TOTAL_LESSONS，按时间戳淘汰最旧的
    if (totalCount > MAX_TOTAL_LESSONS) {
      const allLessons: { category: string; lesson: string; date: string }[] = [];

      for (const [category, lessons] of Object.entries(parsed.categories)) {
        for (const lesson of lessons) {
          const dateMatch = lesson.match(/\[(\d{4}-\d{2}-\d{2})\]/);
          allLessons.push({
            category,
            lesson,
            date: dateMatch?.[1] || "1970-01-01",
          });
        }
      }

      // 按日期排序，保留最新的 MAX_TOTAL_LESSONS 条
      allLessons.sort((a, b) => b.date.localeCompare(a.date));
      const kept = allLessons.slice(0, MAX_TOTAL_LESSONS);

      // 重建 categories
      const newCategories: Record<string, string[]> = {};
      for (const item of kept) {
        newCategories[item.category] = newCategories[item.category] || [];
        newCategories[item.category].push(item.lesson);
      }
      parsed.categories = newCategories;
    }
  }

  /**
   * 重新生成完整的 SOUL.md
   */
  private rebuildSoulMd(
    beforeSection: string,
    categories: Record<string, string[]>,
  ): string {
    const parts = [beforeSection, "", "## Lessons Learned", ""];
    parts.push(
      "> 本节由系统自动维护。当 AI 犯错并被用户纠正后，经验教训会被提炼并追加到此处。",
    );
    parts.push(
      "> 此处的每条教训都具有与"安全规则"同等的约束力——AI 必须在后续交互中严格遵守。",
    );
    parts.push("");

    // 按固定顺序输出分类
    const categoryOrder = [
      "编码与技术",
      "用户偏好与习惯",
      "工具与环境",
      "项目规范",
      "其他",
    ];

    for (const category of categoryOrder) {
      const lessons = categories[category];
      if (lessons && lessons.length > 0) {
        parts.push(CATEGORY_HEADERS[category]);
        for (const lesson of lessons) {
          parts.push(lesson);
        }
        parts.push("");
      }
    }

    return parts.join("\n");
  }
}
```

#### 集成到对话流程

```typescript
// src/index.ts — 在对话路由中集成 Lessons Learned

import { detectErrorSignal, detectWithLLM } from "./lessons/error-detector";
import { extractLesson } from "./lessons/lesson-extractor";
import { LessonsLearnedUpdater } from "./lessons/lessons-updater";

const lessonsUpdater = new LessonsLearnedUpdater(ov, configLoader);

app.post("/chat", async (c) => {
  const { message, sessionId } = await c.req.json();

  // 1. 正常对话流程
  const config = await configLoader.loadAll();
  const memories = await retrieveMemories(ov, { query: message });
  const systemPrompt = buildSystemPrompt(config, memories);

  const response = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: "user", content: message }],
  });

  const aiReply = response.content[0].text;

  // 2. 错误信号检测（异步，不阻塞响应）
  queueMicrotask(async () => {
    const signal = detectErrorSignal(message, sessionId);

    // 如果关键词未触发，可选使用 LLM 辅助（对话量大时可省略以节省成本）
    if (!signal.isCorrection) {
      // const llmSignal = await detectWithLLM(previousAiReply, message, llmRouter);
      // if (!llmSignal.isCorrection) return;
      return;
    }

    // 3. 提炼教训
    const existingLessons = config.soul.match(
      /## Lessons Learned[\s\S]*/,
    )?.[0] || "";

    const lesson = await extractLesson(
      previousAiReply || "",
      message,
      getRecentContext(sessionId, 3),
      existingLessons,
      llmRouter,
    );

    // 4. 更新 SOUL.md
    await lessonsUpdater.applyLesson(lesson);
    console.log(
      `[Lessons] ${lesson.action}: [${lesson.category}] ${lesson.lesson}`,
    );
  });

  // 3. 返回响应（不等待 Lesson 处理完成）
  return c.json({ reply: aiReply });
});
```

#### 6.8.6 完整生命周期

```
┌────────────────────────────────────────────────────────────────────┐
│                 Lessons Learned 生命周期                            │
│                                                                    │
│  Phase 1: 错误发生                                                 │
│  ┌──────┐    ┌──────────┐    ┌──────────┐                         │
│  │ 用户  │───▶│ AI 回复   │───▶│ 用户纠正  │                         │
│  │ 提问  │    │ (含错误)  │    │ "不对..." │                         │
│  └──────┘    └──────────┘    └─────┬────┘                         │
│                                    │                               │
│  Phase 2: 检测                     ▼                               │
│  ┌─────────────────────────────────────────┐                      │
│  │ ErrorSignalDetector                      │                      │
│  │ • 关键词匹配 → "不对" 命中               │                      │
│  │ • 重复计数器 → 同主题第 2 次              │                      │
│  │ • 置信度: HIGH                           │                      │
│  └────────────────────┬────────────────────┘                      │
│                       │                                            │
│  Phase 3: 提炼        ▼                                            │
│  ┌─────────────────────────────────────────┐                      │
│  │ LessonExtractor (LLM)                    │                      │
│  │ • 输入: AI错误回复 + 用户纠正 + 上下文    │                      │
│  │ • 输出: {                                │                      │
│  │     action: "ADD",                       │                      │
│  │     category: "编码与技术",               │                      │
│  │     lesson: "Bun 中 fetch POST..."       │                      │
│  │   }                                      │                      │
│  └────────────────────┬────────────────────┘                      │
│                       │                                            │
│  Phase 4: 更新        ▼                                            │
│  ┌─────────────────────────────────────────┐                      │
│  │ LessonsLearnedUpdater                    │                      │
│  │ • 读取 SOUL.md                           │                      │
│  │ • 解析 Lessons Learned section           │                      │
│  │ • 追加到"编码与技术"子分类                │                      │
│  │ • 容量检查（≤ 20/类，≤ 80 总）            │                      │
│  │ • 写回 SOUL.md + VikingFS 同步           │                      │
│  │ • 清除 ConfigLoader 缓存                 │                      │
│  └────────────────────┬────────────────────┘                      │
│                       │                                            │
│  Phase 5: 生效        ▼                                            │
│  ┌─────────────────────────────────────────┐                      │
│  │ 下一次对话                                │                      │
│  │ • configLoader.loadAll() 重新加载         │                      │
│  │ • SOUL.md 包含新教训                      │                      │
│  │ • System Prompt 中注入                    │                      │
│  │ • AI 遵循教训，不再犯同样的错误            │                      │
│  └─────────────────────────────────────────┘                      │
└────────────────────────────────────────────────────────────────────┘
```

#### 6.8.7 ConfigLoader 适配

需要在 `ConfigLoader` 中增加缓存失效方法，供 `LessonsLearnedUpdater` 调用：

```typescript
// src/config-loader.ts — 新增方法

export class ConfigLoader {
  // ... 现有代码 ...

  /**
   * 强制失效缓存（Lessons Learned 更新后调用）
   * 下次 loadAll() 会重新读取所有 AIEOS 文件
   */
  invalidateCache(): void {
    this.cache = null;
    this.lastLoad = 0;
  }

  /**
   * 获取当前 SOUL.md 中的 Lessons Learned section
   * 用于 LessonExtractor 去重检查
   */
  async getLessonsLearned(): Promise<string> {
    const config = await this.loadAll();
    const match = config.soul.match(/## Lessons Learned[\s\S]*/);
    return match?.[0] || "";
  }
}
```

#### 6.8.8 手动管理能力

除了自动更新，用户也应能够手动管理 Lessons Learned：

```typescript
// src/lessons/manual-management.ts

import type { LessonsLearnedUpdater } from "./lessons-updater";

/**
 * 用户通过自然语言指令管理 Lessons Learned
 * 在对话中识别如下意图：
 * - "记住：以后不要..."     → 手动添加教训
 * - "删掉那条关于...的教训"  → 删除指定教训
 * - "查看学到的教训"        → 展示当前所有教训
 */
export async function handleLessonCommand(
  userMessage: string,
  configLoader: ConfigLoader,
): Promise<{ handled: boolean; response?: string }> {
  // 手动添加
  const addMatch = userMessage.match(
    /记住[：:]\s*(.+)|remember[：:]\s*(.+)/i,
  );
  if (addMatch) {
    const lesson = addMatch[1] || addMatch[2];
    // 直接添加为 "用户偏好与习惯" 类别
    return {
      handled: true,
      response: `已记录到 Lessons Learned：${lesson}`,
    };
  }

  // 查看教训
  if (/查看.*(教训|lessons)|show.*lessons/i.test(userMessage)) {
    const lessons = await configLoader.getLessonsLearned();
    return {
      handled: true,
      response: lessons || "当前没有记录任何教训。",
    };
  }

  return { handled: false };
}
```

#### 6.8.9 防膨胀策略

SOUL.md 直接注入 System Prompt，因此必须严格控制 Lessons Learned 的体积：

| 策略 | 具体措施 | 限制 |
|------|---------|------|
| **单分类上限** | 每个子 section 最多 20 条 | 超出时淘汰最旧条目 |
| **总量上限** | 所有分类合计最多 80 条 | 按时间戳淘汰 |
| **合并去重** | 新教训与已有教训语义重复时合并 | LLM 辅助判断 |
| **Token 预算** | Lessons Learned 总计 ≤ 2000 Token | 约 40-60 条短教训 |
| **定期清理** | 每月自动审查，移除不再适用的过时教训 | 可选的定时任务 |

#### Token 影响估算

| 教训条数 | 预估 Token | 占 System Prompt 比例 | 影响 |
|---------|-----------|---------------------|------|
| 10 条 | ~300 Token | ~2% | 几乎无影响 |
| 30 条 | ~900 Token | ~5% | 轻微增加 |
| 60 条 | ~1800 Token | ~10% | 可接受上限 |
| 80 条（上限） | ~2400 Token | ~13% | 需要关注 |

#### 6.8.10 项目目录更新

新增的文件：

```
ai-assistant/
├── src/
│   ├── lessons/                    # 新增：Lessons Learned 模块
│   │   ├── error-detector.ts       # 错误信号检测
│   │   ├── lesson-extractor.ts     # 经验提炼（LLM）
│   │   ├── lessons-updater.ts      # SOUL.md 更新器
│   │   └── manual-management.ts    # 手动管理命令
│   ├── index.ts                    # 修改：集成错误检测
│   ├── config-loader.ts            # 修改：新增 invalidateCache()
│   └── ...
├── config/
│   └── SOUL.md                     # 修改：新增 ## Lessons Learned section
└── ...
```


---

## 七、记忆分类、存储结构与读写时机

### 7.1 六类记忆体系

OpenViking 内置 6 类记忆，每类有不同的读写策略：

| 记忆类型 | 说明 | 示例 | 更新策略 |
|----------|------|------|----------|
| **Fact** | 客观事实 | "用户在字节跳动工作" | 新事实覆盖旧事实 |
| **Preference** | 偏好习惯 | "偏好 TypeScript，使用 Bun" | 追加或更新 |
| **Procedure** | 工作流程 | "部署：build → push → apply" | 整体替换 |
| **Episodic** | 事件经历 | "上周五调试了 OOM 问题" | 仅追加，不覆盖 |
| **Semantic** | 领域知识 | "用户理解的微服务架构是..." | 合并更新 |
| **Meta** | 元信息 | "记忆更新频率：每日 3-5 条" | 系统自动维护 |

### 7.2 VikingFS 存储结构详解

#### 目录总览

```
viking://
├── agent/
│   ├── config/                   # AIEOS 协议文件
│   │   ├── SOUL.md
│   │   ├── IDENTITY.md
│   │   ├── USER.md
│   │   └── AGENTS.md
│   ├── skills/                   # Agent 技能定义
│   └── graph/                    # 轻量图谱
│       ├── entities/             # 实体文件
│       └── relations/            # 关系索引
├── user/
│   └── memories/                 # 记忆存储（核心）
│       ├── facts/                # 事实记忆
│       │   ├── user-works-at-bytedance/
│       │   ├── user-prefers-bun-runtime/
│       │   └── ...
│       ├── preferences/          # 偏好记忆
│       │   ├── code-style-typescript/
│       │   ├── response-format-concise/
│       │   └── ...
│       ├── procedures/           # 流程记忆
│       │   ├── deploy-workflow/
│       │   └── ...
│       ├── episodic/             # 情景记忆
│       │   ├── 2026-03-04-debug-oom/
│       │   └── ...
│       ├── semantic/             # 语义记忆（Reflect 产出）
│       │   ├── user-architecture-philosophy/
│       │   └── ...
│       └── meta/                 # 元记忆
│           ├── memory-stats/
│           └── ...
├── resources/                    # 用户上传的知识库
│   ├── docs/
│   ├── code/
│   └── media/
└── sessions/                     # 会话历史
    ├── session-abc123/
    └── ...
```

#### 单条记忆的文件结构

每条记忆是 VikingFS 中的一个**目录**，包含三层内容文件：

```
viking://user/memories/facts/user-works-at-bytedance/
│
├── content.md          # L2：完整内容（原始记忆全文）
│                         ┌──────────────────────────────────────┐
│                         │ 用户在字节跳动的CIS AI应用团队工作。    │
│                         │ 入职时间约2024年。                     │
│                         │ 日常使用 TypeScript + Bun 技术栈。     │
│                         │ 参与AI助手相关项目开发。                │
│                         │                                      │
│                         │ 来源：2026-03-01 对话                 │
│                         │ 置信度：高（用户直接陈述）              │
│                         └──────────────────────────────────────┘
│
├── .overview.md         # L1：概览（OpenViking VLM 自动生成，~2000 tokens）
│                         ┌──────────────────────────────────────┐
│                         │ 用户在字节跳动CIS团队工作，2024年入职。 │
│                         │ 技术栈为 Bun + TypeScript。            │
│                         └──────────────────────────────────────┘
│
├── .abstract.md         # L0：摘要（OpenViking VLM 自动生成，~100 tokens）
│                         ┌──────────────────────────────────────┐
│                         │ 字节跳动CIS团队，TS+Bun技术栈         │
│                         └──────────────────────────────────────┘
│
├── .embedding.vec       # Dense 向量索引（sqlite-vec 管理）
│                         [0.032, -0.018, 0.045, ... ] (1024 维)
│
└── .relations.json      # 关联关系
                          ┌──────────────────────────────────────┐
                          │ [                                    │
                          │   {                                  │
                          │     "uri": "viking://user/memories/  │
                          │            preferences/code-style-   │
                          │            typescript",              │
                          │     "reason": "semantic_similarity:  │
                          │              0.82"                   │
                          │   }                                  │
                          │ ]                                    │
                          └──────────────────────────────────────┘
```

### 7.3 记忆的完整读写时机

#### 7.3.1 写入时机（什么时候存）

| 写入时机 | 触发条件 | 写入动作 | 代码入口 |
|----------|----------|----------|----------|
| **会话提交** | 调用 `ov.commit(sessionId)` | OpenViking 自动从对话中提取记忆，决定 CREATE/UPDATE/MERGE/SKIP | `POST /api/v1/sessions/:id/commit` |
| **Pre-Compaction** | 对话 Token 达到 80% 容量 | 触发 commit 保存当前记忆，防止截断丢失 | `context-manager.ts → checkAndFlush()` |
| **对话结束** | 用户主动结束或超时（30分钟无活动） | 触发 commit | `session-manager.ts → onSessionEnd()` |
| **Reflect 产出** | 同类记忆 ≥5 条时 | Claude 提炼高层洞察 → 写入 semantic 类别 | `evolution/reflect.ts` |
| **Evolve 合并** | 检测到矛盾/冗余记忆 | 合并/替换/废弃旧记忆 | `evolution/evolve.ts` |
| **用户主动保存** | 用户说"记住这个" | 直接写入对应类别 | `ov.write(uri, content)` |
| **USER.md 更新** | AI 检测到新的持久偏好且用户确认 | 更新 USER.md 文件 | `config-loader.ts → updateUserProfile()` |

#### 写入流程详解

```
┌─────────────────────────────────────────────────────────────────┐
│                    记忆写入完整流程                               │
│                                                                  │
│  ① 会话对话（多轮）                                              │
│     User: "以后代码注释都用英文吧"                                │
│     Assistant: "好的，已记录偏好"                                 │
│                                                                  │
│  ② ov.commit(sessionId)                                         │
│     │                                                            │
│     ▼                                                            │
│  ③ OpenViking 内部处理：                                         │
│     a. 分析对话内容，识别可提取信息                                │
│     b. 分类：Preference 类别                                     │
│     c. 去重检查：搜索已有记忆                                     │
│        - 找到 "code-style-typescript" 记忆                       │
│        - 决策：UPDATE（更新已有记忆，追加"注释用英文"）             │
│     d. 生成 content.md（L2）                                     │
│     e. 调用火山引擎 Embedding API 生成向量 → 存入 sqlite-vec      │
│     f. 调用火山引擎 VLM API 生成 .overview.md（L1）和 .abstract.md（L0）│
│     g. 返回 { memories_extracted: 1 }                            │
│                                                                  │
│  ④ 异步进化（Bunqueue）                                          │
│     a. Link：搜索相似记忆 → 发现 "response-format-concise"       │
│        → ov.link() 建立关联                                      │
│     b. Reflect：检查 preferences 类别记忆数量                     │
│        → 若 ≥5 条，触发反思提炼                                   │
│     c. Evolve：检查是否与已有记忆矛盾                             │
│        → 若矛盾则合并处理                                        │
└─────────────────────────────────────────────────────────────────┘
```

#### 去重决策矩阵（OpenViking Session Commit 内置）

| 决策 | 条件 | 动作 |
|------|------|------|
| **CREATE** | 全新信息，无相似记忆 | 新建记忆文件 + 向量索引 |
| **UPDATE** | 已有记忆的补充/更新 | 更新 content.md → 重新生成 L0/L1 + 向量 |
| **MERGE** | 多条碎片记忆可合并为一条 | 合并 → 删除碎片 → 新建合并记忆 |
| **SKIP** | 与已有记忆重复 | 不操作 |

#### 7.3.2 读取时机（什么时候取）

| 读取时机 | 触发条件 | 读取内容 | 代码入口 |
|----------|----------|----------|----------|
| **会话启动** | 新对话请求到达 | AIEOS 4 文件（SOUL/IDENTITY/USER/AGENTS） | `config-loader.ts → loadAll()` |
| **每轮对话** | 用户发送消息 | 根据消息内容检索相关记忆 | `memory-retriever.ts → retrieveMemories()` |
| **上下文构建** | 检索完成后 | L0 → L1 → L2 渐进加载，受 Token 预算控制 | `memory-retriever.ts` 内的渐进加载逻辑 |
| **Link 操作** | 新记忆写入后 | 读取新记忆的 L0 摘要用于相似度搜索 | `evolution/link.ts` |
| **Reflect 操作** | 异步触发 | 批量读取同类记忆的 L0 摘要 | `evolution/reflect.ts` |
| **Evolve 操作** | 检测到冲突 | 读取已有记忆的 L2 完整内容用于对比 | `evolution/evolve.ts` |
| **图谱查询** | 需要实体关系上下文时 | 读取实体及其关联记忆的 L0 摘要 | `graph/entity-manager.ts → query()` |

#### 读取流程详解（每轮对话）

```
用户消息: "帮我继续做记忆系统的开发"
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 1: AIEOS 配置加载（会话首轮 or 缓存过期）                   │
│                                                                  │
│  ConfigLoader.loadAll()                                          │
│  ├── 读取 SOUL.md      → ~200 tokens（安全规则）                 │
│  ├── 读取 IDENTITY.md   → ~150 tokens（人格定义）                │
│  ├── 读取 USER.md       → ~300 tokens（用户画像）                │
│  └── 读取 AGENTS.md     → ~200 tokens（操作协议）                │
│                                                                  │
│  总计：~850 tokens（缓存 60 秒，不重复读取）                      │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 2: 记忆检索                                                │
│                                                                  │
│  retrieveMemories(ov, { query: "记忆系统开发" })                  │
│                                                                  │
│  并行执行两路搜索：                                               │
│  ├── ov.find({ query, target_uri: "viking://user/memories" })    │
│  │   → [facts/..., procedures/..., episodic/...]                 │
│  │   匹配到 12 条记忆                                            │
│  │                                                               │
│  └── ov.find({ query, target_uri: "viking://resources" })        │
│      → [docs/memory-design-v2.1.md, ...]                         │
│      匹配到 3 条资源                                              │
│                                                                  │
│  合并 15 条结果，按 score 排序                                    │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 3: 渐进式加载（Token 预算控制）                             │
│                                                                  │
│  Token 预算: 4000 tokens                                         │
│  剩余预算: 4000                                                  │
│                                                                  │
│  #1 (score=0.92): facts/user-works-at-bytedance                  │
│     剩余 > 2000 → 加载 L1 (overview)                             │
│     "字节跳动CIS团队，2024入职，Bun+TS技术栈"                     │
│     消耗 ~300 tokens → 剩余 3700                                 │
│                                                                  │
│  #2 (score=0.88): procedures/memory-system-design                │
│     剩余 > 2000 → 加载 L1                                       │
│     "记忆系统v2.1设计方案概览..."                                  │
│     消耗 ~1500 tokens → 剩余 2200                                │
│                                                                  │
│  #3 (score=0.85): episodic/2026-03-04-design-discussion          │
│     剩余 > 2000 → 加载 L1                                       │
│     "讨论了AIEOS协议和存储结构..."                                 │
│     消耗 ~800 tokens → 剩余 1400                                 │
│                                                                  │
│  #4 (score=0.80): preferences/code-style-typescript              │
│     剩余 < 2000 但 > 100 → 加载 L0 (abstract)                   │
│     "TypeScript偏好，Bun运行时"                                   │
│     消耗 ~50 tokens → 剩余 1350                                  │
│                                                                  │
│  #5-#8: 继续 L0 加载...                                          │
│     每条 ~50-100 tokens                                          │
│                                                                  │
│  最终使用 ~3200 tokens，注入 8 条记忆上下文                       │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 4: System Prompt 组装                                      │
│                                                                  │
│  [SOUL 规则]        ~200 tokens                                  │
│  [IDENTITY 人格]    ~150 tokens                                  │
│  [USER 画像]        ~300 tokens                                  │
│  [AGENTS 协议]      ~200 tokens                                  │
│  [记忆上下文]       ~3200 tokens                                 │
│  ─────────────────────────                                       │
│  合计 System:       ~4050 tokens                                 │
│  + 对话历史:        ~N tokens                                    │
│  = 总输入:          ~4050 + N tokens                             │
└─────────────────────────────────────────────────────────────────┘
```

### 7.4 记忆读写时机汇总表

| 场景 | 动作 | 读/写 | 读什么 / 写什么 | 同步/异步 |
|------|------|-------|----------------|-----------|
| 新会话开始 | 加载 AIEOS 配置 | **读** | SOUL + IDENTITY + USER + AGENTS | 同步 |
| 用户发消息 | 检索相关记忆 | **读** | find() → L0/L1/L2 渐进加载 | 同步 |
| 对话结束 | 提交会话 | **写** | commit() → 提取记忆 → 向量索引 | 同步 |
| Token 达 80% | Pre-Compaction | **读+写** | commit 保存 + 读 L0 作记忆锚点 | 同步 |
| commit 之后 | Link 关联发现 | **读+写** | 读 L0 搜索相似 → 写 link 关系 | **异步** |
| commit 之后 | Reflect 反思 | **读+写** | 读 L0 摘要 → 写 semantic 记忆 | **异步** |
| commit 之后 | Evolve 进化 | **读+写** | 读 L2 全文对比 → 写合并结果 | **异步** |
| 用户说"记住" | 主动保存 | **写** | 直接写入对应类别 | 同步 |
| 偏好变更确认 | 更新 USER.md | **写** | 更新配置文件 + VikingFS | 同步 |
| 图谱查询 | 实体关系遍历 | **读** | 实体 + 关联记忆 L0 | 同步 |

### 7.5 记忆生命周期状态机

```
                    ┌───────────┐
                    │  对话内容   │
                    └─────┬─────┘
                          │ ov.commit()
                          ▼
                    ┌───────────┐
                    │ 去重决策    │
                    └─────┬─────┘
              ┌───────┬───┴───┬────────┐
              ▼       ▼       ▼        ▼
          ┌──────┐┌──────┐┌──────┐┌──────┐
          │CREATE││UPDATE││MERGE ││ SKIP │
          └──┬───┘└──┬───┘└──┬───┘└──────┘
             │       │       │
             ▼       ▼       ▼
          ┌─────────────────────┐
          │    活跃记忆 (Active)  │
          │  - L0/L1/L2 已生成   │
          │  - 向量已索引         │
          │  - 可被检索           │
          └──────────┬──────────┘
                     │
         ┌───────────┼───────────┐
         ▼           ▼           ▼
    ┌─────────┐ ┌─────────┐ ┌─────────┐
    │ Link    │ │ Reflect │ │ Evolve  │
    │ 关联增强 │ │ 提炼洞察 │ │ 冲突处理 │
    └────┬────┘ └────┬────┘ └────┬────┘
         │           │           │
         ▼           ▼           ▼
    ┌─────────────────────────────────┐
    │       成熟记忆 (Mature)          │
    │  - 有关联关系                    │
    │  - 可能已被提炼为 semantic 记忆   │
    │  - 冲突已解决                    │
    └──────────────┬──────────────────┘
                   │ 长期未访问 / 被 Evolve 判定过时
                   ▼
    ┌─────────────────────────────────┐
    │       衰减记忆 (Decaying)        │
    │  - score 权重降低                │
    │  - 检索中排序靠后                │
    │  - P2 阶段实现时间衰减算法       │
    └──────────────┬──────────────────┘
                   │ Evolve 判定 DUPLICATE / 被合并
                   ▼
    ┌─────────────────────────────────┐
    │       归档/删除 (Archived)       │
    │  - 从活跃索引移除                │
    │  - 文件可保留供审计              │
    └─────────────────────────────────┘
```

### 7.6 Token 预算分配策略

整个 System Prompt 的 Token 预算管理：

```typescript
// Token 预算常量
const TOKEN_BUDGET = {
  // 最大上下文窗口（Claude Sonnet）
  MAX_CONTEXT: 128_000,

  // AIEOS 配置文件（固定开销）
  SOUL_MD: 200,
  IDENTITY_MD: 150,
  USER_MD: 300,
  AGENTS_MD: 200,

  // 记忆检索预算
  MEMORY_RETRIEVAL: 4_000,

  // 对话历史预算
  CONVERSATION_HISTORY: 100_000,

  // 输出预算
  MAX_OUTPUT: 4_096,

  // Pre-Compaction 阈值
  FLUSH_THRESHOLD: 0.8, // 80%
};

// 每轮对话 Token 分配
// System Prompt = AIEOS(~850) + Memories(~4000) = ~4850
// 对话历史 = MAX_CONTEXT - System - Output = ~119,000
// 当对话历史 > 119,000 * 0.8 ≈ 95,200 时触发 Pre-Compaction
```


---

## 八、混合检索机制

### 8.1 OpenViking 检索体系

| 方法 | 用途 | 特点 |
|------|------|------|
| `find(query)` | 语义搜索 | 意图分析 → 层级递归 → Rerank |
| `search(query)` | 精确搜索 | 直接向量搜索，更快速 |
| `grep(pattern)` | 正则搜索 | 精确文本匹配 |
| `glob(pattern)` | 模式匹配 | URI 路径匹配 |

### 8.2 find() 检索流程

```
用户查询
    │
    ▼
IntentAnalyzer ── 分析意图，生成搜索策略
    │
    ▼
HierarchicalRetriever
    ├── 1. 根目录搜索
    ├── 2. 命中目录递归
    ├── 3. 优先队列排序
    └── 4. 分数传播（α=0.5）
    │
    ▼
Rerank ── 精排模型二次排序
    │
    ▼
渐进式加载 ── L0 → L1 → L2 按需展开
```

### 8.3 记忆检索实现

```typescript
// memory-retriever.ts

import type { OpenVikingClient } from "./openviking-client";
import type { MatchedContext } from "./types";

interface RetrieveOptions {
  query: string;
  tokenBudget?: number;       // 默认 4000
  memoryTopK?: number;        // 默认 20
  resourceTopK?: number;      // 默认 10
}

export async function retrieveMemories(
  ov: OpenVikingClient,
  options: RetrieveOptions,
): Promise<MatchedContext[]> {
  const {
    query,
    tokenBudget = 4000,
    memoryTopK = 20,
    resourceTopK = 10,
  } = options;

  // 1. 并行检索记忆和资源
  const [memoryResults, resourceResults] = await Promise.all([
    ov.find({
      query,
      target_uri: "viking://user/memories",
      limit: memoryTopK,
    }),
    ov.find({
      query,
      target_uri: "viking://resources",
      limit: resourceTopK,
    }),
  ]);

  // 2. 合并并按分数排序
  const allResults = [...memoryResults, ...resourceResults].sort(
    (a, b) => b.score - a.score,
  );

  // 3. 渐进式上下文加载
  const contextItems: MatchedContext[] = [];
  let remaining = tokenBudget;

  for (const result of allResults) {
    if (remaining <= 0) break;

    if (remaining > 2000) {
      const content = await ov.overview(result.uri);
      contextItems.push({
        uri: result.uri, content, level: "L1", score: result.score,
      });
      remaining -= 2000;
    } else if (remaining > 100) {
      const content = await ov.abstract(result.uri);
      contextItems.push({
        uri: result.uri, content, level: "L0", score: result.score,
      });
      remaining -= 100;
    }
  }

  return contextItems;
}
```

### 8.4 上下文压缩效果

| 场景 | 记忆数 | 全量注入 | L1 注入 | L0 注入 | 节省 |
|------|--------|----------|---------|---------|------|
| 日常对话 | 5 条 | ~10,000 | ~5,000 | ~500 | 50~95% |
| 复杂任务 | 15 条 | ~30,000 | ~10,000 | ~1,500 | 67~95% |
| 全局回顾 | 50 条 | ~100,000 | ~20,000 | ~5,000 | 80~95% |

---

## 九、记忆进化引擎（自研 TypeScript）

核心差异化模块。OpenViking 提供基础记忆管理，进化引擎在其上提供高阶自进化能力。

### 9.1 进化操作

| 操作 | 触发条件 | 执行逻辑 | 异步 |
|------|----------|----------|------|
| **Reflect** | 同类记忆 ≥5 条 | LLM 从多条记忆提炼高层洞察 | ✅ Bunqueue |
| **Link** | 新记忆创建时 | 向量相似度发现关联 → VikingFS link | ✅ Bunqueue |
| **Evolve** | 检测到矛盾/更新 | 合并/替换/废弃旧记忆 | ✅ Bunqueue |

### 9.2 Reflect 操作

```typescript
// evolution/reflect.ts

import Anthropic from "@anthropic-ai/sdk";
import type { OpenVikingClient } from "../openviking-client";

const claude = new Anthropic();

export async function reflect(
  ov: OpenVikingClient,
  category: string,
): Promise<void> {
  const memories = await ov.find({
    query: `所有 ${category} 类记忆`,
    target_uri: `viking://user/memories/${category}`,
    limit: 50,
  });

  if (memories.length < 5) return;

  const abstracts = await Promise.all(
    memories.map((m) => ov.abstract(m.uri)),
  );

  const message = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `分析以下 ${abstracts.length} 条记忆摘要，提炼 2-3 条高层洞察。
每条洞察用一行输出，格式为 "- 洞察: ..."

${abstracts.map((a, i) => `${i + 1}. ${a}`).join("\n")}`,
      },
    ],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  const insights = text.split("\n").filter((line) => line.startsWith("- "));

  for (const insight of insights) {
    const content = insight.replace(/^- 洞察:\s*/, "");
    const slug = content.slice(0, 50).replace(/\s+/g, "-").toLowerCase();
    await ov.write(`viking://user/memories/semantic/${slug}`, content);
  }
}
```

### 9.3 Link 操作

```typescript
// evolution/link.ts

export async function linkMemory(
  ov: OpenVikingClient,
  newMemoryUri: string,
): Promise<void> {
  const content = await ov.abstract(newMemoryUri);

  const similar = await ov.search({
    query: content,
    target_uri: "viking://user/memories",
    limit: 5,
  });

  for (const result of similar) {
    if (result.score > 0.75 && result.uri !== newMemoryUri) {
      await ov.link(
        newMemoryUri,
        [result.uri],
        `semantic_similarity:${result.score.toFixed(2)}`,
      );
    }
  }
}
```

### 9.4 Evolve 操作

```typescript
// evolution/evolve.ts

export async function evolveMemory(
  ov: OpenVikingClient,
  newContent: string,
  existingUri: string,
): Promise<void> {
  const existing = await ov.read(existingUri);

  const message = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: `对比两条记忆，输出一个词表示关系：
已有：${existing}
新增：${newContent}

SUPERSEDE（新替代旧）| SUPPLEMENT（新补充旧）| CONTRADICT（矛盾需合并）| DUPLICATE（重复跳过）`,
      },
    ],
  });

  const relation = message.content[0].type === "text"
    ? message.content[0].text.trim() : "DUPLICATE";

  switch (relation) {
    case "SUPERSEDE":
      await ov.write(existingUri, newContent);
      break;
    case "SUPPLEMENT": {
      const merged = await mergeMemories(existing, newContent);
      await ov.write(existingUri, merged);
      break;
    }
    case "CONTRADICT": {
      const resolved = await resolveContradiction(existing, newContent);
      await ov.write(existingUri, resolved);
      break;
    }
    // DUPLICATE → 不操作
  }
}
```

### 9.5 Bunqueue 异步任务调度

```typescript
// evolution/scheduler.ts

import { Queue } from "bunqueue";

interface EvolutionJob {
  type: "reflect" | "link" | "evolve";
  payload: Record<string, unknown>;
}

const evolutionQueue = new Queue<EvolutionJob>("memory-evolution", {
  concurrency: 2,
  retries: 1,
});

evolutionQueue.process(async (job) => {
  switch (job.data.type) {
    case "reflect":
      await reflect(ov, job.data.payload.category as string);
      break;
    case "link":
      await linkMemory(ov, job.data.payload.uri as string);
      break;
    case "evolve":
      await evolveMemory(
        ov,
        job.data.payload.newContent as string,
        job.data.payload.existingUri as string,
      );
      break;
  }
});

export function schedulePostCommit(
  sessionId: string,
  extractedMemories: string[],
): void {
  for (const uri of extractedMemories) {
    evolutionQueue.add({ type: "link", payload: { uri } });
  }
  evolutionQueue.add({ type: "reflect", payload: { category: "facts" } });
}
```

---

## 十、轻量图谱（自研 TypeScript）

### 10.1 设计思路

利用 OpenViking 的 `link/relations` + VikingFS 文件模拟轻量图谱，不引入独立图数据库。

### 10.2 实体管理

```typescript
// graph/entity-manager.ts

export class EntityManager {
  constructor(private ov: OpenVikingClient) {}

  async upsertEntity(
    name: string,
    description: string,
    properties?: Record<string, string>,
  ): Promise<string> {
    const slug = name.replace(/\s+/g, "-").toLowerCase();
    const uri = `viking://agent/graph/entities/${slug}`;

    const content = [
      `# ${name}`, "", description, "",
      properties
        ? Object.entries(properties)
            .map(([k, v]) => `- **${k}**: ${v}`)
            .join("\n")
        : "",
    ].join("\n");

    await ov.write(`${uri}/content.md`, content);
    return uri;
  }

  async addRelation(
    fromEntity: string, toEntity: string, relationType: string,
  ): Promise<void> {
    await ov.link(
      `viking://agent/graph/entities/${fromEntity}`,
      [`viking://agent/graph/entities/${toEntity}`],
      relationType,
    );
  }

  async linkToMemory(
    entitySlug: string, memoryUri: string, reason: string,
  ): Promise<void> {
    await ov.link(
      `viking://agent/graph/entities/${entitySlug}`,
      [memoryUri],
      `related_memory:${reason}`,
    );
  }

  async query(entitySlug: string, depth = 2): Promise<GraphQueryResult> {
    const uri = `viking://agent/graph/entities/${entitySlug}`;
    const result: GraphQueryResult = { entity: entitySlug, relations: [] };

    const relations = await this.ov.relations(uri);
    for (const rel of relations) {
      const abstract = await this.ov.abstract(rel.uri);
      result.relations.push({
        target: rel.uri, reason: rel.reason, abstract,
      });

      if (depth > 1) {
        const subRelations = await this.ov.relations(rel.uri);
        for (const sub of subRelations) {
          const subAbstract = await this.ov.abstract(sub.uri);
          result.relations.push({
            target: sub.uri, reason: sub.reason,
            abstract: subAbstract, via: rel.uri,
          });
        }
      }
    }

    return result;
  }
}

interface GraphQueryResult {
  entity: string;
  relations: {
    target: string;
    reason: string;
    abstract: string;
    via?: string;
  }[];
}
```

---

## 十一、Pre-Compaction Memory Flush

### 11.1 机制说明

当对话上下文接近 Token 上限时，在截断前静默保存记忆，防止信息丢失。

### 11.2 实现方案

```typescript
// context-manager.ts

export class ContextManager {
  constructor(
    private ov: OpenVikingClient,
    private maxTokens = 128_000,
    private flushThreshold = 0.8,
  ) {}

  async checkAndFlush(
    sessionId: string,
    currentTokens: number,
  ): Promise<string | null> {
    if (currentTokens / this.maxTokens < this.flushThreshold) {
      return null;
    }

    await this.ov.commit(sessionId);

    const keyMemories = await this.ov.find({
      query: "当前会话关键信息",
      target_uri: "viking://user/memories",
      limit: 10,
    });

    const abstracts = await Promise.all(
      keyMemories.map((m) => this.ov.abstract(m.uri)),
    );

    const anchor = [
      "## 关键记忆（上下文压缩后保留）",
      ...abstracts.map((a) => `- ${a}`),
    ].join("\n");

    return anchor;
  }
}
```

