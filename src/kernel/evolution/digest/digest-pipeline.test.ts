import { describe, expect, mock, spyOn, test } from 'bun:test';
import type { OpenVikingClient } from '../../memory/openviking/openviking-client';
import {
  type DigestCluster,
  type DigestInsight,
  type DigestableItem,
  clusterItems,
  clusterItemsWithOV,
  distillClusters,
  scanUndigested,
  writeInsights,
} from './digest-pipeline';

describe('clusterItems', () => {
  test('items 少于 3 个返回空', () => {
    const items: DigestableItem[] = [
      { uri: 'a', content: 'hello', importance: 0.3, accessCount: 0 },
      { uri: 'b', content: 'world', importance: 0.2, accessCount: 0 },
    ];
    expect(clusterItems(items)).toEqual([]);
  });

  test('相同主题的 items 聚为一个 cluster', () => {
    const items: DigestableItem[] = [
      { uri: 'a', content: 'Rust 所有权规则', importance: 0.3, accessCount: 0 },
      { uri: 'b', content: 'Rust 所有权借用', importance: 0.2, accessCount: 0 },
      { uri: 'c', content: 'Rust 所有权生命周期', importance: 0.4, accessCount: 0 },
    ];
    const clusters = clusterItems(items);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    // All should be in same cluster since they share "Rust 所有权"
    const totalItems = clusters.reduce((sum, c) => sum + c.items.length, 0);
    expect(totalItems).toBeGreaterThanOrEqual(3);
  });

  test('cluster size < 3 的被过滤', () => {
    const items: DigestableItem[] = [
      { uri: 'a', content: 'TypeScript 类型', importance: 0.3, accessCount: 0 },
      { uri: 'b', content: 'TypeScript 类型', importance: 0.2, accessCount: 0 },
      { uri: 'c', content: 'TypeScript 类型', importance: 0.4, accessCount: 0 },
      { uri: 'd', content: 'Python 独立话题', importance: 0.3, accessCount: 0 },
      { uri: 'e', content: 'Go 独立话题', importance: 0.3, accessCount: 0 },
    ];
    const clusters = clusterItems(items);
    // Only TypeScript cluster should survive (3 items), others are < 3
    for (const c of clusters) {
      expect(c.items.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('clusterItemsWithOV', () => {
  test('通过 OV 向量相似度聚类', async () => {
    spyOn(console, 'log').mockImplementation(() => {});
    const items: DigestableItem[] = [
      { uri: 'a', content: 'Rust 所有权', importance: 0.3, accessCount: 0 },
      { uri: 'b', content: 'Rust 借用', importance: 0.3, accessCount: 0 },
      { uri: 'c', content: 'Rust 生命周期', importance: 0.3, accessCount: 0 },
      { uri: 'd', content: 'Python 装饰器', importance: 0.3, accessCount: 0 },
    ];

    // Mock OV: when queried with "Rust 所有权", returns b and c as similar
    const ovClient = {
      find: mock(async (opts: { query: string }) => {
        if (opts.query.includes('Rust')) {
          return [
            { uri: 'a', abstract: 'Rust 所有权', score: 0.9, context_type: 'memory', match_reason: '' },
            { uri: 'b', abstract: 'Rust 借用', score: 0.8, context_type: 'memory', match_reason: '' },
            { uri: 'c', abstract: 'Rust 生命周期', score: 0.7, context_type: 'memory', match_reason: '' },
          ];
        }
        return [{ uri: opts.query, abstract: opts.query, score: 0.9, context_type: 'memory', match_reason: '' }];
      }),
    } as unknown as OpenVikingClient;

    const clusters = await clusterItemsWithOV(items, ovClient);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    // Rust cluster should have at least 3 items
    const rustCluster = clusters.find((c) => c.topic === 'Rust');
    expect(rustCluster).toBeDefined();
    expect(rustCluster!.items.length).toBeGreaterThanOrEqual(3);
  });

  test('items 少于 3 个返回空', async () => {
    const ovClient = { find: mock(async () => []) } as unknown as OpenVikingClient;
    const result = await clusterItemsWithOV(
      [{ uri: 'a', content: 'x', importance: 0.3, accessCount: 0 }],
      ovClient,
    );
    expect(result).toEqual([]);
  });
});

describe('scanUndigested', () => {
  test('从 OV 扫描低 importance 的碎片', async () => {
    spyOn(console, 'log').mockImplementation(() => {});
    const ovClient = {
      find: mock(async () => [
        { uri: 'mem/1', abstract: '碎片1', score: 0.3, context_type: 'memory', match_reason: '' },
        { uri: 'mem/2', abstract: '碎片2', score: 0.8, context_type: 'memory', match_reason: '' },
        { uri: 'mem/3', abstract: '碎片3', score: 0.2, context_type: 'memory', match_reason: '' },
      ]),
    } as unknown as OpenVikingClient;

    const items = await scanUndigested(ovClient, 'user1');
    // Only score < 0.5 should be returned
    expect(items.length).toBe(2);
    expect(items.map((i) => i.uri)).toEqual(['mem/1', 'mem/3']);
  });
});

describe('distillClusters', () => {
  test('调用 llmDistill 并返回 insights', async () => {
    spyOn(console, 'log').mockImplementation(() => {});
    const clusters: DigestCluster[] = [
      {
        topic: 'Rust',
        items: [
          { uri: 'a', content: '所有权', importance: 0.3, accessCount: 0 },
          { uri: 'b', content: '借用', importance: 0.3, accessCount: 0 },
          { uri: 'c', content: '生命周期', importance: 0.3, accessCount: 0 },
        ],
      },
    ];

    const llmDistill = mock(async () => ({
      topic: 'Rust 所有权',
      insight: 'Rust 的所有权系统通过借用和生命周期实现内存安全',
      questions: ['如何处理循环引用？'],
      relatedSkills: [],
      sourceUris: [],
    }));

    const insights = await distillClusters(clusters, llmDistill);
    expect(insights).toHaveLength(1);
    expect(insights[0]?.topic).toBe('Rust 所有权');
    expect(insights[0]?.sourceUris).toEqual(['a', 'b', 'c']);
  });

  test('LLM 失败时跳过该 cluster', async () => {
    spyOn(console, 'log').mockImplementation(() => {});
    const clusters: DigestCluster[] = [
      { topic: 'fail', items: [{ uri: 'a', content: 'x', importance: 0, accessCount: 0 }] },
    ];

    const llmDistill = mock(async () => {
      throw new Error('LLM timeout');
    });

    const insights = await distillClusters(clusters, llmDistill);
    expect(insights).toHaveLength(0);
  });
});

describe('writeInsights', () => {
  test('将 insights 写入 OpenViking', async () => {
    spyOn(console, 'log').mockImplementation(() => {});
    const ovClient = {
      write: mock(async () => {}),
    } as unknown as OpenVikingClient;

    const insights: DigestInsight[] = [
      {
        topic: 'Rust 所有权',
        insight: '核心洞察',
        questions: [],
        relatedSkills: [],
        sourceUris: ['a', 'b'],
      },
    ];

    const count = await writeInsights(ovClient, 'user1', insights);
    expect(count).toBe(1);
    expect(ovClient.write).toHaveBeenCalledWith(
      'viking://mem/user1/insight/Rust-所有权',
      '核心洞察',
    );
  });
});
