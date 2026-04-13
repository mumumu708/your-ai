# 测试能力升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接入 Istanbul(nyc) + Stryker-JS，提升覆盖率，建立完整测试闭环

**Architecture:** 在 Bun 测试体系上叠加 Istanbul 覆盖率报告层（nyc report + check-coverage）和 Stryker-JS 变异测试层。Bun test 继续负责执行测试和生成 lcov 数据，nyc 负责报告生成和阈值校验，Stryker 用 command runner 调用 bun test 做变异测试。

**Tech Stack:** Bun Test, nyc (Istanbul CLI), @stryker-mutator/core, @stryker-mutator/typescript-checker

**Worktree:** `/Users/bytedance/Documents/work/js/your-ai-arch-upgrade` (branch: `agent/feat/architecture-upgrade-v2`)

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `.nycrc.json` | nyc 配置：报告格式、阈值、include/exclude |
| Create | `stryker.config.mjs` | Stryker-JS 配置：command runner、mutate 范围 |
| Create | `scripts/lcov-to-nyc.ts` | 将 bun 的 lcov 输出转换为 nyc JSON 格式 |
| Modify | `scripts/check-coverage.ts` | 改用 nyc check-coverage，保留变更文件卡点逻辑 |
| Modify | `package.json` | 新增 scripts、devDependencies |
| Modify | `bunfig.toml` | 确保 lcov 输出路径与 nyc 对齐 |
| Create | `docs/test-tools/nyc.md` | nyc 使用文档（从主仓库复制 + 补充本项目用法） |
| Create | `docs/test-tools/Stryker_JS.md` | Stryker 使用文档（从主仓库复制 + 补充本项目用法） |
| Modify | `.harness/testing.md` | 更新工具链表、新增变异测试章节、更新覆盖率流程 |
| Modify | `CLAUDE.md` | 更新 check:all 流程描述（加入 stryker） |

---

## Task 1: 安装 nyc 并配置 Istanbul 覆盖率管线

**Files:**
- Modify: `package.json` (devDependencies + scripts)
- Create: `.nycrc.json`
- Create: `scripts/lcov-to-nyc.ts`
- Modify: `bunfig.toml`

### 背景

Bun test 已经能生成 `coverage/lcov.info`（Istanbul lcov 格式），但我们缺少：
1. HTML 可视化报告
2. 多轮测试覆盖率合并能力（unit + integration 分开跑再合并）
3. 标准化的阈值校验（nyc check-coverage）

nyc 不能直接 instrument Bun 进程（它只支持 Node.js），但可以读取 Bun 产出的 lcov 数据生成报告和校验阈值。关键桥梁是一个 lcov→nyc JSON 转换脚本。

- [ ] **Step 1: 安装依赖**

```bash
cd /Users/bytedance/Documents/work/js/your-ai-arch-upgrade
bun add -d nyc @istanbuljs/nyc-config-typescript istanbul-lib-coverage istanbul-lib-report istanbul-reports
```

- [ ] **Step 2: 创建 `.nycrc.json`**

```json
{
  "extends": "@istanbuljs/nyc-config-typescript",
  "all": true,
  "include": ["src/**/*.ts"],
  "exclude": [
    "**/*.test.ts",
    "**/*.integration.test.ts",
    "**/*.e2e.test.ts",
    "**/test-utils/**",
    "**/__fixtures__/**",
    "**/*.types.ts",
    "**/*.d.ts"
  ],
  "reporter": ["text", "text-summary", "lcov", "html"],
  "report-dir": "coverage",
  "temp-dir": ".nyc_output",
  "check-coverage": true,
  "per-file": true,
  "lines": 100,
  "functions": 100,
  "branches": 90,
  "statements": 100,
  "skip-full": false
}
```

- [ ] **Step 3: 创建 `scripts/lcov-to-nyc.ts`**

这个脚本将 bun 生成的 `coverage/lcov.info` 转换为 nyc 能读取的 JSON 格式，放入 `.nyc_output/`。

```typescript
/**
 * lcov-to-nyc.ts
 *
 * 将 Bun test 生成的 coverage/lcov.info 转换为 .nyc_output/ 下的 JSON 格式，
 * 供 nyc report / nyc check-coverage 使用。
 */
import fs from 'node:fs';
import path from 'node:path';
import libCoverage from 'istanbul-lib-coverage';

const ROOT = path.resolve(import.meta.dir, '..');
const LCOV_PATH = path.join(ROOT, 'coverage', 'lcov.info');
const NYC_OUTPUT_DIR = path.join(ROOT, '.nyc_output');

interface LcovEntry {
  file: string;
  lines: Map<number, number>;     // lineNo → hitCount
  functions: Map<string, { name: string; line: number; hits: number }>;
  branches: Map<string, { line: number; block: number; branch: number; hits: number }>;
  linesFound: number;
  linesHit: number;
  fnsFound: number;
  fnsHit: number;
  branchesFound: number;
  branchesHit: number;
}

function parseLcov(content: string): LcovEntry[] {
  const entries: LcovEntry[] = [];
  let current: LcovEntry | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('SF:')) {
      current = {
        file: line.slice(3),
        lines: new Map(),
        functions: new Map(),
        branches: new Map(),
        linesFound: 0, linesHit: 0,
        fnsFound: 0, fnsHit: 0,
        branchesFound: 0, branchesHit: 0,
      };
    } else if (line === 'end_of_record' && current) {
      entries.push(current);
      current = null;
    } else if (current) {
      if (line.startsWith('DA:')) {
        const [lineNo, count] = line.slice(3).split(',').map(Number);
        current.lines.set(lineNo, count);
      } else if (line.startsWith('FN:')) {
        const parts = line.slice(3).split(',');
        const fnLine = Number(parts[0]);
        const fnName = parts.slice(1).join(',');
        current.functions.set(fnName, { name: fnName, line: fnLine, hits: 0 });
      } else if (line.startsWith('FNDA:')) {
        const parts = line.slice(5).split(',');
        const hits = Number(parts[0]);
        const fnName = parts.slice(1).join(',');
        const fn = current.functions.get(fnName);
        if (fn) fn.hits = hits;
      } else if (line.startsWith('BRDA:')) {
        const [bLine, block, branch, hits] = line.slice(5).split(',');
        const key = `${bLine}:${block}:${branch}`;
        current.branches.set(key, {
          line: Number(bLine),
          block: Number(block),
          branch: Number(branch),
          hits: hits === '-' ? 0 : Number(hits),
        });
      } else if (line.startsWith('LF:')) {
        current.linesFound = Number(line.slice(3));
      } else if (line.startsWith('LH:')) {
        current.linesHit = Number(line.slice(3));
      } else if (line.startsWith('FNF:')) {
        current.fnsFound = Number(line.slice(4));
      } else if (line.startsWith('FNH:')) {
        current.fnsHit = Number(line.slice(4));
      } else if (line.startsWith('BRF:')) {
        current.branchesFound = Number(line.slice(4));
      } else if (line.startsWith('BRH:')) {
        current.branchesHit = Number(line.slice(4));
      }
    }
  }
  return entries;
}

function lcovToIstanbulCoverage(entries: LcovEntry[]): Record<string, object> {
  const coverageMap = libCoverage.createCoverageMap({});

  for (const entry of entries) {
    const filePath = entry.file;
    const statementMap: Record<string, object> = {};
    const s: Record<string, number> = {};
    const fnMap: Record<string, object> = {};
    const f: Record<string, number> = {};
    const branchMap: Record<string, object> = {};
    const b: Record<string, number[]> = {};

    // Statements from line data
    let stmtIdx = 0;
    for (const [lineNo, count] of entry.lines) {
      const key = String(stmtIdx);
      statementMap[key] = {
        start: { line: lineNo, column: 0 },
        end: { line: lineNo, column: 999 },
      };
      s[key] = count;
      stmtIdx++;
    }

    // Functions
    let fnIdx = 0;
    for (const [, fn] of entry.functions) {
      const key = String(fnIdx);
      fnMap[key] = {
        name: fn.name,
        decl: { start: { line: fn.line, column: 0 }, end: { line: fn.line, column: 999 } },
        loc: { start: { line: fn.line, column: 0 }, end: { line: fn.line, column: 999 } },
      };
      f[key] = fn.hits;
      fnIdx++;
    }

    // Branches
    let brIdx = 0;
    const branchGroups = new Map<string, { line: number; branches: number[] }>();
    for (const [, br] of entry.branches) {
      const groupKey = `${br.line}:${br.block}`;
      if (!branchGroups.has(groupKey)) {
        branchGroups.set(groupKey, { line: br.line, branches: [] });
      }
      branchGroups.get(groupKey)!.branches.push(br.hits);
    }
    for (const [, group] of branchGroups) {
      const key = String(brIdx);
      branchMap[key] = {
        type: 'if',
        loc: { start: { line: group.line, column: 0 }, end: { line: group.line, column: 999 } },
        locations: group.branches.map(() => ({
          start: { line: group.line, column: 0 },
          end: { line: group.line, column: 999 },
        })),
      };
      b[key] = group.branches;
      brIdx++;
    }

    coverageMap.addFileCoverage(
      libCoverage.createFileCoverage({
        path: filePath,
        statementMap,
        s,
        fnMap,
        f,
        branchMap,
        b,
      }),
    );
  }

  return coverageMap.toJSON();
}

async function main() {
  if (!fs.existsSync(LCOV_PATH)) {
    console.error('❌ coverage/lcov.info not found. Run bun test first.');
    process.exit(1);
  }

  const lcovContent = fs.readFileSync(LCOV_PATH, 'utf-8');
  const entries = parseLcov(lcovContent);

  if (entries.length === 0) {
    console.log('⚠️ No coverage entries found in lcov.info');
    process.exit(0);
  }

  const coverage = lcovToIstanbulCoverage(entries);

  // Write to .nyc_output/
  if (!fs.existsSync(NYC_OUTPUT_DIR)) {
    fs.mkdirSync(NYC_OUTPUT_DIR, { recursive: true });
  }

  const outputPath = path.join(NYC_OUTPUT_DIR, 'out.json');
  fs.writeFileSync(outputPath, JSON.stringify(coverage, null, 2));
  console.log(`✅ Converted ${entries.length} files → ${outputPath}`);
}

main().catch((err) => {
  console.error('lcov-to-nyc failed:', err);
  process.exit(1);
});
```

- [ ] **Step 4: 更新 `package.json` scripts**

在现有 scripts 基础上新增/修改：

```json
{
  "scripts": {
    "test": "bun test",
    "test:coverage": "bun test --coverage && bun run scripts/lcov-to-nyc.ts && npx nyc report",
    "test:coverage:html": "bun test --coverage && bun run scripts/lcov-to-nyc.ts && npx nyc report --reporter=html && echo '📊 HTML report: coverage/index.html'",
    "coverage:report": "npx nyc report",
    "coverage:check": "npx nyc check-coverage",
    "check:coverage": "bun test --coverage && bun run scripts/lcov-to-nyc.ts && npx nyc check-coverage",
    "check:all": "bun run lint && bun run typecheck && bun run check:arch && bun run check:conventions && bun test && bun run check:coverage && bun run test:mutate"
  }
}
```

- [ ] **Step 5: 更新 `.gitignore`**

确保 `.nyc_output/` 和 `coverage/` 在 `.gitignore` 中。

```
.nyc_output/
coverage/
```

- [ ] **Step 6: 验证 nyc 管线**

```bash
cd /Users/bytedance/Documents/work/js/your-ai-arch-upgrade
bun test --coverage
bun run scripts/lcov-to-nyc.ts
npx nyc report
npx nyc report --reporter=html
```

Expected: 终端输出覆盖率表格，`coverage/` 目录下生成 HTML 报告。

- [ ] **Step 7: Commit**

```bash
git add .nycrc.json scripts/lcov-to-nyc.ts package.json bun.lockb bunfig.toml .gitignore
git commit -m "feat: 接入 nyc (Istanbul) 覆盖率报告管线"
```

---

## Task 2: 安装并配置 Stryker-JS 变异测试

**Files:**
- Modify: `package.json` (devDependencies + scripts)
- Create: `stryker.config.mjs`

### 背景

Stryker-JS 没有原生 Bun test runner，使用 `command` runner 调用 `bun test`。`coverageAnalysis: "off"` 因为 command runner 不支持 perTest。TypeScript checker 可以提前剔除无效变异体。

- [ ] **Step 1: 安装依赖**

```bash
cd /Users/bytedance/Documents/work/js/your-ai-arch-upgrade
bun add -d @stryker-mutator/core @stryker-mutator/typescript-checker
```

- [ ] **Step 2: 创建 `stryker.config.mjs`**

```javascript
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  // Bun test 作为 command runner
  testRunner: 'command',
  commandRunner: {
    command: 'bun test',
  },

  // 变异范围：只变异 src/ 下业务代码
  mutate: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.integration.test.ts',
    '!src/**/*.e2e.test.ts',
    '!src/**/test-utils/**',
    '!src/**/__fixtures__/**',
    '!src/**/*.types.ts',
    '!src/**/*.d.ts',
  ],

  // command runner 不支持 perTest
  coverageAnalysis: 'off',

  // TypeScript checker 提前剔除无效变异体
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',

  // 报告
  reporters: ['clear-text', 'html', 'progress'],
  htmlReporter: {
    fileName: 'reports/mutation/index.html',
  },

  // 性能
  concurrency: 4,
  timeoutMS: 30000,
  timeoutFactor: 1.5,

  // 阈值
  thresholds: {
    high: 80,
    low: 60,
    break: 50,
  },

  // 临时目录
  tempDirName: '.stryker-tmp',
};
```

- [ ] **Step 3: 更新 `package.json` scripts**

```json
{
  "scripts": {
    "test:mutate": "npx stryker run",
    "test:mutate:dry": "npx stryker run --dryRunOnly"
  }
}
```

- [ ] **Step 4: 更新 `.gitignore`**

```
.stryker-tmp/
reports/mutation/
```

- [ ] **Step 5: 验证 Stryker dry run**

```bash
cd /Users/bytedance/Documents/work/js/your-ai-arch-upgrade
npx stryker run --dryRunOnly
```

Expected: Stryker 成功发现变异体并执行 dry run，无报错。

- [ ] **Step 6: 运行完整变异测试（首次可限定范围）**

```bash
npx stryker run --mutate "src/shared/**/*.ts"
```

Expected: 对 shared/ 目录执行变异测试，生成 clear-text 报告。

- [ ] **Step 7: Commit**

```bash
git add stryker.config.mjs package.json bun.lockb .gitignore
git commit -m "feat: 接入 Stryker-JS 变异测试"
```

---

## Task 3: 复制并补充工具文档

**Files:**
- Create: `docs/test-tools/nyc.md`
- Create: `docs/test-tools/Stryker_JS.md`

- [ ] **Step 1: 创建 `docs/test-tools/` 目录**

```bash
mkdir -p /Users/bytedance/Documents/work/js/your-ai-arch-upgrade/docs/test-tools
```

- [ ] **Step 2: 从主仓库复制 nyc.md 并追加本项目用法**

将 `/Users/bytedance/Documents/work/js/your-ai/docs/test-tools/nyc.md` 内容复制到 worktree，并在末尾追加：

```markdown
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
```

- [ ] **Step 3: 从主仓库复制 Stryker_JS.md 并追加本项目用法**

将 `/Users/bytedance/Documents/work/js/your-ai/docs/test-tools/Stryker_JS.md` 内容复制到 worktree，并在末尾追加：

```markdown
---

## 本项目集成方式

本项目使用 `command` runner 调用 `bun test`，因为 Stryker 没有原生 Bun runner。

### 常用命令

| 命令 | 说明 |
|------|------|
| `bun run test:mutate` | 执行完整变异测试 |
| `bun run test:mutate:dry` | 仅 dry run，验证配置 |
| `npx stryker run --mutate "src/shared/**/*.ts"` | 限定范围执行 |
| `npx stryker run --logLevel trace` | 排障模式 |

### 配置文件

- `stryker.config.mjs` — Stryker 主配置
- 变异报告：`reports/mutation/index.html`

### 在开发流程中的位置

```
编码 → 单元测试 → check:coverage (Istanbul) → test:mutate (Stryker) → 通过 → 提交
```

变异测试是测试闭环的最后一环。只有变异测试分数达标（break threshold: 50%），才可认定测试用例有效。
```

- [ ] **Step 4: Commit**

```bash
git add docs/test-tools/
git commit -m "docs: 添加 nyc 和 Stryker-JS 工具文档"
```

---

## Task 4: 更新 check-coverage.ts 使用 Istanbul

**Files:**
- Modify: `scripts/check-coverage.ts`

### 背景

当前 `check-coverage.ts` 自行解析 lcov，改为调用 nyc check-coverage + 保留变更文件卡点逻辑。

- [ ] **Step 1: 重写 `scripts/check-coverage.ts`**

```typescript
/**
 * 变更文件覆盖率卡点（Istanbul/nyc 版）
 *
 * 流程：
 * 1. bun test --coverage 生成 coverage/lcov.info
 * 2. lcov-to-nyc.ts 转换为 .nyc_output/out.json
 * 3. 本脚本调用 nyc check-coverage 做全局阈值校验
 * 4. 对变更文件额外做 per-file 100% 行/函数覆盖率校验
 */

import path from 'node:path';
import libCoverage from 'istanbul-lib-coverage';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dir, '..');
const NYC_OUTPUT = path.join(ROOT, '.nyc_output', 'out.json');

// --- git diff: 获取变更文件列表 ---

function getBaseBranch(): string {
  const ciBase = process.env.CI_BASE_BRANCH;
  if (ciBase) return ciBase;

  const branchResult = Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT });
  const currentBranch = branchResult.stdout.toString().trim();
  if (currentBranch === 'main') return 'HEAD~1';
  return 'main';
}

function getChangedFiles(): string[] {
  const base = getBaseBranch();
  const diffArg = base === 'HEAD~1' ? 'HEAD~1' : `${base}...HEAD`;
  const result = Bun.spawnSync(['git', 'diff', '--name-only', diffArg], { cwd: ROOT });
  const output = result.stdout.toString().trim();
  if (!output) return [];
  return output.split('\n').filter(Boolean);
}

function filterSourceFiles(files: string[]): string[] {
  return files.filter((f) => {
    if (!f.startsWith('src/')) return false;
    if (!f.endsWith('.ts')) return false;
    if (f.endsWith('.test.ts')) return false;
    if (f.endsWith('.integration.test.ts')) return false;
    if (f.endsWith('.e2e.test.ts')) return false;
    if (f.includes('test-utils/')) return false;
    if (f.endsWith('.types.ts')) return false;
    return true;
  });
}

// --- 主逻辑 ---

async function main() {
  // Step 1: 确保 lcov → nyc 转换已执行
  if (!fs.existsSync(NYC_OUTPUT)) {
    console.log('🔄 Running lcov-to-nyc conversion...');
    const convertResult = Bun.spawnSync(['bun', 'run', 'scripts/lcov-to-nyc.ts'], { cwd: ROOT });
    if (convertResult.exitCode !== 0) {
      console.error('❌ lcov-to-nyc 转换失败');
      console.error(convertResult.stderr.toString());
      process.exit(1);
    }
  }

  // Step 2: 读取 Istanbul coverage map
  const coverageData = JSON.parse(fs.readFileSync(NYC_OUTPUT, 'utf-8'));
  const coverageMap = libCoverage.createCoverageMap(coverageData);

  // Step 3: 变更文件卡点
  const changedFiles = getChangedFiles();
  const sourceFiles = filterSourceFiles(changedFiles);

  if (sourceFiles.length === 0) {
    console.log('✅ 无变更源文件需要检查覆盖率');
    process.exit(0);
  }

  let failures = 0;

  for (const file of sourceFiles) {
    const absPath = path.resolve(ROOT, file);
    const summary = coverageMap.fileCoverageFor(absPath)?.toSummary();

    if (!summary) {
      console.log(`⚠️ ${file} — 未在 Istanbul coverage map 中找到（可能是纯类型文件）`);
      continue;
    }

    const linePct = summary.lines.pct;
    const fnPct = summary.functions.pct;
    const lineOk = linePct === 100 || (summary.lines.total === 0);
    const fnOk = fnPct === 100 || (summary.functions.total === 0);

    if (lineOk && fnOk) {
      console.log(
        `✅ ${file} — 行 ${linePct}% (${summary.lines.covered}/${summary.lines.total})  函数 ${fnPct}% (${summary.functions.covered}/${summary.functions.total})`,
      );
    } else {
      failures++;
      console.log(
        `❌ ${file} — 行 ${linePct}% (${summary.lines.covered}/${summary.lines.total})  函数 ${fnPct}% (${summary.functions.covered}/${summary.functions.total})`,
      );
      if (summary.lines.pct < 100) {
        const fileCov = coverageMap.fileCoverageFor(absPath);
        const uncovered = fileCov.getUncoveredLines();
        if (uncovered.length > 0) {
          console.log(`   未覆盖行: ${uncovered.join(', ')}`);
        }
      }
    }
  }

  if (failures > 0) {
    console.error(`\n共 ${failures} 个文件覆盖率不达标`);
    process.exit(1);
  }

  console.log('\n✅ 所有变更源文件覆盖率达标 (Istanbul)');
  process.exit(0);
}

main().catch((err) => {
  console.error('覆盖率检查脚本出错:', err);
  process.exit(1);
});
```

- [ ] **Step 2: 验证新的 check-coverage**

```bash
cd /Users/bytedance/Documents/work/js/your-ai-arch-upgrade
bun test --coverage
bun run scripts/lcov-to-nyc.ts
bun run scripts/check-coverage.ts
```

Expected: 输出与之前格式类似，但底层使用 Istanbul coverage map。

- [ ] **Step 3: Commit**

```bash
git add scripts/check-coverage.ts
git commit -m "refactor: check-coverage 改用 Istanbul coverage map"
```

---

## Task 5: 运行覆盖率分析，识别补测范围

**Files:** 无新文件创建，分析阶段

- [ ] **Step 1: 运行全量测试 + 覆盖率**

```bash
cd /Users/bytedance/Documents/work/js/your-ai-arch-upgrade
bun run test:coverage
```

- [ ] **Step 2: 生成 HTML 报告并分析**

```bash
bun run test:coverage:html
```

打开 `coverage/index.html` 查看全局覆盖率分布。

- [ ] **Step 3: 识别需要补充集成测试的场景**

重点关注：
- **跨模块调用链**：如 gateway → kernel → shared 的完整消息处理流
- **数据落库场景**：memory-retriever-v2 → openviking-client、scheduling → JobStore
- **中间件管道**：message pipeline 的 middleware 链
- 现有 8 个集成测试未覆盖的 kernel 子模块（对照 kernel/ 下 16 个子目录）

已有集成测试覆盖：
- channel-manager, memory-pipeline, tasking-pipeline, message-pipeline
- light-llm, streaming-pipeline, websocket-channel, scheduling-pipeline

可能缺失的集成测试场景：
- `agents/` → agent-runtime 与 LLM 的集成
- `evolution/` → evolve 流程的跨模块集成
- `media/` → media-understanding 管道
- `prompt/` → system prompt 构建流程
- `skills/` → skill 执行管道
- `security/` → 安全校验中间件集成
- `monitoring/` → 监控数据采集管道

- [ ] **Step 4: 记录分析结论**

将分析结论记录到执行日志中，作为 Task 6 的输入。格式：

```
| 模块 | 当前覆盖率 | 是否需要集成测试 | 原因 |
|------|-----------|----------------|------|
| xxx  | xx%       | 是/否          | ...  |
```

---

## Task 6: 补充集成测试

**Files:**
- Create: `src/integration/` 下新增集成测试文件（具体文件根据 Task 5 分析结论决定）

### 模板

每个新集成测试遵循此模板（以 agent-runtime 为例）：

- [ ] **Step 1: 编写集成测试文件**

```typescript
// src/integration/agent-runtime.integration.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
// import actual modules, mock only external services

describe('AgentRuntime Integration', () => {
  beforeEach(() => {
    // Setup: real module connections, mock external services
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should execute agent with real pipeline and mocked LLM', async () => {
    // Arrange: create real agent runtime with mocked LLM
    // Act: execute a message through the pipeline
    // Assert: verify the full pipeline output
  });

  it('should handle LLM timeout gracefully in full pipeline', async () => {
    // Arrange: configure mocked LLM to timeout
    // Act: execute message
    // Assert: verify error propagation through pipeline
  });
});
```

- [ ] **Step 2: 运行新测试验证通过**

```bash
bun test src/integration/agent-runtime.integration.test.ts
```

- [ ] **Step 3: 运行全量测试确认无回归**

```bash
bun test
```

- [ ] **Step 4: 更新覆盖率**

```bash
bun run test:coverage
```

- [ ] **Step 5: Commit**

```bash
git add src/integration/
git commit -m "test: 补充集成测试覆盖"
```

**注意：** Task 6 的具体测试文件数量和内容取决于 Task 5 的分析结果。上面是模板，实际执行时需要根据覆盖率分析结论逐个编写。每个集成测试文件写完后先单独运行确认通过，再合并提交。

---

## Task 7: 补充单元测试

**Files:**
- Create/Modify: 覆盖率不达标的源文件对应的 `*.test.ts`

- [ ] **Step 1: 从 HTML 报告中找出覆盖率 < 100% 的变更文件**

```bash
bun run test:coverage:html
# 查看 coverage/index.html 中红色/黄色文件
```

- [ ] **Step 2: 逐文件补充单元测试**

对每个不达标文件：
1. 查看未覆盖行（HTML 报告中红色行）
2. 分析未覆盖的分支/路径
3. 编写覆盖这些路径的测试用例

遵循 AAA 模式、单行为单断言。

- [ ] **Step 3: 验证覆盖率达标**

```bash
bun run check:coverage
```

Expected: 所有变更文件 100% 行/函数覆盖率。

- [ ] **Step 4: Commit**

```bash
git add src/
git commit -m "test: 补充单元测试至 100% 覆盖率"
```

---

## Task 8: 运行 Stryker-JS 变异测试并修复存活变异体

**Files:**
- Modify: 对应的 `*.test.ts` 文件（增强断言）

- [ ] **Step 1: 对 shared/ 层运行变异测试**

```bash
cd /Users/bytedance/Documents/work/js/your-ai-arch-upgrade
npx stryker run --mutate "src/shared/**/*.ts"
```

- [ ] **Step 2: 分析存活变异体**

查看 clear-text 报告和 `reports/mutation/index.html`。
存活变异体（Survived）= 测试没有检测到的代码变更 = 假断言或断言不充分。

- [ ] **Step 3: 修复存活变异体**

对每个存活的变异体：
1. 查看变异类型（如：条件取反、算术替换、字符串替换）
2. 找到对应测试文件
3. 增强断言：添加更精确的 `expect` 或增加边界条件测试

- [ ] **Step 4: 对 kernel/ 层运行变异测试**

```bash
npx stryker run --mutate "src/kernel/**/*.ts"
```

重复 Step 2-3 修复存活变异体。

- [ ] **Step 5: 对 gateway/ 层运行变异测试**

```bash
npx stryker run --mutate "src/gateway/**/*.ts"
```

重复 Step 2-3。

- [ ] **Step 6: 运行全量变异测试确认**

```bash
bun run test:mutate
```

Expected: 变异得分 ≥ break threshold (50%)。

- [ ] **Step 7: Commit**

```bash
git add src/
git commit -m "test: 修复 Stryker 变异测试中的假断言和弱断言"
```

---

## Task 9: 更新 .harness 文档 + CLAUDE.md

**Files:**
- Modify: `.harness/testing.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: 更新 `.harness/testing.md` 工具链表**

在 §2 测试框架与工具链 表格中追加：

```markdown
| nyc (Istanbul CLI)    | 覆盖率报告 + 阈值校验 | ≥ 18.0  |
| Stryker-JS            | 变异测试              | latest  |
| istanbul-lib-coverage | 覆盖率数据处理        | latest  |
```

- [ ] **Step 2: 在 `.harness/testing.md` 新增变异测试章节**

在 §9（覆盖率要求）后新增 §9.5：

```markdown
### 9.5 变异测试 (Mutation Testing)

变异测试是覆盖率的补充验证手段，用于检测"假断言"（测试通过但未真正验证逻辑）。

| 属性 | 规定 |
|------|------|
| 工具 | Stryker-JS (`stryker.config.mjs`) |
| 运行器 | command runner (`bun test`) |
| 变异范围 | `src/**/*.ts`（排除测试文件和类型文件） |
| 阈值 | break: 50%, low: 60%, high: 80% |
| 执行时机 | 开发完成 + 覆盖率通过后，提交前 |

**开发闭环：**

```
编码 → 单元/集成测试 → check:coverage (Istanbul) → test:mutate (Stryker) → 通过 → 提交
```

存活变异体的处理：
1. 查看变异类型和位置
2. 增强对应测试的断言精度
3. 重新运行变异测试确认已杀死
```

- [ ] **Step 3: 更新 `.harness/testing.md` 覆盖率流程**

将 §9.2 执行机制更新为：

```markdown
### 9.2 执行机制

```bash
# 完整覆盖率检查流程
bun test --coverage           # 生成 coverage/lcov.info
bun run scripts/lcov-to-nyc.ts # 转换为 Istanbul JSON
npx nyc report                 # 生成报告（text + lcov + html）
npx nyc check-coverage         # 全局阈值校验
bun run scripts/check-coverage.ts # 变更文件 per-file 100% 卡点
```
```

- [ ] **Step 4: 更新 `CLAUDE.md` 关键命令**

在关键命令部分更新：

```markdown
- 覆盖率检查: `bun run check:coverage`（Istanbul/nyc，提交前必跑）
- 变异测试: `bun run test:mutate`（Stryker-JS，测试闭环最后一环）
- 覆盖率 HTML 报告: `bun run test:coverage:html`
```

在 check:all 描述中说明加入了 stryker：

```markdown
- 全量检查: `bun run check:all`（lint + typecheck + arch + conventions + test + coverage + mutate）
```

- [ ] **Step 5: 运行 check:docs**

```bash
bun run check:docs
```

Expected: 文档一致性检查通过。

- [ ] **Step 6: Commit**

```bash
git add .harness/testing.md CLAUDE.md
git commit -m "docs: 更新测试工程规范，新增 Istanbul + Stryker 章节"
```

---

## Task 10: 最终验证 + 推送

- [ ] **Step 1: 运行 check:all**

```bash
cd /Users/bytedance/Documents/work/js/your-ai-arch-upgrade
bun run check:all
```

Expected: lint ✅ typecheck ✅ arch ✅ conventions ✅ test ✅ coverage ✅ mutate ✅

- [ ] **Step 2: 运行 check:docs**

```bash
bun run check:docs
```

Expected: ✅

- [ ] **Step 3: 推送分支**

```bash
git push origin agent/feat/architecture-upgrade-v2
```

- [ ] **Step 4: 报告完成**

向管理员报告：
- PR 分支：`agent/feat/architecture-upgrade-v2`
- 变更摘要
- 覆盖率数据
- 变异测试分数
