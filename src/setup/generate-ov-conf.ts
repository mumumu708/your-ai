import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Generates ~/.openviking/ov.conf from environment variables or provided config.
 */

export interface OVConfOptions {
  volcengineApiKey?: string;
  vlmModel?: string;
  embeddingModel?: string;
  workspace?: string;
  host?: string;
  port?: number;
}

export function buildOVConf(options: OVConfOptions = {}): Record<string, unknown> {
  const apiKey =
    options.volcengineApiKey ??
    process.env.VOLCENGINE_API_KEY ??
    '4aa5617e-edf1-4ce6-a861-4ab8a020ec2a';

  return {
    vlm: {
      provider: 'volcengine',
      api_key: apiKey,
      model: options.vlmModel ?? 'doubao-seed-1-8-251228',
      api_base: 'https://ark.cn-beijing.volces.com/api/v3',
      temperature: 0.1,
      max_retries: 3,
    },
    embedding: {
      dense: {
        provider: 'volcengine',
        api_key: apiKey,
        model: options.embeddingModel ?? 'doubao-embedding-vision-250615',
        api_base: 'https://ark.cn-beijing.volces.com/api/v3',
        dimension: 1024,
        input: 'multimodal',
      },
    },
    storage: {
      workspace: options.workspace ?? './openviking-data',
      agfs: { backend: 'local' },
      vectordb: { backend: 'local', name: 'memory_context' },
    },
    server: {
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 1933,
    },
  };
}

export async function generateOVConf(options: OVConfOptions = {}): Promise<string> {
  const ovDir = join(homedir(), '.openviking');
  await mkdir(ovDir, { recursive: true });

  const confPath = join(ovDir, 'ov.conf');
  const conf = buildOVConf(options);
  const content = JSON.stringify(conf, null, 2);

  await writeFile(confPath, content, 'utf-8');
  return confPath;
}

// CLI entry point
if (import.meta.main) {
  const path = await generateOVConf();
  console.log(`Generated OpenViking config at: ${path}`);
}
