import { describe, expect, mock, test } from 'bun:test';
import type { OpenVikingClient } from '../memory/openviking/openviking-client';
import { evolveMemory } from './evolve';

// Mock the Anthropic SDK
import { mock as bunMock } from 'bun:test';

let mockCreate: ReturnType<typeof mock>;

bunMock.module('@anthropic-ai/sdk', () => {
  mockCreate = mock(async () => ({
    content: [{ type: 'text', text: 'DUPLICATE' }],
  }));
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
  };
});

function createMockOV(): OpenVikingClient {
  return {
    read: mock(async () => 'existing content'),
    write: mock(async () => {}),
  } as unknown as OpenVikingClient;
}

describe('evolveMemory', () => {
  test('SUPERSEDE: writes new content over existing', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'SUPERSEDE' }],
    });

    const ov = createMockOV();
    await evolveMemory(ov, 'new content', 'viking://mem/1');
    expect(ov.write).toHaveBeenCalledWith('viking://mem/1', 'new content');
  });

  test('SUPPLEMENT: merges new content with existing', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'SUPPLEMENT' }],
    });

    const ov = createMockOV();
    await evolveMemory(ov, 'new info', 'viking://mem/1');
    const written = (ov.write as ReturnType<typeof mock>).mock.calls[0][1] as string;
    expect(written).toContain('existing content');
    expect(written).toContain('new info');
  });

  test('CONTRADICT: writes conflict resolution', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'CONTRADICT' }],
    });

    const ov = createMockOV();
    await evolveMemory(ov, 'contradicting info', 'viking://mem/1');
    const written = (ov.write as ReturnType<typeof mock>).mock.calls[0][1] as string;
    expect(written).toContain('合并解决矛盾');
  });

  test('DUPLICATE: does not write', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'DUPLICATE' }],
    });

    const ov = createMockOV();
    await evolveMemory(ov, 'dup content', 'viking://mem/1');
    expect(ov.write).not.toHaveBeenCalled();
  });

  test('defaults to DUPLICATE for unrecognized response', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'something random' }],
    });

    const ov = createMockOV();
    await evolveMemory(ov, 'content', 'viking://mem/1');
    expect(ov.write).not.toHaveBeenCalled();
  });

  test('handles empty content array', async () => {
    mockCreate.mockResolvedValue({
      content: [],
    });

    const ov = createMockOV();
    await evolveMemory(ov, 'content', 'viking://mem/1');
    // Should default to DUPLICATE
    expect(ov.write).not.toHaveBeenCalled();
  });
});
