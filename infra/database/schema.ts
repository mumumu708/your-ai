import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/**
 * @deprecated These tables are replaced by OpenViking VikingFS storage.
 * Kept temporarily for the migration script (src/setup/migrate-sqlite-to-viking.ts).
 * Remove after migration is complete.
 */

// --- Memories Table (deprecated — use OpenVikingClient) ---

export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(),
  content: text('content').notNull(),
  category: text('category').notNull(),
  tags: text('tags').notNull().default('[]'),
  importance: text('importance').notNull().default('medium'),
  layer: text('layer').notNull(),
  userId: text('user_id').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  accessCount: integer('access_count').notNull().default(0),
  lastAccessedAt: integer('last_accessed_at').notNull(),
  source: text('source'),
  metadata: text('metadata'),
});

// --- Session Summaries Table (deprecated — use ov.commit()) ---

export const sessionSummaries = sqliteTable('session_summaries', {
  sessionId: text('session_id').primaryKey(),
  userId: text('user_id').notNull(),
  summary: text('summary').notNull(),
  keywords: text('keywords').notNull().default('[]'),
  actionItems: text('action_items').notNull().default('[]'),
  preferences: text('preferences').notNull().default('[]'),
  messageCount: integer('message_count').notNull(),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at').notNull(),
});
