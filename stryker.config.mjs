/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'command',
  commandRunner: {
    // bash wrapper: bun's coverage table output causes WriteFailed (EPIPE) when
    // Stryker's command runner captures stdout. Redirecting stderr→stdout and
    // preserving exit code avoids false negatives in the dry run.
    command: 'bash -c "bun test 2>&1; exit $?"',
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
