const os = require('os');
const path = require('path');

const HOME = os.homedir();
const BUN = path.join(HOME, '.bun', 'bin', 'bun');
const OV_CONF = path.join(HOME, '.openviking', 'ov.conf');

module.exports = {
  apps: [
    {
      name: 'openviking-server',
      script: 'openviking-server',
      args: `--config ${OV_CONF}`,
      interpreter: 'none',
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
