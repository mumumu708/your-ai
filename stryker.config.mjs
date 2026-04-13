/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'command',
  commandRunner: {
    // Wrapper script: suppresses bun coverage table output to avoid EPIPE,
    // preserves exit code for proper mutant kill detection.
    command: 'bash scripts/stryker-test-runner.sh',
  },
  mutate: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.integration.test.ts',
    '!src/**/*.e2e.test.ts',
    '!src/**/test-utils/**',
    '!src/**/__fixtures__/**',
    '!src/**/*.types.ts',
    '!src/**/*.d.ts',
  ],
  coverageAnalysis: 'off',
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  reporters: ['clear-text', 'html', 'progress'],
  htmlReporter: {
    fileName: 'reports/mutation/index.html',
  },
  concurrency: 4,
  timeoutMS: 30000,
  timeoutFactor: 1.5,
  thresholds: {
    high: 80,
    low: 60,
    break: 50,
  },
  tempDirName: '.stryker-tmp',
};
