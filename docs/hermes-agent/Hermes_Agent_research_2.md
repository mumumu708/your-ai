# Hermes-Agent 记忆模块与 Skill 管理模块深度探索报告

作者：**Manus AI**  
日期：2026-04-11

## 摘要

本文围绕 Hermes-Agent 的两个关键长期适应模块——**记忆模块**与**Skill 管理模块**——进行源码级深入分析。整体结论是，Hermes-Agent 并没有把“自我进化”收敛为单一机制，而是明确拆成两条长期沉淀路径：其一是 **Memory 路径**，用于保存跨会话持续有效的事实、偏好与环境信息；其二是 **Skill 路径**，用于保存可复用的方法、流程、模板、脚本和依赖声明。前者偏向“知道什么”，后者偏向“怎么做”。二者都被接入系统提示装配、运行时工具暴露和代理生命周期钩子，因此不是外围附属功能，而是 Hermes-Agent 长期适应能力的核心基础设施。[1] [2] [3] [4] [5]

从工程实现看，Hermes 选择了一种高度约束的设计哲学：长期知识必须**外部化**，但外部化后的知识又必须**可编辑、可审计、可限制作用边界**。于是，内置记忆采用文件持久化、冻结快照、字符预算和注入扫描；Skill 则采用目录化能力包、渐进披露、路径边界校验、平台过滤和环境准备度判定。这种组合使 Hermes 既允许模型积累经验，又避免模型无边界地修改自身行为协议。[2] [4] [5] [6]

![Hermes-Agent 记忆模块与 Skill 管理模块协同关系图](https://private-us-east-1.manuscdn.com/sessionFile/hvP9YokHVO6MLBr06FkQdu/sandbox/8n05BBDuoDQFId28qV42FG-images_1775909298273_na1fn_L2hvbWUvdWJ1bnR1L2hlcm1lcy1hZ2VudC1yZXNlYXJjaC9maW5hbC9oZXJtZXNfYWdlbnRfbWVtb3J5X3NraWxsX2ludGVycGxheQ.png?Policy=eyJTdGF0ZW1lbnQiOlt7IlJlc291cmNlIjoiaHR0cHM6Ly9wcml2YXRlLXVzLWVhc3QtMS5tYW51c2Nkbi5jb20vc2Vzc2lvbkZpbGUvaHZQOVlva0hWTzZNTEJyMDZGa1FkdS9zYW5kYm94LzhuMDVCQkR1b0RRRklkMjhxVjQyRkctaW1hZ2VzXzE3NzU5MDkyOTgyNzNfbmExZm5fTDJodmJXVXZkV0oxYm5SMUwyaGxjbTFsY3kxaFoyVnVkQzF5WlhObFlYSmphQzltYVc1aGJDOW9aWEp0WlhOZllXZGxiblJmYldWdGIzSjVYM05yYVd4c1gybHVkR1Z5Y0d4aGVRLnBuZyIsIkNvbmRpdGlvbiI6eyJEYXRlTGVzc1RoYW4iOnsiQVdTOkVwb2NoVGltZSI6MTc5ODc2MTYwMH19fV19&Key-Pair-Id=K2HSFNDJXOU9YS&Signature=muxfDV2WweHighqvodE8zobyxxk01T2JSgchKo48W38vUzPz6mOhbgqEK7QStMVyMIJ2ky6KljP~D3FVaD0m4CSjqlLQY13F2YP2wXM6Z1PMVxcw2KhJ1Vl5ORT5YFHRpBA~AaDSE2UUanCWdxAx9S3H53Ikbos3Pj~8gAmFBDWgZ3jFiW0VDjsnFfAOSVtKCUHO7nl6dfKgsg1oIOzjQUuMbFHUy23gIvxFCuQ3rSox1VQbw9o4JhfVVUWw7uipNSy0HppbTt2iQ00GGjGaauV9lScbHOFsPkWP-Sw2ckghuZIQK~MUsmjR-ICd6nKyZcjcILYHlRVND5BM2hhVvw__)

## 一、问题背景：Hermes 为什么同时需要 Memory 与 Skill

Hermes 的系统提示装配逻辑明确告诉代理：如果获得了稳定事实，如用户偏好、环境约束、工具 quirks，应优先写入 memory；如果获得了新的做事方法、故障修复套路或可反复复用的流程，则应沉淀为 skill。[1] 这说明 Hermes 从一开始就把“长期知识”拆成了两种不同的数据形态，而不是用单一知识库容纳一切。

这种拆分并不是文档层面的概念区分，而是贯穿到实际运行机制。内置记忆会在会话开始时以冻结快照注入系统提示；技能则先以压缩索引的方式进入系统提示，待模型判断相关后，再通过 `skill_view` 做按需全文加载。[1] [4] 这意味着 Memory 是默认常驻上下文的一部分，而 Skill 更像是按需挂载的外部化程序经验。

下表可概括二者的职责边界。

| 维度 | Memory | Skill |
|---|---|---|
| 主要保存对象 | 用户偏好、环境事实、长期稳定约束、工作经验摘要 | 可复用流程、模板、脚本、参考资料、配置与依赖说明 |
| 典型粒度 | 短条目，有限字符预算 | 目录化能力包，可包含多文件 |
| 进入模型方式 | 会话开始时自动注入冻结快照 | 先暴露索引，再按需加载正文与 supporting files |
| 更新方式 | `memory` 工具 `add/replace/remove` | `skill_manage` 的创建、补丁、编辑、删除等动作 |
| 面向问题 | “记住事实与偏好” | “下次按这个方法做” |
| 主要风险控制 | 内容扫描、字符限制、并发安全、快照冻结 | 路径边界、平台过滤、注入检测、readiness 检查 |

从系统架构上看，这是一种典型的**事实层**与**程序层**分治。事实层解决“别让用户重复解释自己是谁、环境是什么、有哪些长期偏好”；程序层解决“别让模型每次从头发明流程”。这恰恰构成了 Hermes 自助进化中最重要的一道分流阀门。[1] [2] [4]

## 二、记忆模块：从内置文件记忆到插件化长期记忆编排

### 2.1 内置记忆的最小可靠实现

Hermes 的默认记忆实现位于 `tools/memory_tool.py`。它并不试图提供一个大型知识库，而是刻意做成一个**小而稳、显式可控的长期记忆层**。底层只使用两个文件：`MEMORY.md` 与 `USER.md`。前者保存代理自己的长期工作笔记，例如环境事实、项目惯例、工具特性；后者保存关于用户的长期画像，例如写作偏好、交流方式和工作习惯。[2]

这一设计的第一层关键点是 **双目标分离**。Hermes 明确把“关于用户”的信息和“关于世界/环境/项目”的信息分开存储，这使后续注入系统提示时能以不同标题组织内容，也降低了记忆条目语义混杂的风险。[2]

第二层关键点是 **冻结快照模式**。`MemoryStore.load_from_disk()` 在会话初始化时读取两份记忆文件，并把它们渲染成 `_system_prompt_snapshot`。此后，本轮会话里即便调用 `memory` 工具写入磁盘，系统提示中的记忆块也不会动态刷新。源码注释明确说明，这样做是为了维持 system prompt 稳定，从而保留 prefix cache 的收益。[2] 这是一项很有工程味的权衡：牺牲“本轮写入立刻影响当前系统提示”的即时性，换取更稳定的推理前缀和更低的上下文波动。

第三层关键点是 **边界与安全控制**。内置记忆有固定字符预算，而不是无限扩展；新增或替换内容之前，会用 `_scan_memory_content()` 扫描 prompt injection、角色劫持、秘密外泄和隐形 Unicode 等风险模式。因为记忆会进入未来会话的系统提示，所以 Hermes 明确把记忆视为高敏感输入面，而不是普通文本缓存。[2]

第四层关键点是 **并发持久化安全**。内置记忆的读写使用锁文件和原子 rename，避免并发写入导致的文件截断或部分可见状态。这说明 Hermes 并不是把记忆当成“玩具功能”，而是意识到跨会话持久层一旦损坏，就会对未来多个任务持续产生污染。[2]

### 2.2 记忆不是单一实现，而是统一的 Provider 抽象

如果说 `memory_tool.py` 提供了内置文件记忆，那么 `agent/memory_provider.py` 与 `agent/memory_manager.py` 则提供了 Hermes 更抽象的一层：**记忆提供者协议**与**记忆管理器**。`MemoryProvider` 抽象类定义了统一生命周期，包括 `initialize()`、`system_prompt_block()`、`prefetch()`、`queue_prefetch()`、`sync_turn()`、`get_tool_schemas()`、`handle_tool_call()` 以及若干可选钩子，如 `on_turn_start()`、`on_session_end()`、`on_pre_compress()`、`on_memory_write()` 和 `on_delegation()`。[3]

这里非常值得注意的一点是：Hermes 对记忆的理解并不止于“存和取”。它把记忆放在了一条完整的代理生命周期链路上：会话启动可以初始化后端，回合开始可以维护状态，回复前可以预取相关信息，回合结束可以异步同步，压缩前可以提炼要保留的 insight，会话结束可以做总结抽取，内置记忆写入后还可以镜像到外部语义记忆。换句话说，Hermes 的记忆系统本质上是一个**事件驱动的长期适应子系统**，而不仅是一个 KV 存储接口。[3]

`MemoryManager` 把这一协议统一编排起来。它坚持三个强约束。第一，**内置记忆始终存在并且排第一位**；第二，**外部 provider 最多只允许一个**；第三，**各 provider 失败相互隔离**。源码注释明确指出，只允许一个外部 provider，是为了避免 tool schema 膨胀和多个记忆后端之间的语义冲突。[3] 这是一种非常克制的架构选择：Hermes 认可外部语义记忆的价值，但不愿把记忆系统本身做成“多后端竞争的复杂中枢”。

### 2.3 内置记忆与外部记忆的关系

在 Hermes 的记忆设计里，内置记忆并不是外部 provider 的后备方案，而是一个**永久存在的最小可靠层**。抽象接口文档明确写道，外部 provider 是 additive 的，永远不会替代 built-in store。[3] 这意味着 Hermes 对长期记忆的分层是有优先级的：

| 层次 | 作用 | 特征 |
|---|---|---|
| 内置记忆 | 最小可靠、显式可编辑、强可审计 | 文件后端、预算受限、冻结快照 |
| 外部 provider | 语义检索、异步同步、自动抽取、扩展工具 | 插件化、可选启用、生命周期钩子丰富 |

这种层次结构具有明显的工程优势。即便外部 provider 不可用，Hermes 仍有一个稳定可工作的长期记忆底座；而一旦外部 provider 启用，内置记忆的显式写入又可以通过 `on_memory_write()` 钩子向外传播，使用户确认过的事实流入更强的语义后端。[3]

> “Built-in memory is always active as the first provider and cannot be removed. External providers … are additive — they never disable the built-in store.” [3]

这个设计体现出 Hermes 的一个核心价值观：**高级能力可以是可选增强，但基础可控性必须始终保留。**

## 三、Skill 模块：把可复用经验封装成能力包

### 3.1 Skill 不是提示词片段，而是目录化能力包

Hermes 的 Skill 实现位于 `tools/skills_tool.py`、`tools/skill_manager_tool.py` 以及若干辅助模块中。根据 `skills_tool.py` 的顶层文档，Skill 的基本组织方式是一个目录，其中 `SKILL.md` 为主文件，`references/`、`templates/`、`assets/`、`scripts/` 等为可选 supporting files。[4]

这种目录结构已经说明，Hermes 对 Skill 的定义远超过“保存一段好 prompt”。它更接近一个**可复用能力包**：既可以包含行为说明，也可以携带示例、模板、脚本和素材。与此同时，`SKILL.md` 的 frontmatter 又允许声明 `platforms`、`required_environment_variables`、`required_credential_files`、`metadata.hermes.tags`、`metadata.hermes.related_skills`、`setup.collect_secrets` 等元信息。[4]

因此，一个 Skill 同时具备三层含义。第一层是**行为协议**，告诉模型应如何做；第二层是**资源包**，提供执行这个协议所需的补充文件；第三层是**运行约束声明**，说明这个协议需要什么平台、环境变量和凭据支持。正因为有这三层能力，Hermes 的 Skill 才能成为长期程序经验的封装载体。

### 3.2 渐进披露：先列索引，再按需加载

Hermes Skill 系统最有代表性的工程决策之一，是 `skills_list()` 与 `skill_view()` 组成的**渐进披露机制**。`skills_list()` 只返回技能名、描述与分类，目的是最小化 token 占用；当模型判定某个 Skill 与当前任务相关时，再通过 `skill_view()` 加载完整正文和 supporting files。[4]

这种机制的意义在于，Hermes 试图把“长期经验库”做大，但又不想让每次对话都背负全部细节。于是，技能索引承担的是“能力发现”功能，技能正文承担的是“能力展开”功能。对模型而言，这近似于从“低分辨率检索”过渡到“高分辨率执行”。

更重要的是，`prompt_builder.py` 会把一个紧凑的技能索引直接注入系统提示，并明确要求代理：先扫描技能列表，若存在明显匹配项，就调用 `skill_view(name)` 加载并遵循技能说明；若技能有问题，则使用 `skill_manage(action='patch')` 立即修补。[1] 由此可见，Hermes Skill 系统不是一个被动资料库，而是一个被系统提示显式激活的运行时决策层。

### 3.3 Skill 的 readiness：从元数据到执行权限

`skill_view()` 在加载技能正文时，还会做一件非常关键的事：判定该 Skill 是否“准备就绪”。它会检查 `required_environment_variables` 是否已经持久化可用，检查 `required_credential_files` 是否存在，并据此返回 `readiness_status`、`setup_needed`、`setup_note` 等字段。[4]

这个 readiness 机制的工程价值不在于“提示用户缺啥”，而在于把 Skill 的依赖声明与实际执行环境安全控制联动起来。`skills_tool.py` 会把已满足的环境变量注册到 `env_passthrough` 机制中；而 `env_passthrough.py` 又明确说明，默认情况下执行沙箱会剥离秘密环境变量，只有技能显式声明且被允许透传的变量才能进入子进程环境。[5]

这意味着 Skill frontmatter 中的依赖声明并不只是文档，而是**影响执行权限边界的真实控制面**。只有当一个 Skill 被加载、依赖被判定为满足、相关变量被登记后，它所需的 secrets 才能进入代码执行或终端环境。[4] [5]

> `env_passthrough.py` 明确指出，默认执行环境会去除 secrets，而 `required_environment_variables` 声明是允许这些变量通过的两大来源之一。[5]

这是一项非常重要的设计信号：Hermes 把 Skill 当成了“受控能力升级”的单位。Skill 不只是指导模型做事，还能在受约束的前提下扩展其执行环境能力。

## 四、Skill 管理：允许模型进化经验，但限制其修改边界

### 4.1 管理与消费分离

Hermes 对 Skill 做了一个非常值得肯定的架构拆分：**运行时消费**与**编辑时管理**分离。`skills_tool.py` 负责浏览与加载技能；`skill_manager_tool.py` 则负责创建、补丁、重写文件、删文件与删除技能等管理动作。[4] [6]

这种拆分看似平常，实际上体现了很强的安全与治理意识。如果只有一个统一工具既可浏览又可随意写，那么模型在执行中就容易越界；而把管理行为隔离出来后，Hermes 就能对写操作施加更严格的边界约束，例如限定写入位置、验证技能目录、控制动作类型和文件路径。

### 4.2 Skill 管理的核心动作语义

根据 Skill 管理器源码与官方文档，Hermes 支持围绕技能目录进行的多种动作，包括新建技能、为现有技能打补丁、重写 supporting files、移除单个文件以及删除整个技能目录。[6] 这种动作协议意味着模型被允许做的不是“随意编辑仓库”，而是“在专门的长期能力容器中进行结构化维护”。

这样做的意义在于，Hermes 把“自我进化”限制为对**外部化经验资产**的持续维护。模型可以总结出更好的流程、修正错误步骤、补充遗漏的注意事项，也可以删除过时的 supporting files，但这些变化都必须发生在 Skill 的边界内，而不能直接修改代理内核本身。[6]

### 4.3 patch-first 的维护文化

`prompt_builder.py` 在 Skills 系统提示中明确要求：当代理加载一个 Skill 并发现其中步骤不完整、命令错误或缺少自己刚发现的坑点时，应在结束任务之前立即用 `skill_manage(action='patch')` 修补它。[1] 这揭示了 Hermes 的一个核心理念：**Skill 不是静态文档，而是长期维护对象**。

换言之，Hermes 所追求的不是“一次性生成技能”，而是“任务驱动的连续校正”。Skill 管理器的存在，使模型在完成任务后可以把新发现反写到自己的外部能力库中，形成可审计、可复用、可持续优化的经验资产。这种机制正是 Hermes 自助进化设计在程序层面的直接体现。[1] [6]

## 五、Skill 如何在运行时真正变成行为

### 5.1 系统提示中的技能索引装配

`prompt_builder.py` 会扫描本地和外部技能目录，生成一个按分类组织的紧凑索引，并把它注入系统提示。为了降低冷启动开销，这个索引构建还实现了进程内缓存与磁盘快照缓存，只有当 manifest 变化时才重新构建。[1] 这表明 Hermes 认为 Skill 数量可能增长到需要专门做索引缓存的程度，也侧面说明 Skill 是其核心运行机制，而不是附属功能。

被注入系统提示的并不是所有 Skill 的全文，而是“名称 + 描述 + 分类”的索引。系统提示还写明：如果某个 Skill 明显匹配当前任务，就应该使用 `skill_view(name)` 加载全文。[1] 因此，Skill 的运行时模式是 **索引触发的按需展开**，而不是全量灌入上下文。

### 5.2 slash 命令与预加载

`agent/skill_commands.py` 进一步把 Skill 与交互表面连接起来。它会扫描技能目录，将技能名称规范化成 `/skill-name` 形式的命令；当用户显式使用某个 slash 命令时，Hermes 会读取该 Skill，构造一条激活消息，将技能正文、setup note、supporting files 提示、用户附加指令和运行时说明一起注入当前会话。[7]

此外，`build_preloaded_skills_prompt()` 支持会话启动时预加载一个或多个 Skill，使它们在整个会话期间持续有效。[7] 由此可见，Skill 的运行时定位非常特殊：它既不是普通工具，也不是硬编码系统提示，而是一种**可动态挂载的行为协议层**。

这也是 Hermes Skill 设计比“提示词库”更高级的地方。传统提示词库只是在用户手动复制粘贴时发挥作用；而 Hermes 的 Skill 能被发现、被加载、被预加载、被显式命令激活，还能带着 setup 状态和 supporting files 一起工作。[4] [7]

## 六、记忆与 Skill 的协同机制

### 6.1 两条沉淀路径的协同分工

Hermes 的系统提示中同时存在 Memory Guidance 与 Skill Guidance。前者强调保存用户偏好、环境事实和稳定惯例，后者强调在复杂任务、棘手报错或非平凡 workflow 完成后，将其沉淀为 Skill。[1] 这说明 Hermes 对代理长期适应采取的是一种**双路径协同策略**：

1. 稳定事实进入 Memory；
2. 可复用方法进入 Skill。

这两个路径的协同价值在于避免“长期知识单仓库化”。如果所有长期内容都进入记忆，那么记忆会被流程细节撑爆；如果所有长期内容都做成 Skill，又会把大量事实性偏好文档化得过重。Hermes 正是通过职责分离，才同时获得了紧凑事实记忆与高表达力程序经验库。[1] [2] [4]

### 6.2 Memory 为 Skill 提供上下文参数，Skill 为 Memory 提供行为模板

从运行逻辑看，Memory 与 Skill 是互补关系。Memory 以冻结快照形式进入每轮系统提示，因此可以向所有任务提供默认上下文。例如，用户偏好“报告多用表格、少用 bullet”，这类信息进入 `USER.md` 后，会影响 Skill 最终落地时的输出风格。[2]

而 Skill 则提供结构化方法模板。例如，一套“GitHub 深度调研”技能可以定义搜索轮次、证据保留方式、结构化成文模版。执行该 Skill 时，模型不会重新发明流程，而是直接复用既有做法。[4] [6] [7]

因此可以说，**Memory 提供个性化参数，Skill 提供程序化模板**。前者回答“在谁的上下文里做”，后者回答“按什么方法做”。

### 6.3 生命周期钩子让记忆系统成为更广义的学习总线

虽然 Skill 没有像 MemoryProvider 那样定义完整生命周期钩子协议，但 Memory 系统中的 `on_pre_compress()`、`on_session_end()`、`on_memory_write()`、`on_delegation()` 等钩子，实际上为更高级的长期学习铺设了总线。[3] 它们让 Hermes 能在上下文压缩前抽取可保留 insight、在会话结束时总结、在子代理完成任务后吸收结果、在显式 memory 写入后同步到外部后端。

这套机制与 Skill 管理器配合后，会形成一个自然的经验演化回路：任务执行时，系统提示激活技能索引；任务结束后，若发现稳定事实，则写 memory；若发现可复用流程，则 patch 或创建 skill；若启用了外部记忆 provider，则这些显式结果还可能进一步被同步和检索。[1] [3] [6]

## 七、设计权衡：Hermes 为什么这样做

### 7.1 记忆层的权衡：小容量换高可控

Hermes 的内置记忆采用字符上限、显式编辑和冻结快照，明显不是为了追求“记更多”，而是为了追求“记得稳、记得准、记得可审计”。这使它很适合保存长期偏好和稳定约束，却不适合保存复杂任务过程、超长项目状态或大量临时上下文。因此系统提示中才会明确区分：任务进度和已完成结果不应写入 memory，而应依赖 `session_search` 等机制跨会话召回。[1] [2]

### 7.2 Skill 层的权衡：高表达力换治理成本

Skill 的表达能力远比 Memory 强，因为它可以包含多文件、脚本、模板和依赖声明。但高表达力带来的副作用是治理成本上升：技能过多后需要索引缓存，技能质量下降时需要 patch，依赖不完整时需要 setup 检查，安全上还要防止 prompt injection 和路径越界。[1] [4] [6]

Hermes 对此的回答并不是放弃 Skill，而是增加治理基础设施：索引快照缓存、禁用列表、平台过滤、readiness 判定、supporting files 按需加载，以及 patch-first 的维护文化。[1] [4] [6]

### 7.3 两者共同体现的工程哲学

无论是 Memory 还是 Skill，Hermes 的底层哲学高度一致：

| 哲学原则 | 在 Memory 中的体现 | 在 Skill 中的体现 |
|---|---|---|
| 长期知识必须外部化 | `MEMORY.md` / `USER.md` 持久化 | `SKILL.md` 与 supporting files 持久化 |
| 外部化知识必须可审计 | 明确文件、显式条目、有限预算 | 明确目录结构、frontmatter、可查看正文 |
| 长期知识必须可约束 | 内容扫描、预算限制、快照冻结 | 路径边界、平台过滤、依赖检查、secret 透传白名单 |
| 代理应主动维护长期知识 | 系统提示鼓励写 memory | 系统提示鼓励保存/修补 skill |

这使 Hermes 的“自助进化”不同于许多仅靠在线反思或隐式权重更新的方案。它更像一种**外部化、受控、可回溯的知识资产演化机制**。

## 八、我的综合判断

如果只用一句话概括 Hermes-Agent 在这两个模块上的设计，我会说：它把“持续学习”拆成了**事实记忆的稳定化**与**方法资产的程序化**两件事，并分别为它们设计了不同的数据形态、运行路径和安全约束。

记忆模块最值得肯定的地方，是它没有迷信“大记忆”，而是优先保证可控性、稳定性和可审计性。Skill 模块最值得肯定的地方，则是它没有停留在“提示词收藏夹”层面，而是把技能升级为可带元数据、可带依赖声明、可带 supporting files、可做运行时预加载和命令激活的能力包。

更重要的是，这两个模块并不是彼此独立的小功能。Memory 通过系统提示快照为一切任务提供个性化上下文；Skill 通过系统提示索引与按需加载为复杂任务提供程序化模板；而系统提示本身又不断督促代理在任务结束后把稳定事实写入 Memory、把新方法沉淀为 Skill。[1] [2] [4] [6] 这才是 Hermes-Agent “自助进化”最扎实的一层工程实现。

## 参考资料

[1]: https://github.com/NousResearch/hermes-agent/blob/main/agent/prompt_builder.py "Hermes-Agent prompt_builder.py"
[2]: https://github.com/NousResearch/hermes-agent/blob/main/tools/memory_tool.py "Hermes-Agent memory_tool.py"
[3]: https://github.com/NousResearch/hermes-agent/blob/main/agent/memory_provider.py "Hermes-Agent memory_provider.py"
[4]: https://github.com/NousResearch/hermes-agent/blob/main/tools/skills_tool.py "Hermes-Agent skills_tool.py"
[5]: https://github.com/NousResearch/hermes-agent/blob/main/tools/env_passthrough.py "Hermes-Agent env_passthrough.py"
[6]: https://github.com/NousResearch/hermes-agent/blob/main/tools/skill_manager_tool.py "Hermes-Agent skill_manager_tool.py"
[7]: https://github.com/NousResearch/hermes-agent/blob/main/agent/skill_commands.py "Hermes-Agent skill_commands.py"
[8]: https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly/ "Hermes-Agent Developer Guide: Prompt Assembly"
[9]: https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage/ "Hermes-Agent Developer Guide: Session Storage"
[10]: https://hermes-agent.nousresearch.com/docs/developer-guide/architecture/ "Hermes-Agent Developer Guide: Architecture"
