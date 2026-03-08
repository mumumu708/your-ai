import { describe, expect, mock, test } from 'bun:test';
import type { OpenVikingClient } from '../openviking/openviking-client';
import { EntityManager } from './entity-manager';

function createMockOV(): OpenVikingClient {
  return {
    write: mock(async () => {}),
    link: mock(async () => {}),
    relations: mock(async () => []),
    abstract: mock(async (uri: string) => `abstract of ${uri}`),
  } as unknown as OpenVikingClient;
}

describe('EntityManager', () => {
  // ─── upsertEntity ────────────────────────────────────
  test('creates entity with slug URI', async () => {
    const ov = createMockOV();
    const em = new EntityManager(ov);
    const uri = await em.upsertEntity('John Doe', 'A user');
    expect(uri).toBe('viking://agent/graph/entities/john-doe');
    expect(ov.write).toHaveBeenCalled();
  });

  test('includes properties in content', async () => {
    const ov = createMockOV();
    const em = new EntityManager(ov);
    await em.upsertEntity('Alice', 'Engineer', { role: 'frontend', team: 'core' });
    const writeCall = (ov.write as ReturnType<typeof mock>).mock.calls[0];
    const content = writeCall[1] as string;
    expect(content).toContain('**role**: frontend');
    expect(content).toContain('**team**: core');
  });

  test('handles entity without properties', async () => {
    const ov = createMockOV();
    const em = new EntityManager(ov);
    await em.upsertEntity('Bob', 'Test user');
    const writeCall = (ov.write as ReturnType<typeof mock>).mock.calls[0];
    const content = writeCall[1] as string;
    expect(content).toContain('# Bob');
    expect(content).toContain('Test user');
  });

  // ─── addRelation ─────────────────────────────────────
  test('links two entities', async () => {
    const ov = createMockOV();
    const em = new EntityManager(ov);
    await em.addRelation('alice', 'bob', 'knows');
    expect(ov.link).toHaveBeenCalledWith(
      'viking://agent/graph/entities/alice',
      ['viking://agent/graph/entities/bob'],
      'knows',
    );
  });

  // ─── linkToMemory ────────────────────────────────────
  test('links entity to memory URI', async () => {
    const ov = createMockOV();
    const em = new EntityManager(ov);
    await em.linkToMemory('alice', 'viking://user/memories/m1', 'context');
    expect(ov.link).toHaveBeenCalledWith(
      'viking://agent/graph/entities/alice',
      ['viking://user/memories/m1'],
      'related_memory:context',
    );
  });

  // ─── query ───────────────────────────────────────────
  test('queries entity relations', async () => {
    const ov = createMockOV();
    (ov.relations as ReturnType<typeof mock>).mockResolvedValue([
      { uri: 'viking://agent/graph/entities/bob', reason: 'knows', created_at: '2024-01-01' },
    ]);
    const em = new EntityManager(ov);
    const result = await em.query('alice', 1);
    expect(result.entity).toBe('alice');
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0].target).toBe('viking://agent/graph/entities/bob');
    expect(result.relations[0].abstract).toBe('abstract of viking://agent/graph/entities/bob');
  });

  test('queries entity with depth > 1 traversal', async () => {
    const ov = createMockOV();
    let callCount = 0;
    (ov.relations as ReturnType<typeof mock>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [{ uri: 'viking://e/bob', reason: 'knows', created_at: '2024-01-01' }];
      }
      return [{ uri: 'viking://e/charlie', reason: 'friend', created_at: '2024-01-02' }];
    });

    const em = new EntityManager(ov);
    const result = await em.query('alice', 2);
    expect(result.relations).toHaveLength(2);
    expect(result.relations[1].via).toBe('viking://e/bob');
  });

  test('returns empty relations when entity has none', async () => {
    const ov = createMockOV();
    const em = new EntityManager(ov);
    const result = await em.query('lonely');
    expect(result.relations).toHaveLength(0);
  });
});
