import { OpenVikingClient } from '../kernel/memory/openviking/openviking-client';

/**
 * Migrates existing SQLite memories to VikingFS via OpenVikingClient.
 * Maps old categories to new VikingFS URIs.
 */

const CATEGORY_URI_MAP: Record<string, string> = {
  preference: 'viking://user/memories/preferences',
  fact: 'viking://user/memories/facts',
  context: 'viking://user/memories/episodic',
  instruction: 'viking://user/memories/procedures',
  task: 'viking://user/memories/procedures',
  insight: 'viking://user/memories/semantic',
};

interface SqliteMemory {
  id: string;
  content: string;
  category: string;
  tags: string;
  importance: string;
  layer: string;
  user_id: string;
  created_at: number;
  updated_at: number;
  access_count: number;
  last_accessed_at: number;
  source: string | null;
  metadata: string | null;
}

export async function migrateSqliteToViking(
  dbPath = process.env.DB_PATH ?? './data/yourbot.db',
  ovUrl = process.env.OPENVIKING_URL ?? 'http://localhost:1933',
): Promise<{ migrated: number; skipped: number; errors: number }> {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath, { readonly: true });
  const ov = new OpenVikingClient({ baseUrl: ovUrl });

  // Wait for OpenViking to be ready
  await ov.waitProcessed(30);

  const rows = db.prepare('SELECT * FROM memories').all() as SqliteMemory[];
  console.log(`Found ${rows.length} memories to migrate`);

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    const baseUri = CATEGORY_URI_MAP[row.category] ?? 'viking://user/memories/facts';
    const uri = `${baseUri}/${row.id}`;

    // Build content with metadata header
    const tags = (() => {
      try {
        return JSON.parse(row.tags);
      } catch {
        return [];
      }
    })();

    const header = [
      `<!-- migrated from SQLite -->`,
      `<!-- original_id: ${row.id} -->`,
      `<!-- tags: ${tags.join(',')} -->`,
      `<!-- importance: ${row.importance} -->`,
      `<!-- layer: ${row.layer} -->`,
      `<!-- userId: ${row.user_id} -->`,
      `<!-- createdAt: ${new Date(row.created_at).toISOString()} -->`,
      `<!-- source: ${row.source ?? 'unknown'} -->`,
      '',
    ].join('\n');

    try {
      await ov.write(uri, header + row.content);
      migrated++;
      if (migrated % 50 === 0) {
        console.log(`  Migrated ${migrated}/${rows.length}...`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('exists')) {
        skipped++;
      } else {
        console.error(`  Error migrating ${row.id}: ${msg}`);
        errors++;
      }
    }
  }

  // Also migrate session summaries
  try {
    const sessions = db.prepare('SELECT * FROM session_summaries').all() as {
      session_id: string;
      user_id: string;
      summary: string;
      keywords: string;
      action_items: string;
      message_count: number;
      started_at: number;
      ended_at: number;
    }[];

    console.log(`Found ${sessions.length} session summaries to migrate`);

    for (const session of sessions) {
      const uri = `viking://user/memories/episodic/session_${session.session_id}`;
      const keywords = (() => {
        try { return JSON.parse(session.keywords); } catch { return []; }
      })();
      const content = [
        `<!-- session: ${session.session_id} -->`,
        `<!-- userId: ${session.user_id} -->`,
        `<!-- messages: ${session.message_count} -->`,
        `<!-- period: ${new Date(session.started_at).toISOString()} - ${new Date(session.ended_at).toISOString()} -->`,
        '',
        session.summary,
        '',
        keywords.length > 0 ? `关键词: ${keywords.join(', ')}` : '',
      ].join('\n');

      try {
        await ov.write(uri, content);
        migrated++;
      } catch {
        skipped++;
      }
    }
  } catch {
    console.log('No session_summaries table found, skipping');
  }

  db.close();

  console.log(`\nMigration complete: ${migrated} migrated, ${skipped} skipped, ${errors} errors`);
  return { migrated, skipped, errors };
}

// CLI entry point
if (import.meta.main) {
  const result = await migrateSqliteToViking();
  process.exit(result.errors > 0 ? 1 : 0);
}
