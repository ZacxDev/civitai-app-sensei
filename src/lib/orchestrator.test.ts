import { describe, it, expect } from 'vitest';
import { createOrchestrator } from './orchestrator.js';

describe('orchestrator', () => {
  it('createOrchestrator returns an adapter with submitChatCompletion', () => {
    const adapter = createOrchestrator();
    expect(adapter).toBeDefined();
    expect(typeof adapter.submitChatCompletion).toBe('function');
  });

  it('submitChatCompletion returns a valid ChatCompletionResponse', async () => {
    const adapter = createOrchestrator();
    const result = await adapter.submitChatCompletion({
      model: 'test',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(result.id).toBeTruthy();
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0].message.role).toBe('assistant');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage.total_tokens).toBeGreaterThan(0);
  });

  it('onChunk callback receives streaming words', async () => {
    const adapter = createOrchestrator();
    const chunks: string[] = [];
    await adapter.submitChatCompletion(
      { model: 'test', messages: [{ role: 'user', content: 'hello' }] },
      (c) => chunks.push(c),
    );
    expect(chunks.length).toBeGreaterThan(0);
  });
});
