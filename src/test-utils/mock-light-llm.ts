/**
 * Shared mock LightLLMClient for integration/E2E tests.
 */
import { mock } from 'bun:test';
import type { LightLLMClient } from '../kernel/agents/light-llm-client';

export function createMockLightLLM(response = 'mock light response'): LightLLMClient {
  return {
    complete: mock(async () => ({
      content: response,
      model: 'deepseek-chat',
      usage: { promptTokens: 5, completionTokens: 3, totalCost: 0.0001 },
    })),
    stream: mock(async function* () {
      yield { content: response, done: false };
      yield { content: '', done: true };
    }),
    getDefaultModel: () => 'deepseek-chat',
  } as unknown as LightLLMClient;
}
