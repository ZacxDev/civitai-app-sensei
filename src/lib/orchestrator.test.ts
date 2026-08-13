import { describe, it, expect, vi } from 'vitest';
import { createOrchestrator } from './orchestrator.js';

function helpers() {
  return {
    estimate: vi.fn().mockResolvedValue({ cost: { total: 1 } }),
    submit: vi.fn().mockResolvedValue({ workflowId: 'wf-test', status: 'pending' }),
    poll: vi.fn().mockResolvedValue({ status: 'succeeded', textOutputs: ['Bridge response'] }),
    cancel: vi.fn().mockResolvedValue({ status: 'canceled' }),
  };
}

describe('orchestrator', () => {
  it('returns a bridge adapter over the supplied workflow helpers', async () => {
    const workflow = helpers();
    const adapter = createOrchestrator(workflow);
    expect(typeof adapter.submitChatCompletion).toBe('function');

    const result = await adapter.submitChatCompletion({
      model: 'deepseek/deepseek-chat',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.choices[0].message.content).toBe('Bridge response');
    expect(result.choices[0].message.role).toBe('assistant');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage.total_tokens).toBeGreaterThan(0);
    expect(workflow.estimate).toHaveBeenCalledOnce();
    expect(workflow.submit).toHaveBeenCalledOnce();
  });

  it('routes every call through the host, with no stub fallback', async () => {
    // 🔴 THE STUB IS GONE ON PURPOSE. It used to answer whenever the helpers were
    // absent — which never happened in the app but was the ONLY path these tests
    // covered, so a fully broken bridge stayed green. There is now no way to get
    // a canned answer: a call either reaches the injected helpers or it fails.
    const workflow = helpers();
    const adapter = createOrchestrator(workflow);
    await adapter.submitChatCompletion({
      model: 'deepseek/deepseek-chat',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(workflow.submit).toHaveBeenCalledOnce();
  });
});
