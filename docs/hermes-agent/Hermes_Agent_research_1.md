# Hermes-Agent 深度调研报告：架构图、自助进化设计与运行过程

**作者：Manus AI**  
**日期：2026-04-11**

## 摘要

Hermes-Agent 将自己定义为 **“self-improving AI agent”**，但其“自助进化”并不是单点能力，而是一套分层工程体系：前台运行时通过 **技能沉淀、记忆写入、历史会话检索、跨会话用户建模与上下文压缩** 实现在线学习，后台则通过 **轨迹保存、环境评测、强化学习与 OPD 蒸馏** 把真实运行经验转化为离线训练资产。[1] [2] [3] [4] [5] 本报告的核心判断是：Hermes-Agent 的创新并不主要在某个单独算法，而在于它把 **“执行—复盘—沉淀—召回—再训练”** 做成了一个统一的代理操作系统。

![Hermes-Agent 架构图](./hermes_agent_architecture.png)

![Hermes-Agent 自助进化双闭环过程图](./hermes_agent_self_evolution_loop.png)

## 一、研究对象与结论概览

从仓库首页与官方开发文档交叉来看，Hermes-Agent 的定位非常明确：它不满足于“一次性完成任务”，而是试图让代理在持续使用中 **越来越会做事、越来越了解用户、越来越善于复用历史经验**。[1] [2] 这种定位决定了 Hermes 的架构不是传统聊天机器人结构，而是一个带有持久化、反思、检索、技能化和训练接口的 agent runtime。

为了便于理解，下面先给出一个总体结论表。

| 维度 | Hermes-Agent 的做法 | 对“自助进化”的意义 |
|---|---|---|
| 运行中枢 | 以 `AIAgent` 为统一编排核心 | 把提示、工具、压缩、回退、持久化放入同一循环 |
| 长期知识 | 内置 memory + 外部 memory provider | 让稳定信息跨轮、跨会话保留 |
| 程序性经验 | `skill_manage` 管理 Skills | 把“做事方法”沉淀为可复用流程 |
| 历史召回 | SQLite + FTS5 + 会话摘要 | 让旧会话成为可检索经验库 |
| 用户模型 | Honcho peer/profile/context/conclude | 让代理形成跨会话用户画像与 AI peer 表征 |
| 训练闭环 | trajectory、benchmark、RL、OPD | 让真实 rollout 成为下一轮模型/系统优化数据 |

换言之，Hermes 的 “self-improving” 可以拆成 **两条闭环**：其一是运行时的 **在线闭环**，其二是环境与数据层的 **离线闭环**。[4] [5] 只有把两条闭环放在一起，Hermes 的设计逻辑才是完整的。

## 二、总体架构：多入口、单中枢、双下游

官方架构文档把 Hermes-Agent 描绘成一个由多种入口统一汇入 `AIAgent` 的系统。上游入口包括 CLI、Gateway、ACP、Batch Runner、API Server 和 Python Library，中间层是负责运行时编排的主代理核心，下游则连接 **会话状态存储** 与 **工具后端**。[2] 这意味着 Hermes 从一开始就不是“只给命令行用的工具代理”，而是一个可作为产品内核、批处理引擎、服务端代理或程序库嵌入式能力的统一运行时。

进一步结合 `agent-loop` 文档可以看到，`AIAgent.run_conversation()` 是真正的执行主循环。它负责构建系统提示、解析不同模型 API 形态、接收工具调用、回填工具结果、控制迭代预算、在上下文膨胀时触发压缩，并在回合结束后把状态落盘。[3] 因此，从实现上说，Hermes 的架构中心不是某种 memory 模块，而是 **一个能够调度 memory、skills、tools、compression 和 persistence 的对话操作循环**。

为了更清楚地呈现整体结构，下面给出分层解剖。

| 层次 | 关键组件 | 主要职责 |
|---|---|---|
| 入口层 | CLI、Gateway、ACP、Batch Runner、API Server、Python Library | 接收任务与会话上下文 |
| 编排层 | `AIAgent` / `run_conversation()` | 提示拼装、模型调用、工具循环、持久化、压缩、回退 |
| 提示与上下文层 | `prompt_builder.py`、prompt caching、context compressor | 把 identity、memory、skills、context files、平台提示注入系统上下文 |
| 工具层 | 注册表工具 + 代理级拦截工具 | 执行终端、浏览器、文件、web、MCP 等能力 |
| 长期状态层 | session storage、memory manager、Honcho | 保存会话、长期事实、用户画像、召回材料 |
| 训练与评测层 | environments、trajectory、Atropos、OPD | 把运行轨迹转成 benchmark/RL/SFT 资产 |

## 三、主运行时架构：AIAgent 如何组织一次任务

Hermes 的主循环可以被理解为一个 **“推理—行动—观察—再推理”** 的稳定编排器。官方文档指出，运行时会先构建或复用缓存化系统提示，然后按模型供应商的 API 形态组织消息；如果模型输出工具调用，就执行工具并把结果插回消息流，再进入下一轮推理；如果模型直接生成自然语言答案，则结束该轮、持久化状态并触发必要的后台动作。[3]

这里有一个非常关键的架构特征：`todo`、`memory`、`session_search` 和 `delegate_task` 等工具并非只是普通工具注册项，而是由主循环直接拦截的“代理级工具”。官方文档明确说明这样做是为了让这些工具能直接修改代理本地状态或访问代理级存储。[3] 这说明 Hermes 的体系不是“所有工具一律平铺”，而是区分了 **通用外部工具** 与 **影响代理自我状态的内生工具**。

这种区分对“自助进化”意义重大，因为真正推动代理长期变化的能力，恰恰是这些代理级工具：它们负责维护记忆、检索历史、委托子代理和更新技能，而不是单纯调用外部服务。

## 四、提示构建：Hermes 如何把“学习意识”注入模型

`prompt-assembly` 文档给出了一个很重要的事实：Hermes 的系统提示并不只是 persona 和工具定义，而是按固定顺序拼入身份、工具感知指导、Honcho 静态块、可选系统消息、冻结的 `MEMORY.md` 与 `USER.md`、skills 索引、项目上下文文件、时间戳与平台提示。[6] 这种拼装顺序决定了“长期信息”与“当轮任务信息”在模型视角中的层级关系。

从自助进化角度看，最关键的是 **skills 索引和记忆提示的注入**。Hermes 会把可用技能清单直接放进系统提示，并告诉模型在回复前先扫描技能、优先采用已有工作流；如果某个技能在使用中发现问题，应立即修补。[6] 这意味着“复用过去经验”和“纠正过时经验”不是偶然行为，而是被明文写进系统规范的默认策略。

与此相对应，记忆层也不是一股脑地把全部历史塞进上下文。官方文档说明，静态可缓存部分与 API 调用期动态注入部分是分开的，尤其是 Honcho 的后续轮次召回会以临时方式注入，而不是不断改写缓存系统提示。[6] 这种设计保证了提示成本和上下文稳定性，同时让长期记忆能够在需要时被调入。

可以说，Hermes 在提示层完成了第一层“自助进化工程化”：它先把 **何时复用经验、何时写入记忆、何时更新技能** 编译成运行前规则，然后才让模型开始行动。

## 五、记忆体系：从内置记忆到外部用户模型

Hermes 的长期记忆不是单一模块，而是一个 **内置记忆 + 外部提供者插件** 的双层结构。`MemoryManager` 文件的开头就直接说明：系统总是包含 built-in provider，同时至多接入一个外部 provider，以避免工具模式膨胀和冲突。[7] 这说明 Hermes 不是把不同记忆系统简单拼盘，而是有意识地控制记忆接口的复杂度。

`MemoryManager` 在生命周期上承担了多个关键动作。它既可以通过 `build_system_prompt()` 收集静态提示块，又能在每轮前调用 `prefetch_all()` 取回相关上下文，在回合结束后调用 `sync_all()` 同步结果，并通过 `queue_prefetch_all()` 为下一轮预取材料。[7] 更重要的是，当 built-in memory 写入后，`on_memory_write()` 还会把这些更新同步给外部 provider。也就是说，内置记忆与外部长期记忆之间不是彼此割裂，而是可以联动。

这种设计使 Hermes 的记忆具备两个层次。第一层是 **轻量、稳定、直接可注入的事实记忆**，适合保存用户偏好、习惯和稳定约束。第二层是 **更复杂、更结构化的长期记忆服务**，适合承载跨会话召回、语义搜索、用户画像或 AI peer representation。二者结合后，Hermes 才真正具备“越用越懂你”的结构基础。

## 六、会话检索：Hermes 如何把历史工作变成可查询经验库

Hermes 的 `session_search` 是其自助进化体系中非常关键、但容易被低估的一环。该工具的实现说明，它不是简单把历史对话全文返回，而是采用 **SQLite FTS5 搜索 + LLM 聚焦总结** 的两段式流程：先在过去消息中做全文检索，再按 session 聚合与截断上下文，最后调用辅助模型生成面向当前问题的摘要。[8]

官方工具说明还明确区分了两种模式：一种是 **不带 query 的 recent 模式**，快速列出最近处理过的工作；另一种是 **带 query 的 keyword search 模式**，面向具体主题跨会话召回结果。[8] 这两个模式的组合意味着 Hermes 既能回答“我们最近在做什么”，也能回答“我们以前是怎么解决某个问题的”。

这套机制对于“自助进化”的价值在于，它把过去会话从“沉没成本”变成了“结构化经验资产”。如果没有会话检索，过去任务即使完成，也很难在未来被有效复用；而有了 FTS5 检索与定向摘要，代理就可以在新任务中主动调取旧经验，从而避免重复试错。[8]

## 七、技能系统：把成功方法沉淀为程序性记忆

Hermes 对 Skills 的定义非常鲜明。`skill_manager_tool.py` 文件直接写道：Skills 是 agent 的 **procedural memory**，而一般 memory（如 `MEMORY.md`、`USER.md`）则是更宽泛的 declarative memory。[9] 也就是说，Hermes 把“知道某件事”与“知道怎么做某类事”明确拆开，并为后者提供了独立的数据结构和维护工具。

该工具支持 `create`、`patch`、`edit`、`delete`、`write_file` 和 `remove_file` 六类动作。[9] 其中最值得注意的是 `patch` 与 supporting files 机制。Hermes 并不把技能视为一段短提示，而是允许技能目录带有 `references/`、`templates/`、`scripts/` 和 `assets/` 等配套文件，这使 skill 可以包含真正可操作的模板、脚本、文档和资源。[9] 换言之，Hermes 的 skill 更接近“经验包”而不是“摘要标签”。

实现细节也显示出这一层是高度工程化的。代码中存在 frontmatter 校验、内容大小限制、原子写入、安全扫描、路径边界控制，以及用于减少精确匹配失败的 fuzzy patch 逻辑。[9] 这些机制说明 Hermes 不只是让代理“能写技能”，而是努力保证代理 **写出来的技能可维护、可修补、相对安全且不容易自我破坏**。

从系统设计角度看，skill 机制承担了 Hermes 在线自助进化中的“经验固化器”角色：某次任务中摸索出的有效流程，不必留在临时上下文中，而是可以被转写为独立工作流，在未来再次被系统提示发现和调用。

## 八、Honcho 用户模型：从普通记忆升级到跨会话 peer 建模

如果说 built-in memory 和 session search 已经让 Hermes 具备“记住事实”和“找回历史”的能力，那么 Honcho 插件进一步把长期学习升级为 **用户模型与 AI peer 表征**。Honcho 实现文件开头就说明，该插件提供跨会话用户建模、dialectic 问答、语义搜索、peer cards 和持久化 conclusions。[10]

其暴露的四个工具分别是 `honcho_profile`、`honcho_search`、`honcho_context` 和 `honcho_conclude`。[10] 其中 `profile` 面向低成本事实快照，`search` 面向原始语义检索，`context` 面向使用 Honcho 自身 LLM 做综合回答，而 `conclude` 则用于把用户的新事实或偏好写回长期画像。[10] 这套工具组合意味着 Hermes 不再只是“存一条记忆”，而是在维护一个可问答、可搜索、可更新的用户表示。

更重要的是，Honcho 插件还引入了 `recall_mode`、first-turn context baking 和 cost-aware cadence 等控制策略。[10] 前者允许系统在 `context`、`tools` 和 `hybrid` 模式之间切换；中者允许首轮对话预烘焙高价值上下文；后者则通过调用频率控制成本。结合 `on_memory_write()` 的镜像机制，可以看出 Hermes 正在把“记忆”从静态文本升级为 **面向长期协作的用户建模层**。

## 九、后台复盘机制：Hermes 在线自助进化的核心引擎

Hermes 最有代表性的“自助进化”设计，其实出现在 `run_agent.py` 的后台复盘逻辑中。代码中定义了 `_MEMORY_REVIEW_PROMPT`、`_SKILL_REVIEW_PROMPT` 和 `_COMBINED_REVIEW_PROMPT` 三类复盘提示，并在 `_spawn_background_review()` 中根据触发情况生成一个新的 review agent，在共享 memory 与 skill 存储的前提下对刚结束的会话进行再分析。[11]

这一设计非常关键，因为它把“完成任务”和“从任务中学到东西”彻底解耦。前台代理先服务用户，确保输出不被打断；随后后台线程才会基于完整会话快照执行额外推理，判断是否值得保存记忆、创建技能或更新技能。[11] 从工程上看，这样做避免了两种常见问题：一是把复盘行为塞进主任务导致用户等待变长，二是让模型在尚未完成任务时过早总结经验。

更值得注意的是，`_SKILL_REVIEW_PROMPT` 的文字标准并不宽泛。它要求系统关注 **是否采用了非平凡方法、是否存在试错与路径修正、是否出现了值得复用的工作流**；若已有相关 skill 就更新，否则才创建新的 skill。[11] 这意味着 Hermes 并不是逢任务必存，而是试图筛选出真正具备复用价值的方法论。

从设计哲学上讲，这一后台复盘机制正是 Hermes 在线进化闭环的中心：**先做事，再反思，再写入长期状态。**

## 十、上下文压缩与 session lineage：为什么 Hermes 能持续工作而不“失忆”

在 agent-loop 文档中，官方特别强调当上下文压力过高时，Hermes 会先刷新记忆，再执行摘要压缩，并创建新的 session lineage。[3] 这一点非常重要，因为很多代理系统在长任务里要么直接截断上下文，要么把全部对话压成粗糙摘要，结果是长期信息与短期细节混在一起，导致越跑越糊涂。

Hermes 的做法更细致：需要长期保留的用户事实或偏好，优先写入 memory/provider；需要保留但不宜原样留在窗口里的工作上下文，则交给压缩器生成摘要；而 lineage 则负责把新旧 session 串联起来。[3] 这相当于给代理提供了一种“可续航的遗忘机制”：它不是无差别遗忘，而是 **把不同类型的信息迁移到不同层级的持久化容器**。

这一步对于自助进化至关重要，因为如果压缩环节处理不好，前面沉淀下来的技能和记忆就会在长时任务中失去调用价值。Hermes 通过 lineage 和分层保留策略，让长期学习真正能跨越上下文窗口限制。

## 十一、离线训练闭环：从运行轨迹到可训练数据

Hermes 的“self-improving”并不止于在线状态更新。官方 `environments` 文档指出，Hermes 已经与 Atropos 环境框架结合，用同一个 environment 抽象支持 **多轮 agentic RL、benchmark 评测和 SFT 数据生成**。[4] 这意味着前台运行时积累的不只是产品层经验，也能成为训练层经验。

文档进一步说明了三层继承结构：`BaseEnv` 负责服务管理、调度和日志，`HermesAgentBaseEnv` 负责工具解析、终端后端和 Hermes agent loop 的对接，再往上才是具体 benchmark 或训练环境。[4] 这说明 Hermes 运行时与训练环境不是两个完全不同的系统，而是共享同一套 agent loop 与工具接口。

这种共享是离线进化闭环能够成立的基础。因为只有训练环境真正调用了与线上一致的代理循环，轨迹、失败模式、工具错误和策略选择才具备训练价值。

## 十二、轨迹格式：Hermes 如何把真实运行转成数据资产

`trajectory-format` 文档清楚说明，Hermes 会把对话轨迹保存为 ShareGPT-compatible JSONL，可用于训练数据、调试工件和强化学习数据集。[5] 成功完成的对话写入 `trajectory_samples.jsonl`，失败或中断的对话写入 `failed_trajectories.jsonl`；batch 模式下还会额外记录 `tool_stats` 与 `tool_error_counts` 等标准化字段。[5]

更关键的是，Hermes 对轨迹做了严格规范化。所有 reasoning 都会转入统一的 `<think>` 标签，工具调用被标准化为 `<tool_call>` 包裹的 JSON，对应的工具结果被标准化为 `<tool_response>` 结构。[5] 这种统一格式使不同模型、不同 API 返回形态都能在训练数据层被拉平，降低后续训练与数据加载的复杂度。

这说明 Hermes 的 trajectory 不是简单日志，而是 **预先为训练可用性设计的标准数据接口**。它既服务调试，也服务后续监督微调与 RL，是真正把运行经验转为机器学习资产的桥梁。

## 十三、Agentic OPD：Hermes 如何把 next-state 变成更密集的学习信号

仅有轨迹保存还不足以构成“进化系统”，Hermes 进一步在 `agentic_opd_env.py` 中引入了 **Agentic On-Policy Distillation (OPD)**。环境文档说明，这一机制会在标准工具调用轨迹之上，根据后续状态构造 hindsight hints，并把这些 hints 拼回增强提示中，再由教师分布为学生 token 分配对数概率与 advantage 相关信号。[4] [12]

这种设计的关键思想是：代理在真实任务中，每一次工具返回、测试结果、错误信息乃至失败状态，都会暴露“前一步本可以更好地怎么做”。传统 RL 往往只在终局给出稀疏奖励，而 OPD 试图把这些中间 next-state 也转译成可学习监督。[12] 这使 Hermes 的训练闭环比“只看成功/失败”更加细粒度。

从系统层面理解，OPD 是 Hermes 离线自助进化的加速器。在线运行产生的轨迹不只是供人类复盘，也不只是打标签做 benchmark，而是可以被转化为 **更密集、更多步、与真实工具交互强相关的训练信号**。

## 十四、自助进化的完整过程：从一次任务到下一轮更强的代理

综合以上模块，Hermes-Agent 的自助进化过程可以被还原为一个连续的五阶段流程。

首先，在 **执行阶段**，`AIAgent` 依据系统提示、技能索引、记忆与项目上下文开展任务推理，并通过工具循环完成动作。[2] [3] 此时代理已经可以利用此前沉淀下来的 skill、memory 和历史召回。

其次，在 **沉淀阶段**，主循环结束后会触发 memory sync、next-turn prefetch 与必要的后台 review。若本轮形成了稳定事实，则写入 built-in memory 或 Honcho；若形成了非平凡工作流，则通过 `skill_manage` 创建或修补 skill。[7] [9] [10] [11]

再次，在 **召回阶段**，未来任务到来时，提示构建器会重新注入 skills 索引、静态 memory 与必要的 provider block，而 `session_search` 与 Honcho 的 prefetch/context 工具则能把过去会话和用户画像带回当前轮。[6] [8] [10]

随后，在 **续航阶段**，如果上下文膨胀，Hermes 会把适合长期保存的信息迁移到 memory/provider，把短期上下文转为压缩摘要，并通过 lineage 维持会话可追溯性。[3] 这让长期任务不会因为上下文窗口限制而彻底“断代”。

最后，在 **再训练阶段**，对话轨迹被保存为结构化 JSONL，并进入 environment、benchmark、RL 或 OPD 管线，最终成为下一轮模型或系统改进的数据基础。[4] [5] [12]

为了直观看到这条链路，下面给出一个流程表。

| 阶段 | 在线/离线 | 关键模块 | 输出 |
|---|---|---|---|
| 执行 | 在线 | `AIAgent`、tools、prompt builder | 完成当前任务 |
| 沉淀 | 在线 | memory、skill review、Honcho conclude | 稳定事实、技能工作流、用户画像 |
| 召回 | 在线 | skills index、session_search、Honcho prefetch | 历史经验重新进入当前上下文 |
| 续航 | 在线 | compression、session lineage、memory sync | 长任务不中断且不丢关键长期信息 |
| 再训练 | 离线 | trajectory、environments、Atropos、OPD | SFT/RL/蒸馏训练资产 |

## 十五、架构评价：Hermes-Agent 的强项与约束

从架构角度评价，Hermes-Agent 最强的一点是 **层次清楚且闭环完整**。很多 agent 系统只做到工具调用，少数进一步做到 memory，再少数支持轨迹；而 Hermes 试图把这些部件用同一 agent loop 串起来，使它们相互促进。[2] [3] [4] 这让它具备较强的工程延展性。

另一个明显优势是 **区分事实记忆、程序性记忆和历史会话召回**。事实记忆适合稳定注入，skills 适合复用方法，session search 适合查找细节，这种分工避免了把一切都塞进单一记忆容器。[6] [7] [8] [9] 再叠加 Honcho 的用户模型层，Hermes 在“长期协作代理”方向上形成了比普通聊天型 agent 更完整的结构。[10]

不过，其约束也同样存在。首先，自助进化的许多关键动作依赖 LLM 判断，例如后台复盘是否值得建 skill、会话摘要是否足够准确、Honcho dialectic 的结果是否可靠，因此系统质量仍受模型质量影响。其次，长期状态越多，越需要更细致的成本控制、冲突消解和安全边界管理，这也是为什么代码中存在 recall cadence、安全扫描、路径边界和单外部 provider 限制等控制措施。[7] [9] [10] 这些并非缺陷，而是自助进化代理不可避免的系统复杂性表现。

## 十六、最终结论

Hermes-Agent 所谓的“自助进化”，本质上是一种 **分层学习架构**。它在在线层面通过 skills、memory、session recall、Honcho 用户模型和后台复盘，让代理越来越会处理重复出现的问题；在离线层面又通过 trajectory、environment、benchmark 与 OPD，把真实运行经验沉淀为模型级训练资产。[1] [3] [4] [5] [11] [12]

因此，如果要用一句话概括 Hermes-Agent，我认为最准确的说法不是“一个带记忆的 agent”，也不是“一个会自动写技能的 agent”，而是：

> **Hermes-Agent 是一个把执行、复盘、沉淀、召回与再训练统一到同一运行时中的自学习代理系统。**

这也是它相较于一般 function-calling agent 最本质的架构差异所在。

## 参考文献

[1]: https://github.com/NousResearch/hermes-agent "NousResearch/hermes-agent"
[2]: https://hermes-agent.nousresearch.com/docs/developer-guide/architecture/ "Hermes Agent Architecture"
[3]: https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop/ "Hermes Agent Loop Internals"
[4]: https://hermes-agent.nousresearch.com/docs/developer-guide/environments/ "Hermes Environments, Benchmarks and Data Generation"
[5]: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/trajectory-format.md "Trajectory Format"
[6]: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/prompt-assembly.md "Prompt Assembly"
[7]: https://github.com/NousResearch/hermes-agent/blob/main/agent/memory_manager.py "memory_manager.py"
[8]: https://github.com/NousResearch/hermes-agent/blob/main/tools/session_search_tool.py "session_search_tool.py"
[9]: https://github.com/NousResearch/hermes-agent/blob/main/tools/skill_manager_tool.py "skill_manager_tool.py"
[10]: https://github.com/NousResearch/hermes-agent/blob/main/plugins/memory/honcho/__init__.py "Honcho memory provider"
[11]: https://github.com/NousResearch/hermes-agent/blob/main/run_agent.py "run_agent.py"
[12]: https://github.com/NousResearch/hermes-agent/blob/main/environments/agentic_opd_env.py "agentic_opd_env.py"
