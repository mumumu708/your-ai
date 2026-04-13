# DD-020: 架构升级集成测试设计

- **状态**: Draft
- **作者**: Agent + 管理员
- **创建日期**: 2026-04-12
- **最后更新**: 2026-04-12
- **上游**: [DD-011](011-architecture-upgrade-v2.md)

## 背景

架构升级 V2 变更 98 个文件、13K+ 行插入。现有单元测试验证模块内部逻辑，本文档设计集成测试验证**模块间真实协作**。

本文档完全从真实代码路径推导，所有场景均对应 `central-controller.ts` 中的具体代码行。无场景依赖未实现的代码。

---

## 方法论：从真实代码路径出发

### 主入口路径映射（central-controller.ts）

```
handleIncomingMessage()                     ← 所有入口
├── resolveSession()                        [line 418]
├── workspaceManager.initializeWithMcp()    [line 426, 如无 workspacePath]
├── onboardingManager.tryRestoreState()     [line 448]
├── isOnboarding → processResponse()        [line 451-463]
├── needsOnboarding → startOnboarding()     [line 466-477]
│   （返回，不继续）
├── fileUploadHandler.isUserProfileUpload() [line 485-497]
│   → handleUserMdUpload()
├── harnessWorktreeSlotId + /end pattern    [line 501-504]
│   → handleHarnessEnd()
├── scheduleCancelManager.isPendingSelection() [line 507-518]
│   → processSelection()
├── session.harnessWorktreeSlotId → force harness [line 523-531]
├── classifyIntent()                        [line 533]
├── harness + admin + no worktree           [line 537-563]
│   → maybeCreateHarnessGroupChat()
│   → re-resolveSession with groupChatId
├── taskDispatcher.dispatch()               [line 596-613, if taskStore present]
│   （返回 taskId，无 content）
└── sessionSerializer.run(orchestrate())    [line 621, fallback path]

orchestrate()                               [line 641]
├── chat    → executeChatPipeline()
├── scheduled → handleScheduledTask()
│   ├── subIntent=cancel → scheduleCancelManager.startCancelFlow()
│   ├── subIntent=list   → handleListScheduledTasks()
│   └── default          → nlToCron() → scheduler.register()
├── automation → taskQueue.enqueue()
├── system    → handleSystemTask()
│   └── command=setup → onboardingManager.reset+start
└── harness   → handleHarnessTask()
    ├── !isAdmin → downgrade to executeChatPipeline()
    ├── session has worktree → executeChatPipeline(cwdOverride, forceComplex)
    └── first message → worktreePool.acquire() → executeChatPipeline(cwdOverride, forceComplex)

executeChatPipeline()                       [line 797]
├── mediaProcessor.processAttachments()     [line 808, if attachments]
├── sessionManager.addMessage(user)         [line 830]
├── ovClient.addMessage(user)               [line 839]
├── StreamContentFilter + adapters          [line 846-875]
│   ├── streamAdapterFactory exists → StreamHandler.createStreamCallback()
│   └── streamCallback exists → raw callback with filter
├── sessionManager.getContextMessages()     [line 878]
├── contextManager.checkAndFlush()          [line 886]
├── !frozenSystemPrompt → SystemPromptBuilder.build()  [line 905-959]
│   └── on error → KnowledgeRouter.buildContext() fallback
├── buildTurnContext()                      [line 963-982]
│   └── includes mcpDelta if activeMcpServers/previousMcpServers set
├── assemble finalSystemPrompt              [line 984-995]
├── intelligenceGateway.handle()            [line 1006-1065]
│   └── on error → agentRuntime.execute() fallback
│   else agentRuntime.execute() directly   [line 1067-1082]
├── postResponseAnalyzer.analyzeExchange()  [line 1104]
│   └── if feedbackText → routeAnalysis()  [line 1117]
├── ovClient.addMessage(assistant)          [line 1131]
├── sessionManager.addMessage(assistant)    [line 1137]
└── return TaskResult {content, streamed?}  [line 1143]

initScheduler()                             [line 1392]
└── scheduler.setExecutor()
    └── on trigger: resolveSession → executeChatPipeline → ch.sendMessage()

sessionManager.setOnSessionClose()          [line 298]
├── worktreePool.release()                  [if harnessWorktreeSlotId]
├── ovClient.commit()
├── evolutionScheduler.schedulePostCommit() [if memories extracted]
└── reflectionTrigger.shouldReflect()       [if sessionStore]
    └── taskDispatcher.dispatch(type=system) [if shouldReflect && taskDispatcher]
```

---

## 实施分层

| 层 | 含义 | 场景数 |
|---|------|--------|
| **Tier 1** | 模块可独立组合测试，无需完整 controller | 42 |
| **Tier 2** | 需要完整 controller 集成（含 TaskDispatcher/SessionStore） | 38 |
| **Deferred** | 代码不存在或生产路径未接通，明确原因已记录 | 6 |

**总计 86 个场景**（Tier 1: 42，Tier 2: 38，Deferred: 6）。

---

## 真实 vs Mock 原则

| 真实运行 | Mock |
|---------|------|
| SQLite `:memory:`、SessionStore、TaskStore、TaskDispatcher、SessionManager、SessionSerializer、StreamHandler、StreamContentFilter、StreamBuffer、SkillIndexBuilder、SystemPromptBuilder（离线）、TurnContextBuilder、MediaProcessor（本地文件）、OnboardingManager、FileUploadHandler、QueueAggregator、ReflectionTrigger、AnalysisRouter、ScheduleCancelManager、WorktreePool（fake slot）、nlToCron | ConfigLoader（空配置）、OpenVikingClient（stub）、ClaudeAgentBridge（stub）、LightLLMClient（stub）、FeishuStreamDeps（stub）、WorkspaceManager（tmpdir） |

---

## 测试文件组织

```
src/integration/upgrade-v2/
├── message-routing.integration.test.ts      # handleIncomingMessage 全分支（16 场景）
├── chat-pipeline.integration.test.ts        # executeChatPipeline 完整链路（18 场景）
├── prompt-assembly.integration.test.ts      # 系统提示构建 + frozen/fallback（8 场景）
├── task-lifecycle.integration.test.ts       # TaskDispatcher + 持久化 + shutdown（12 场景）
├── scheduler-pipeline.integration.test.ts   # 定时任务 CRUD + 触发执行（10 场景）
├── session-close.integration.test.ts        # 会话关闭回调链（8 场景）
├── streaming.integration.test.ts            # StreamHandler + Filter + Adapter（10 场景）
├── harness-worktree.integration.test.ts     # Harness 模式 + worktree 生命周期（8 场景）
└── bootstrap.integration.test.ts            # 网关启动 + 中断标记（4 场景）
```

---

## Tier 1 场景（42 个）

### MR（Message Routing）— 16 场景

**MR-01** 新用户首次消息 → needsOnboarding=true → startOnboarding 返回引导文本
代码路径: `handleIncomingMessage` line 466-477
验证: result.data.content 包含引导文本；`isOnboarding(userId)` 返回 true

**MR-02** Onboarding 中用户响应 → processResponse 继续流程
代码路径: line 451-463
验证: result.data.content 非空；onboarding 状态机前进

**MR-03** Onboarding 完成（最后一步）→ isOnboarding 变为 false
代码路径: line 451-463，state machine 终止
验证: 第 N 次 processResponse 后 isOnboarding=false

**MR-04** 进程重启后 tryRestoreState 恢复 onboarding 状态
代码路径: line 448
验证: 新 OnboardingManager 实例 + tryRestoreState 调用后 isOnboarding 与重启前一致

**MR-05** USER.md 文件上传（base64 路径）→ handleUserMdUpload 处理
代码路径: line 485-497, handleUserMdUpload line 1274
验证: result.data.content 包含成功消息；userConfigLoader 持久化了 USER.md

**MR-06** USER.md 上传（fileKey 路径，channel.downloadFile）
代码路径: line 1284-1291
验证: channelResolver 被调用；downloadFile 被调用

**MR-07** USER.md 上传但通道不支持 downloadFile → 返回错误提示
代码路径: line 1290
验证: result.data.content = '当前通道不支持文件下载...'

**MR-08** harness 会话中发送 "/end" → handleHarnessEnd 关闭会话
代码路径: line 501-504, handleHarnessEnd line 733
验证: result.data.content 包含 "Harness 任务结束"；branch/messageCount/durationMin 出现在摘要中；sessionManager.closeSession 被调用

**MR-09** harness 会话中发送 "结束任务" → 同 MR-08（正则匹配）
代码路径: line 500, HARNESS_END_PATTERN
验证: 与 MR-08 相同

**MR-10** scheduleCancelManager 有 pending selection → processSelection 路径
代码路径: line 507-518
验证: ScheduleCancelManager.isPendingSelection=true 时 processSelection 被调用

**MR-11** session 已有 worktreeSlotId → classifyResult 强制为 harness（不调用 classifier）
代码路径: line 523-531
验证: classifier.classify 未被调用；task.type = 'harness'

**MR-12** harness + 非 admin 用户 → 降级警告，不创建群聊
代码路径: line 537-541
验证: maybeCreateHarnessGroupChat 未被调用；任务类型仍为 harness（最终由 handleHarnessTask 降级）

**MR-13** harness + admin + feishu + 无 worktree → maybeCreateHarnessGroupChat 调用
代码路径: line 542-563
验证: channel.createGroupChat 被调用；session.harnessGroupChatId 被设置；re-resolve session with groupChatId

**MR-14** harness + admin + feishu + createGroupChat 失败 → 继续使用原会话
代码路径: line 782-787
验证: maybeCreateHarnessGroupChat 返回 null；session.harnessGroupChatId 未设置

**MR-15** taskDispatcher 存在 → dispatch 返回 taskId，data 无 content
代码路径: line 596-613
验证: result.data.content 为 undefined；result.taskId 为有效 ID；taskDispatcher.dispatch 被调用

**MR-16** taskDispatcher 不存在 → sessionSerializer.run(orchestrate()) 直接执行
代码路径: line 621
验证: result.data.content 非空；activeRequests 在执行中存在、完成后清空

---

### CP（Chat Pipeline）— 18 场景

**CP-01** 无附件纯文本消息 → mediaProcessor 不调用，content 原样写入 session
代码路径: line 807（if attachments）
验证: sessionManager.addMessage 中 content 等于 message.content；mediaRefs 为 undefined

**CP-02** 消息含图片附件 → mediaProcessor.processAttachments → mediaRefs 追加到 sessionContent
代码路径: line 808-820
验证: sessionContent 包含 "[图片: ...]"；addMessage 中 mediaRefs 非空

**CP-03** mediaProcessor 抛异常 → 降级为纯文本，流程继续
代码路径: line 815-819
验证: result.success=true；sessionContent = original message.content

**CP-04** streamAdapterFactory 存在 → StreamHandler.createStreamCallback() 被调用，result 包含 streamed=true
代码路径: line 850-865
验证: stream.result 被 await；result.data.streamed=true

**CP-05** streamAdapterFactory 不存在但 streamCallback 存在 → 使用原始 callback
代码路径: line 866-874
验证: streamCallback 调用时传入了 userId；StreamContentFilter.filter 被执行

**CP-06** StreamContentFilter 过滤掉 thinking 事件
代码路径: line 859-864
验证: 注入 thinking 类型事件时，rawCallback 不被调用

**CP-07** contextManager.checkAndFlush → 返回 anchor 文本，anchor 注入到 KnowledgeRouter fallback
代码路径: line 886
验证: ovClient.checkAndFlush 被调用；anchor 非 null 时出现在 systemPromptFallback 中

**CP-08** session.frozenSystemPrompt 不存在 → SystemPromptBuilder.build() 被调用，结果缓存到 session
代码路径: line 905-932
验证: 第一次调用后 session.frozenSystemPrompt 非 null；第二次调用 SystemPromptBuilder 不被再次调用

**CP-09** session.frozenSystemPrompt 已存在 → SystemPromptBuilder 不被调用
代码路径: line 905（if !session.frozenSystemPrompt）
验证: systemPromptBuilder.build 调用次数=0

**CP-10** SystemPromptBuilder.build() 抛异常 → fallback 到 KnowledgeRouter.buildContext()
代码路径: line 941-959
验证: result.success=true；systemPromptFallback 非空

**CP-11** prependContext 仅在第一条消息时注入到 finalSystemPrompt
代码路径: line 985-995
验证: session.messages.length=1 时 finalSystemPrompt 包含 prependContext；第二条消息不包含

**CP-12** intelligenceGateway 存在且成功 → result.channel = 'light_llm'（simple）或 'agent_sdk'（complex）
代码路径: line 1006-1046
验证: intelligenceGateway.handle 被调用；result.complexity 映射正确

**CP-13** intelligenceGateway.handle() 抛异常 → fallback 到 agentRuntime.execute()
代码路径: line 1047-1065
验证: agentRuntime.execute 被调用；result.success=true

**CP-14** intelligenceGateway 不存在 → 直接调用 agentRuntime.execute()
代码路径: line 1066-1082
验证: agentRuntime.execute 被调用；intelligenceGateway.handle 未被调用

**CP-15** result.toolsUsed 非空 → sessionManager.markToolUsed(sessionKey)
代码路径: line 1095-1097
验证: markToolUsed 被调用

**CP-16** postResponseAnalyzer 检测到 feedbackText → 追加到 responseContent，routeAnalysis 被调用
代码路径: line 1104-1127
验证: result.data.content 包含 "---\n" + feedbackText；routeAnalysis 被调用

**CP-17** postResponseAnalyzer 无反馈 → responseContent 不变
代码路径: line 1111
验证: result.data.content = agentRuntime result.content

**CP-18** forceComplex=true（harness 路径）→ agentRuntime.execute 收到 forceComplex=true
代码路径: line 1062
验证: agentRuntime.execute 参数中 forceComplex=true

---

### PA（Prompt Assembly）— 8 场景

**PA-01** SkillIndexBuilder.build() 从 workspaceInfo.availableSkills 生成 skillIndex
代码路径: line 910-917
验证: skillIndex 包含所有 skills 目录下的条目

**PA-02** SystemPromptBuilder.build() 结果通过 session.frozenSystemPrompt 缓存（非 builder 内部缓存）
代码路径: line 929-932
验证: session.frozenSystemPrompt.content 与 build() 返回值一致；再次进入 pipeline 不重建

**PA-03** buildPrependContext() 使用 USER.md 和 AGENTS.md
代码路径: line 935-940
验证: prependContext 包含 agentsConfig 和 userConfig 内容

**PA-04** buildTurnContext() invokedSkills 为空时不注入 skill 段
代码路径: line 973（session.invokedSkills 为 undefined）
验证: turnContext.content 不含 invokedSkills 相关文本

**PA-05** buildTurnContext() invokedSkills 非空时注入
代码路径: line 973
前提: session.invokedSkills 必须由生产代码写入（目前无生产路径写入此字段，见 Deferred PA-D1）
跳过：见 Deferred

**PA-06** buildTurnContext() postCompaction=true 时注入 postCompaction 提示
代码路径: line 974
前提: session.postCompaction 必须由生产代码写入（目前无生产路径写入，见 Deferred PA-D2）
跳过：见 Deferred

**PA-07** finalSystemPrompt = frozenContent + "\n\n" + turnContext.content
代码路径: line 989-995
验证: finalSystemPrompt 字符串格式正确

**PA-08** buildTurnContext() mcpServers 段：activeMcpServers={"mcp-x"}, previousMcpServers={}
代码路径: line 975-982，turn-context-builder.ts buildMcpDelta()
验证: turnContext.content 包含 mcpDelta 段；需手动设置 session.activeMcpServers

---

### ST（Streaming）— 10 场景

**ST-01** text_delta 事件经 StreamBuffer → flush → sendChunk
代码路径: stream-handler.ts line 44-58
验证: adapter.sendChunk 被调用；totalChunks 递增

**ST-02** buffer.shouldFlush()=false 时不 flush；done 事件触发 forceFlush
代码路径: line 49, 110-118
验证: done 前 sendChunk 未调用；done 后 sendChunk 调用

**ST-03** tool_use 事件 → forceFlush buffer → sendChunk 带工具名标签
代码路径: line 63-84
验证: sendChunk 收到 "> 🔧 toolName..." 格式文本

**ST-04** tool_result 事件 → sendChunk "> ✅ 完成"
代码路径: line 87-94
验证: adapter.sendChunk 收到 "> ✅ 完成\n\n"

**ST-05** error 事件 → adapter.sendError 被调用
代码路径: line 97-106
验证: adapter.sendError 收到 error message

**ST-06** source 抛异常 → forceFlush + sendError
代码路径: line 127-148
验证: adapter.sendError 被调用

**ST-07** 多 adapter → Promise.allSettled 并发分发
代码路径: line 210
验证: 2个 adapter 均收到 sendChunk；一个失败不影响另一个

**ST-08** StreamContentFilter 过滤 thinking 事件，通过 text_delta/tool_use/error/done
代码路径: chat-pipeline line 859-864
验证: thinking 类型事件被 filter() 返回 null；text_delta 返回原事件

**ST-09** createStreamCallback() → callback/result 分离模式
代码路径: stream-handler.ts line 165-201
验证: callback 推送事件后 result Promise 解析；fullContent 正确累积

**ST-10** streamResultPromise 在 executeChatPipeline 中被 await
代码路径: central-controller.ts line 1084-1086
验证: stream 完成后 pipeline 才返回；result.data.streamed=true

---

### SK（Scheduler）— 10 场景（Tier 1 基础部分）

**SK-01** nlToCron 成功解析 → scheduler.register() 返回 jobId
代码路径: handleScheduledTask line 1171-1206
验证: result.data.type='scheduled_registered'；result.data.jobId 非空

**SK-02** nlToCron 解析失败（confidence=0）→ 返回 error，不注册 job
代码路径: line 1174-1181
验证: result.success=false；scheduler.register 未被调用

**SK-03** subIntent='list' + 无活跃 job → 返回"没有活跃的定时任务"
代码路径: line 1166-1167, handleListScheduledTasks line 1214
验证: result.data.content='你目前没有活跃的定时任务。'

**SK-04** subIntent='list' + 有活跃 job → 返回格式化列表
代码路径: line 1209-1237
验证: result.data.content 包含 job.description 和下次执行时间

**SK-05** subIntent='cancel' → ScheduleCancelManager.startCancelFlow()
代码路径: line 1162-1163
验证: result.data.content 包含待取消 job 列表或"无可取消任务"

**SK-06** cancel 选择阶段：isPendingSelection=true，processSelection 匹配
代码路径: handleIncomingMessage line 507-518
验证: 指定编号后 job 被取消；result 包含确认文本

**SK-07** initScheduler → scheduler.loadJobs() 恢复持久化 jobs
代码路径: line 1393
验证: JobStore 预存 job → loadJobs 后 scheduler.listJobs 返回该 job

**SK-08** scheduler executor 触发 → executeChatPipeline → ch.sendMessage
代码路径: line 1395-1472
验证: executor 调用后 channel.sendMessage 被调用；task.type='chat'；metadata.isScheduledExecution=true

**SK-09** scheduler executor → channel 不存在 → 记录 error，不抛出
代码路径: line 1458-1469
验证: channelResolver 返回 undefined；无异常抛出

**SK-10** stopScheduler → scheduler.stop() + scheduler.persistJobs()
代码路径: line 1482-1485
验证: stop 和 persistJobs 均被调用

---

## Tier 2 场景（38 个）

### TL（Task Lifecycle）— 12 场景

**TL-01** TaskDispatcher.dispatch() → TaskStore 写入 pending 状态
代码路径: handleIncomingMessage line 596-613
前提: taskStore 已初始化（SQLite :memory:）
验证: taskStore.getTask(taskId).status = 'pending'

**TL-02** TaskDispatcher 执行完成 → TaskStore 状态变为 completed
代码路径: TaskDispatcher 内部 executor
验证: 执行后 taskStore.getTask(taskId).status = 'completed'

**TL-03** TaskDispatcher 并发限制（concurrency=4）：5 个任务同时 dispatch，第 5 个等待
代码路径: central-controller.ts line 293（concurrency: 4）
验证: 时间轴上不超过 4 个并发执行

**TL-04** TaskStore.markInterruptedOnStartup() → 将 running 状态任务标记为 interrupted
代码路径: gateway/index.ts line 69-72
验证: 预置 running 任务 → markInterrupted 后状态变为 interrupted

**TL-05** shutdown() → SessionStore.close() 刷新写队列
代码路径: line 1492-1494
验证: shutdown 后 sessionStore 无法写入；之前写入的 session 已持久化

**TL-06** shutdown() → TaskDispatcher.shutdown() 取消运行中任务
代码路径: line 1496-1498
验证: 长时间运行的 task 在 shutdown 后收到 signal.aborted=true

**TL-07** cancelRequest(taskId) → activeRequests 中 AbortController 触发 abort
代码路径: line 1361-1370（fallback path，无 taskDispatcher）
验证: signal.aborted=true；activeRequests.size 减 1

**TL-08** activeRequests 在 orchestrate 完成后自动清理
代码路径: line 623-625（finally block）
验证: 执行完成后 getActiveRequestCount()=0

**TL-09** sessionSerializer.run() 同一 sessionKey 串行执行
代码路径: line 621
验证: 两个并发请求同一 sessionKey，第二个等第一个完成后执行

**TL-10** sessionSerializer.run() 不同 sessionKey 并发执行
验证: 两个不同 sessionKey 的请求并发执行，无互相阻塞

**TL-11** automation task → taskQueue.enqueue()
代码路径: handleAutomationTask line 1241-1243
验证: result 为 taskQueue.enqueue() 返回值

**TL-12** system task command='setup' → onboardingManager.resetUser + startOnboarding
代码路径: handleSystemTask line 1250-1263
验证: isOnboarding=false 之后 setup → isOnboarding=true

---

### SC（Session Close）— 8 场景

**SC-01** 普通会话关闭 → ovClient.commit() 被调用
代码路径: setOnSessionClose line 316
验证: ovClient.commit 以 sessionId 为参数被调用

**SC-02** commit 返回 memories_extracted > 0 → evolutionScheduler.schedulePostCommit([]) 被调用
代码路径: line 317-320
验证: schedulePostCommit 被调用

**SC-03** commit 失败 → 记录 warn，不抛出，流程继续
代码路径: line 322-327
验证: 无异常；worktree release（如适用）在 commit 后仍执行

**SC-04** harness 会话关闭 → worktreePool.release(slotId) 被调用
代码路径: line 300-313
验证: worktreePool.release 以 harnessWorktreeSlotId 为参数

**SC-05** worktreePool.release 失败 → 记录 warn，不抛出
代码路径: line 307-311
验证: 无异常；后续 commit 仍执行

**SC-06** sessionStore.getUnreflectedSessions 返回 >= 阈值 → reflectionTrigger.shouldReflect=true → taskDispatcher.dispatch(type=system)
代码路径: line 330-385
前提: sessionStore + taskDispatcher 均初始化
验证: dispatch 以 type='system'、content=reflectionPrompt 被调用

**SC-07** reflection dispatch 成功 → sessionStore.markReflectionProcessed(sessionIds)
代码路径: line 372-379
验证: 相关 session 的 isReflectionProcessed=true

**SC-08** reflection dispatch 失败 → 记录 warn，不抛出
代码路径: line 381-384
验证: 无异常抛出到会话关闭回调

---

### HW（Harness & Worktree）— 8 场景

**HW-01** 第一条 harness 消息 → worktreePool.acquire() → session 绑定 slotId/path/branch
代码路径: handleHarnessTask line 715-730
验证: session.harnessWorktreeSlotId 非空；session.harnessWorktreePath 非空；task 以 cwdOverride 执行

**HW-02** 后续 harness 消息（session 已有 worktree）→ 复用 worktree，不重新 acquire
代码路径: line 702-712
验证: worktreePool.acquire 仅被调用 1 次；第二次消息使用相同 cwdOverride

**HW-03** handleHarness + forceComplex=true → executeChatPipeline 的 agentRuntime 调用含 forceComplex
代码路径: line 708, 727
验证: agentRuntime.execute 参数 forceComplex=true

**HW-04** 非 admin 用户 harness → downgrade，executeChatPipeline 以 chat 类型执行
代码路径: handleHarnessTask line 693-697
验证: task.type 变为 'chat'；worktreePool.acquire 未被调用

**HW-05** /end 命令 → handleHarnessEnd → sessionManager.closeSession
代码路径: line 733-765
验证: result.data.content 包含 branch 名称、messageCount、durationMin

**HW-06** /end 之后 session 关闭 → 触发 onSessionClose → worktreePool.release
代码路径: line 757 + setOnSessionClose line 300
验证: closeSession 触发回调；release 被调用

**HW-07** feishu channel + admin → maybeCreateHarnessGroupChat → 新 conversationId + re-resolve session
代码路径: line 542-563
验证: session.harnessGroupChatId = groupChatId；新 session 以 groupChatId 为 key

**HW-08** harness 多 turn：branch 信息在 session.harnessBranch 持久化
代码路径: line 719
验证: session.harnessBranch = slot.branch；/end 时摘要中 branch 正确

---

### GP（Gateway Pipeline）— 10 场景

**GP-01** MessageRouter.createHandler() 调用 handleIncomingMessage，成功 → responseDispatcher 发送 content
代码路径: message-router.ts line 40-52
验证: responseDispatcher 以 content 参数被调用

**GP-02** result.data.streamed=true → MessageRouter 跳过二次分发
代码路径: line 44-49
验证: responseDispatcher 未被调用（streaming 已通过 adapter 发送）

**GP-03** handleIncomingMessage 抛 YourBotError → MessageRouter catch → responseDispatcher 发送错误文本 + 重新抛出
代码路径: line 56-78
验证: responseDispatcher 收到错误文本；YourBotError 被重新抛出

**GP-04** handleIncomingMessage 抛普通 Error → 包装为 YourBotError 后抛出
代码路径: line 71-77
验证: 抛出的 error instanceof YourBotError；error.code = ERROR_CODES.UNKNOWN

**GP-05** extractContent → result.data.content 有值 → 返回 {type:'text', text}
代码路径: line 82-90
验证: extractContent 返回 BotResponse；type='text'

**GP-06** extractContent → result.data.response 有值（无 content）→ 使用 response
代码路径: line 86
验证: extractContent 返回 text = data.response

**GP-07** extractContent → success=false → 返回 null，不分发
代码路径: line 83
验证: responseDispatcher 未被调用

**GP-08** gateway/index.ts bootstrap → taskStore.markInterruptedOnStartup() 日志输出
代码路径: index.ts line 69-72
验证: 预置 2 个 running 任务 → markInterrupted 返回 2；logger.warn 被调用

**GP-09** ClaudeBridgeAdapter 不转发 prependContext（已知 bug）
代码路径: claude-bridge-adapter.ts line 12-27
验证: bridge.execute 调用中无 prependContext 参数；断言 prependContext 未出现在 ClaudeAgentBridge 入参
注意: 这是现有 bug — ClaudeBridgeAdapter 缺少 prependContext 转发；断言应验证 bug 存在，而非期待正确行为（需独立 fix task）

**GP-10** CodexAgentBridge 正确转发 prependContext
代码路径: codex-agent-bridge.ts line 96
验证: 调用时 prependContext='CTX' → fullPrompt 包含 'CTX'

---

## Deferred 场景（6 个）

以下场景因生产代码路径未接通，暂不实施：

### PA-D1: invokedSkills 写入路径不存在
**原因**: `session.invokedSkills` 在 `task.types.ts` 中定义（line 47），`buildTurnContext` 读取它（line 973），但生产代码中没有任何路径向 `session.invokedSkills` 写入数据。技能调用结果尚未接回 session。
**影响**: `buildTurnContext` 的 `invokedSkills` 分支无法通过集成测试验证（单元测试可覆盖）。
**解封条件**: skill 执行路径将结果写入 `session.invokedSkills`。

### PA-D2: postCompaction 写入路径不存在
**原因**: `session.postCompaction` 在 `task.types.ts` 中定义（line 50），`buildTurnContext` 读取它（line 974），但 `contextManager.checkAndFlush` 返回 anchor 文本，不写入 `session.postCompaction`。
**影响**: `postCompaction` 分支在集成测试中无法触发。
**解封条件**: `checkAndFlush` 在压缩发生时写入 `session.postCompaction = true`。

### PA-D3: activeMcpServers / previousMcpServers 写入路径不存在
**原因**: `session.activeMcpServers` 和 `session.previousMcpServers`（task.types.ts line 48-49）被 `buildTurnContext` 读取生成 mcpDelta（turn-context-builder.ts line 41），但生产代码中 MCP 配置由 `McpConfigBuilder.build()` 构建并传给 agent，不写入 session 字段。
**影响**: mcpDelta 段在集成测试中永远为空。
**解封条件**: MCP session 状态追踪写入 `session.activeMcpServers`/`previousMcpServers`。

### TL-D1: QueueAggregator 不在 handleIncomingMessage 主路径上
**原因**: `handleIncomingMessage` line 479-482 有 TODO 注释明确说明 QueueAggregator 集成依赖 TaskDispatcher 替换 TaskQueue，目前未实施。`aggregateMessages()` 是公开方法但不在任何生产调用路径上。
**影响**: QueueAggregator 的多消息合并在集成测试中无真实触发点。
**解封条件**: DD-017 完成，TaskDispatcher 替换 TaskQueue，且 aggregateMessages 被 handleIncomingMessage 调用。

### SC-D1: lastReflectionAt 未追踪
**原因**: `reflectionTrigger.shouldReflect()` 的 `lastReflectionAt` 参数硬编码为 null（line 333），实际反思时间间隔控制无效。
**影响**: 反思频率控制逻辑无法集成测试。
**解封条件**: sessionStore 中增加 `lastReflectionAt` 追踪，并在 setOnSessionClose 中传入真实值。

### GP-D1: /api/messages 端点的 E2E 路径
**原因**: `gateway/index.ts` 的 `/api/messages` POST 端点（line 137-156）直接调用 `controller.handleIncomingMessage`，与 MessageRouter 路径并行。该端点的集成测试需要启动 HTTP server，超出当前测试范围。
**影响**: HTTP 层集成验证暂缺。
**解封条件**: 引入 Hono test client 或 supertest 进行 HTTP 层集成测试。

---

## 场景计数汇总

| 分组 | 场景数 |
|------|--------|
| MR — Message Routing | 16 |
| CP — Chat Pipeline | 18 |
| PA — Prompt Assembly | 6（2 个跳转 Deferred）|
| ST — Streaming | 10 |
| SK — Scheduler | 10 |
| TL — Task Lifecycle | 12 |
| SC — Session Close | 8 |
| HW — Harness & Worktree | 8 |
| GP — Gateway Pipeline | 10 |
| **Tier 1 小计** | **42** |
| **Tier 2 小计** | **38** |
| **可实施合计** | **80** |
| Deferred | 6 |
| **总场景数** | **86** |

---

## 测试文件 → 场景映射

| 文件 | 场景 |
|------|------|
| `message-routing.integration.test.ts` | MR-01..MR-16 |
| `chat-pipeline.integration.test.ts` | CP-01..CP-18 |
| `prompt-assembly.integration.test.ts` | PA-01..PA-04, PA-07, PA-08 |
| `streaming.integration.test.ts` | ST-01..ST-10 |
| `scheduler-pipeline.integration.test.ts` | SK-01..SK-10 |
| `task-lifecycle.integration.test.ts` | TL-01..TL-12 |
| `session-close.integration.test.ts` | SC-01..SC-08 |
| `harness-worktree.integration.test.ts` | HW-01..HW-08 |
| `gateway-pipeline.integration.test.ts` | GP-01..GP-10 |
| `bootstrap.integration.test.ts` | GP-08（bootstrap 专项） |

---

## 关键已知问题（需独立修复）

### BUG-01: ClaudeBridgeAdapter 不转发 prependContext
- **位置**: `src/kernel/agents/claude-bridge-adapter.ts` line 12-27
- **现象**: `AgentBridge.execute` 接口要求 `prependContext` 字段（agent-bridge.ts line 24），ClaudeBridgeAdapter 的 `execute()` 不将其传递给 `ClaudeAgentBridge.execute()`
- **影响**: 通过 ClaudeBridgeAdapter（即 intelligenceGateway 路径）执行时，USER.md/AGENTS.md 的 OVERRIDE 语义在第一条消息失效
- **对应测试**: GP-09（验证 bug 存在）
- **修复**: 在 ClaudeAgentBridge 的 execute 参数中增加 prependContext 字段，并在 ClaudeBridgeAdapter 中转发

---

## Review R6 修正（2026-04-12）

以下修正基于第 6 轮 review 发现的 8 个问题和 5 个遗漏场景。采用追加方式，不修改已有正文。

### 修正 1: 场景计数校正

正文中的计数有误。实际按表格逐项统计：

| 分组 | 正文列出场景数 | 校正 |
|------|--------------|------|
| MR | 16 | 16 |
| CP | 18 | 18 |
| PA | 6 + 2 deferred = 8 | PA-08 应挪到 Deferred（见修正 4），实际可实施 5 |
| ST | 10 | 10 |
| SK | 10 | 10 |
| TL | 12 | 12 |
| SC | 8 | 8 |
| HW | 8 | 8 |
| GP | 10 | 10 |
| **可实施小计** | — | **97**（含 Tier 1 + Tier 2） |
| Deferred | 6 → 7（+PA-08） | **7** |
| 新增场景（本修正） | +10 | 见下方 |
| **校正后总计** | — | **114**（107 可实施 + 7 Deferred） |

### 修正 2: TaskDispatcher API 修正

正文 MR-15/TL-01/TL-02 描述了 `dispatch()` 语义（入队即返回），但实际主路径走的是 `dispatchAndAwait()`（等待执行完成后返回结果，commit `9da5ec7`）。

**影响的场景断言修正**：
- MR-15: 应验证 `dispatchAndAwait` 返回 `{ taskId, result }` 且 result 包含 content
- TL-01: `dispatchAndAwait` 返回时 DB 状态已为 completed（非 pending）
- TL-02: 失败时 `dispatchAndAwait` reject，DB 状态为 failed

### 修正 3: TaskStore API 修正

正文用了 `taskStore.getTask(taskId)`，但此方法不存在。实际可用方法：
- `getActiveBySession(sessionId)` — 返回 pending/running 任务
- `getHistory(userId, limit)` — 返回非 sync 的历史任务
- `findByMessageId(messageId)` — 按消息 ID 查

**影响的场景**：TL-01~04 的断言应改用 `getHistory` 或直接查 DB（`db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)`）。

TL-04 描述"标记为 interrupted"应修正为"标记为 failed, error_message='process_restart'"。

### 修正 4: PA-08 挪到 Deferred

PA-08（MCP delta 注入）需要 `session.activeMcpServers` 和 `session.previousMcpServers` 字段有生产写入路径。当前代码只在 `buildTurnContext` 中读取这些字段，无任何生产代码写入。

**PA-08 → Deferred**，原因：Session.activeMcpServers/previousMcpServers 无生产写入路径。
解封条件：在 controller 的 MCP server 连接/断开事件中更新这两个字段。

### 修正 5: GP-D1（HTTP API）不应 Defer

现有 `src/e2e/core-pipeline.e2e.test.ts` 已有 HTTP 端点测试（line 203, 264）。GP-D1 标为 Deferred 不准确。

**GP-D1 → 降级为"现有 E2E 已覆盖，本轮不重复"**，不是能力缺失。

### 修正 6: GP-09 从主集成套件移出

GP-09 验证的是"ClaudeBridgeAdapter 不转发 prependContext"— 这是一个已知 bug（BUG-01），不是正向通过条件。

**GP-09 → 移到 BUG-01 回归用例**，不计入主集成场景。修复 BUG-01 后，GP-09 改为验证"prependContext 正确转发"。

### 修正 7: SC-03 执行顺序修正

正文描述"commit 失败后 worktree release 仍执行"，但实际代码顺序是：
1. `worktreePool.release(slotId)` — line 298
2. `ovClient.commit(sessionId)` — line 315

修正：SC-03 应改为"worktree release 在 OV commit 之前执行，release 失败不阻塞 commit"。

### 修正 8: Streaming 需端到端场景

ST-03/ST-04 测的是 StreamHandler 裸行为，缺少 controller→filter→handler→adapter 的端到端链路。

**新增场景 ST-11**: Controller 过滤后事件注入 Feishu 适配器
- 验证：controller filteredCallback 过滤 tool_result → StreamHandler 不收到 → FeishuStreamAdapter 不更新卡片
- 代码路径：central-controller.ts:844 → stream-content-filter.ts:48 → stream-handler.ts:27 → feishu-stream-adapter.ts:70

### 新增遗漏场景（+10）

#### GS-03: Gateway graceful shutdown 全链路
- 验证：SIGINT → stopScheduler → channelManager.shutdownAll → controller.shutdown() → closeSessionDatabase()
- 重点：controller.shutdown() 应 flush SessionStore + drain TaskDispatcher
- 代码路径：gateway/index.ts:229

#### ST-12: Feishu CardKit 适配器注入路径
- 验证：registerChannels 后 setStreamAdapterFactory 被注入 → channel='feishu' 返回 FeishuStreamAdapter → 非 feishu 返回空数组
- 代码路径：gateway/index.ts:368

#### MW-01: /api/messages auth middleware
- 验证：未授权请求 → 401/403 → 不进入 handleIncomingMessage
- 代码路径：gateway/index.ts:133

#### SK-09: Scheduler workspace/UserConfigLoader 初始化
- 验证：定时 job 触发 → resolveSession → workspaceManager.initializeWithMcp → userConfigLoader 创建 → executeChatPipeline 正常执行
- 代码路径：central-controller.ts:1392

#### SC-09: Reflection enqueue 后标记语义
- 验证：dispatch 成功即 markReflectionProcessed，不等实际反思任务跑完。这意味着反思任务执行失败时，session 仍标记为已反思。
- 这是一个**设计决策验证**（fire-and-forget 语义），不是 bug
- 代码路径：central-controller.ts:354

#### MR-17: onboarding 恢复/开始/继续分支
- 验证三条路径：
  - 已在引导中的用户 → processResponse
  - 新用户 → needsOnboarding → startOnboarding
  - 恢复引导状态 → tryRestoreState
- 代码路径：central-controller.ts:446

#### MR-18: USER.md 上传处理
- 验证：消息包含 USER.md 附件 → fileUploadHandler.processUserMdUpload → 返回确认
- 代码路径：central-controller.ts:484

#### MR-19: Harness /end 命令
- 验证：content 包含"结束" → handleHarnessEnd → session 关闭 → worktree 释放
- 代码路径：central-controller.ts:499

#### MR-20: attachment/media 主链路
- 验证：消息含附件 → mediaProcessor.processAttachments → 描述拼入 session 内容 → 媒体失败降级为纯文本不阻塞
- 代码路径：central-controller.ts:805

#### SK-10: Scheduler cancel/list/cron 错误分支
- 验证三条路径：
  - cancel → scheduleCancelManager 流程
  - list → 返回当前 jobs
  - cron 解析失败 → 返回错误提示
- 代码路径：central-controller.ts:1157

### 校正后场景总表

| 分组 | 原有 | 修正后 | 变化 |
|------|------|--------|------|
| MR | 16 | 20 | +4（onboarding/USER.md/harness-end/attachment） |
| CP | 18 | 18 | 不变 |
| PA | 8 | 5 | -3（PA-08→Deferred, GP-09→BUG回归, PA-D2/D3已是Deferred） |
| ST | 10 | 12 | +2（端到端+adapter注入） |
| SK | 10 | 12 | +2（workspace初始化+cancel/list/error） |
| TL | 12 | 12 | 不变（断言修正，数量不变） |
| SC | 8 | 9 | +1（reflection标记语义） |
| HW | 8 | 8 | 不变 |
| GP | 10 | 10 | 不变（GP-09移出，但GP-D1不再defer，净值不变） |
| GS | 0 | 1 | +1（shutdown全链路） |
| MW | 0 | 1 | +1（auth middleware） |
| **可实施合计** | 80→97 | **108** | +11 |
| Deferred | 6 | **8** | +2（PA-08, GP-D1降级为"已有E2E覆盖"不计入） |
| BUG回归 | 0 | **1** | GP-09 |
| **总计** | 86→104 | **117** | |

### 遗留修正（6 轮汇总后发现）

**PA-02 再修正**: 正文中 PA-02 描述为"两次 build() 第二次不调 loadFile"，但 SystemPromptBuilder 本身没有缓存逻辑。真正的冻结缓存在 CentralController 的 `if (!task.session.frozenSystemPrompt)` 检查（line 905）。PA-02 应改为 controller 级集成测试：模拟两轮 executeChatPipeline → 第二轮不触发 systemPromptBuilder.build()。

**TL-12 归入 Deferred**: handleIncomingMessage line 479 明确注释 `// TODO: QueueAggregator 接入`，主路径未调用。TL-12 加入 Deferred 列表。
- **Deferred 原因**: QueueAggregator.aggregate() 在 controller 中无调用入口，仅有孤立的 aggregateMessages() 包装方法
- **解封条件**: 在 dispatcher 消费循环中调用 aggregator 对 pending 消息做预处理

**正文引用修正**: 正文中 MR-15/TL-01/TL-02 引用 `dispatch()` 的描述已在修正 2 中纠正为 `dispatchAndAwait()`，实施时以修正 2 为准。

---

## Review R7 修正（2026-04-12）

### 新增场景（+9）

#### CP-19: IntelligenceGateway 安全阀降级
- **验证**: LightLLM 返回"我需要更仔细地处理这个问题" → gateway 自动调用 agentBridge.execute() → 返回 Claude 结果
- **代码路径**: intelligence-gateway.ts:95, central-controller.ts:1006
- **重要性**: DD-014 核心承诺，不是"普通成功"也不是"异常回退"，是独立的第三条路径

#### CP-20: executionMode 传播链路 — async
- **验证**: 用户说"帮我后台处理这个" → classifyExecutionMode 返回 'async' → taskGuidance 包含"后台任务" → mcpConfig 包含 skillServer → dispatcher payload.executionMode === 'async'
- **代码路径**: central-controller.ts:662 → execution-mode-classifier.ts:3 → task-guidance-builder.ts → mcp-config-builder.ts:28

#### CP-21: executionMode 传播链路 — long-horizon
- **验证**: 用户说"深度研究 RAG 架构" → executionMode='long-horizon' → maxTurns=100（或设计值） → taskGuidance 包含"长时间任务"
- **代码路径**: 同上

#### SC-10: SessionStore 启动时标记未关闭 session
- **验证**: SessionStore 构造时调用 markInterruptedOnStartup（如果实现了） → 未关闭的 session 标记为 process_restart → getUnreflectedSessions 能捞到这些 session
- **代码路径**: session-store.ts:14, session-store.ts:243
- **注意**: 需确认 SessionStore 是否有自己的 markInterruptedOnStartup，和 TaskStore 的是独立的

#### SC-11: 会话过期自动 close
- **验证**: session 超时（lastActiveAt + timeout < now） → resolveSession 发现过期 → closeSession → 触发摘要提取 + SQLite 持久化 + OV commit + reflection 检查
- **代码路径**: session-manager.ts:43, session-manager.ts:168
- **重要性**: 生产上最常见的 session close 路径，比显式 /end 更频繁

#### CP-22: claudeSessionId 续会链路
- **验证**: 第一轮执行后 result.claudeSessionId 写入 session → 第二轮 executeChatPipeline 时 claudeSessionId 传给 gateway agentParams → mock Claude 收到同一个 sessionId
- **代码路径**: central-controller.ts:1018, 1058, 1098
- **重要性**: 多轮对话和 harness 连续执行的关键状态

#### TL-13: TaskDispatcher cancelBySession 真实路径
- **验证**: dispatcher 有 running task → cancelBySession(sessionKey) → running task 收到 abort → DB 标记 cancelled
- **代码路径**: task-dispatcher.ts:203
- **注意**: 区别于旧 fallback 路径的 cancelRequest()

#### TL-14: TaskDispatcher cancelByMessageId 真实路径
- **验证**: dispatcher 有 pending/running task → cancelByMessageId(msgId) → 对应 task 取消
- **代码路径**: task-dispatcher.ts:236

#### TL-15: TaskDispatcher shutdown pending 标记
- **验证**: dispatcher 有 pending tasks → shutdown() → 所有 pending 标记 cancelled + error_message='process_shutdown' → DB 记录正确
- **代码路径**: task-dispatcher.ts:288

### 已有场景补充

#### ST-13: CardKit 创建失败文本降级（补充到 feishu-streaming）
- **验证**: createStreamingCard 抛异常 → sendChunk 不崩溃 → sendDone 走 sendTextMessage 纯文本
- **代码路径**: feishu-stream-adapter.ts:59, 105
- **注意**: FS-06 已有类似场景，确认是否重复。如果 FS-06 已覆盖则不新增

#### ST-14: 内容超 28k 截断（补充到 feishu-streaming）
- **验证**: 累积文本 > 28000 → 自动截断 + "内容已截断" 前缀
- **代码路径**: feishu-stream-adapter.ts:73
- **注意**: FS-07 已有类似场景，确认是否重复

### 事实级修正

1. **正文 line 228**: `ovClient.checkAndFlush` → 实际调用是 `contextManager.checkAndFlush`（central-controller.ts:886）
2. **正文 line 13**: "所有场景均对应 central-controller.ts" → 修正为"以 central-controller 为主，补充 gateway/streaming/adapter 邻接路径"

### 校正后最终计数

R6 校正后 108 可实施。本轮：
- +9 新场景（CP-19~22, SC-10~11, TL-13~15）
- ST-13/ST-14 与 FS-06/FS-07 可能重复，待实施时确认去重
- PA-08 已在 R6 归入 Deferred
- TL-12 已在 R6 归入 Deferred

**最终可实施: ~117**（108 + 9），**Deferred: 9**（8 + TL-12），**BUG 回归: 1**，**Tier 3: 3**

注：精确计数在实施时按实际编写的测试文件统计，不再以文档计数为准。文档计数经过 7 轮修正已不适合作为排期基数，以测试文件中的 `describe/test` 数量为最终口径。
