/**
 * 项目约定检查脚本
 *
 * 检查 Biome 管不到的项目特有规则：
 * - user-space 硬编码（P-006）→ error
 * - 桶文件缺失（P-010）→ warn
 * - Logger 命名不匹配 → warn
 * - 裸 throw new Error → warn
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SRC_DIR = path.join(ROOT, 'src');

interface Issue {
  file: string;
  line: number;
  message: string;
  severity: 'error' | 'warn';
}

const issues: Issue[] = [];

// Collect all source files
async function collectFiles(): Promise<string[]> {
  const glob = new Bun.Glob('src/**/*.ts');
  const files: string[] = [];

  for await (const entry of glob.scan({ cwd: ROOT, absolute: true })) {
    const rel = path.relative(ROOT, entry);
    if (rel.includes('test-utils/')) continue;
    if (rel.endsWith('.test.ts')) continue;
    if (rel.endsWith('.e2e.test.ts')) continue;
    if (rel.endsWith('.integration.test.ts')) continue;
    files.push(entry);
  }

  return files;
}

// Check 1: user-space hardcoding (P-006) — error
function checkUserSpaceHardcoding(_file: string, lines: string[], relPath: string) {
  const PATTERN = /['"`]user-space\//;
  const COMMENT_RE = /^\s*\/\//;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (COMMENT_RE.test(line)) continue;
    if (PATTERN.test(line)) {
      issues.push({
        file: relPath,
        line: i + 1,
        message: 'user-space 路径硬编码 (P-006)，应通过配置获取',
        severity: 'error',
      });
    }
  }
}

// Check 2: kernel barrel files (P-010) — warn
function checkKernelBarrelFiles() {
  const kernelDir = path.join(SRC_DIR, 'kernel');
  if (!fs.existsSync(kernelDir)) return;

  const entries = fs.readdirSync(kernelDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const indexPath = path.join(kernelDir, entry.name, 'index.ts');
    if (!fs.existsSync(indexPath)) {
      issues.push({
        file: `src/kernel/${entry.name}/`,
        line: 0,
        message: `桶文件缺失 (P-010)，kernel/${entry.name}/ 缺少 index.ts`,
        severity: 'warn',
      });
    }
  }
}

// Check 3: Logger naming mismatch — warn
function checkLoggerNaming(_file: string, content: string, lines: string[], relPath: string) {
  const LOGGER_RE = /new\s+Logger\(\s*['"]([^'"]+)['"]\s*\)/g;
  // Extract class name from file if there's a class declaration
  const CLASS_RE = /class\s+(\w+)/;
  const classMatch = CLASS_RE.exec(content);
  if (!classMatch) return;

  const className = classMatch[1] ?? '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    LOGGER_RE.lastIndex = 0;
    const loggerMatch = LOGGER_RE.exec(line);
    if (loggerMatch) {
      const loggerName = loggerMatch[1] ?? '';
      if (loggerName !== className) {
        issues.push({
          file: relPath,
          line: i + 1,
          message: `Logger 命名 '${loggerName}' 与类名 '${className}' 不匹配`,
          severity: 'warn',
        });
      }
    }
  }
}

// Check 4: bare throw new Error — warn
function checkBareThrowError(_file: string, lines: string[], relPath: string) {
  const THROW_RE = /throw\s+new\s+Error\s*\(/;
  const COMMENT_RE = /^\s*\/\//;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (COMMENT_RE.test(line)) continue;
    if (THROW_RE.test(line)) {
      issues.push({
        file: relPath,
        line: i + 1,
        message: '使用了裸 throw new Error，业务代码应使用 YourBotError',
        severity: 'warn',
      });
    }
  }
}

async function main() {
  const files = await collectFiles();

  // Per-file checks
  for (const file of files) {
    const content = await Bun.file(file).text();
    const lines = content.split('\n');
    const relPath = path.relative(ROOT, file);

    checkUserSpaceHardcoding(file, lines, relPath);
    checkLoggerNaming(file, content, lines, relPath);
    checkBareThrowError(file, lines, relPath);
  }

  // Global checks
  checkKernelBarrelFiles();

  // Report
  const errors = issues.filter((i) => i.severity === 'error');
  const warns = issues.filter((i) => i.severity === 'warn');

  for (const issue of errors) {
    const loc = issue.line > 0 ? `:${issue.line}` : '';
    console.error(`❌ ${issue.file}${loc} — ${issue.message}`);
  }

  for (const issue of warns) {
    const loc = issue.line > 0 ? `:${issue.line}` : '';
    console.warn(`⚠️  ${issue.file}${loc} — ${issue.message}`);
  }

  if (errors.length > 0) {
    console.error(`\n${errors.length} error(s), ${warns.length} warning(s)`);
    process.exit(1);
  }

  if (warns.length > 0) {
    console.log(`\n${warns.length} warning(s), 0 error(s)`);
  } else {
    console.log('✅ 约定检查通过');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('约定检查脚本出错:', err);
  process.exit(1);
});
