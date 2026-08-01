import { describe, it, expect } from 'vitest';
import { delegateToNsfwAgent, isNsfwModelAvailable, NSFW_MODEL } from './nsfw-agent.js';

describe('nsfw-agent', () => {
  describe('delegateToNsfwAgent', () => {
    it('returns a response', async () => {
      const result = await delegateToNsfwAgent({
        task: 'Tell me about mature content',
      });
      expect(result.choices).toHaveLength(1);
      expect(result.choices[0].message.role).toBe('assistant');
    });

    it('includes context when provided', async () => {
      const result = await delegateToNsfwAgent({
        task: 'question',
        context: 'from main chat',
      });
      expect(result.choices[0].message.content).toBeTruthy();
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
