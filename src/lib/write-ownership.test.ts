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
