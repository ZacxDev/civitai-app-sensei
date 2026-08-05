import { describe, it, expect, vi } from 'vitest';
import { delegateToNsfwAgent, isNsfwModelAvailable, NSFW_MODEL } from './nsfw-agent.js';
import type { OrchestratorAdapter } from './orchestrator.js';
import type { ChatCompletionResponse } from './completion-types.js';

function mockOrchestrator(resp?: Partial<ChatCompletionResponse>): OrchestratorAdapter {
  return {
    submitChatCompletion: vi.fn().mockResolvedValue({
      id: 'mock-1',
      choices: [{ index: 0, message: { role: 'assistant' as const, content: 'NSFW response' }, finish_reason: 'stop' as const }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      ...resp,
    }),
  };
}

describe('nsfw-agent', () => {
  describe('delegateToNsfwAgent', () => {
    it('returns a response', async () => {
      const orchestrator = mockOrchestrator();
      const result = await delegateToNsfwAgent(orchestrator, {
        task: 'Tell me about mature content',
      });
      expect(result.choices).toHaveLength(1);
      expect(result.choices[0].message.role).toBe('assistant');
      expect(orchestrator.submitChatCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ model: NSFW_MODEL }),
        undefined,
      );
    });

    it('includes context when provided', async () => {
      const orchestrator = mockOrchestrator();
      const result = await delegateToNsfwAgent(orchestrator, {
        task: 'question',
        context: 'from main chat',
      });
      expect(result.choices[0].message.content).toBe('NSFW response');
      expect(orchestrator.submitChatCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({ content: 'Context from main conversation: from main chat' }),
          ]),
        }),
        undefined,
      );
    });

    it('passes onChunk through to orchestrator', async () => {
      const orchestrator = mockOrchestrator();
      const onChunk = vi.fn();
      await delegateToNsfwAgent(orchestrator, { task: 'test' }, onChunk);
      expect(orchestrator.submitChatCompletion).toHaveBeenCalledWith(
        expect.any(Object),
        onChunk,
      );
    });
  });

  describe('isNsfwModelAvailable', () => {
    it('returns true', () => {
      expect(isNsfwModelAvailable()).toBe(true);
    });
  });

  describe('NSFW_MODEL', () => {
    it('is the dolphin model', () => {
      expect(NSFW_MODEL).toBe('cognitivecomputations/dolphin-mistral-24b-venice-edition');
    });
  });
});