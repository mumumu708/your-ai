/**
 * 文档一致性检查脚本
 *
 * 5 项检查：
 * 1. 新鲜度 — doc-source-map.json 中源码 vs 文档 mtime
 * 2. 映射覆盖 — src/ 下模块目录是否都在 doc-source-map.json 中
 * 3. 引用有效性 — CLAUDE.md 和 .harness/*.md 中 `→ path` 引用是否指向有效文件
 * 4. architecture.md 一致性 — architecture.md 列出的模块 vs src/ 实际目录
 * 5. pitfalls 格式 — pitfalls.md 每条是否包含编号、陷阱、修复指令
 *
 * 始终 exit 0（纯提醒，不阻塞流程）。
 */

import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

interface Mapping {
  doc: string;
  sources: string[];
  description: string;
}

interface DocSourceMap {
  description: string;
  mappings: Mapping[];
}

interface CheckResult {
  name: string;
  passed: number;
  total: number;
  issues: Array<{ severity: 'error' | 'warning'; message: string; suggestion: string }>;
}

// ── Check 1: 新鲜度 ──────────────────────────────────────────

async function checkFreshness(map: DocSourceMap): Promise<CheckResult> {
  const result: CheckResult = { name: '新鲜度', passed: 0, total: 0, issues: [] };

  for (const mapping of map.mappings) {
    const docPath = path.join(ROOT, mapping.doc);
    const docFile = Bun.file(docPath);

    if (!(await docFile.exists())) {
      result.total++;
      result.issues.push({
        severity: 'error',
        message: `文档不存在: ${mapping.doc}`,
        suggestion: '创建该文档或从 doc-source-map.json 中移除映射',
      });
      continue;
    }

    const docMtime = docFile.lastModified;

    for (const sourcePath of mapping.sources) {
      result.total++;
      const absSource = path.join(ROOT, sourcePath);
      const sourceFile = Bun.file(absSource);

      if (!(await sourceFile.exists())) {
        result.issues.push({
          severity: 'warning',
          message: `源文件不存在: ${sourcePath}（映射自 ${mapping.doc}）`,
          suggestion: '从 doc-source-map.json 中移除该源文件引用',
        });
        continue;
      }

      if (sourceFile.lastModified > docMtime) {
        result.issues.push({
          severity: 'warning',
          message: `${mapping.doc} 可能过时 — ${sourcePath} 更新更晚`,
          suggestion: `检查 ${mapping.doc} 是否需要同步更新`,
        });
      } else {
        result.passed++;
      }
    }
  }

  return result;
}

// ── Check 2: 映射覆盖 ──────────────────────────────────────────

function checkMappingCoverage(map: DocSourceMap): CheckResult {
  const result: CheckResult = { name: '映射覆盖', passed: 0, total: 0, issues: [] };

  const mappedPrefixes = new Set<string>();
  for (const mapping of map.mappings) {
    for (const source of mapping.sources) {
      // Extract module prefix: src/kernel/agents/foo.ts → src/kernel/agents
      const parts = source.split('/');
      if (parts.length >= 3) {
        mappedPrefixes.add(parts.slice(0, 3).join('/'));
      }
    }
  }

  // Scan src/ for module directories
  const layers = ['gateway', 'kernel', 'shared', 'lessons'];
  for (const layer of layers) {
    const layerDir = path.join(ROOT, 'src', layer);
    if (!existsSync(layerDir)) continue;

    const entries = readdirSync(layerDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const modulePrefix = `src/${layer}/${entry.name}`;
      result.total++;
      if (mappedPrefixes.has(modulePrefix)) {
        result.passed++;
      } else {
        result.issues.push({
          severity: 'warning',
          message: `${modulePrefix}/ 未在 doc-source-map.json 中映射`,
          suggestion: `在 doc-source-map.json 中为 ${modulePrefix}/ 添加映射条目`,
        });
      }
    }
  }

  return result;
}

// ── Check 3: 引用有效性 ──────────────────────────────────────────

async function checkReferenceValidity(): Promise<CheckResult> {
  const result: CheckResult = { name: '引用有效性', passed: 0, total: 0, issues: [] };

  const filesToCheck = ['CLAUDE.md'];
  // Add .harness/*.md files
  const harnessDir = path.join(ROOT, '.harness');
  if (existsSync(harnessDir)) {
    const entries = readdirSync(harnessDir);
    for (const entry of entries) {
      if (entry.endsWith('.md')) {
        filesToCheck.push(`.harness/${entry}`);
      }
    }
  }

  const refPattern = /→\s+(\S+)/g;

  for (const relPath of filesToCheck) {
    const absPath = path.join(ROOT, relPath);
    const file = Bun.file(absPath);
    if (!(await file.exists())) continue;

    const content = await file.text();
    let match: RegExpExecArray | null;
    refPattern.lastIndex = 0;

    while ((match = refPattern.exec(content)) !== null) {
      const ref = match[1]!;
      // Skip non-path references
      if (ref.startsWith('http')) continue;
      if (ref.length < 3) continue;
      // Must contain / to look like a file path (e.g. ".harness/architecture.md")
      if (!ref.includes('/')) continue;
      // Skip method calls like ClassName.method(), descriptions with CJK/parentheses
      if (/[()（）]/.test(ref)) continue;
      if (/[\u4e00-\u9fff]/.test(ref)) continue;

      result.total++;
      const refAbs = path.join(ROOT, ref);
      if (existsSync(refAbs)) {
        result.passed++;
      } else {
        result.issues.push({
          severity: 'warning',
          message: `${relPath} 引用了不存在的路径: ${ref}`,
          suggestion: `更新 ${relPath} 中的引用，或创建 ${ref}`,
        });
      }
    }
  }

  return result;
}

// ── Check 4: architecture.md 一致性 ──────────────────────────────

async function checkArchitectureConsistency(): Promise<CheckResult> {
  const result: CheckResult = { name: 'architecture.md 一致性', passed: 0, total: 0, issues: [] };

  const archPath = path.join(ROOT, '.harness', 'architecture.md');
  const archFile = Bun.file(archPath);
  if (!(await archFile.exists())) {
    result.issues.push({
      severity: 'error',
      message: '.harness/architecture.md 不存在',
      suggestion: '创建 .harness/architecture.md',
    });
    return result;
  }

  const archContent = await archFile.text();

  // Extract kernel submodule names mentioned in architecture.md
  // Pattern: lines containing "kernel/" followed by a module name like "agents/" or "classifier/"
  const mentionedModules = new Set<string>();
  const modulePattern = /(?:kernel\/|│\s+)(\w[\w-]*)\/\s/g;
  let match: RegExpExecArray | null;
  while ((match = modulePattern.exec(archContent)) !== null) {
    mentionedModules.add(match[1]!);
  }

  // Scan actual kernel subdirectories
  const kernelDir = path.join(ROOT, 'src', 'kernel');
  if (!existsSync(kernelDir)) return result;

  const entries = readdirSync(kernelDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    result.total++;
    if (mentionedModules.has(entry.name)) {
      result.passed++;
    } else {
      result.issues.push({
        severity: 'warning',
        message: `src/kernel/${entry.name}/ 未在 architecture.md 中提及`,
        suggestion: `在 .harness/architecture.md 的 Kernel 层描述中补充 ${entry.name} 子模块`,
      });
    }
  }

  return result;
}

// ── Check 5: pitfalls 格式 ──────────────────────────────────────────

async function checkPitfallsFormat(): Promise<CheckResult> {
  const result: CheckResult = { name: 'pitfalls 格式', passed: 0, total: 0, issues: [] };

  const pitfallsPath = path.join(ROOT, '.harness', 'pitfalls.md');
  const pitfallsFile = Bun.file(pitfallsPath);
  if (!(await pitfallsFile.exists())) {
    result.issues.push({
      severity: 'error',
      message: '.harness/pitfalls.md 不存在',
      suggestion: '创建 .harness/pitfalls.md',
    });
    return result;
  }

  const content = await pitfallsFile.text();
  const lines = content.split('\n');

  // Find table rows (lines starting with |, not header/separator)
  const tableRows = lines.filter(
    (l) => l.startsWith('|') && !l.startsWith('| 编号') && !l.startsWith('|---'),
  );

  for (const row of tableRows) {
    result.total++;
    const cells = row
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);

    if (cells.length < 3) {
      result.issues.push({
        severity: 'warning',
        message: `pitfalls 条目格式不完整: ${row.slice(0, 60)}...`,
        suggestion: '确保每条包含三列: 编号 | 陷阱描述 | 修复指令',
      });
      continue;
    }

    const [id, trap, fix] = cells;
    if (!id?.match(/^P-\d+$/) || !trap || trap.length < 5 || !fix || fix.length < 5) {
      result.issues.push({
        severity: 'warning',
        message: `pitfalls 条目内容不完整: ${id ?? '?'}`,
        suggestion: '编号需要 P-NNN 格式，陷阱和修复指令各至少 5 个字符',
      });
    } else {
      result.passed++;
    }
  }

  return result;
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const mapPath = path.join(ROOT, '.harness', 'doc-source-map.json');
  const mapFile = Bun.file(mapPath);

  let map: DocSourceMap = { description: '', mappings: [] };
  if (await mapFile.exists()) {
    map = await mapFile.json();
  }

  const results = await Promise.all([
    checkFreshness(map),
    checkMappingCoverage(map),
    checkReferenceValidity(),
    checkArchitectureConsistency(),
    checkPitfallsFormat(),
  ]);

  console.log('📋 文档一致性检查结果\n');

  let totalIssues = 0;

  for (const r of results) {
    const hasIssues = r.issues.length > 0;
    const icon = hasIssues ? (r.issues.some((i) => i.severity === 'error') ? '❌' : '⚠️') : '✅';
    console.log(`${icon} ${r.name}: ${r.passed}/${r.total} 通过`);

    if (hasIssues) {
      for (const issue of r.issues) {
        const prefix = issue.severity === 'error' ? '  ❌' : '  ⚠️';
        console.log(`${prefix} ${issue.message}`);
        console.log(`     建议: ${issue.suggestion}`);
      }
      console.log();
    }

    totalIssues += r.issues.length;
  }

  if (totalIssues === 0) {
    console.log('\n✅ 所有文档检查通过');
  } else {
    console.log(`共 ${totalIssues} 个问题`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('文档检查脚本出错:', err);
  process.exit(0);
});
