const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const fs = require('fs');

const HOME = os.homedir();
const BUN = path.join(HOME, '.bun', 'bin', 'bun');
const OV_CONF = path.join(HOME, '.openviking', 'ov.conf');

// ── Load .env for config generation ──────────────────────
function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  const vars = {};
  try {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
      }
    }
  } catch { /* .env may not exist */ }
  return vars;
}
const dotEnv = loadDotEnv();

// ── Regenerate ~/.openviking/ov.conf synchronously before PM2 boots apps ──
// PM2's require-in-the-middle instrumentation is incompatible with bun running
// TS files that use top-level await, so we invoke the generator here instead
// of as a PM2-managed app.
try {
  execFileSync(BUN, ['run', path.join(__dirname, 'src/setup/generate-ov-conf.ts')], {
    env: {
      ...process.env,
      VOLCENGINE_API_KEY: dotEnv.VOLCENGINE_API_KEY || process.env.VOLCENGINE_API_KEY || '',
      OV_VLM_MODEL: dotEnv.OV_VLM_MODEL || process.env.OV_VLM_MODEL || '',
      OV_EMBEDDING_MODEL: dotEnv.OV_EMBEDDING_MODEL || process.env.OV_EMBEDDING_MODEL || '',
    },
    stdio: 'inherit',
  });
} catch (err) {
  console.error('[ecosystem] Failed to regenerate ov.conf:', err.message);
  // Don't block PM2 startup — openviking-server may still work with stale conf
}

// ── Link builtin skills to agent runtimes ───────────────
const SKILLS_SRC = path.join(__dirname, 'skills', 'builtin');
const SKILL_TARGETS = [
  path.join(HOME, '.claude', 'skills'),  // Claude Code
  path.join(HOME, '.codex', 'skills'),   // Codex
];

function linkSkills(src, dst) {
  if (!fs.existsSync(src) || !fs.existsSync(dst)) return 0;
  let count = 0;
  for (const name of fs.readdirSync(src)) {
    const srcDir = path.join(src, name);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    const dstLink = path.join(dst, name);
    try { fs.unlinkSync(dstLink); } catch {}
    fs.symlinkSync(srcDir, dstLink);
    count++;
  }
  return count;
}

for (const target of SKILL_TARGETS) {
  linkSkills(SKILLS_SRC, target);
}

module.exports = {
  apps: [
    {
      name: 'openviking-server',
      script: 'openviking-server',
      args: `--config ${OV_CONF}`,
      interpreter: 'none',
      restart_delay: 2000,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/openviking-error.log',
      out_file: 'logs/openviking-out.log',
    },
    {
      name: 'yourbot-gateway',
      script: 'src/gateway/index.ts',
      interpreter: BUN,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      // gateway 依赖 openviking-server，延迟启动等其就绪
      wait_ready: false,
      restart_delay: 3000,
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/gateway-error.log',
      out_file: 'logs/gateway-out.log',
      merge_logs: true,
    },
    {
      name: 'yourbot-scheduler',
      script: 'src/kernel/scheduling/scheduler.ts',
      interpreter: BUN,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '256M',
      cron_restart: '0 4 * * *',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/scheduler-error.log',
      out_file: 'logs/scheduler-out.log',
    },
  ],
};
