import { describe, expect, test } from 'bun:test';
import { DEFAULT_REFLECTION_CONFIG, ReflectionTrigger } from './reflection-trigger';

describe('ReflectionTrigger', () => {
  const trigger = new ReflectionTrigger();

  test('default config has expected values', () => {
    expect(DEFAULT_REFLECTION_CONFIG.minHoursSinceLastReflection).toBe(24);
    expect(DEFAULT_REFLECTION_CONFIG.minSessionsSinceLastReflection).toBe(5);
  });

  describe('never reflected (lastReflectionAt = null)', () => {
    test('triggers when enough sessions accumulated', () => {
      expect(
        trigger.shouldReflect({
          lastReflectionAt: null,
          unreflectedSessionCount: 5,
        }),
      ).toBe(true);
    });

    test('does not trigger when too few sessions', () => {
      expect(
        trigger.shouldReflect({
          lastReflectionAt: null,
          unreflectedSessionCount: 4,
        }),
      ).toBe(false);
    });

    test('triggers when sessions exceed threshold', () => {
      expect(
        trigger.shouldReflect({
          lastReflectionAt: null,
          unreflectedSessionCount: 10,
        }),
      ).toBe(true);
    });
  });

  describe('has reflected before', () => {
    test('triggers when both time and session thresholds met', () => {
      const twentyFiveHoursAgo = Date.now() - 25 * 3_600_000;
      expect(
        trigger.shouldReflect({
          lastReflectionAt: twentyFiveHoursAgo,
          unreflectedSessionCount: 5,
        }),
      ).toBe(true);
    });

    test('does not trigger when time threshold not met', () => {
      const oneHourAgo = Date.now() - 1 * 3_600_000;
      expect(
        trigger.shouldReflect({
          lastReflectionAt: oneHourAgo,
          unreflectedSessionCount: 10,
        }),
      ).toBe(false);
    });

    test('does not trigger when session threshold not met', () => {
      const fortyEightHoursAgo = Date.now() - 48 * 3_600_000;
      expect(
        trigger.shouldReflect({
          lastReflectionAt: fortyEightHoursAgo,
          unreflectedSessionCount: 2,
        }),
      ).toBe(false);
    });

    test('does not trigger when neither threshold met', () => {
      const oneHourAgo = Date.now() - 1 * 3_600_000;
      expect(
        trigger.shouldReflect({
          lastReflectionAt: oneHourAgo,
          unreflectedSessionCount: 1,
        }),
      ).toBe(false);
    });
  });

  describe('custom config', () => {
    test('respects custom thresholds', () => {
      const twoHoursAgo = Date.now() - 2 * 3_600_000;
      expect(
        trigger.shouldReflect({
          lastReflectionAt: twoHoursAgo,
          unreflectedSessionCount: 2,
          config: {
            minHoursSinceLastReflection: 1,
            minSessionsSinceLastReflection: 2,
          },
        }),
      ).toBe(true);
    });

    test('custom config can be more restrictive', () => {
      const thirtyHoursAgo = Date.now() - 30 * 3_600_000;
      expect(
        trigger.shouldReflect({
          lastReflectionAt: thirtyHoursAgo,
          unreflectedSessionCount: 8,
          config: {
            minHoursSinceLastReflection: 48,
            minSessionsSinceLastReflection: 10,
          },
        }),
      ).toBe(false);
    });
  });
});
