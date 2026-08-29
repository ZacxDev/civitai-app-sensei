import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage } from './test-helpers.js';

/**
 * 🔴 REGRESSION TEST FOR: a stopped stream spent Buzz and persisted NOTHING.
 *
 * Measured on the live store before the fix — after a two-exchange
 * verification the stored array was `[user, assistant, user]`, three elements.
 * The second reply was not written incompletely; it was never written AT ALL.
 *
 * The cause was that `handleStopStream` aborted and cancelled but did not
 * persist: saving depended entirely on the completion promise settling into the
 * try or the catch, and a viewer who stops a reply and reloads promptly beats
 * it. The Buzz was already spent — stopping the stream stops the RENDERING, not
 * the billing — so the viewer paid and had nothing, with no record of why.
 *
 * 🔴 HOW THIS TEST IS MADE TO FAIL ON PRE-CHANGE CODE, WHICH IS THE POINT.
 * `poll` returns a promise that NEVER resolves. The bridge's abort check runs at
 * the top of each poll iteration, so with no tick there is no rejection, no
 * catch, and therefore — before the fix — no write of any kind after Stop.
 * Anything this asserts about a persisted array is then unreachable.
 *
 * A `waitFor` alone would not distinguish "wrote late" from "never wrote"; the
 * never-resolving poll is what makes the absence structural rather than a race.
 */

// ONE storage instance for the whole render, so the test can read what was
// written. The shared block mock builds a fresh `fakeAppStorage()` per call,
// which records into an object nobody can see.
const storage = fakeAppStorage();

/**
 * 🔴 HOISTED, NOT INLINE. `useBuzzWorkflow` is called on every render, and an
 * inline `vi.fn()` here is a NEW function identity each time — which changes
 * the `useMemo` dep in `App`, rebuilds the orchestrator adapter, and silently
 * discards the `lastWorkflowId` it closes over. `cancel()` then no-ops. That
 * cost a real debugging cycle: the symptom looked like Stop failing to cancel.
 */
const estimateFn = vi.fn().mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } });

const submitFn = vi.fn(async () => ({ workflowId: 'wf-1', status: 'pending' }));
/**
 * Two poll shapes, selected per test.
 *
 * `'never'` never settles — that is what made the ORIGINAL regression failure
 * structural (no tick, no rejection, no catch, so pre-change there was no write
 * of any kind after Stop).
 *
 * 🔴 BUT IT ALSO REMOVED THE PATH THAT MATTERS IN PRODUCTION. With no catch,
 * the never-settling shape cannot see the catch OVERWRITING Stop's write —
 * which is exactly what happened on the ordinary abort path. `'pending'` keeps
 * resolving so the bridge loops, observes the abort, and throws into the catch:
 * the real shape. Both are covered now.
 */
let pollMode: 'never' | 'pending' = 'never';
const pollFn = vi.fn(() =>
  pollMode === 'never'
    ? new Promise<never>(() => {})
    : Promise.resolve({ workflowId: 'wf-1', status: 'pending' }),
);
const cancelFn = vi.fn(async () => undefined);

vi.mock('@civitai/blocks-react', () => ({
  useAppStorage: () => storage.appStorage,
  useBlockAnalytics: () => ({ track: vi.fn() }),
  useBlockContext: () => ({ ready: true, viewer: { id: 1 }, theme: 'dark' }),
  useBlockResize: () => {},
  useRequestConsent: () => ({ requestConsent: vi.fn() }),
  useRequestSignIn: () => ({ requestSignIn: vi.fn() }),
  useBlockToken: () => ({ raw: 'block-jwt-test', scopes: ['ai:write:budgeted', 'buzz:read:self'] }),
  useBuzzBalance: () => ({ balance: { blue: 100, green: 0, yellow: 200 } }),
  useBuzzWorkflow: () => ({
    estimate: estimateFn,
    submit: submitFn,
    poll: pollFn,
    cancel: cancelFn,
    status: 'idle',
    result: null,
    error: null,
  }),
}));

function messageWrites() {
  // 🔴 THE PREFIX IS `sensei:messages:`, NOT `messages:`. A wrong prefix here
  // makes this helper return [] forever, so the test fails (or passes) for a
  // reason that has nothing to do with the persist it is written to pin.
  return storage.sets.filter((s) => s.key.startsWith('sensei:messages:'));
}

describe('stopping a stream persists what was already spent', () => {
  beforeEach(() => {
    pollMode = 'never';
    storage.sets.length = 0;
    submitFn.mockClear();
    pollFn.mockClear();
    cancelFn.mockClear();
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ tools: [] }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
  });

  it('🔴 writes the conversation when the viewer presses Stop mid-stream', async () => {
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'tell me about DreamShaper' },
    });
    fireEvent.click(screen.getByTestId('send-button'));

    // In flight: submitted, and polling a promise that will never settle.
    await waitFor(() => expect(submitFn).toHaveBeenCalled());

    // The user turn is saved by the send path itself. Clear so the assertion
    // below can only be satisfied by a write that STOP caused — otherwise this
    // would pass on the pre-change code purely because sending saves.
    storage.sets.length = 0;

    const stop = await screen.findByTestId('stop-button');
    fireEvent.click(stop);

    // The write must happen because Stop happened. Pre-change there is no path
    // to one: the poll never ticks, so the abort never rejects.
    await waitFor(() => expect(messageWrites().length).toBeGreaterThan(0), { timeout: 3000 });

    const written = messageWrites().at(-1)!.value as Array<{ role: string; content: string }>;
    expect(written.some((m) => m.role === 'user' && m.content === 'tell me about DreamShaper')).toBe(
      true,
    );
    // The assistant turn is present too — an empty reply is still the record of
    // a charge, which is exactly what used to vanish.
    expect(written.some((m) => m.role === 'assistant')).toBe(true);

    // And the stream really was stopped, not merely persisted.
    expect(cancelFn).toHaveBeenCalled();
  });
});

describe('the ORDINARY abort path — the catch must not undo Stop', () => {
  beforeEach(() => {
    // The real shape: the poll keeps resolving, so the bridge's own abort check
    // fires and REJECTS into `handleSend`'s catch.
    pollMode = 'pending';
    storage.sets.length = 0;
    submitFn.mockClear();
    pollFn.mockClear();
    cancelFn.mockClear();
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ tools: [] }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
  });

  it("🔴 Stop's write SURVIVES — the catch does not overwrite it with 'Error: Aborted'", async () => {
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'tell me about DreamShaper' },
    });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(submitFn).toHaveBeenCalled());

    storage.sets.length = 0;
    const stop = await screen.findByTestId('stop-button');
    fireEvent.click(stop);

    await waitFor(() => expect(messageWrites().length).toBeGreaterThan(0), { timeout: 3000 });

    // 🔴 SETTLE BEFORE ASSERTING — A `waitFor` CANNOT PIN A NEGATIVE, AND A
    // SHORT "no change" WINDOW CANNOT EITHER.
    //
    // The regression is a SECOND write landing AFTER the first. Two shapes were
    // measured to pass on broken code before this one worked:
    //   1. `waitFor` around the assertion — satisfied by the EARLY state, it
    //      returns before the overwrite arrives.
    //   2. a settle loop exiting after ~100 ms of no change — the overwrite
    //      does not arrive for a full POLL INTERVAL, so it exits first.
    //
    // The bridge polls on a 1000 ms interval and observes the abort on its NEXT
    // iteration, so the catch's write lands ~1 s after Stop. The bound below is
    // derived from that, not picked: wait up to ~2.5 intervals, exiting EARLY
    // the moment a second write appears. So a regression fails fast and a pass
    // costs the full wait — the right way round.
    const BOUND_MS = 2_500;
    const step = 50;
    for (let waited = 0; waited < BOUND_MS && messageWrites().length < 2; waited += step) {
      await new Promise((r) => setTimeout(r, step));
    }

    // 🔴 THE ISOLATING ASSERTION. Pre-fix, exactly two writes landed: Stop's
    // (`assistant:''`), then the catch's, which replaced the assistant content
    // with `Error: Aborted` — measured directly on the mutant. One write means
    // the catch returned early and Stop's record is what survives a reload.
    expect(messageWrites()).toHaveLength(1);
    const settled = messageWrites().at(-1)!.value as Array<{ role: string; content: string }>;
    for (const m of settled.filter((x) => x.role === 'assistant')) {
      expect(m.content).not.toContain('Error:');
      expect(m.content).not.toContain('Aborted');
    }

    // The user turn is still there — Stop must not cost the question either.
    const written = messageWrites().at(-1)!.value as Array<{ role: string; content: string }>;
    expect(written.some((m) => m.role === 'user' && m.content === 'tell me about DreamShaper')).toBe(
      true,
    );
  });
});
