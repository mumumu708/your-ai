# 常见陷阱库

Agent 每次犯错后须追加一条，随代码一起提交。管理员 review 时审核。

| 编号 | 陷阱 | 修复指令 |
|------|------|---------|
| P-001 | 在 shared/ 引入有状态逻辑或业务依赖 | shared/ 必须零依赖（纯类型+工具函数）。将有状态逻辑移至 kernel/ 对应子模块 |
| P-002 | MCP Server 直接 import kernel 内部模块 | MCP Server 通过 stdio 隔离，只能引用 mcp-servers/shared/。需要的类型提取到 shared/ |
| P-003 | 外部调用（LLM/API）缺少超时或错误处理 | 所有 LLM/API 调用必须设超时。参考 ClaudeAgentBridge 的 signal + processStream 模式 |
| P-004 | 修改 config/ 下 AIEOS 文件未评估用户侧影响 | config/ 是全局默认模板，会被复制到新用户的 user-space。修改前评估 UserConfigLoader 的三级回退链路 |
| P-005 | 测试直接依赖外部服务（OpenViking/LLM API） | 测试中使用 mock。参考现有测试中的 mock 模式 |
| P-006 | user-space 路径硬编码 | 必须通过配置/环境变量获取，不能硬编码 `user-space/` 路径 |
| P-007 | kernel 子模块间直接引用内部文件 | 子模块间通过 index.ts 桶文件引用公开 API，禁止 import 对方内部文件 |
| P-008 | 使用 `any` 类型 | Biome 规则 `noExplicitAny: error`，使用具体类型或 `unknown` + 类型守卫 |
| P-009 | CentralController 外部直接实例化 | 必须通过 `CentralController.getInstance(deps)` 获取单例。测试中使用 `resetInstance()` |
| P-010 | 忘记在新模块的 index.ts 中导出公开 API | 每个 kernel 子模块必须有 index.ts，导出外部需要的类/类型/函数 |
| P-011 | Harness 任务被路由到 LightLLM（无工具访问） | Harness 任务必须 forceComplex 走 Claude 路径，LightLLM 无法执行 bash/git |
| P-012 | shared/ 类型文件间循环依赖 | shared/ 中的类型文件互相 import 会造成循环。解决：用 inline 联合类型代替跨文件 import（如 UnifiedClassifyResult 中 taskType 直接写联合字面量而非 import TaskType） |
| P-013 | catch 块中 return 误杀后续逻辑 | `try { mkdir() } catch { return; }` 会阻止后续 sync 逻辑。"目录已存在"是正常情况，catch 应仅消化异常而非 return |
| P-014 | 飞书 API 响应需通过 resp.data 访问 | Lark SDK v3 的 `im.chat.create` 等 API 返回 `{ data: { chat_id } }` 而非直接 `{ chat_id }`，忘记 `.data` 会导致 TS 编译错误和运行时 undefined |
| P-015 | 流式卡片 sendDone 传入空内容 | 飞书 streamUpdateText API 要求非空文本，当 LLM 返回空内容时需降级为占位文本，否则返回 99992402 field validation failed |

---

**纪律**：每次 Agent 犯错 → 立即追加一条 → 随代码一起提交。
