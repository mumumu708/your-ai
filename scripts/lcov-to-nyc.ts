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
  lines: Map<number, number>;
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
        linesFound: 0,
        linesHit: 0,
        fnsFound: 0,
        fnsHit: 0,
        branchesFound: 0,
        branchesHit: 0,
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
    console.error('coverage/lcov.info not found. Run bun test first.');
    process.exit(1);
  }

  const lcovContent = fs.readFileSync(LCOV_PATH, 'utf-8');
  const entries = parseLcov(lcovContent);

  if (entries.length === 0) {
    console.log('No coverage entries found in lcov.info');
    process.exit(0);
  }

  const coverage = lcovToIstanbulCoverage(entries);

  if (!fs.existsSync(NYC_OUTPUT_DIR)) {
    fs.mkdirSync(NYC_OUTPUT_DIR, { recursive: true });
  }

  const outputPath = path.join(NYC_OUTPUT_DIR, 'out.json');
  fs.writeFileSync(outputPath, JSON.stringify(coverage, null, 2));
  console.log(`Converted ${entries.length} files -> ${outputPath}`);
}

main().catch((err) => {
  console.error('lcov-to-nyc failed:', err);
  process.exit(1);
});
