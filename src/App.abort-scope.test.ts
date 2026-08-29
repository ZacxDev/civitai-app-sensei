import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A SOURCE-TEXT GUARD OVER `handleSend`'s ABORT PREDICATE.
 *
 * Four consecutive rounds fixed an abort exit and each fix created the next one.
 * The root cause was never the individual guard: every guard asked a MUTABLE REF
 * (`abortControllerRef.current`) "are we aborted?" instead of asking the turn it
 * belonged to. A second send replaces that ref, so an in-flight turn reads the
 * NEW turn's controller and every check answers false.
 *
 * 🔴 BE EXACT ABOUT WHAT THIS TEST CAN AND CANNOT DO — AN EARLIER VERSION OF
 * THIS DOCSTRING CLAIMED THE PROPERTY AND ENFORCED ONLY THE SPELLING, WHICH IS
 * THE DEFECT THIS FILE EXISTS TO PREVENT, ONE LEVEL UP.
 *
 * The property that matters is a DATAFLOW fact: every abort read in `handleSend`
 * resolves to THIS turn's controller. No source-text test can decide that — an
 * audit demonstrated two walks against the previous version:
 *
 *   1. a second ref (`latestControllerRef`) written beside the legal write and
 *      read by `aborted()` kept the occurrence count at three and passed every
 *      assertion here while fully reintroducing the hazard;
 *   2. a wrong-turn read placed at the post-loop guard ONLY survived the entire
 *      suite, because the two-turn behavioural test used the `{tools: []}`
 *      fixture and exited through the `catch` without ever reaching it.
 *
 * What this file DOES enforce, and it is narrower than "the property":
 *   - `aborted()` is defined by exactly the text that closes over the captured
 *     controller, so redefining it to read any other cell fails here (walk 1);
 *   - `handleSend` contains no second abort read of any kind, so a new guard
 *     must go through `aborted()`;
 *   - `abortControllerRef` stays confined to its declaration, the single write,
 *     and `handleStopStream`.
 *
 * 🔴 THE DATAFLOW WEIGHT IS CARRIED BY BEHAVIOUR, NOT BY THIS FILE:
 * `stop-stream.e2e.test.tsx` drives a second send while the first turn is still
 * in flight, on BOTH exits — the `catch` (no-tools fixture) and the post-loop
 * guard (tool fixture, walk 2). If those are deleted, this file is not a
 * substitute for them.
 *
 * 🔴 THIS TEST IS EXPECTED TO FAIL ON A LEGITIMATE REFACTOR, and that is the
 * trade: it fails loudly with an instruction rather than silently permitting the
 * regression. Updating it is a deliberate act.
 *
 * 🔴 IT DELIBERATELY SAYS NOTHING ABOUT TURN OWNERSHIP. `turnSeqRef` answers a
 * different question — "is my turn still the current one" — for the shared
 * `isStreaming` / `streamingRef` writes in the `finally`. A superseded turn that
 * was never aborted is invisible to every abort predicate, so that hazard is
 * pinned behaviourally (`stop-stream.e2e.test.tsx`, the three-turn case) and not
 * here. Counting `turnSeqRef` occurrences would only re-create the spelling
 * mistake on a second axis.
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

/** `handleSend`'s body: from the controller capture to the start of Stop. */
function turnBody(stripped: string): string {
  const start = stripped.indexOf('const controller = new AbortController();');
  const end = stripped.indexOf('const handleStopStream');
  expect(start, 'the controller capture must exist').toBeGreaterThan(-1);
  expect(end, 'handleStopStream must follow handleSend').toBeGreaterThan(start);
  return stripped.slice(start, end);
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

  it('🔴 `aborted()` closes over THIS turn\'s captured controller', () => {
    // Walk 1 from the audit: redefining `aborted` to read a second ref kept the
    // occurrence count at three and passed the old assertions. Pinning the whole
    // definition is what refuses that — the predicate may only be built from the
    // local `controller`.
    expect(
      codeOnly(source),
      '`aborted()` must be exactly `() => controller.signal.aborted`, closing over the ' +
        'controller captured by THIS turn. Reading any other cell — a second ref, a ' +
        'parameter, a closure from elsewhere — reintroduces the cross-turn defect while ' +
        'leaving every occurrence count unchanged.',
    ).toContain('const aborted = () => controller.signal.aborted;');
  });

  it('🔴 `aborted()` is the ONLY abort read in handleSend', () => {
    const body = turnBody(codeOnly(source));
    // One `.aborted` — the definition above. Any second read is a new guard
    // asking something other than this turn.
    const reads = (body.match(/\.aborted\b/g) ?? []).length;
    expect(
      reads,
      'handleSend must contain exactly one `.aborted` read: the definition of ' +
        '`aborted()`. A second one is a guard resolving somewhere else — call `aborted()`.',
    ).toBe(1);
    // `.signal` may legitimately be PASSED (to fetch, to the tool client); it may
    // not be interrogated.
    expect(body).not.toMatch(/abortControllerRef\.current\?\.signal/);
  });

  it('🔴 abortControllerRef appears in code exactly three times', () => {
    const occurrences = codeOnly(source).match(/abortControllerRef/g) ?? [];
    expect(
      occurrences.length,
      'A fourth `abortControllerRef` in code means a guard is reading the mutable ref ' +
        "again instead of this turn's captured controller. Use `aborted()` inside " +
        '`handleSend`. If you genuinely need a fourth, update this test deliberately ' +
        'and say why in the commit.',
    ).toBe(3);
  });

  it('🔴 handleSend holds no second AbortController cell', () => {
    // The other half of walk 1: the hazard needs somewhere to live. One
    // controller is constructed per turn and one ref holds it.
    const stripped = codeOnly(source);
    expect((stripped.match(/new AbortController\(\)/g) ?? []).length).toBe(1);
    expect(
      (stripped.match(/useRef<AbortController/g) ?? []).length,
      'a second AbortController ref is where a wrong-turn read hides',
    ).toBe(1);
  });

  it('handleStopStream still acts on the current turn', () => {
    const stripped = codeOnly(source);
    const stop = stripped.slice(stripped.indexOf('const handleStopStream'));
    // Stop SHOULD use the ref: it aborts whichever turn is in flight now.
    expect(stop).toContain('abortControllerRef.current?.abort()');
  });
});
