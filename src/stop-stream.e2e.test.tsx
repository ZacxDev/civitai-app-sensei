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
/** Never settles. See the header — this is what makes the pre-change failure structural. */
const pollFn = vi.fn(() => new Promise<never>(() => {}));
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
