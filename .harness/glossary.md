# 术语表

| 术语 | 含义 |
|------|------|
| **AIEOS** | AI 助手操作系统协议。config/ 下的四个 Markdown 文件（SOUL/IDENTITY/USER/AGENTS），定义 AI 助手的人格、身份、用户画像和行为配置 |
| **SOUL.md** | AI 助手的核心人格定义（价值观、沟通风格、行为边界） |
| **IDENTITY.md** | AI 助手的身份信息（名字、背景、角色定位） |
| **USER.md** | 用户画像（兴趣、偏好、习惯），由 onboarding 和日常交互逐步填充 |
| **AGENTS.md** | Agent 行为配置（响应策略、工具使用权限、交互模式） |
| **UserSpace** | 每个用户的独立工作空间，包含个性化的 AIEOS 文件副本和记忆数据 |
| **UserConfigLoader** | 用户配置加载器，三级回退：本地文件 → OpenViking FS → 全局默认(config/) |
| **ConfigLoader** | 全局配置加载器，读取 config/ 目录下的 AIEOS 默认模板 |
| **OpenViking** | 自研向量/图数据库，用于记忆存储、语义检索和会话管理 |
| **CentralController** | 核心编排器（单例），消息的统一入口，负责分类→分发→编排 |
| **AgentRuntime** | Agent 运行时，根据任务复杂度路由到 Claude Code 或 LightLLM |
| **ClaudeAgentBridge** | Claude CLI 子进程封装，通过 `claude -p` 执行复杂任务 |
| **LightLLM** | 轻量 LLM 客户端，兼容 OpenAI API，用于简单任务（DeepSeek/Qwen 等） |
| **TaskClassifier** | 任务分类器，两层架构：规则匹配（快） + LLM 兜底（慢），输出 simple/complex |
| **KnowledgeRouter** | 知识路由器，构建 system prompt：加载 AIEOS 配置 + 检索相关记忆 + Token 预算分配 |
| **TokenBudgetAllocator** | Token 预算分配器，在有限上下文窗口内分配各类知识的 token 配额 |
| **PostResponseAnalyzer** | 回复后分析器，检测用户纠正行为并提取经验教训 |
| **EvolutionScheduler** | 进化调度器，安排记忆提交和经验学习 |
| **OnboardingManager** | 新用户引导管理器，多步对话状态机，完成初始人格配置 |
| **SessionManager** | 会话管理器，维护用户对话历史和上下文 |
| **WorkspaceManager** | 工作空间管理器，初始化用户目录结构和 MCP 配置 |
| **StreamHandler** | 流式输出处理器，将 LLM 流式响应推送到各通道 |
| **MessageRouter** | 消息路由器，将通道消息统一格式化后分发到 CentralController |
| **ChannelManager** | 通道管理器，注册和管理 Feishu/Telegram/Web 通道 |
| **Harness** | 工程模式，管理员通过对话触发代码修改等工程任务时的运行模式 |
| **check:all** | 全量质量检查命令，包含 lint + 架构检查 + 测试 |
| **MCP** | Model Context Protocol，AI Agent 的工具协议，mcp-servers/ 通过 stdio 通信 |
| **Biome** | 代码 lint + 格式化工具，替代 ESLint + Prettier |
