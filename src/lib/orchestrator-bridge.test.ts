import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBridgeAdapter, type WorkflowHelpers } from './orchestrator-bridge.js';

function mockWorkflowHelpers(overrides?: Partial<WorkflowHelpers>): WorkflowHelpers {
  return {
    estimate: vi.fn().mockResolvedValue({ cost: { total: 10 } }),
    submit: vi.fn().mockResolvedValue({ workflowId: 'wf-1', status: 'pending' }),
    poll: vi.fn().mockResolvedValue({
      status: 'succeeded',
      content: 'Hello from the bridge!',
    }),
    cancel: vi.fn().mockResolvedValue({ status: 'canceled' }),
    ...overrides,
  };
}

describe('orchestrator-bridge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates an adapter with submitChatCompletion', () => {
    const adapter = createBridgeAdapter(mockWorkflowHelpers());
    expect(typeof adapter.submitChatCompletion).toBe('function');
  });

  it('calls estimate, submit, poll in order and returns response', async () => {
    const estimate = vi.fn().mockResolvedValue({ cost: { total: 10 } });
    const submit = vi.fn().mockResolvedValue({ workflowId: 'wf-42', status: 'pending' });
    const poll = vi.fn().mockResolvedValue({
      status: 'succeeded',
      content: 'The answer is 42.',
    });
    const adapter = createBridgeAdapter({ estimate, submit, poll, cancel: vi.fn() });

    const result = await adapter.submitChatCompletion({
      model: 'test-model',
      messages: [{ role: 'user', content: 'What is the answer?' }],
    });

    expect(estimate).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenCalled();
    expect(result.id).toBe('wf-42');
    expect(result.choices[0].message.content).toBe('The answer is 42.');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage.total_tokens).toBeGreaterThan(0);
  });

  it('polls until terminal status', async () => {
    const poll = vi.fn()
      .mockResolvedValueOnce({ status: 'processing' })
      .mockResolvedValueOnce({ status: 'processing' })
      .mockResolvedValueOnce({ status: 'succeeded', content: 'Done!' });
    const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));

    const result = await adapter.submitChatCompletion({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(poll).toHaveBeenCalledTimes(3);
    expect(result.choices[0].message.content).toBe('Done!');
  });

  it('calls onChunk with streaming simulation', async () => {
    const adapter = createBridgeAdapter(mockWorkflowHelpers());
    const chunks: string[] = [];

    await adapter.submitChatCompletion(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      (c) => chunks.push(c),
    );

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('')).toContain('Hello from the bridge!');
  });

  it('throws on failed workflow', async () => {
    const poll = vi.fn().mockResolvedValue({ status: 'failed', error: 'Budget exceeded' });
    const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));

    await expect(
      adapter.submitChatCompletion({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow('Budget exceeded');
  });

  it('throws on expired workflow', async () => {
    const poll = vi.fn().mockResolvedValue({ status: 'expired' });
    const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));

    await expect(
      adapter.submitChatCompletion({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow('Workflow expired');
  });

  it('throws on zero cost estimate', async () => {
    const estimate = vi.fn().mockResolvedValue({ cost: { total: 0 } });
    const adapter = createBridgeAdapter(mockWorkflowHelpers({ estimate }));

    await expect(
      adapter.submitChatCompletion({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow('zero or missing cost');
  });

  it('throws when submit returns no workflowId', async () => {
    const submit = vi.fn().mockResolvedValue({ status: 'pending' });
    const adapter = createBridgeAdapter(mockWorkflowHelpers({ submit }));

    await expect(
      adapter.submitChatCompletion({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow('workflowId');
  });

  it('extracts tool_calls from snapshot when present', async () => {
    const poll = vi.fn().mockResolvedValue({
      status: 'succeeded',
      content: '',
      tool_calls: [{
        id: 'tc-1',
        type: 'function',
        function: { name: 'search_models', arguments: '{"query":"test"}' },
      }],
    });
    const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));

    const result = await adapter.submitChatCompletion({
      model: 'm',
      messages: [{ role: 'user', content: 'search for models' }],
    });

    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    expect(result.choices[0].finish_reason).toBe('tool_calls');
  });

  it('extracts content from steps[0].output.text path', async () => {
    const poll = vi.fn().mockResolvedValue({
      status: 'succeeded',
      steps: [{ output: { text: 'From steps path' } }],
    });
    const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));

    const result = await adapter.submitChatCompletion({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.choices[0].message.content).toBe('From steps path');
  });

  it('extracts content from steps[0].output.content path', async () => {
    const poll = vi.fn().mockResolvedValue({
      status: 'succeeded',
      steps: [{ output: { content: 'From steps output.content' } }],
    });
    const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));

    const result = await adapter.submitChatCompletion({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.choices[0].message.content).toBe('From steps output.content');
  });
});
