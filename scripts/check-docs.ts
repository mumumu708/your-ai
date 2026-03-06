/**
 * 文档新鲜度检查脚本
 *
 * 读取 .harness/doc-source-map.json，比较文档 mtime 与源文件 mtime。
 * 始终 exit 0（纯提醒，不阻塞流程）。
 */

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

async function main() {
  const mapPath = path.join(ROOT, '.harness', 'doc-source-map.json');
  const mapFile = Bun.file(mapPath);

  if (!(await mapFile.exists())) {
    console.warn('⚠️ .harness/doc-source-map.json 不存在，跳过文档检查');
    process.exit(0);
  }

  const map: DocSourceMap = await mapFile.json();
  let staleCount = 0;

  for (const mapping of map.mappings) {
    const docPath = path.join(ROOT, mapping.doc);
    const docFile = Bun.file(docPath);

    if (!(await docFile.exists())) {
      console.warn(`⚠️ 文档不存在: ${mapping.doc}`);
      continue;
    }

    const docMtime = docFile.lastModified;

    for (const sourcePath of mapping.sources) {
      const absSource = path.join(ROOT, sourcePath);
      const sourceFile = Bun.file(absSource);

      if (!(await sourceFile.exists())) {
        console.warn(`⚠️ 源文件不存在: ${sourcePath}（映射自 ${mapping.doc}）`);
        continue;
      }

      const sourceMtime = sourceFile.lastModified;

      if (sourceMtime > docMtime) {
        const date = new Date(sourceMtime).toISOString().slice(0, 19);
        console.warn(`⚠️ 文档可能过时: ${mapping.doc} — ${sourcePath} 更新于 ${date}`);
        staleCount++;
      }
    }
  }

  if (staleCount === 0) {
    console.log('✅ 所有文档均为最新');
  } else {
    console.log(`\n共 ${staleCount} 个源文件比对应文档更新，建议检查`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('文档检查脚本出错:', err);
  process.exit(0); // 不阻塞
});
