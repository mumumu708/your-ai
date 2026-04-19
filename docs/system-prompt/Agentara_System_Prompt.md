# Agentara 的 System Prompt 设计调研

## 结论

从源码看，**Agentara 并没有把 system prompt 设计成一段隐藏在服务端代码里的巨型字符串**，而是把它做成了一个**文件化、可持久化、可被用户长期维护的指令框架**。其核心载体是 `~/.agentara/CLAUDE.md`；首次启动时，启动器会自动把仓库中的默认版本下载到用户 home 目录下，之后会话默认也在这个 home 目录启动，因此 Claude Code 会直接在该工作目录下运行，而 Codex 则由 Agentara 在每次调用前把 `CLAUDE.md` 解析、展开并同步成 `AGENTS.md` 供 Codex 原生读取。[1] [2] [3] [4] [5]

这意味着，**Agentara 自己的 prompt 设计哲学不是“后台动态拼一段隐式 system prompt”**，而是“**用一个显式主文件 + 少量长期记忆文件 + 运行约定**”来塑造 agent 行为。换言之，它的 system prompt 更像是一个**可编辑的 operating manual**，而不只是模型初始化时的一次性提示词。[1] [4] [5] [6]

| 问题 | 结论 | 证据 |
|---|---|---|
| system prompt 的主载体是什么 | `CLAUDE.md` 是主入口文件 | [1] [4] |
| 是否在启动时自动准备 | 是，BootLoader 会在缺失时下载默认 `CLAUDE.md` | [1] |
| 是否默认进入所有会话 | 是，会话 `cwd` 默认指向 `config.paths.home`，即 `~/.agentara` | [2] [3] |
| Claude 与 Codex 的加载方式是否相同 | 不完全相同；Claude 直接在含 `CLAUDE.md` 的目录运行，Codex 会先同步成 `AGENTS.md` | [4] [5] |
| 是否有单独的后端 prompt 编排器 | 从当前源码看，没有发现一个独立的动态 prompt builder | [4] [5] [6] |

## 一、它的 prompt 是如何“分层”设计的

Agentara 的 system prompt 可以理解为四层叠加结构。第一层是**基础行为骨架**，写在默认 `CLAUDE.md` 中，包括能力宣告、目录规范、会话结束协议、`memory/` 文件的写作方式，以及 IM 场景下的消息发送约定。[4] 第二层是**长期记忆层**，即 `SOUL.md` 和 `USER.md`。这两个文件通过 `@memory/SOUL.md`、`@memory/USER.md` 的形式被主文件引用，用来承载 agent 自我身份、用户偏好、历史上下文等长期稳定信息。[4] [6] 第三层是**运行时兼容层**，Agentara 为 Codex 专门做了一层适配：先解析 `CLAUDE.md` 里的 `@path/file` 引用，再把文本中的 “Claude Code” 替换为 “Codex”，最后写成 `AGENTS.md`。[5] [6] 第四层则是**外部技能层**。虽然 skills 不直接拼进 system prompt 文本，但 `CLAUDE.md` 会明确要求 agent 优先发现、使用、必要时创建技能，因此它相当于通过规则把“技能系统”纳入了 prompt 的操作范围。[1] [4]

| 层次 | 载体 | 作用 | 设计意义 |
|---|---|---|---|
| 基础行为骨架 | `CLAUDE.md` | 规定能力、自我定位、目录结构、输出约定、会话结束更新记忆等规则 | 让 agent 的行为长期稳定且可审查 |
| 长期记忆层 | `memory/SOUL.md`、`memory/USER.md` | 注入身份、偏好、重要历史与持续上下文 | 让 prompt 具备用户个性化和跨会话延续性 |
| 运行时兼容层 | `resolveInstructionFile()` + `AGENTS.md` 同步 | 让同一套 prompt 能同时服务 Claude 与 Codex | 降低双 runner 的维护成本 |
| 外部技能层 | `.claude/skills` 与规则引用 | 让 prompt 不只是“说话方式”，而是扩展到“做事方式” | 把技能发现与调用上升为默认工作流 |

这种分层方式的关键特点是：**把稳定部分写死在主文件里，把变化较慢但需要长期维护的部分放进 memory 文件，把 runner 差异放在适配层解决**。因此，Agentara 的 system prompt 不是一段扁平文本，而是一套围绕文件组织出来的“提示词操作系统”。[1] [4] [5] [6]

## 二、默认 `CLAUDE.md` 到底写了什么

默认 `CLAUDE.md` 的前两段非常关键。它先要求 agent “先读 `SOUL.md`，回忆自己是谁、能力和原则”，再要求 agent “读 `USER.md`，回忆用户是谁、偏好、持续上下文和重要历史”；随后把两份文件通过 `@memory/...` 的形式嵌入进来。[4] 这说明 Agentara 对 system prompt 的理解并不是“只给模型一段静态规则”，而是“**静态规则 + 可演化的人格/用户记忆**”。

在此之后，`CLAUDE.md` 继续规定 agent 的能力边界，例如把 Claude Code 描述为最强编码 agent、要求必要时使用 web search、使用或创建 skills；又规定了目录布局，明确 `memory/`、`workspace/`、`uploads/`、`outputs/` 的职责；还定义了 session end protocol，要求在会话结束前按需更新 `memory/USER.md` 与 `memory/SOUL.md`，并特别强调要**清理过时或无关信息**、控制 token 长度。[4] 这些内容都表明：**Agentara 的 system prompt 并不只是“如何回答”，而是同时约束“如何组织文件、如何沉淀长期记忆、如何在会话末完成维护动作”。**

尤其值得注意的是，`CLAUDE.md` 里还包含 IM 适配约束，例如哪些路径的文件可以真正发送给用户、如何用 Markdown 链接发送非图片文件、如何嵌入本地图片、如何限制表格数量等。[4] 这意味着它不仅在塑造模型思考，也在塑造**消息渠道兼容性**。从 prompt engineering 的角度说，这是一种非常工程化的设计：把“模型行为约束”与“产品交付约束”合并到同一个系统提示文件里。

## 三、运行时是如何真正加载进去的

启动阶段，BootLoader 会确保 `~/.agentara` 目录、`memory/`、`workspace/`、`.claude/` 等目录存在；如果 `CLAUDE.md` 不存在，就从仓库 `user-home/CLAUDE.md` 下载一份到 `config.paths.home` 下。[1] 而 `config.paths.home` 默认为 `~/.agentara`，`memory`、`workspace` 等路径也都从这里展开。[2] 之后，会话管理器在创建会话时，若未显式传入 `cwd`，就默认使用 `config.paths.home` 作为工作目录，并把该目录写入 session 元数据；恢复会话时也会继续沿用这个 `cwd`。[3]

对 **Claude** 而言，运行器只是以这个 `cwd` 启动 `claude` 命令，并没有在命令行参数里显式再传一段 system prompt 文本。[4] 这说明 Agentara 对 Claude 的策略是：**把 prompt 放到工作目录中的 `CLAUDE.md`，再依赖 Claude Code CLI 的原生约定去读取它。** 对 **Codex** 而言，情况稍微复杂。由于 Codex 原生读取的是 `AGENTS.md`，所以 Agentara 会在每次调用前执行 `_syncAgentsMd()`：读取 `cwd/CLAUDE.md`，用 `resolveInstructionFile()` 展开 `@memory/USER.md`、`@memory/SOUL.md` 这类静态导入，再把 “Claude Code” 文本替换成 “Codex”，最后写成 `cwd/AGENTS.md`。[5] [6]

| 运行器 | system prompt 的入口 | Agentara 是否显式预处理 | 实际效果 |
|---|---|---|---|
| Claude Code | `cwd` 下的 `CLAUDE.md` | 从当前代码看，不显式做文本展开；直接交给 Claude CLI 原生读取 | 设计上更贴近 Claude 原生生态 [4] |
| Codex | `cwd` 下的 `AGENTS.md` | 是，会先从 `CLAUDE.md` 解析导入并同步生成 | 让 Claude 与 Codex 共享同一套提示骨架 [5] [6] |

因此，从运行机制上看，Agentara 的 system prompt 不是通过 API 请求体中的 `system` 字段注入，而是通过**工作目录中的规范文件**注入。这也是它与很多“后端拼 prompt + API 调模型”的 agent 框架最明显的区别之一。[1] [3] [4] [5]

## 四、这套设计体现了什么 prompt 设计思路

第一，它强调**可见性与可编辑性**。默认 prompt 不是隐藏实现，而是一个用户本地可见、可修改、可版本化的 Markdown 文件。[1] [4] 这使得 prompt 成为产品的一部分，而不仅是工程细节。

第二，它强调**人格与用户画像的分离**。`SOUL.md` 更偏 agent 自我身份、原则与能力；`USER.md` 更偏用户偏好、长期项目与历史上下文。[4] [7] 这种拆分让系统提示能够同时承载“我是谁”和“我为谁服务”，减少把所有信息揉成一团的混乱。

第三，它强调**低 token 的长期记忆**。`CLAUDE.md` 明确要求 `SOUL.md` 和 `USER.md` 都控制在 1000 tokens 内，并鼓励把细节移到其他文件。[4] 这并不是一个 RAG 式记忆系统，而是一种**把长期稳定认知压缩进 system layer** 的做法。它的优点是简单、稳定、低依赖；缺点则是当长期上下文过多时，需要人工维护和清理。

第四，它强调**跨 runner 统一提示**。Codex 适配层并不是另写一套 prompt，而是复用 `CLAUDE.md`，只做导入展开和少量名称替换。[5] 这说明 Agentara 希望把不同底层 agent CLI 的差异，尽量收敛到一个共同的 system prompt 框架上。

第五，它强调**把工作流规则写进 prompt，而不是写进复杂 runtime**。例如“会话结束前更新记忆”“不要直接发送 project 目录下文件”“必要时创建技能”等，都被写成了 prompt 约束。[4] 这与它整体“轻 orchestration、重 CLI 原生能力”的架构风格是一致的。

## 五、我对其 system prompt 设计的判断

综合来看，Agentara 的 system prompt 设计可以概括为：**一个以 `CLAUDE.md` 为中心、以 `USER.md`/`SOUL.md` 为长期记忆层、以 `AGENTS.md` 同步为跨 runner 兼容层的文件化操作系统提示框架。** 它的长处在于结构清楚、透明、可维护、容易个性化，也容易与 Claude/Codex 这类本地 agent CLI 对接。[1] [4] [5]

但它也有明显边界。因为它主要依赖**静态主文件 + 少量记忆文件**，所以并没有看到一个更复杂的“任务级动态 prompt 组装器”“基于检索的记忆回灌器”或“上下文自动压缩中间层”。[4] [5] [6] [7] 这意味着它的 system prompt 更适合承载**稳定原则、长期偏好、产品约束和工作约定**，而不是承担完整的长期上下文治理。

如果用一句话总结：**Agentara 的 system prompt 不是“魔法隐藏词”，而是一套公开、文件化、长期维护的 agent 宪法。**

## References

[1]: https://github.com/MagicCube/agentara/blob/main/src/boot-loader/boot-loader.ts "BootLoader: default CLAUDE.md download and home initialization"
[2]: https://github.com/MagicCube/agentara/blob/main/src/shared/config/paths.ts "Path configuration for home, memory, workspace, and skills"
[3]: https://github.com/MagicCube/agentara/blob/main/src/kernel/sessioning/session-manager.ts "SessionManager: default cwd and session persistence"
[4]: https://github.com/MagicCube/agentara/blob/main/user-home/CLAUDE.md "Default CLAUDE.md instruction scaffold"
[5]: https://github.com/MagicCube/agentara/blob/main/src/community/openai/codex-agent-runner.ts "Codex runner: sync CLAUDE.md to AGENTS.md"
[6]: https://github.com/MagicCube/agentara/blob/main/src/shared/instructions/resolve-instructions.ts "Instruction resolver for @path/file imports"
[7]: https://github.com/MagicCube/agentara/blob/main/src/server/routes/memory.ts "Memory routes for USER.md and SOUL.md"
