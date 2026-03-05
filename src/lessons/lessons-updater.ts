import { Logger } from '../shared/logging/logger';
import type { ConfigLoader } from '../kernel/memory/config-loader';
import type { OpenVikingClient } from '../kernel/memory/openviking/openviking-client';
import type { ExtractedLesson } from './lesson-extractor';

const MAX_PER_CATEGORY = 20;
const MAX_TOTAL = 80;
const LESSONS_SECTION_MARKER = '## Lessons Learned';
const VIKING_SOUL_URI = 'viking://agent/config/SOUL.md';
const LOCAL_SOUL_PATH = './config/SOUL.md';

interface LessonEntry {
  date: string;
  text: string;
  category: string;
}

/**
 * Parses, updates, and writes the Lessons Learned section of SOUL.md.
 * Enforces capacity control: 20 per category, 80 total.
 * Syncs to both local file and VikingFS.
 */
export class LessonsLearnedUpdater {
  private readonly logger = new Logger('LessonsLearnedUpdater');

  constructor(
    private readonly ov: OpenVikingClient,
    private readonly configLoader: ConfigLoader,
  ) {}

  /** Add a new lesson to SOUL.md */
  async addLesson(lesson: ExtractedLesson): Promise<boolean> {
    const config = await this.configLoader.loadAll();
    const soulContent = config.soul;

    const { before, entries } = this.parseLessons(soulContent);

    // Dedup check
    if (this.isDuplicate(lesson.lesson, entries)) {
      this.logger.info('教训已存在，跳过', { lesson: lesson.lesson.slice(0, 40) });
      return false;
    }

    // Add new entry
    const date = new Date().toISOString().split('T')[0];
    entries.push({ date, text: lesson.lesson, category: lesson.category });

    // Enforce capacity limits
    this.enforceCapacity(entries);

    // Rebuild SOUL.md
    const newSoul = this.rebuildSoul(before, entries);

    // Write to local file + VikingFS
    await Bun.write(LOCAL_SOUL_PATH, newSoul);
    try {
      await this.ov.write(VIKING_SOUL_URI, newSoul);
    } catch (err) {
      this.logger.warn('VikingFS 同步 SOUL.md 失败', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Invalidate config cache
    this.configLoader.invalidateCache();

    this.logger.info('教训已记录', {
      category: lesson.category,
      lesson: lesson.lesson.slice(0, 40),
    });

    return true;
  }

  /** Parse the Lessons Learned section from SOUL.md */
  parseLessons(soulContent: string): { before: string; entries: LessonEntry[] } {
    const idx = soulContent.indexOf(LESSONS_SECTION_MARKER);
    if (idx < 0) {
      return { before: soulContent, entries: [] };
    }

    const before = soulContent.slice(0, idx + LESSONS_SECTION_MARKER.length);
    const lessonsSection = soulContent.slice(idx + LESSONS_SECTION_MARKER.length);

    const entries: LessonEntry[] = [];
    let currentCategory = 'general';

    for (const line of lessonsSection.split('\n')) {
      const trimmed = line.trim();

      // Category header: ### 编码与技术
      if (trimmed.startsWith('### ')) {
        currentCategory = trimmed.slice(4).trim();
        continue;
      }

      // Lesson entry: - [2025-01-15] lesson text
      const match = /^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.+)$/.exec(trimmed);
      if (match) {
        entries.push({
          date: match[1],
          text: match[2],
          category: currentCategory,
        });
      }
    }

    return { before, entries };
  }

  private isDuplicate(newLesson: string, existing: LessonEntry[]): boolean {
    const newTokens = tokenize(newLesson);
    for (const entry of existing) {
      const entryTokens = tokenize(entry.text);
      if (jaccardSimilarity(newTokens, entryTokens) > 0.7) {
        return true;
      }
    }
    return false;
  }

  private enforceCapacity(entries: LessonEntry[]): void {
    // Per-category limit
    const byCat = new Map<string, LessonEntry[]>();
    for (const e of entries) {
      const arr = byCat.get(e.category) ?? [];
      arr.push(e);
      byCat.set(e.category, arr);
    }

    const kept: LessonEntry[] = [];
    for (const [, catEntries] of byCat) {
      // Keep newest entries up to MAX_PER_CATEGORY
      catEntries.sort((a, b) => b.date.localeCompare(a.date));
      kept.push(...catEntries.slice(0, MAX_PER_CATEGORY));
    }

    // Global limit
    kept.sort((a, b) => b.date.localeCompare(a.date));
    entries.length = 0;
    entries.push(...kept.slice(0, MAX_TOTAL));
  }

  private rebuildSoul(before: string, entries: LessonEntry[]): string {
    // Group by category
    const byCat = new Map<string, LessonEntry[]>();
    for (const e of entries) {
      const arr = byCat.get(e.category) ?? [];
      arr.push(e);
      byCat.set(e.category, arr);
    }

    const lines = [before, ''];

    for (const [cat, catEntries] of byCat) {
      lines.push(`### ${cat}`);
      for (const e of catEntries) {
        lines.push(`- [${e.date}] ${e.text}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
