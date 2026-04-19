import { describe, expect, test } from 'bun:test';
import { FrozenContextManager } from './frozen-context-manager';

describe('FrozenContextManager', () => {
  const manager = new FrozenContextManager();

  const sampleParams = {
    soul: 'soul content',
    identity: 'identity content',
    user: 'user content',
    agents: 'agents content',
    memorySnapshot: 'memory snapshot',
    skillIndex: 'skill index',
  };

  describe('freeze', () => {
    test('creates snapshot with all fields', () => {
      const frozen = manager.freeze(sampleParams);
      expect(frozen.soul).toBe('soul content');
      expect(frozen.identity).toBe('identity content');
      expect(frozen.user).toBe('user content');
      expect(frozen.agents).toBe('agents content');
      expect(frozen.memorySnapshot).toBe('memory snapshot');
      expect(frozen.skillIndex).toBe('skill index');
    });

    test('sets frozenAt to current timestamp', () => {
      const before = Date.now();
      const frozen = manager.freeze(sampleParams);
      const after = Date.now();
      expect(frozen.frozenAt).toBeGreaterThanOrEqual(before);
      expect(frozen.frozenAt).toBeLessThanOrEqual(after);
    });

    test('creates independent snapshots', () => {
      const frozen1 = manager.freeze(sampleParams);
      const frozen2 = manager.freeze({ ...sampleParams, soul: 'different soul' });
      expect(frozen1.soul).toBe('soul content');
      expect(frozen2.soul).toBe('different soul');
    });
  });

  describe('needsRebuild', () => {
    test('returns false when no compaction timestamp', () => {
      const frozen = manager.freeze(sampleParams);
      expect(manager.needsRebuild(frozen)).toBe(false);
      expect(manager.needsRebuild(frozen, undefined)).toBe(false);
    });

    test('returns false when compaction is before freeze', () => {
      const frozen = manager.freeze(sampleParams);
      const beforeFreeze = frozen.frozenAt - 1000;
      expect(manager.needsRebuild(frozen, beforeFreeze)).toBe(false);
    });

    test('returns true when compaction is after freeze', () => {
      const frozen = manager.freeze(sampleParams);
      const afterFreeze = frozen.frozenAt + 1000;
      expect(manager.needsRebuild(frozen, afterFreeze)).toBe(true);
    });

    test('returns false when compaction equals freeze time', () => {
      const frozen = manager.freeze(sampleParams);
      expect(manager.needsRebuild(frozen, frozen.frozenAt)).toBe(false);
    });

    test('returns false when compaction timestamp is 0', () => {
      const frozen = manager.freeze(sampleParams);
      expect(manager.needsRebuild(frozen, 0)).toBe(false);
    });
  });
});
