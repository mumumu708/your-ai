/**
 * 分层依赖检查脚本
 *
 * 扫描 src/ 下 .ts 文件的 import 语句，验证分层规则：
 * - shared/ 禁止引用 gateway/, kernel/, lessons/
 * - kernel/ 禁止引用 gateway/
 * - lessons/ 禁止引用 gateway/, kernel/
 * - kernel 子模块间必须通过 index.ts 引用
 */

import path from 'node:path';

const SRC_DIR = path.resolve(import.meta.dir, '..', 'src');

// tsconfig path aliases
const ALIASES: Record<string, string> = {
  '@gateway/': 'src/gateway/',
  '@kernel/': 'src/kernel/',
  '@shared/': 'src/shared/',
};

type Layer = 'gateway' | 'kernel' | 'shared' | 'lessons' | 'other';

const FORBIDDEN: Record<string, Layer[]> = {
  shared: ['gateway', 'kernel', 'lessons'],
  kernel: ['gateway'],
  lessons: ['gateway', 'kernel'],
};

function resolveLayer(filePath: string): Layer {
  const rel = path.relative(SRC_DIR, filePath).replace(/\\/g, '/');
  if (rel.startsWith('gateway/')) return 'gateway';
  if (rel.startsWith('kernel/')) return 'kernel';
  if (rel.startsWith('shared/')) return 'shared';
  if (rel.startsWith('lessons/')) return 'lessons';
  return 'other';
}

function getKernelSubmodule(filePath: string): string | null {
  const rel = path.relative(SRC_DIR, filePath).replace(/\\/g, '/');
  if (!rel.startsWith('kernel/')) return null;
  const parts = rel.split('/');
  // kernel/sub-module/... → sub-module
  // kernel/central-controller.ts → null (top-level file)
  if (parts.length < 3) return null;
  return parts[1] ?? null;
}

function resolveImportTarget(importPath: string, sourceFile: string): string | null {
  // Handle tsconfig aliases
  for (const [alias, replacement] of Object.entries(ALIASES)) {
    if (importPath.startsWith(alias)) {
      return path.resolve(SRC_DIR, '..', replacement + importPath.slice(alias.length));
    }
  }

  // Handle relative imports
  if (importPath.startsWith('.')) {
    return path.resolve(path.dirname(sourceFile), importPath);
  }

  // External package — ignore
  return null;
}

function resolveTargetLayer(targetPath: string): Layer {
  const normalized = targetPath.replace(/\\/g, '/');
  if (!normalized.includes('/src/')) return 'other';
  const afterSrc = normalized.split('/src/')[1] ?? '';
  if (afterSrc.startsWith('gateway/')) return 'gateway';
  if (afterSrc.startsWith('kernel/')) return 'kernel';
  if (afterSrc.startsWith('shared/')) return 'shared';
  if (afterSrc.startsWith('lessons/')) return 'lessons';
  return 'other';
}

function getTargetKernelSubmodule(targetPath: string): string | null {
  const normalized = targetPath.replace(/\\/g, '/');
  if (!normalized.includes('/src/kernel/')) return null;
  const afterKernel = normalized.split('/src/kernel/')[1] ?? '';
  const parts = afterKernel.split('/');
  if (parts.length < 2) return null;
  return parts[0] ?? null;
}

function isIndexImport(importPath: string): boolean {
  // e.g. ../agents, ../agents/index, ../agents/index.ts
  const normalized = importPath.replace(/\\/g, '/');
  if (normalized.endsWith('/index') || normalized.endsWith('/index.ts')) {
    return true;
  }
  // If the import is just the directory name (no further path segments after submodule)
  // e.g. @kernel/agents or ../agents → resolves to the directory itself
  const parts = normalized.split('/');
  const last = parts.at(-1) ?? '';
  // No extension and no deeper path → assumed directory import (resolves to index)
  return !last.includes('.') && !normalized.endsWith('/index');
}

const IMPORT_RE =
  /import\s+(?:type\s+)?(?:[\s\S]*?from\s+)?['"](\.{1,2}\/[^'"]+|@(?:gateway|kernel|shared)\/[^'"]+)['"]/g;

interface Violation {
  file: string;
  line: number;
  target: string;
  sourceLayer: string;
  targetLayer: string;
  message: string;
}

async function main() {
  const violations: Violation[] = [];

  const glob = new Bun.Glob('src/**/*.ts');
  const files: string[] = [];

  for await (const entry of glob.scan({
    cwd: path.resolve(SRC_DIR, '..'),
    absolute: true,
  })) {
    const rel = path.relative(path.resolve(SRC_DIR, '..'), entry);
    // Skip test files and test-utils
    if (rel.includes('test-utils/')) continue;
    if (rel.endsWith('.test.ts')) continue;
    if (rel.endsWith('.e2e.test.ts')) continue;
    if (rel.endsWith('.integration.test.ts')) continue;
    files.push(entry);
  }

  for (const file of files) {
    const content = await Bun.file(file).text();
    const lines = content.split('\n');
    const sourceLayer = resolveLayer(file);
    const sourceSubmodule = getKernelSubmodule(file);

    if (sourceLayer === 'other') continue;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      // Reset regex state
      IMPORT_RE.lastIndex = 0;

      for (let match = IMPORT_RE.exec(line); match !== null; match = IMPORT_RE.exec(line)) {
        const importPath = match[1];
        if (!importPath) continue;
        const targetPath = resolveImportTarget(importPath, file);
        if (!targetPath) continue;

        const targetLayer = resolveTargetLayer(targetPath);
        if (targetLayer === 'other') continue;

        const relFile = path.relative(path.resolve(SRC_DIR, '..'), file);

        // Check layer violation
        const forbidden = FORBIDDEN[sourceLayer];
        if (forbidden?.includes(targetLayer)) {
          violations.push({
            file: relFile,
            line: i + 1,
            target: importPath,
            sourceLayer,
            targetLayer,
            message: `${sourceLayer} 禁止引用 ${targetLayer}`,
          });
          continue;
        }

        // Check kernel cross-submodule violation
        if (sourceLayer === 'kernel' && targetLayer === 'kernel') {
          const targetSubmodule = getTargetKernelSubmodule(targetPath);
          if (sourceSubmodule && targetSubmodule && sourceSubmodule !== targetSubmodule) {
            if (!isIndexImport(importPath)) {
              violations.push({
                file: relFile,
                line: i + 1,
                target: importPath,
                sourceLayer: `kernel/${sourceSubmodule}`,
                targetLayer: `kernel/${targetSubmodule}`,
                message: 'kernel 子模块间必须通过 index.ts 引用，禁止引用内部文件',
              });
            }
          }
        }
      }
    }
  }

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`❌ ${v.file}:${v.line} → ${v.target}，${v.message}`);
    }
    console.error(`\n共 ${violations.length} 处架构违规`);
    process.exit(1);
  } else {
    console.log('✅ 架构检查通过，无分层违规');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('架构检查脚本出错:', err);
  process.exit(1);
});
