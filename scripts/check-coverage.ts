/**
 * 变更文件覆盖率卡点
 *
 * 读取 .nyc_output/out.json（Istanbul coverage map），对本次变更的源文件强制 100% 行/函数覆盖率。
 * 变更文件通过 git diff 自动检测（对比 main 分支或 HEAD~1）。
 */

import fs from 'node:fs';
import path from 'node:path';
import libCoverage from 'istanbul-lib-coverage';

const ROOT = path.resolve(import.meta.dir, '..');
const NYC_OUTPUT = path.join(ROOT, '.nyc_output', 'out.json');
const LCOV_TO_NYC_SCRIPT = path.join(ROOT, 'scripts', 'lcov-to-nyc.ts');

// --- git diff: 获取变更文件列表 ---

function getBaseBranch(): string {
  // 1. CI 环境变量
  const ciBase = process.env.CI_BASE_BRANCH;
  if (ciBase) return ciBase;

  // 2. 如果当前就在 main 上，对比 HEAD~1
  const branchResult = Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT });
  const currentBranch = branchResult.stdout.toString().trim();
  if (currentBranch === 'main') return 'HEAD~1';

  // 3. 否则对比 main
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

// --- 确保 .nyc_output/out.json 存在 ---

function ensureNycOutput(): void {
  if (fs.existsSync(NYC_OUTPUT)) return;

  console.log('⏳ .nyc_output/out.json 不存在，正在运行 lcov-to-nyc 转换...');
  const result = Bun.spawnSync(['bun', 'run', LCOV_TO_NYC_SCRIPT], { cwd: ROOT });
  if (result.exitCode !== 0) {
    console.error('❌ lcov-to-nyc 转换失败:', result.stderr.toString());
    process.exit(1);
  }

  if (!fs.existsSync(NYC_OUTPUT)) {
    console.error('❌ lcov-to-nyc 运行完成但 .nyc_output/out.json 仍不存在');
    process.exit(1);
  }
}

// --- 主逻辑 ---

function main() {
  const changedFiles = getChangedFiles();
  const sourceFiles = filterSourceFiles(changedFiles);

  if (sourceFiles.length === 0) {
    console.log('✅ 无变更源文件需要检查覆盖率');
    process.exit(0);
  }

  ensureNycOutput();

  const coverageData = JSON.parse(fs.readFileSync(NYC_OUTPUT, 'utf-8'));
  const coverageMap = libCoverage.createCoverageMap(coverageData);

  let failures = 0;

  for (const file of sourceFiles) {
    const absolutePath = path.resolve(ROOT, file);

    let fileCoverage: libCoverage.FileCoverage;
    try {
      fileCoverage = coverageMap.fileCoverageFor(absolutePath);
    } catch {
      console.log(`⚠️ ${file} — 未在覆盖率数据中找到（可能是纯类型文件）`);
      continue;
    }

    const summary = fileCoverage.toSummary();
    const linePct = summary.lines.pct;
    const fnPct = summary.functions.pct;
    const lineOk = linePct === 100;
    const fnOk = fnPct === 100;

    if (lineOk && fnOk) {
      console.log(
        `✅ ${file} — 行 100% (${summary.lines.covered}/${summary.lines.total})  函数 100% (${summary.functions.covered}/${summary.functions.total})`,
      );
    } else {
      failures++;
      console.log(
        `❌ ${file} — 行 ${linePct}% (${summary.lines.covered}/${summary.lines.total})  函数 ${fnPct}% (${summary.functions.covered}/${summary.functions.total})`,
      );
      const uncoveredLines = fileCoverage.getUncoveredLines();
      if (uncoveredLines.length > 0) {
        console.log(`   未覆盖行: ${uncoveredLines.join(', ')}`);
      }
    }
  }

  if (failures > 0) {
    console.error(`\n共 ${failures} 个文件覆盖率不达标`);
    process.exit(1);
  }

  console.log('\n✅ 所有变更源文件覆盖率达标');
  process.exit(0);
}

main();
