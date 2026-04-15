import { describe, expect, spyOn, test } from 'bun:test';
import { shouldTriggerDigest } from './digest-trigger';

describe('shouldTriggerDigest', () => {
  test('手动触发始终返回 true', () => {
    spyOn(console, 'log').mockImplementation(() => {});
    expect(shouldTriggerDigest({ undigestedCount: 0, lastDigestAt: Date.now() }, true)).toBe(true);
  });

  test('undigestedCount ≥ 20 触发', () => {
    spyOn(console, 'log').mockImplementation(() => {});
    expect(shouldTriggerDigest({ undigestedCount: 20, lastDigestAt: Date.now() })).toBe(true);
    expect(shouldTriggerDigest({ undigestedCount: 25, lastDigestAt: Date.now() })).toBe(true);
  });

  test('undigestedCount < 20 不触发（无其他条件）', () => {
    expect(shouldTriggerDigest({ undigestedCount: 5, lastDigestAt: Date.now() })).toBe(false);
  });

  test('距上次消化 ≥ 3 天触发', () => {
    spyOn(console, 'log').mockImplementation(() => {});
    const threeDaysAgo = Date.now() - 3 * 86_400_000;
    expect(shouldTriggerDigest({ undigestedCount: 0, lastDigestAt: threeDaysAgo })).toBe(true);
  });

  test('距上次消化 < 3 天不触发', () => {
    const oneDayAgo = Date.now() - 1 * 86_400_000;
    expect(shouldTriggerDigest({ undigestedCount: 0, lastDigestAt: oneDayAgo })).toBe(false);
  });

  test('从未消化（lastDigestAt = null）但碎片不够不触发', () => {
    expect(shouldTriggerDigest({ undigestedCount: 5, lastDigestAt: null })).toBe(false);
  });

  test('两个条件独立满足即可', () => {
    spyOn(console, 'log').mockImplementation(() => {});
    // 碎片够但时间不够 → 触发
    expect(shouldTriggerDigest({ undigestedCount: 25, lastDigestAt: Date.now() })).toBe(true);
    // 碎片不够但时间够 → 触发
    const fiveDaysAgo = Date.now() - 5 * 86_400_000;
    expect(shouldTriggerDigest({ undigestedCount: 3, lastDigestAt: fiveDaysAgo })).toBe(true);
  });

  test('自定义阈值生效', () => {
    spyOn(console, 'log').mockImplementation(() => {});
    const config = { minUndigested: 5, minDaysSinceLastDigest: 1 };
    expect(
      shouldTriggerDigest({ undigestedCount: 5, lastDigestAt: Date.now() }, false, config),
    ).toBe(true);
  });
});
