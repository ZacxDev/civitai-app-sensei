import { describe, it, expect } from 'vitest';
import { claimMessageWrite, ownsMessageWrite } from './write-ownership.js';

/**
 * Unit cover for the ownership primitive behind clawgate #425.
 *
 * The behavioural weight is carried by `src/App.unmount-turn.e2e.test.tsx`,
 * which drives a real unmount → remount → stranded-turn settle. This file pins
 * the primitive's own contract so a change to it fails HERE, with a small
 * message, rather than only as a confusing e2e failure three layers up.
 *
 * 🔴 SESSION IDS ARE DISTINCT PER TEST ON PURPOSE. The map is module state and
 * persists across tests in this file; reusing an id would make one test's
 * ticket numbers depend on another's execution order.
 */
describe('message-write ownership', () => {
  it('a fresh session issues ticket 1, and the claimant owns it', () => {
    const ticket = claimMessageWrite('s-fresh');
    expect(ticket).toBe(1);
    expect(ownsMessageWrite('s-fresh', ticket)).toBe(true);
  });

  it('🔴 a later claim SUPERSEDES the earlier one — the mechanism the fix rests on', () => {
    const stranded = claimMessageWrite('s-supersede');
    const newer = claimMessageWrite('s-supersede');

    expect(newer).not.toBe(stranded);
    expect(ownsMessageWrite('s-supersede', stranded)).toBe(false);
    expect(ownsMessageWrite('s-supersede', newer)).toBe(true);
  });

  it('🔴 ownership is PER SESSION — a claim on one must not demote another', () => {
    // Without this, one map for all sessions would let a send in session B
    // silently strand an in-flight turn in session A.
    const a = claimMessageWrite('s-A');
    const b = claimMessageWrite('s-B');
    claimMessageWrite('s-B');

    expect(ownsMessageWrite('s-A', a)).toBe(true);
    expect(ownsMessageWrite('s-B', b)).toBe(false);
  });

  it('an unknown session owns nothing, and a forged ticket is refused', () => {
    // A never-claimed key must not read as owned by an arbitrary number —
    // otherwise a write could slip through on a session nobody claimed.
    expect(ownsMessageWrite('s-never-claimed', 1)).toBe(false);
    const real = claimMessageWrite('s-forged');
    expect(ownsMessageWrite('s-forged', real + 1)).toBe(false);
    expect(ownsMessageWrite('s-forged', real - 1)).toBe(false);
  });
});

/**
 * The CLAIM-BEFORE-FIRST-WRITE ordering, pinned as source text.
 *
 * `App.tsx` states "CLAIM THIS SESSION'S MESSAGE KEY BEFORE THE FIRST WRITE OF
 * THE TURN". That ordering is the correct defensive choice — a claim taken after
 * the user-message persist leaves a window in which a stranded turn's write can
 * still land as the owner — but nothing enforced it: moving the claim below that
 * `await` left the whole suite green.
 *
 * 🔴 A SOURCE-TEXT GUARD, WITH THE LIMITS THAT IMPLIES. It cannot prove the
 * dataflow; it pins the one thing a behavioural test could not see, in the same
 * spirit as `App.abort-scope.test.ts`. It is expected to fail on a legitimate
 * refactor of `handleSend`'s opening, and updating it is a deliberate act.
 */
describe('claim ordering in handleSend', () => {
  it('🔴 the claim precedes the turn\'s first storage write', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

    const claimAt = src.indexOf('const myWrite = claimMessageWrite(activeSessionId);');
    const firstWriteAt = src.indexOf("await persist('save your message'");

    expect(claimAt, 'the claim must exist').toBeGreaterThan(-1);
    expect(firstWriteAt, "the turn's first write must exist").toBeGreaterThan(-1);
    expect(
      claimAt,
      'the ticket must be claimed BEFORE the first write of the turn: a claim taken ' +
        'after it leaves a window where a turn stranded by an unmount is still the ' +
        'owner and its later write is accepted.',
    ).toBeLessThan(firstWriteAt);
  });
});
