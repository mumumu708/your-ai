import { OpenVikingClient } from '../kernel/memory/openviking';

/**
 * Creates the VikingFS directory structure via OpenViking API.
 * Run after OpenViking server is started.
 */

const VIKING_DIRS = [
  'viking://agent/config',
  'viking://user/memories/facts',
  'viking://user/memories/preferences',
  'viking://user/memories/procedures',
  'viking://user/memories/episodic',
  'viking://user/memories/semantic',
  'viking://user/memories/meta',
  'viking://user/resources',
  'viking://sessions',
];

export async function initVikingDirs(
  ovUrl = process.env.OPENVIKING_URL ?? 'http://localhost:1933',
): Promise<void> {
  const ov = new OpenVikingClient({ baseUrl: ovUrl });

  // Wait for server to be ready
  await ov.waitProcessed(30);

  for (const dir of VIKING_DIRS) {
    try {
      await ov.mkdir(dir);
    } catch (err) {
      // Directory may already exist — that's fine
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('exists')) {
        console.warn(`Warning: could not create ${dir}: ${msg}`);
      }
    }
  }

  console.log(`Initialized ${VIKING_DIRS.length} VikingFS directories`);
}

// CLI entry point
if (import.meta.main) {
  await initVikingDirs();
}
