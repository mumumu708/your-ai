import { describe, expect, mock, test } from 'bun:test';
import type { OpenVikingClient } from '../memory/openviking/openviking-client';
import { reflect } from './reflect';

import { mock as bunMock } from 'bun:test';

let mockCreate: ReturnType<typeof mock>;

bunMock.module('@anthropic-ai/sdk', () => {
  mockCreate = mock(async () => ({
    content: [{ type: 'text', text: '- 洞察: insight one\n- 洞察: insight two' }],
  }));
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
  };
});

function createMockOV(): OpenVikingClient {
  return {
    find: mock(async () => []),
    abstract: mock(async () => 'abstract text'),
    write: mock(async () => {}),
  } as unknown as OpenVikingClient;
}

describe('reflect', () => {
  test('skips when fewer than 5 memories', async () => {
    const ov = createMockOV();
    (ov.find as ReturnType<typeof mock>).mockResolvedValue([
      { uri: 'v://m1' },
      { uri: 'v://m2' },
      { uri: 'v://m3' },
    ]);

    await reflect(ov, 'facts');
    expect(ov.write).not.toHaveBeenCalled();
  });

  test('extracts insights and writes to semantic/', async () => {
    const ov = createMockOV();
    const memories = Array.from({ length: 6 }, (_, i) => ({ uri: `v://m${i}` }));
    (ov.find as ReturnType<typeof mock>).mockResolvedValue(memories);

    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: '- 洞察: users prefer short answers\n- 洞察: common theme is efficiency',
        },
      ],
    });

    await reflect(ov, 'preferences');
    expect(ov.write).toHaveBeenCalledTimes(2);
    const firstWriteUri = (ov.write as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(firstWriteUri).toContain('viking://user/memories/semantic/');
  });

  test('handles empty insights from LLM', async () => {
    const ov = createMockOV();
    const memories = Array.from({ length: 6 }, (_, i) => ({ uri: `v://m${i}` }));
    (ov.find as ReturnType<typeof mock>).mockResolvedValue(memories);

    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'no insights found' }],
    });

    await reflect(ov, 'facts');
    expect(ov.write).not.toHaveBeenCalled();
  });

  test('handles empty content array', async () => {
    const ov = createMockOV();
    const memories = Array.from({ length: 6 }, (_, i) => ({ uri: `v://m${i}` }));
    (ov.find as ReturnType<typeof mock>).mockResolvedValue(memories);

    mockCreate.mockResolvedValue({ content: [] });

    await reflect(ov, 'facts');
    expect(ov.write).not.toHaveBeenCalled();
  });
});
