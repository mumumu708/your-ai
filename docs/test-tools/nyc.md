# nyc 使用调研总结

> **结论先行**：`nyc` 是 [Istanbul](https://istanbul.js.org/) 的命令行覆盖率工具，适合给现有 JavaScript／TypeScript 测试命令"外面再包一层"，从而生成文本、LCOV、HTML 等覆盖率报告。对于多数 Node 项目，最常见的接入方式就是：先保留原有 `test` 脚本，再增加一个 `coverage` 脚本，通过 `nyc npm run test` 来执行测试并收集覆盖率。[1]

## 一、这个仓库是什么，适合在什么场景下使用

`istanbuljs/nyc` 仓库的定位非常明确：它是 **Istanbul 的命令行接口**，用于对 JavaScript 代码进行插桩并统计测试覆盖率。README 明确说明，`nyc` 可以与常见测试框架协同工作，例如 Mocha、AVA 等；它也特别强调对 Babel 与 TypeScript 项目的 source map 覆盖率支持。[1] 从仓库元数据看，该项目长期活跃，当前主线版本为 **18.0.0**，最新主版本已经把 Node 运行环境要求提升到了 **`20 || >=22`**。[2] [3]

如果你的项目已经有测试命令，只是还没有覆盖率报告，那么 `nyc` 非常适合直接接入。如果你使用的是 Jest 或 tap，则 README 还特别提醒：这两类运行器已经内置了 Istanbul 相关能力，通常**不需要额外安装 `nyc`**，应优先查看各自测试框架的覆盖率文档。[1]

| 维度 | 说明 |
| --- | --- |
| 仓库定位 | Istanbul 的命令行覆盖率工具 [1] |
| 典型语言 | JavaScript，且支持 Babel／TypeScript 场景 [1] |
| 常见用途 | 统计单元测试覆盖率、输出 HTML／LCOV 报告、做覆盖率阈值校验 [1] |
| 进阶用途 | 合并多轮测试覆盖率、预插桩源码、配合 CI 上传到 Codecov／Coveralls [1] [4] |
| 当前版本环境要求 | v18.0.0 需要 Node `20 || >=22` [2] [3] |

## 二、最快的上手方式

最标准的做法是把 `nyc` 安装为开发依赖，然后让它去执行你已有的测试命令。官方 README 给出的推荐示例如下：先把测试脚本写成普通测试命令，例如 `mocha`，再新增一个覆盖率脚本，用 `nyc npm run test` 包起来即可。[1]

```bash
npm i -D nyc
```

```json
{
  "scripts": {
    "test": "mocha",
    "coverage": "nyc npm run test"
  }
}
```

执行时，直接运行：

```bash
npm run coverage
```

这样做的好处是：**测试命令与覆盖率命令解耦**。平时本地快速跑测试时继续用 `npm test`；需要产出覆盖率时再运行 `npm run coverage`。这是最稳妥、最容易维护的接入方式。[1]

如果你不想安装依赖，也可以使用 `npx` 直接执行。不过 README 明确提醒，直接使用 `npx nyc` 可能会拿到你尚未准备好的新版本，因此更安全的做法是**固定大版本号**，例如 `npx nyc@17 mocha` 或 `npx nyc@18 mocha`。[1]

| 方式 | 推荐程度 | 示例 | 说明 |
| --- | --- | --- | --- |
| 安装为开发依赖 | 高 | `npm i -D nyc` | 最稳定，适合团队协作与 CI [1] |
| 直接用 `npx` | 中 | `npx nyc@18 mocha` | 适合临时使用，但建议固定版本 [1] |
| 在原有测试脚本外包裹 `nyc` | 高 | `nyc npm run test` | 最符合官方 README 的接入方式 [1] |

## 三、命令行怎么写

`nyc` 的命令行参数必须写在**被执行程序之前**。README 给出的例子是：

```bash
nyc --reporter=lcov --reporter=text-summary ava
```

这条命令的含义是：让 `nyc` 去执行 `ava`，并同时输出 `lcov` 与 `text-summary` 两种报告格式。[1] 因此，理解 `nyc` 的关键不是把它当作"测试框架"，而是把它当成一个"覆盖率包装器"。它负责包裹真实测试命令，并在执行过程中完成覆盖率收集与报告生成。

对于大多数项目，我建议把命令拆成两层：一层是纯测试命令，另一层是覆盖率命令。这样 CI 和本地开发都更清晰。例如：

```json
{
  "scripts": {
    "test": "mocha 'test/**/*.spec.js'",
    "coverage": "nyc --reporter=text --reporter=lcov npm run test"
  }
}
```

生成 HTML 报告的常见做法是启用 `lcov` 报告器。根据 README，`lcov` 会生成 `lcov.info` 和 HTML 报告目录，默认输出在 `./coverage` 下。[1]

## 四、推荐的配置文件写法

`nyc` 支持把命令行参数写进配置文件。官方支持以下几种文件：`package.json` 中的 `nyc` 字段、`.nycrc`、`.nycrc.json`、`.nycrc.yaml`、`.nycrc.yml`，以及可编程的 `nyc.config.js`。[1]

对于一般项目，我更推荐把配置单独放在 `.nycrc.json` 或 `nyc.config.js`。前者直观，后者适合写动态逻辑。下面是一个适合多数 Node 项目的最小配置示例：

```json
{
  "all": true,
  "reporter": ["text", "lcov"],
  "report-dir": "coverage",
  "check-coverage": true,
  "lines": 80,
  "functions": 80,
  "branches": 80,
  "statements": 80
}
```

这份配置的核心价值在于三点。第一，`all: true` 会让未被测试命中的源码文件也进入统计，而不是只统计运行时被 `require()` 到的文件。第二，`reporter` 决定输出格式；实际团队里，通常会同时保留终端文本摘要与 `lcov` 结果。第三，`check-coverage: true` 会让覆盖率门槛真正参与构建成败判断。[1]

README 还给出了一个 `nyc.config.js` 的例子，说明当你需要根据平台动态拼接排除规则时，可以把默认排除项与自定义规则组合起来导出。[1]

| 配置项 | 作用 | 默认值 | 何时建议开启 |
| --- | --- | --- | --- |
| `all` | 统计所有源文件，而不仅是测试触达文件 | `false` | 希望尽早发现"完全没被测试到"的文件时 [1] |
| `check-coverage` | 覆盖率低于阈值时直接失败 | `false` | 用于 CI 门禁时 [1] |
| `reporter` | 定义报告输出格式 | `['text']` | 需要 HTML／LCOV／终端摘要时 [1] |
| `report-dir` | 指定报告输出目录 | `./coverage` | 想统一产物目录时 [1] |
| `include` | 限制参与统计的文件范围 | `['**']` | 只想统计 `src` 等目录时 [1] |
| `exclude` | 从统计中排除文件或目录 | 官方默认排除列表 | 需要剔除测试文件、脚本文件时 [1] |
| `temp-dir` | 原始覆盖率临时数据目录 | `./.nyc_output` | 多轮合并报告时尤其重要 [1] |
| `skip-full` | 不显示 100% 覆盖文件 | `false` | 报告太长时可开启 [1] |

## 五、Babel 与 TypeScript 项目怎么配

README 明确建议：**Babel 项目优先从 `@istanbuljs/nyc-config-babel` 起步，TypeScript 项目优先从 `@istanbuljs/nyc-config-typescript` 起步**。这意味着在这些场景下，最稳妥的方式并不是手写一大堆底层参数，而是先复用官方预设，再叠加少量自定义项。[1]

例如 TypeScript 项目可以这样写：

```json
{
  "extends": "@istanbuljs/nyc-config-typescript",
  "all": true,
  "check-coverage": true
}
```

这样做的意义在于，官方预设已经处理了 TypeScript 与 source map 相关的常见细节，你只需要补充自己项目真正关心的策略，例如是否统计所有文件、是否启用覆盖率门槛。[1]

如果项目采用预插桩而不是运行时转译，README 还特别提醒：应将 `exclude-after-remap` 设为 `false`，否则 source map 重映射之后，某些文件可能因为命中排除规则而从报告里消失。[1]

## 六、哪些文件会被统计，哪些不会

理解 `nyc` 的文件选择逻辑很重要。默认情况下，`nyc` **只统计测试运行期间真正被加载到的源码文件**。如果你希望连未加载的文件也进入覆盖率统计，就必须设置 `--all` 或 `all: true`。[1]

在此基础上，`nyc` 会先从 `cwd` 下、扩展名在 `extension` 列表中的文件里选候选集，然后再按 `include`、`exclude`、排除取反模式等规则过滤。[1] README 还强调了一点：`node_modules` 会被默认加入排除列表；如果确实需要统计依赖中的特定代码，必须显式设置 `excludeNodeModules: false`，并结合更精确的 `include`／`exclude` 规则控制范围。[1]

对于多数业务项目，一个实用配置通常是只统计 `src` 目录，并排除测试文件，例如：

```json
{
  "all": true,
  "include": ["src/**/*.js"],
  "exclude": ["**/*.spec.js"]
}
```

如果你在命令行里直接传 glob，README 建议把模式包在单引号里，以避免被操作系统提前展开。[1]

## 七、如何做覆盖率门槛校验

`nyc` 支持把覆盖率校验直接纳入构建流程。README 给出的方式是：配置 `branches`、`lines`、`functions`、`statements` 等阈值，再把 `check-coverage` 设为 `true`。这样一来，只要覆盖率跌破阈值，命令就会失败，从而让 CI 直接拦截不达标的提交。[1]

典型配置如下：

```json
{
  "check-coverage": true,
  "branches": 80,
  "lines": 80,
  "functions": 80,
  "statements": 80
}
```

如果你希望按**单文件**而不是整体汇总来校验，可以再开启 `per-file: true`。另外，README 还支持配置 `watermarks`，用于控制报告中的高低水位颜色区间，让报告更容易读。[1]

## 八、如何合并多轮测试的覆盖率

这是 `nyc` 很实用但常被忽略的一个能力。如果你的项目把单元测试、集成测试、端到端测试分开跑，那么可以先在多轮执行中保留原始覆盖率数据，再用 `nyc report` 统一产出最终报告。README 给出的关键做法是：第二轮及之后运行时加上 `--no-clean`，避免覆盖前一次的 `.nyc_output` 数据。[1]

官方示例如下：

```json
{
  "scripts": {
    "cover": "npm run cover:unit && npm run cover:integration && npm run cover:report",
    "cover:unit": "nyc --silent npm run test:unit",
    "cover:integration": "nyc --silent --no-clean npm run test:integration",
    "cover:report": "nyc report --reporter=lcov --reporter=text"
  }
}
```

如果你不是想直接出报告，而是想把多次运行的原始数据合成一个 `coverage.json` 给别的工具消费，则应使用 `nyc merge .nyc_output coverage.json`。[1]

## 九、`nyc instrument` 在什么情况下有用

除了最常见的"包测试命令"模式，`nyc` 还提供 `instrument` 子命令，用来生成**预插桩源码**。官方文档说明，它适用于需要把插桩后的代码部署到浏览器端、端到端测试环境，或其他测试流程中的场景。[4]

基本语法是：

```bash
nyc instrument <input> [output]
```

例如：

```bash
nyc instrument ./lib ./output
```

如果不写 `[output]`，插桩结果会直接输出到 `stdout`；如果希望在输出前先删除已有输出目录，可以加 `--delete`；如果希望把未被插桩的其余文件也完整复制过去，可以使用 `--complete-copy`。[4] 这类能力对于浏览器端 E2E、特殊打包流程、动态插桩服务等场景尤其有价值。

## 十、版本与环境方面的注意事项

从当前仓库与发布说明看，`nyc` 的主版本升级已经伴随 Node 版本要求上调。`package.json` 中的 `engines.node` 指向 **`20 || >=22`**，而 v18.0.0 的发布说明也明确写出，其传递依赖现在要求该 Node 范围。[2] [3] 再往前看，v17.0.0 已经把最低 Node 版本提高到了 **18**。[3]

这意味着如果你的项目还停留在 Node 18 或 Node 16，就不应直接无脑升级到最新版 `nyc`。更稳妥的做法是先核对项目运行时版本，再决定安装哪个主版本。如果只是临时试用，使用带主版本号的 `npx nyc@17` 或 `npx nyc@18` 往往更安全。[1] [2] [3]

| 版本 | 关键兼容性信息 | 适合谁 |
| --- | --- | --- |
| `nyc` v18 | Node `20 || >=22` [2] [3] | 已升级到较新 Node 运行时的项目 |
| `nyc` v17 | 最低 Node 18 [3] | 仍在 Node 18 体系内的项目 |

## 十一、给你的实际建议

如果你只是想"把现有项目尽快跑出覆盖率报告"，我建议按下面这个最小方案落地。第一步，确认 Node 版本与 `nyc` 主版本兼容。第二步，安装 `nyc` 并保留原测试命令不动。第三步，新增一个 `coverage` 脚本执行 `nyc npm run test`。第四步，在配置里至少打开 `reporter`、`all` 和 `check-coverage`。这样你就能同时获得本地可读性、CI 可门禁性和后续可扩展性。

一个比较稳的起步模板如下：

```json
{
  "scripts": {
    "test": "mocha",
    "coverage": "nyc npm run test"
  },
  "nyc": {
    "all": true,
    "reporter": ["text", "lcov"],
    "check-coverage": true,
    "lines": 80,
    "functions": 80,
    "branches": 80,
    "statements": 80
  }
}
```

如果你告诉我你的技术栈是 **Mocha、AVA、Vitest、Jest、TypeScript、Babel** 中的哪一种，我还可以继续把这份总结收敛成一份**可直接复制到你项目里的配置文件与 `package.json` 脚本方案**。

## References

[1]: https://github.com/istanbuljs/nyc "istanbuljs/nyc: the Istanbul command line interface"
[2]: https://raw.githubusercontent.com/istanbuljs/nyc/main/package.json "nyc package.json on GitHub"
[3]: https://github.com/istanbuljs/nyc/releases/tag/nyc-v18.0.0 "nyc v18.0.0 release"
[4]: https://istanbul.js.org/docs/advanced/instrument/ "Instrumenting source files - Istanbul docs"

---

## 本项目集成方式

本项目使用 Bun test 作为测试运行器，Bun 原生支持 lcov 格式覆盖率输出。
nyc 在本项目中**不作为 test wrapper**，而是作为覆盖率报告和阈值校验工具。

### 数据流

```
bun test --coverage → coverage/lcov.info → scripts/lcov-to-nyc.ts → .nyc_output/out.json → nyc report / nyc check-coverage
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `bun run test:coverage` | 运行测试 + 生成 Istanbul 报告 |
| `bun run test:coverage:html` | 生成 HTML 可视化报告 |
| `bun run coverage:check` | 仅校验覆盖率阈值（需先跑测试） |
| `bun run check:coverage` | 完整流程：测试 + 转换 + 阈值校验 |

### 配置文件

- `.nycrc.json` — nyc 配置
- `scripts/lcov-to-nyc.ts` — lcov → Istanbul JSON 转换桥
