import { describe, it, expect, beforeEach } from 'vitest';
import {
  submitChatCompletion,
  resetStubCounter,
  getStubToolResult,
  __STUB_ENABLED__,
} from './orchestrator-stub.js';

describe('orchestrator-stub', () => {
  beforeEach(() => {
    resetStubCounter();
  });

  describe('__STUB_ENABLED__', () => {
    it('is true', () => {
      expect(__STUB_ENABLED__).toBe(true);
    });
  });

  describe('submitChatCompletion', () => {
    it('returns a valid response', async () => {
      const result = await submitChatCompletion({
        model: 'test',
        messages: [{ role: 'user', content: 'hello' }],
      });
      expect(result.id).toBeTruthy();
      expect(result.choices).toHaveLength(1);
      expect(result.choices[0].message.role).toBe('assistant');
      expect(result.choices[0].finish_reason).toBe('stop');
      expect(result.usage.total_tokens).toBeGreaterThan(0);
    });

    it('calls onChunk for streaming', async () => {
      const chunks: string[] = [];
      await submitChatCompletion(
        { model: 'test', messages: [{ role: 'user', content: 'hello' }] },
        (chunk) => chunks.push(chunk),
      );
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('generates unique IDs', async () => {
      const r1 = await submitChatCompletion({
        model: 'test',
        messages: [{ role: 'user', content: 'a' }],
      });
      const r2 = await submitChatCompletion({
        model: 'test',
        messages: [{ role: 'user', content: 'b' }],
      });
      expect(r1.id).not.toBe(r2.id);
    });

    it('detects tool-call trigger words', async () => {
      const result = await submitChatCompletion({
        model: 'test',
        messages: [{ role: 'user', content: 'search for anime models' }],
        tools: [{ type: 'function', function: { name: 'test', description: '', parameters: {} } }],
      });
      expect(result.choices[0].message.tool_calls).toBeDefined();
      expect(result.choices[0].finish_reason).toBe('tool_calls');
    });

    it('returns text when no tool trigger', async () => {
      const result = await submitChatCompletion({
        model: 'test',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function', function: { name: 'test', description: '', parameters: {} } }],
      });
      expect(result.choices[0].message.tool_calls).toBeUndefined();
      expect(result.choices[0].finish_reason).toBe('stop');
    });
  });

  describe('resetStubCounter', () => {
    it('resets the counter', async () => {
      const r1 = await submitChatCompletion({
        model: 'test',
        messages: [{ role: 'user', content: 'a' }],
      });
      resetStubCounter();
      const r2 = await submitChatCompletion({
        model: 'test',
        messages: [{ role: 'user', content: 'b' }],
      });
      // After reset, IDs should be based on counter=1 again
      expect(r1.id.split('-')[2]).toBe(r2.id.split('-')[2]);
    });
  });

  describe('getStubToolResult', () => {
    it('returns canned results', () => {
      const result = getStubToolResult('search_models');
      expect(result).toBeTruthy();
      expect(JSON.parse(result!).items).toBeDefined();
    });

    it('returns undefined for unknown tool', () => {
      expect(getStubToolResult('unknown')).toBeUndefined();
    });
  });
});
