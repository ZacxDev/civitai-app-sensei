import { describe, it, expect, vi } from 'vitest';
import { createOrchestrator } from './orchestrator.js';

describe('orchestrator', () => {
  it('createOrchestrator returns a stub adapter when no workflow helpers given', () => {
    const adapter = createOrchestrator();
    expect(adapter).toBeDefined();
    expect(typeof adapter.submitChatCompletion).toBe('function');
  });

  it('stub submitChatCompletion returns a valid ChatCompletionResponse', async () => {
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

  it('stub onChunk callback receives streaming words', async () => {
    const adapter = createOrchestrator();
    const chunks: string[] = [];
    await adapter.submitChatCompletion(
      { model: 'test', messages: [{ role: 'user', content: 'hello' }] },
      (c) => chunks.push(c),
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('createOrchestrator returns a bridge adapter when workflow helpers are provided', async () => {
    const workflow = {
      estimate: vi.fn().mockResolvedValue({ cost: { total: 5 } }),
      submit: vi.fn().mockResolvedValue({ workflowId: 'wf-test', status: 'pending' }),
      poll: vi.fn().mockResolvedValue({ status: 'succeeded', content: 'Bridge response' }),
      cancel: vi.fn().mockResolvedValue({ status: 'canceled' }),
    };
    const adapter = createOrchestrator(workflow);
    expect(typeof adapter.submitChatCompletion).toBe('function');

    const result = await adapter.submitChatCompletion({
      model: 'test',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(result.choices[0].message.content).toBe('Bridge response');
    expect(workflow.estimate).toHaveBeenCalledOnce();
    expect(workflow.submit).toHaveBeenCalledOnce();
  });
});
