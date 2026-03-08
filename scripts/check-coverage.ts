/**
 * 变更文件覆盖率卡点
 *
 * 读取 coverage/lcov.info，对本次变更的源文件强制 100% 行/函数覆盖率。
 * 变更文件通过 git diff 自动检测（对比 main 分支或 HEAD~1）。
 */

import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const LCOV_PATH = path.join(ROOT, 'coverage', 'lcov.info');

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

// --- LCOV 解析 ---

interface FileCoverage {
  lineFound: number;
  lineHit: number;
  fnFound: number;
  fnHit: number;
  uncoveredLines: number[];
}

function parseLcov(content: string): Map<string, FileCoverage> {
  const result = new Map<string, FileCoverage>();
  let currentFile: string | null = null;
  let cov: FileCoverage | null = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (trimmed.startsWith('SF:')) {
      const filePath = trimmed.slice(3);
      // 转为相对路径
      currentFile = path.relative(ROOT, filePath);
      cov = { lineFound: 0, lineHit: 0, fnFound: 0, fnHit: 0, uncoveredLines: [] };
    } else if (trimmed.startsWith('DA:') && cov) {
      const parts = trimmed.slice(3).split(',');
      const lineNo = Number.parseInt(parts[0] ?? '0', 10);
      const count = Number.parseInt(parts[1] ?? '0', 10);
      if (count === 0) {
        cov.uncoveredLines.push(lineNo);
      }
    } else if (trimmed.startsWith('LF:') && cov) {
      cov.lineFound = Number.parseInt(trimmed.slice(3), 10);
    } else if (trimmed.startsWith('LH:') && cov) {
      cov.lineHit = Number.parseInt(trimmed.slice(3), 10);
    } else if (trimmed.startsWith('FNF:') && cov) {
      cov.fnFound = Number.parseInt(trimmed.slice(4), 10);
    } else if (trimmed.startsWith('FNH:') && cov) {
      cov.fnHit = Number.parseInt(trimmed.slice(4), 10);
    } else if (trimmed === 'end_of_record' && currentFile && cov) {
      result.set(currentFile, cov);
      currentFile = null;
      cov = null;
    }
  }

  return result;
}

// --- 主逻辑 ---

async function main() {
  const changedFiles = getChangedFiles();
  const sourceFiles = filterSourceFiles(changedFiles);

  if (sourceFiles.length === 0) {
    console.log('✅ 无变更源文件需要检查覆盖率');
    process.exit(0);
  }

  const lcovFile = Bun.file(LCOV_PATH);
  if (!(await lcovFile.exists())) {
    console.error('❌ 未找到 coverage/lcov.info，请先运行 bun test');
    process.exit(1);
  }

  const lcovContent = await lcovFile.text();
  const coverageMap = parseLcov(lcovContent);

  let failures = 0;

  for (const file of sourceFiles) {
    const cov = coverageMap.get(file);

    if (!cov) {
      console.log(`⚠️ ${file} — 未在 lcov 中找到覆盖率数据（可能是纯类型文件）`);
      continue;
    }

    const linePct = cov.lineFound > 0 ? Math.round((cov.lineHit / cov.lineFound) * 100) : 100;
    const fnPct = cov.fnFound > 0 ? Math.round((cov.fnHit / cov.fnFound) * 100) : 100;
    const lineOk = cov.lineHit >= cov.lineFound;
    const fnOk = cov.fnHit >= cov.fnFound;

    if (lineOk && fnOk) {
      console.log(
        `✅ ${file} — 行 100% (${cov.lineHit}/${cov.lineFound})  函数 100% (${cov.fnHit}/${cov.fnFound})`,
      );
    } else {
      failures++;
      console.log(
        `❌ ${file} — 行 ${linePct}% (${cov.lineHit}/${cov.lineFound})  函数 ${fnPct}% (${cov.fnHit}/${cov.fnFound})`,
      );
      if (cov.uncoveredLines.length > 0) {
        console.log(`   未覆盖行: ${cov.uncoveredLines.join(', ')}`);
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

main().catch((err) => {
  console.error('覆盖率检查脚本出错:', err);
  process.exit(1);
});
