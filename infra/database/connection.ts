import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

let dbInstance: ReturnType<typeof drizzle> | null = null;
let rawDb: Database.Database | null = null;

const DEFAULT_DB_PATH = 'data/yourbot.db';

/**
 * Get or create the singleton database connection.
 * Uses WAL mode for concurrent read performance.
 */
export function getDatabase(dbPath?: string): ReturnType<typeof drizzle> {
  if (dbInstance) return dbInstance;

  const path = dbPath ?? DEFAULT_DB_PATH;

  // Ensure data directory exists
  const dir = path.substring(0, path.lastIndexOf('/'));
  if (dir) {
    try {
      require('fs').mkdirSync(dir, { recursive: true });
    } catch {
      // Directory may already exist
    }
  }

  rawDb = new Database(path);

  // Enable WAL mode for better concurrent read performance
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('synchronous = NORMAL');

  // Auto-create tables
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      category TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      importance TEXT NOT NULL DEFAULT 'medium',
      layer TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at INTEGER NOT NULL,
      source TEXT,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS session_summaries (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]',
      action_items TEXT NOT NULL DEFAULT '[]',
      preferences TEXT NOT NULL DEFAULT '[]',
      message_count INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
    CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer);
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_session_summaries_user_id ON session_summaries(user_id);
  `);

  dbInstance = drizzle(rawDb, { schema });
  return dbInstance;
}

/**
 * Close the database connection. Used for graceful shutdown.
 */
export function closeDatabase(): void {
  if (rawDb) {
    rawDb.close();
    rawDb = null;
    dbInstance = null;
  }
}

/**
 * Get the raw better-sqlite3 instance for direct queries.
 */
export function getRawDatabase(): Database.Database | null {
  return rawDb;
}
