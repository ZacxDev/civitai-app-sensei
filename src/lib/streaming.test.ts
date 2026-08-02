import { describe, it, expect } from 'vitest';
import { simulateStreaming } from './streaming.js';

describe('simulateStreaming', () => {
  it('calls onChunk with incremental words', async () => {
    const chunks: string[] = [];
    await simulateStreaming('hello world', (c) => chunks.push(c), 0);
    expect(chunks).toEqual(['hello ', 'world ']);
  });

  it('resolves after all words sent', async () => {
    const chunks: string[] = [];
    await simulateStreaming('a b c', (c) => chunks.push(c), 0);
    expect(chunks).toHaveLength(3);
  });

  it('handles empty text', async () => {
    const chunks: string[] = [];
    await simulateStreaming('', (c) => chunks.push(c), 0);
    expect(chunks).toHaveLength(0);
  });

  it('handles single word', async () => {
    const chunks: string[] = [];
    await simulateStreaming('hello', (c) => chunks.push(c), 0);
    expect(chunks).toEqual(['hello ']);
  });
});
