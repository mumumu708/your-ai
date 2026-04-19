# Hermes-Agent 的 System Prompt 设计深度分析

**作者：Manus AI**  
**研究对象：** [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)  
**研究重点：** system prompt 的组成结构、装配流程、缓存机制、记忆与技能注入边界，以及它如何支撑 Hermes-Agent 的代理行为

## 一、执行摘要

Hermes-Agent 的 system prompt 设计并不是传统意义上“一次性写死的超长总提示词”，而是一个**分层装配、会话级缓存、运行时少量叠加**的控制系统。它的核心目标不是把所有可用上下文都塞进 system prompt，而是把 system prompt 约束为一个**稳定的代理内核**：其中只保留身份、纪律、长期记忆、技能索引、上下文规则和平台提示等**高稳定性**信息，而把高波动、强任务相关、每轮都可能变化的内容迁移到 user message、tool result 或 API 调用时的临时 overlay 中。[1] [2] [3]

这种设计的工程意义非常明确。第一，它显著提高了 prompt caching 的命中机会，因为一个 session 中的大部分 system prompt 前缀保持不变。第二，它减少了提示污染，让“角色控制”与“任务态上下文”分层存在。第三，它为记忆系统、技能系统、平台适配和插件扩展提供了清晰接口：哪些信息是内核级的，哪些信息只是当前轮的临时增强，边界都比较明确。[1] [3] [4]

如果要用一句话概括 Hermes-Agent 的 system prompt 哲学，可以表述为：

> **用稳定的 system prompt 保存代理的内在自我，用临时注入机制承载代理当下的工作记忆。** [1] [2] [4]

## 二、Hermes 为什么不把所有信息都塞进 system prompt

Hermes 在 `run_agent.py` 中对 system prompt 的定位写得非常直接：`_build_system_prompt()` **通常每个 session 只构建一次**，并且只有在上下文压缩之后才重建。这一设计是为了让 system prompt 在整个会话中尽可能稳定，从而最大化前缀缓存复用。[2]

在运行时消息装配部分，代码又进一步说明：外部记忆召回结果会被注入到**当前轮 user message**，而不是 system prompt，因为这样可以保持“stable cache prefix unchanged”；同时，插件在 `pre_llm_call` 钩子里产生的动态上下文也不会写入 system prompt，因为“system prompt is reserved for Hermes internals”。[2]

这说明 Hermes 从一开始就把 prompt 设计成两层：

| 层级 | 典型内容 | 稳定性 | 主要注入位置 | 设计目标 |
|---|---|---:|---|---|
| **内核层** | 身份、行为纪律、长期记忆、技能索引、上下文规则、平台提示 | 高 | system prompt | 稳定控制、缓存友好 |
| **工作层** | 外部召回结果、插件临时上下文、few-shot 预填充、子目录局部规则 | 中到低 | user message、tool result、ephemeral overlay | 任务适配、局部增强 |

这种分层不是单纯的优化技巧，而是 Hermes-Agent 运行机制的一部分。换句话说，**Hermes 并不把 system prompt 当作“最大的上下文容器”，而是把它当作“最稳定的控制边界”。** [1] [2] [3]

## 三、system prompt 的实际装配顺序

`run_agent.py::_build_system_prompt()` 中对 system prompt 的构造顺序给出了相当清晰的层级定义。[2] 结合官方的 prompt assembly 文档，可以把 Hermes 的 system prompt 装配顺序整理为下表。

| 顺序 | 层级 | 主要来源 | 功能定位 |
|---|---|---|---|
| 1 | **Agent identity** | `SOUL.md` 或 `DEFAULT_AGENT_IDENTITY` | 定义代理是谁、以何种人格与职责行动 |
| 2 | **Tool-aware guidance** | `MEMORY_GUIDANCE`、`SESSION_SEARCH_GUIDANCE`、`SKILLS_GUIDANCE` | 在对应工具可用时，告诉模型何时应使用相关能力 |
| 3 | **Product / subscription guidance** | `build_nous_subscription_prompt()` | 注入产品层面的附加引导 |
| 4 | **Tool-use enforcement** | `TOOL_USE_ENFORCEMENT_GUIDANCE` 与模型特定 guidance | 提升工具调用纪律，减少“口头说会做、实际不调用”的失败模式 |
| 5 | **User / gateway system message** | `system_message` | 允许上层调用方追加系统级约束 |
| 6 | **Built-in memory snapshot** | `MEMORY.md`、`USER.md` | 为代理提供稳定的持久记忆与用户画像 |
| 7 | **External memory system block** | `MemoryManager.build_system_prompt()` | 外部记忆 provider 的系统级补充 |
| 8 | **Skills prompt** | `build_skills_system_prompt()` | 向模型暴露技能索引与技能机制 |
| 9 | **Context files** | `build_context_files_prompt()` | 加载工作目录中的 `AGENTS.md`、`CLAUDE.md`、`.cursorrules` |
| 10 | **Runtime metadata** | 时间、session id、model、provider | 提供时效性和执行环境认知 |
| 11 | **Platform hint** | `PLATFORM_HINTS` | 针对 CLI、Gateway、聊天平台做输出行为微调 |

这种顺序体现出非常鲜明的设计逻辑：Hermes 先定义**身份**，再定义**行为纪律**，然后补充**长期知识与环境规则**，最后再注入**运行元信息**。这比很多代理系统“把所有规则杂糅成一个单块 prompt”的方式更接近一个可维护的控制栈。[1] [2]

## 四、Identity 层：SOUL.md 优先，默认身份兜底

在 system prompt 的最顶层，Hermes 会优先尝试读取 `SOUL.md`。如果存在，就直接把它作为 agent identity；如果不存在，才退回到代码中的 `DEFAULT_AGENT_IDENTITY`。[2] [5]

这意味着 Hermes 把“代理是谁”设计成一种**可文件化配置**，而不是只能在代码中硬编码的常量。部署者或特定项目可以通过 `SOUL.md` 替换代理的人格边界、工作风格和行为原则，而不需要改动底层实现。[1] [2]

与此同时，`build_context_files_prompt()` 又会在加载上下文文件时跳过已经作为 identity 使用的 `SOUL.md`，避免重复注入。这个小细节说明 Hermes 的 prompt builder 并非简单拼接，而是有意识地维护层与层之间的语义边界。[2] [5]

## 五、工具感知的行为指导：只有真有工具时才给指导

Hermes 的 system prompt 并不会无条件写入所有功能说明，而是先检查当前运行环境中哪些工具名实际存在，然后再选择性追加对应 guidance。例如，只有 `memory` 工具在 `valid_tool_names` 中时，才注入 `MEMORY_GUIDANCE`；只有 `session_search` 可用时，才注入 `SESSION_SEARCH_GUIDANCE`；只有 `skill_manage` 可用时，才注入 `SKILLS_GUIDANCE`。[2]

这意味着 Hermes 采用的是**tool-surface aware prompting**。它不希望模型“知道一个抽象上可能存在的能力”，而是希望模型“知道当前这次运行里真正存在、真正可用的能力”。这能减少两类常见问题。其一是**虚假 affordance**，也就是模型以为自己能调用某种工具，实际上当前环境并没有。其二是**冗余指令**，系统不必为不可用能力付出 token 成本。[2] [5]

从设计哲学上看，这一步使 system prompt 不再只是“角色描述”，而变成了**运行时能力面板的压缩表示**。

## 六、Tool-use enforcement：从“建议使用工具”到“要求按纪律执行”

Hermes 在 `_build_system_prompt()` 中支持一套可配置的 tool-use enforcement 机制。只有当当前环境存在工具时，这套 guidance 才有意义；而是否实际注入，又由 `agent.tool_use_enforcement` 配置和当前模型名共同决定。它可以被全局强制开启，也可以关闭，也可以只针对某些模型子串生效；默认的 `auto` 模式则匹配一组预定义模型家族。[2]

更值得注意的是，Hermes 不满足于一段通用“请记得调用工具”的提示，而是继续按模型家族追加细化 guidance。对于 Gemini/Gemma，会加入 `GOOGLE_MODEL_OPERATIONAL_GUIDANCE`；对于 GPT/Codex，会加入 `OPENAI_MODEL_EXECUTION_GUIDANCE`。这些内容主要强化执行纪律，例如更明确地要求前置检查、验证结果、避免口头承诺替代真实调用，以及在执行过程中保持操作粒度合理。[2] [6]

从发布说明看，这部分不是一次性设计出来的，而是在自动化 benchmark 中逐步发现失败模式后演化出来的。`RELEASE_v0.8.0.md` 明确提到 “Self-Optimized GPT/Codex Tool-Use Guidance” 和 “GPT/Codex execution discipline guidance in system prompts”，说明 Hermes 已经把 prompt 视为**可通过实验和复盘持续迭代的控制面**，而不是静态文案。[6]

> “Self-optimized GPT/Codex tool-use guidance” 与 “execution discipline guidance in system prompts” 被单独列为版本更新项，表明这部分 system prompt 不是附属装饰，而是影响代理可靠性的核心机制。[6]

## 七、system prompt 与记忆系统的接口边界

Hermes 的记忆信息不是统一塞进一个“记忆大段落”里，而是按稳定性做了分层。[2] [7]

首先，内置记忆层由 `MEMORY.md` 和 `USER.md` 构成，它们会通过 memory store 的 `format_for_system_prompt()` 直接进入 system prompt。这里的内容是**长期、显式、文件化**的，适合当作代理的稳定背景知识和用户画像。[2] [7]

其次，如果加载了外部记忆 provider，那么 `MemoryManager.build_system_prompt()` 返回的系统级补充块也会被追加到 system prompt 中。这使 Hermes 的 system prompt 可以接纳插件化记忆模块，但依然通过统一接口维持结构清晰。[2] [7]

最后，真正与当前问题强相关的外部召回结果并不进入 system prompt，而是在每次 API 调用前通过 `prefetch_all()` 获取，再用 `build_memory_context_block()` 封装后追加到**当前轮 user message**。代码对此解释得非常清楚：这样做是为了保持 system prompt 前缀稳定，不破坏 prompt cache。[2]

| 记忆层次 | 进入位置 | 为什么这样设计 |
|---|---|---|
| 内置持久记忆（`MEMORY.md`/`USER.md`） | system prompt | 稳定、长期、适合作为代理基础背景 |
| 外部 provider 的系统块 | system prompt | 插件化扩展，但仍属于稳定控制面 |
| 外部召回/检索结果 | 当前轮 user message | 高度依赖当前问题，频繁变化，避免破坏缓存 |

这一边界设计非常重要，因为它说明 Hermes 的 system prompt **只吸收“稳定语义记忆”**，而把“检索型工作记忆”留给当前轮消息层。这种区分能减少系统层被频繁更新带来的混乱，也有利于长期记忆与即时检索在心理模型上的分工。[2] [4] [7]

## 八、system prompt 与 Skill 系统的接口边界

Skills 在 Hermes 中也采用了类似“稳定索引 + 按需展开”的模式。只要技能相关工具 `skills_list`、`skill_view` 或 `skill_manage` 中任一存在，Hermes 就会调用 `build_skills_system_prompt()` 生成 skills prompt，并把它加入 system prompt。[2] [5]

这里的关键在于，进入 system prompt 的不是所有技能文件的正文，而更像是一个**技能目录层**。system prompt 会告诉模型：当前存在技能机制、可以通过哪些工具查看技能、何时适合使用技能，以及在可能的情况下去优先发现已有技能，而不是从头发明流程。[2] [5]

这种设计与记忆层的边界非常相似：

| 能力层 | system prompt 中放什么 | 运行时按需获取什么 |
|---|---|---|
| Memory | 稳定快照、稳定 provider block | 当前 query 的 recall 结果 |
| Skills | 技能索引与技能机制说明 | 某个 skill 的完整正文与 supporting files |

也就是说，Hermes 通过 system prompt 让模型拥有一种“**能力自觉**”：它知道自己有技能体系和记忆体系，但具体在当前任务中要调哪一个 skill、读哪段 skill 内容，则交给后续工具调用完成。这本质上是一种**渐进披露**策略，有助于控制 token 开销并避免 system prompt 过度膨胀。[2] [5]

## 九、上下文文件：启动期进 system，运行期进工具结果

Hermes 的上下文文件机制很能体现它对 system prompt 稳定性的重视。启动时，`build_context_files_prompt()` 会从当前工作目录读取 `AGENTS.md`、`CLAUDE.md`、`.cursorrules` 等文件，并把它们作为全局规则注入 system prompt。[1] [5]

但是一旦会话开始运行，模型又逐步进入新的子目录，Hermes 并不会回头改写 system prompt。`subdirectory_hints.py` 的模块说明写得很明确：新发现的子目录提示文件会被附加到对应的工具结果中，而不是修改 system prompt，因为这样可以“preserve prompt caching”。[4]

> “Subdirectory hints are discovered lazily and injected into the conversation without modifying the system prompt (preserving prompt caching).” [4]

这形成了一个很成熟的双阶段策略：

| 阶段 | 规则来源 | 注入位置 | 理由 |
|---|---|---|---|
| 会话启动时已知的全局规则 | 顶层 `AGENTS.md`/`CLAUDE.md`/`.cursorrules` | system prompt | 稳定且具有全局适用性 |
| 运行中才发现的局部规则 | 子目录 hint files | tool result | 动态、局部、避免破坏稳定前缀 |

这说明 Hermes 并没有把“所有规则都进入 system prompt”当作原则，相反，它只让**启动时已知、全局适用、相对稳定**的规则成为 system prompt 的一部分。[1] [4] [5]

## 十、Ephemeral system prompt 与上层 API 的叠加机制

除了核心 system prompt 之外，Hermes 还支持一种 `ephemeral_system_prompt`。这一层不会写入 `_build_system_prompt()` 产物中，而是在实际向模型发起调用前，将它与缓存后的核心 system prompt 做一次字符串拼接。[2]

Gateway 的 API server 也遵循同样思路。`gateway/platforms/api_server.py` 会把外部请求里的 `role=system` 消息解释为“layered ON TOP of core”的临时系统提示，而不是直接改写 Hermes 内核提示。随后，这些消息会以 `ephemeral_system_prompt` 参数传给 agent 实例。[3]

这说明 Hermes 允许上层系统做“系统级补丁”，但它把这种补丁设计成**临时 overlay**，而不是内核结构的一部分。这样一来，上层调用方既能施加场景特定约束，又不会污染 session 持久层、轨迹层或 prompt cache 基线。[2] [3]

## 十一、Prompt caching 不是附加优化，而是架构原则

Hermes 的 prompt caching 设计并不是在 prompt 完成后再“想办法缓存”，而是从 prompt 架构一开始就反向约束各层应该放在哪里。官方 prompt assembly 文档和运行时代码共同表明，Hermes 试图把最稳定的信息集中在 system prompt 中，并让它在一整个 session 内保持不变；同时，把高波动内容迁移到当前轮消息层或临时附加层。[1] [2] [8]

这一策略至少体现在四个方面。

| 设计动作 | 缓存意义 |
|---|---|
| 会话内只构建一次核心 system prompt | 保持长前缀稳定 |
| 仅在 context compression 后重建 | 让重建只发生在真正必要的结构变化点 |
| 外部 recall 注入 user message | 避免每次 recall 都改变 system prompt |
| 插件动态上下文迁到 user message | 保留 prompt cache，可复用缓存前缀 |

特别值得注意的是，版本发布说明中把“`pre_llm_call` plugin context moved to user message to preserve prompt cache”单独列为变化项。[6] 这说明缓存友好性不是偶然副产物，而是推动代码重构的直接原因。

## 十二、Context compression 为什么会触发 system prompt 重建

在常规情况下，system prompt 是会话级缓存的，不会每轮都重建。但当上下文压缩发生后，Hermes 会显式调用 `_invalidate_system_prompt()`，再重新执行 `_build_system_prompt()` 并更新 `_cached_system_prompt`。[2]

这背后的逻辑是合理的。压缩并不只是“删掉一点聊天历史”，它往往会伴随会话记忆态、摘要态、上下文组织方式的改变。既然 system prompt 中包含记忆块、上下文规则和元信息，那么压缩后重建可以确保新的稳定前缀与新的会话状态一致。[2]

因此，Hermes 并不是绝对追求“永不重建”，而是追求**只在结构性变化时重建**。这是一种典型的工程折中：在缓存收益与状态一致性之间选择最划算的重建点。

## 十三、Hermes 的 system prompt 如何支撑代理行为

如果从行为学角度看，Hermes 的 system prompt 至少承担了五种控制职责。

| 职责 | system prompt 中的体现 | 对代理行为的影响 |
|---|---|---|
| 身份控制 | `SOUL.md` / 默认身份 | 决定代理的角色、自我定位和基本风格 |
| 工具纪律 | tool-use enforcement + model-specific guidance | 提升工具调用可靠性，减少空谈式响应 |
| 长期背景注入 | 记忆块、用户画像、外部 provider system block | 提升跨轮一致性与个性化能力 |
| 能力发现 | skills prompt、tool-aware guidance | 让模型知道自己拥有哪些机制和何时该用 |
| 环境适配 | context files、时间、平台 hint、provider/model metadata | 让代理在正确情境下输出、行动和自我描述 |

这表明 Hermes 的 system prompt 本质上是一个**行为操作系统**。它并不直接替代推理本身，而是决定推理在什么身份框架下发生、对哪些工具保持敏感、在什么环境约束下行动，以及当前哪些长期知识应被视为常驻背景。[1] [2] [5]

## 十四、与传统“巨型单块 system prompt”相比的优劣

Hermes 的方式相较于传统单块 system prompt 有明显优势，但也不是没有代价。

| 维度 | Hermes 的分层缓存式设计 | 传统巨型单块设计 |
|---|---|---|
| 可维护性 | 高，组件化明确 | 低，规则容易互相覆盖 |
| 缓存友好性 | 高，稳定前缀长 | 低，稍有变化就整体失效 |
| 运行时扩展性 | 高，可用 overlay / user 注入 / tool result 注入 | 低，往往只能继续往 system prompt 堆内容 |
| 语义边界清晰度 | 高，内核与工作层分离 | 较低，长期规则与临时上下文混杂 |
| 调试复杂度 | 中等偏高，需要理解多层装配 | 低，只有一个总块 |
| 新人理解成本 | 稍高，需要读 builder 逻辑 | 低，打开一个 prompt 就能看全 |

Hermes 明显选择了更工程化的路线。它接受一定的实现复杂度，换来更好的稳定性、缓存性能和可组合性。这与一个面向长期演化的 agent 框架定位是吻合的。[1] [2] [6]

## 十五、结论

Hermes-Agent 的 system prompt 设计最值得注意的，不是“写了哪些提示语”，而是**为什么某些东西被放进 system prompt，而另一些内容被坚决放在外面**。通过 `_build_system_prompt()`、prompt assembly 文档、API gateway 叠加逻辑、subdirectory hints 与发布说明可以看到，Hermes 已经把 prompt 设计提升到一种体系化工程实践：

第一，它把 system prompt 视为代理的稳定内核，承担身份、纪律、长期知识和能力目录的职责。第二，它把高波动上下文迁移到 user message、tool result 和 ephemeral overlay 中，以保护缓存与结构边界。第三，它把 model-specific guidance、skills、memory 和 platform hint 都纳入同一装配框架，构成一个可演化的 prompt 控制栈。[1] [2] [3] [4] [6]

从代理系统设计的角度看，Hermes 的 system prompt 方案之所以值得研究，恰恰是因为它没有停留在“写一段更聪明的提示词”这一层，而是把 prompt 当成了**可分层、可缓存、可插拔、可持续优化的系统接口**。这也是 Hermes-Agent 能够把记忆、技能、上下文和工具纪律整合进一个统一代理内核中的关键原因。[1] [2] [5] [6]

## References

[1]: https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly/ "Hermes-Agent Developer Guide: Prompt Assembly"
[2]: https://github.com/NousResearch/hermes-agent/blob/main/run_agent.py "NousResearch/hermes-agent: run_agent.py"
[3]: https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/api_server.py "NousResearch/hermes-agent: gateway/platforms/api_server.py"
[4]: https://github.com/NousResearch/hermes-agent/blob/main/agent/subdirectory_hints.py "NousResearch/hermes-agent: agent/subdirectory_hints.py"
[5]: https://github.com/NousResearch/hermes-agent/blob/main/agent/prompt_builder.py "NousResearch/hermes-agent: agent/prompt_builder.py"
[6]: https://github.com/NousResearch/hermes-agent/blob/main/RELEASE_v0.8.0.md "NousResearch/hermes-agent: RELEASE_v0.8.0.md"
[7]: https://github.com/NousResearch/hermes-agent/blob/main/agent/memory_manager.py "NousResearch/hermes-agent: agent/memory_manager.py"
[8]: https://github.com/NousResearch/hermes-agent/blob/main/agent/prompt_caching.py "NousResearch/hermes-agent: agent/prompt_caching.py"
