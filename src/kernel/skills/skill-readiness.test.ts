import { describe, expect, test } from 'bun:test';
import { checkReadiness } from './skill-readiness';

describe('checkReadiness', () => {
  test('returns ready when readiness is undefined', () => {
    const result = checkReadiness(undefined);
    expect(result.ready).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test('returns ready when readiness is empty', () => {
    const result = checkReadiness({});
    expect(result.ready).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test('returns ready when all env vars are present', () => {
    process.env.TEST_SKILL_VAR_A = '1';
    process.env.TEST_SKILL_VAR_B = '2';

    const result = checkReadiness({
      env: ['TEST_SKILL_VAR_A', 'TEST_SKILL_VAR_B'],
    });

    expect(result.ready).toBe(true);
    expect(result.missing).toEqual([]);

    process.env.TEST_SKILL_VAR_A = undefined;
    process.env.TEST_SKILL_VAR_B = undefined;
  });

  test('reports missing env vars', () => {
    process.env.NONEXISTENT_SKILL_VAR = undefined;

    const result = checkReadiness({
      env: ['NONEXISTENT_SKILL_VAR'],
    });

    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(['env:NONEXISTENT_SKILL_VAR']);
  });

  test('reports multiple missing env vars', () => {
    process.env.MISSING_A = undefined;
    process.env.MISSING_B = undefined;
    process.env.PRESENT_C = 'yes';

    const result = checkReadiness({
      env: ['MISSING_A', 'PRESENT_C', 'MISSING_B'],
    });

    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(['env:MISSING_A', 'env:MISSING_B']);

    process.env.PRESENT_C = undefined;
  });

  test('ignores tools and credentials (deferred)', () => {
    const result = checkReadiness({
      tools: ['web_fetch'],
      credentials: ['/some/path'],
    });

    expect(result.ready).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test('combines env check with ignored tools/credentials', () => {
    process.env.MISSING_ENV = undefined;

    const result = checkReadiness({
      env: ['MISSING_ENV'],
      tools: ['web_fetch'],
      credentials: ['/some/path'],
    });

    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(['env:MISSING_ENV']);
  });
});
