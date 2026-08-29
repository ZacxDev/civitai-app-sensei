import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 🔴 A SOURCE-TEXT GUARD, DELIBERATELY — because the hazard IS the spelling.
 *
 * Four consecutive rounds fixed an abort exit and each fix created the next one.
 * The root cause was never the individual guard: it was that every guard asked a
 * MUTABLE REF (`abortControllerRef.current`) "are we aborted?" instead of asking
 * the turn it belonged to. A second send replaces that ref, so an in-flight turn
 * reads the NEW turn's controller and every check answers false.
 *
 * `handleSend` now captures `const controller` once and exposes `aborted()`,
 * which closes over it. The behavioural consequence is pinned by
 * `stop-stream.e2e.test.tsx` ("a second send while the first turn is still in
 * flight"). What THAT test cannot pin is the next guard someone adds: a new
 * `if (abortControllerRef.current?.signal.aborted)` inside `handleSend` would
 * reintroduce the class and no behavioural test would fail until someone
 * reproduced the exact two-turn interleaving again.
 *
 * So this asserts the STRUCTURE: `abortControllerRef` is legal in exactly three
 * places — its declaration, the single write in `handleSend`, and the abort in
 * `handleStopStream`, which SHOULD act on whatever turn is current. Any fourth
 * occurrence in code is the defect returning.
 *
 * 🔴 THIS TEST IS EXPECTED TO FAIL ON A LEGITIMATE REFACTOR, and that is the
 * trade. It fails loudly with an instruction rather than silently permitting the
 * regression; updating it is a deliberate act, which is the property the four
 * previous rounds lacked.
 */

const source = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8');

/** Strip comments so a mention in prose is not counted as a read. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

describe('abort scope — guards must read the turn, not the ref', () => {
  it('🔴 positive control: the stripper leaves real code and removes prose', () => {
    // Without this, a stripper bug that deleted everything would make every
    // assertion below pass vacuously.
    const stripped = codeOnly(source);
    expect(stripped).toContain('const controller = new AbortController();');
    expect(stripped).toContain('abortControllerRef.current = controller;');
    // A line that exists ONLY inside a comment must not survive.
    expect(source).toContain('write 4: [u:"FIRST"');
    expect(stripped).not.toContain('write 4: [u:"FIRST"');
  });

  it('🔴 abortControllerRef appears in code exactly three times', () => {
    const occurrences = codeOnly(source).match(/abortControllerRef/g) ?? [];
    expect(
      occurrences.length,
      'A fourth `abortControllerRef` in code means a guard is reading the mutable ref ' +
        'again instead of this turn\'s captured controller. Use `aborted()` inside ' +
        '`handleSend`. If you genuinely need a fourth, update this test deliberately ' +
        'and say why in the commit.',
    ).toBe(3);
  });

  it('🔴 handleSend contains no abort read through the ref', () => {
    const stripped = codeOnly(source);
    const start = stripped.indexOf('const controller = new AbortController();');
    const end = stripped.indexOf('const handleStopStream');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const turnBody = stripped.slice(start, end);

    // The one legal occurrence in this span is the write itself.
    const reads = (turnBody.match(/abortControllerRef/g) ?? []).length;
    expect(reads, 'handleSend must read `aborted()`, never `abortControllerRef`').toBe(1);
    expect(turnBody).not.toMatch(/abortControllerRef\.current\?\.signal/);
  });

  it('handleStopStream still acts on the current turn', () => {
    const stripped = codeOnly(source);
    const stop = stripped.slice(stripped.indexOf('const handleStopStream'));
    // Stop SHOULD use the ref: it aborts whichever turn is in flight now.
    expect(stop).toContain('abortControllerRef.current?.abort()');
  });
});
