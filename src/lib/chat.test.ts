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

    // ── LAYER 2's CORRECTION RECORD. ───────────────────────────────────────
    //
    // 🔴 IT IS STORED SO THE FIRE-RATE CAN BE READ OFF A REAL TRANSCRIPT. The
    // ~22% estimate that motivated the feature comes from an 18-turn probe; the
    // whole point of persisting this is to replace an estimate with a count. A
    // field that silently failed to round-trip would leave the estimate as the
    // only number anyone ever has, and nothing would say so.
    it('🔴 round-trips the correction record', () => {
      const messages: Message[] = [
        {
          id: 'c',
          role: 'assistant',
          content: 'corrected reply',
          timestamp: 3,
          correction: { rounds: 1, resolved: true },
        },
      ];
      const stored = serializeMessages(messages);
      expect(stored[0].correction).toEqual({ rounds: 1, resolved: true });
      expect(deserializeMessages(stored)[0].correction).toEqual({ rounds: 1, resolved: true });
    });

    it('🔴 round-trips a FAILED correction, which is the case that matters most', () => {
      // `resolved: false` says "we spent the viewer's Buzz and it did not work".
      // A serializer that only kept truthy records would store every success and
      // drop every failure — a fire-rate biased in exactly the direction that
      // makes the feature look good.
      const messages: Message[] = [
        {
          id: 'f',
          role: 'assistant',
          content: 'still wrong',
          timestamp: 4,
          correction: { rounds: 1, resolved: false },
        },
      ];
      expect(deserializeMessages(serializeMessages(messages))[0].correction).toEqual({
        rounds: 1,
        resolved: false,
      });
    });

    it('omits the key entirely when no round fired — the common turn is unchanged', () => {
      const messages: Message[] = [
        { id: 'p', role: 'assistant', content: 'plain', timestamp: 5 },
      ];
      expect(serializeMessages(messages)[0]).toEqual({
        id: 'p',
        role: 'assistant',
        content: 'plain',
        timestamp: 5,
      });
      expect(deserializeMessages(serializeMessages(messages))[0].correction).toBeUndefined();
    });

    it('🔴 refuses a malformed stored record rather than deserializing a half one', () => {
      // The row decides the value — `deserializeMessages` casts what storage
      // hands it. A `{ rounds: 0 }` or a missing `resolved` reaching a consumer
      // as a present `correction` would read as "a correction happened" on a
      // turn where none did.
      const rows = [
        { id: 'a', role: 'assistant', content: 'x', timestamp: 6, correction: { rounds: 0, resolved: true } },
        { id: 'b', role: 'assistant', content: 'x', timestamp: 7, correction: { rounds: 1 } },
        { id: 'c', role: 'assistant', content: 'x', timestamp: 8, correction: {} },
      ] as unknown as Parameters<typeof deserializeMessages>[0];
      for (const m of deserializeMessages(rows)) {
        expect(m.correction, `row ${m.id} must not deserialize a malformed record`).toBeUndefined();
      }
      // Positive control: a WELL-FORMED row on the same code path does survive,
      // so the four `undefined`s above are a fact about the rows and not about a
      // clause that rejects everything.
      const good = [
        { id: 'd', role: 'assistant', content: 'x', timestamp: 9, correction: { rounds: 1, resolved: false } },
      ];
      expect(deserializeMessages(good)[0].correction).toEqual({ rounds: 1, resolved: false });
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
