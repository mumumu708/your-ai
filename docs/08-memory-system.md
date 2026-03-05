# 第8章 记忆系统
> **本章目标**：设计 YourBot 的五层记忆体系，实现跨会话的持久化记忆、智能检索和 AIEOS 协议集成。
## 8.1 记忆系统概述
记忆系统是 YourBot 区别于普通 AI 聊天工具的核心差异化能力。YourBot 的记忆系统参考了 OpenClaw 的三层记忆架构，并融合 AIEOS 协议的设计理念，构建了五层记忆体系。
## 8.2 记忆层级详解


| 层级 | 名称 | 存储位置 | 生命周期 | 内容 |
| --- | --- | --- | --- | --- |
| L1 | Working Memory | 内存 | 当前请求 | 当前对话上下文 |
| L2 | Session Memory | 文件 | 单次会话 | 会话内多轮对话摘要 |
| L3 | Daily Memory | 文件 | 1天 | 每日交互摘要、新发现的偏好 |
| L4 | Global Memory | 文件 | 永久 | 用户画像、长期偏好、知识库 |
| L5 | AIEOS Identity | 文件 | 永久 | Agent 身份、灵魂、能力注册 |


### 层级迁移流程
```plaintext
L1 Working Memory (当前对话)
  │ 会话结束时提取关键信息
  ▼
L2 Session Memory (会话摘要)
  │ 每日定时合并
  ▼
L3 Daily Memory (日志摘要)
  │ 周期性提练为长期记忆
  ▼
L4 Global Memory (用户画像)
  │ 影响 Agent 行为准则
  ▼
L5 AIEOS Identity (SOUL.md / USER.md)
```

### Working Memory 实现
```typescript
export class WorkingMemory {
  private context: ConversationContext;
  private readonly maxTokens: number;

  addMessage(message: Message): void {
    this.context.messages.push(message);
    if (this.estimateTokens() > this.maxTokens * 0.8) {
      this.compress();
    }
  }

  private compress(): void {
    // 将较早的消息压缩为摘要
    const oldMessages = this.context.messages.splice(0, Math.floor(this.context.messages.length / 2));
    const summary = this.summarize(oldMessages);
    this.context.summaries.push(summary);
  }
}
```

### Session Memory 实现
会话结束时自动提取关键信息：
```typescript
export class SessionMemoryExtractor {
  async extract(sessionMessages: Message[]): Promise<SessionSummary> {
    const prompt = `请从以下对话中提取：
    1. 摘要（100字内）
    2. 关键信息（人名、日期、任务）
    3. 待跟进事项
    4. 用户偏好发现`;
    return await this.llm.extract(prompt, sessionMessages);
  }
}
```

## 8.3 AIEOS 协议实现
AIEOS (AI Entity Operating System) 协议通过 Markdown 文件定义 Agent 的身份和行为：


| 文件 | 用途 | 修改权限 |
| --- | --- | --- |
| IDENTITY.md | Agent 基本身份 | 系统管理员 |
| SOUL.md | 性格特征、行为准则 | Agent 自我进化 |
| USER.md | 用户偏好、历史摘要 | 自动更新 |
| AGENTS.md | 能力注册表 | Agent 学习新技能时 |


## 8.4 记忆检索引擎
采用 BM25 + 向量混合检索，融合时间衰减和 MMR 重排序：
```typescript
export class MemoryRetriever {
  async search(query: string, options: SearchOptions): Promise<MemoryResult[]> {
    // BM25 关键词检索
    const bm25Results = this.bm25Search(query);
    // 向量相似度检索
    const vectorResults = await this.vectorSearch(query);
    // 融合排序
    const merged = this.reciprocalRankFusion(bm25Results, vectorResults);
    // 时间衰减：越新的记忆权重越高
    const timeWeighted = this.applyTimeDecay(merged);
    // MMR 重排序：平衡相关性和多样性
    return this.mmrRerank(timeWeighted, options.topK);
  }
}
```

---
