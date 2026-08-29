import { describe, it, expect } from 'vitest';
import {
  formatRoleLabel,
  estimateTokens,
  withSystemPrompt,
  serializeMessages,
  deserializeMessages,
  assembleChunks,
  generateMessageId,
} from './chat.js';
import type { Message } from '../types.js';

describe('chat', () => {
  describe('formatRoleLabel', () => {
    it('returns human-readable labels', () => {
      expect(formatRoleLabel('user')).toBe('You');
      expect(formatRoleLabel('assistant')).toBe('Sensei');
      expect(formatRoleLabel('system')).toBe('System');
      expect(formatRoleLabel('tool')).toBe('Tool');
    });

    it('falls back to raw role', () => {
      expect(formatRoleLabel('custom' as never)).toBe('custom');
    });
  });

  describe('estimateTokens', () => {
    it('returns 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('estimates ~4 chars per token', () => {
      expect(estimateTokens('hello')).toBe(2); // 5/4 = 1.25 → 2
      expect(estimateTokens('1234')).toBe(1);
      expect(estimateTokens('12345678')).toBe(2);
    });
  });

  describe('withSystemPrompt', () => {
    it('prepends system message', () => {
      const messages = [{ role: 'user', content: 'hi' }];
      const result = withSystemPrompt(messages, 'You are helpful.');
      expect(result[0]).toEqual({ role: 'system', content: 'You are helpful.' });
      expect(result[1]).toEqual({ role: 'user', content: 'hi' });
    });

    it('strips existing system messages', () => {
      const messages = [
        { role: 'system', content: 'old' },
        { role: 'user', content: 'hi' },
      ];
      const result = withSystemPrompt(messages, 'new prompt');
      expect(result.filter((m) => m.role === 'system')).toHaveLength(1);
      expect(result[0].content).toBe('new prompt');
    });

    it('returns messages without system if prompt is empty', () => {
      const messages = [{ role: 'user', content: 'hi' }];
      const result = withSystemPrompt(messages, '');
      expect(result).toEqual([{ role: 'user', content: 'hi' }]);
    });
  });

  // 🔴 `withRetrievalContext`'s SUITE WAS DELETED WITH THE FUNCTION. It spliced a
  // heuristic search's results in as a system message; grounding now arrives as
  // `role:'tool'` messages the model asked for by name. Coverage for that lives
  // in `./tools.test.ts` and `../tool-calling.e2e.test.tsx`.

  describe('serializeMessages', () => {
    it('preserves all fields including id', () => {
      const messages: Message[] = [
        { id: 'msg-1', role: 'user', content: 'hello', timestamp: 1000 },
      ];
      const result = serializeMessages(messages);
      expect(result).toEqual([{ id: 'msg-1', role: 'user', content: 'hello', timestamp: 1000 }]);
    });

    it('round-trips the withheld flag', () => {
      const messages: Message[] = [
        { id: 'm', role: 'assistant', content: 'policy reason', timestamp: 1, withheld: true },
      ];
      expect(deserializeMessages(serializeMessages(messages))[0].withheld).toBe(true);
    });

    it("deserializes a LEGACY stored 'tool' message rather than dropping it", () => {
      // Sessions written by the tool-loop build are still in KV storage.
      const stored = [{ id: 't', role: 'tool', content: '{"items":[]}', timestamp: 2 }];
      expect(deserializeMessages(stored)[0].role).toBe('tool');
    });
  });

  describe('deserializeMessages', () => {
    it('preserves original IDs', () => {
      const stored = [{ id: 'msg-1', role: 'user', content: 'hello', timestamp: 1000 }];
      const result = deserializeMessages(stored);
      expect(result[0].id).toBe('msg-1');
      expect(result[0].role).toBe('user');
    });
  });

  describe('assembleChunks', () => {
    it('joins chunks', () => {
      expect(assembleChunks(['hello', ' ', 'world'])).toBe('hello world');
    });
  });

  describe('generateMessageId', () => {
    it('generates unique IDs', () => {
      const id1 = generateMessageId();
      const id2 = generateMessageId();
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^msg-\d+-/);
    });
  });
});
