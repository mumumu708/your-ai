import { Database } from 'bun:sqlite';
import { Logger } from '../../src/shared/logging/logger';

const logger = new Logger('SessionDB');
let db: Database | null = null;

/**
 * Get or create the singleton bun:sqlite Database for session/task stores.
 * Uses WAL mode + tuned pragmas for concurrent read performance.
 */
export function getSessionDatabase(dbPath?: string): Database {
  if (db) return db;

  const path = dbPath || process.env.SESSION_DB_PATH || 'data/session.db';

  // Ensure directory exists
  const dir = path.substring(0, path.lastIndexOf('/'));
  if (dir) {
    const fs = require('fs');
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA cache_size = -64000');

  logger.info('Session database initialized', { path });
  return db;
}

/**
 * Close the session database connection. Used for graceful shutdown.
 */
export function closeSessionDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
