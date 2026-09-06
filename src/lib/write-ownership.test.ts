import { describe, it, expect } from 'vitest';
import {
  claimMessageWrite,
  ownsMessageWrite,
  serializeMessageWrite,
} from './write-ownership.js';

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
 * The ORDERING half of the fix (rank 33).
 *
 * The ticket decides WHETHER a write may be issued; this decides WHEN it runs.
 * On a last-writer-wins key the second question is what decides which array
 * survives, and the e2e that carries the behavioural weight is
 * `src/App.late-write-ordering.e2e.test.tsx`. These pin the primitive's own
 * contract so a change to it fails HERE, small, instead of three layers up.
 *
 * 🔴 SESSION IDS ARE DISTINCT PER TEST, same reason as above: the chain is
 * module state and outlives a test.
 */
describe('message-write ordering', () => {
  /** A write that finishes after `ms` and appends its label to `landed`. */
  const slowWrite = (landed: string[], label: string, ms: number) => () =>
    new Promise<void>((resolve) =>
      setTimeout(() => {
        landed.push(label);
        resolve();
      }, ms),
    );

  it('🔴 a write issued FIRST lands FIRST even when it is much slower', async () => {
    // This is the whole mechanism. Unordered, `slow` resolves last and — on a
    // last-writer-wins key — its array would be the one a reload reads, deleting
    // everything `fast` wrote in between.
    const landed: string[] = [];
    const first = serializeMessageWrite('o-order', slowWrite(landed, 'slow', 40));
    const second = serializeMessageWrite('o-order', slowWrite(landed, 'fast', 0));
    await Promise.all([first, second]);

    expect(landed).toEqual(['slow', 'fast']);
  });

  it('🔴 a REJECTED write must not wedge the queue behind it', async () => {
    // One failed write per page life is ordinary — the host rejects, `persist`
    // shows a banner. If the rejection stopped the chain, every later write on
    // that conversation would hang forever and the viewer would silently stop
    // being able to save anything at all.
    const landed: string[] = [];
    const failed = serializeMessageWrite('o-reject', async () => {
      throw new Error('kv rejected');
    });
    await expect(failed).rejects.toThrow('kv rejected');

    await serializeMessageWrite('o-reject', slowWrite(landed, 'after', 0));
    expect(landed).toEqual(['after']);
  });

  it("the caller receives its own write's value and its own rejection", async () => {
    // `persist` turns exactly these two into `saved` / `write-failed`, so a
    // wrapper that swallowed either would silently mis-record every turn.
    await expect(serializeMessageWrite('o-value', async () => 'ok')).resolves.toBe('ok');
    await expect(
      serializeMessageWrite('o-value', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('🔴 ordering is PER SESSION — one conversation must not queue behind another', async () => {
    // A shared chain would make a slow write in a conversation the viewer left
    // delay every write in the one they are actually using.
    const landed: string[] = [];
    const a = serializeMessageWrite('o-sess-A', slowWrite(landed, 'A', 40));
    const b = serializeMessageWrite('o-sess-B', slowWrite(landed, 'B', 0));
    await Promise.all([a, b]);

    expect(landed).toEqual(['B', 'A']);
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
