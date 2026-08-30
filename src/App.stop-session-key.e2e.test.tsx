import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage } from './test-helpers.js';

/**
 * 🔴 REGRESSION: STOP WROTE THE TRANSCRIPT UNDER THE SESSION BEING *VIEWED*,
 * NOT THE SESSION THE IN-FLIGHT TURN BELONGS TO. (clawgate #427.)
 *
 * `isStreaming` is instance-wide, not per session, and nothing disables the
 * session switcher while a turn is in flight — so the session active at Stop is
 * NOT necessarily the session the streaming turn claimed. `handleStopStream`
 * keyed its write on `activeSessionId` and took its array from `messagesRef`,
 * which mirrors whatever the viewer is looking at. Both are the wrong side of
 * that gap.
 *
 * THE REPRO, and it is the one on the card:
 *   1. in session S1, send a question — the turn goes in flight;
 *   2. click "+ New" — you are now in S2, and the Stop button survives the
 *      switch because `isStreaming` is instance-wide;
 *   3. press Stop.
 *
 * TWO HARMS, BOTH SILENT, and the test asserts BOTH SIDES because a fix that
 * captures the wrong id makes the write land nowhere — passing a one-sided
 * "S2 was not corrupted" assertion while losing the transcript entirely:
 *   - S1 gets nothing. The partial reply the viewer was CHARGED for is never
 *     persisted for the conversation it belongs to, which is the entire stated
 *     purpose of Stop's write.
 *   - S2 is corrupted. A brand-new empty chat silently acquires another
 *     conversation's question, visible on the next reload.
 *
 * 🔴 MEASURED AT `462b7a2` BEFORE THE FIX, and the outcome is the FIRST harm,
 * not the second: `messagesRef.current` has already been reset to `[]` by the
 * switch (`createSession` calls `setMessages([])`), so the
 * `current.length > 0` guard refuses and Stop writes NOTHING AT ALL. S1 loses
 * the transcript; S2 escapes corruption only by accident of that guard. The
 * card predicted S2 would be written — that half is not reproducible on this
 * revision, and the assertion below is written to fail on EITHER outcome
 * rather than on the predicted one.
 *
 * 🔴 `poll` NEVER SETTLES, WHICH IS WHAT MAKES THIS ISOLATING. With no tick
 * there is no rejection and no `catch`, so the only write that can land after
 * Stop is Stop's own. A write appearing under S1 therefore cannot be the
 * completion path arriving late.
 */

const storage = fakeAppStorage();

/**
 * 🔴 HOISTED, NOT INLINE — `useBuzzWorkflow` runs on every render and a fresh
 * `vi.fn()` identity per render changes the `useMemo` dep, rebuilds the
 * orchestrator adapter and discards the `lastWorkflowId` it closes over. Same
 * trap `stop-stream.e2e.test.tsx` documents; it cost a real debugging cycle
 * there.
 */
const estimateFn = vi
  .fn()
  .mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } });
const submitFn = vi.fn(async () => ({ workflowId: 'wf-1', status: 'pending' }));
const pollFn = vi.fn(() => new Promise<never>(() => {}));
const cancelFn = vi.fn(async () => undefined);

vi.mock('@civitai/blocks-react', () => ({
  useAppStorage: () => storage.appStorage,
  useBlockAnalytics: () => ({ track: vi.fn() }),
  useBlockContext: () => ({ ready: true, viewer: { id: 1 }, theme: 'dark' }),
  useBlockResize: () => {},
  useRequestConsent: () => ({ requestConsent: vi.fn() }),
  useRequestSignIn: () => ({ requestSignIn: vi.fn() }),
  // The host's native resource picker. A no-op stub (the viewer dismisses without
  // picking) for every suite that is not ABOUT mentions — see
  // `mention-grounding.e2e.test.tsx` for the driven one.
  useResourcePicker: () => ({ open: vi.fn().mockResolvedValue(null) }),
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

const QUESTION = 'what is DreamShaper';

/** Every message write, whatever session it targeted. */
function messageWrites() {
  // 🔴 THE PREFIX IS `sensei:messages:`, NOT `messages:`. A wrong prefix makes
  // this return [] forever and the test would pass or fail for a reason with
  // nothing to do with the persist it exists to pin.
  return storage.sets.filter((s) => s.key.startsWith('sensei:messages:'));
}

/** The writes that targeted one specific session's key. */
function writesFor(sessionId: string) {
  return storage.sets.filter((s) => s.key === `sensei:messages:${sessionId}`);
}

/** The session list as last persisted — the app's own record of the ids. */
function sessionIds(): string[] {
  const last = storage.sets.filter((s) => s.key === 'sensei:sessions').at(-1);
  const value = last?.value as { sessions?: Array<{ id: string }> } | undefined;
  return (value?.sessions ?? []).map((s) => s.id);
}

describe('Stop after a mid-stream session switch (clawgate #427)', () => {
  beforeEach(() => {
    storage.store.clear();
    storage.sets.length = 0;
    submitFn.mockClear();
    pollFn.mockClear();
    cancelFn.mockClear();
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ tools: [] }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
  });

  it("🔴 writes the transcript under the STREAMING turn's session, and does not touch the one merely being viewed", async () => {
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());

    // ── S1, and a turn in flight inside it ──────────────────────────────────
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
    const s1 = sessionIds()[0];
    expect(s1, 'the first session was never persisted, so the test has no key to assert on')
      .toBeTruthy();

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: QUESTION } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(1));

    // ── The switch. Nothing disables the switcher mid-stream — that is the
    // premise of the whole defect, so it is asserted rather than assumed.
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(sessionIds().length).toBe(2));
    const s2 = sessionIds().find((id) => id !== s1)!;
    expect(s2, 'the second session was never created — the switcher may now be disabled').toBeTruthy();

    // 🔴 POSITIVE CONTROL ON THE SWITCH ITSELF. Without it, a run in which the
    // click did nothing would satisfy every assertion below trivially: S1 would
    // be written because S1 was never left. The viewer must genuinely be looking
    // at the empty S2 — the question is gone from the TRANSCRIPT.
    //
    // 🔴 SCOPED TO `messages-container`, NOT `document.body`. The send path
    // auto-titles S1 from its first user message, so the question is still on
    // screen as a SIDEBAR TITLE after a perfectly correct switch — a body-wide
    // check fails on working code and reads as "the switch did not happen".
    // Measured while writing this test.
    await waitFor(() =>
      expect(
        screen.getByTestId('messages-container').textContent ?? '',
        'the view never left S1, so this test is not exercising the defect',
      ).not.toContain(QUESTION),
    );

    // 🔴 AND THE STOP BUTTON MUST HAVE SURVIVED THE SWITCH. `isStreaming` is
    // instance-wide; if that ever changes this test stops reaching the path and
    // must be reconsidered rather than silently passing.
    const stop = await screen.findByTestId('stop-button');

    // Only writes caused by Stop are of interest. The send path's own write to
    // S1 already happened, and counting it would let the assertion below pass on
    // the pre-change code for a reason that has nothing to do with Stop.
    storage.sets.length = 0;

    fireEvent.click(stop);

    // Bounded settle. Exits early the moment a write lands, so a pass is fast
    // and only a genuine absence costs the full wait.
    for (let waited = 0; waited < 1500 && messageWrites().length === 0; waited += 50) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // 🔴 SIDE ONE — the transcript reaches the session it belongs to. The Buzz
    // was spent at submit; Stop stops the rendering, not the billing.
    const s1Writes = writesFor(s1);
    expect(
      s1Writes.length,
      "Stop wrote nothing under S1 — the session the in-flight turn belongs to. The viewer " +
        'was charged for that turn and its transcript is gone.',
    ).toBeGreaterThan(0);
    const written = s1Writes.at(-1)!.value as Array<{ role: string; content: string }>;
    expect(
      written.some((m) => m.role === 'user' && m.content === QUESTION),
      "S1's write does not contain the question that turn was sent with",
    ).toBe(true);
    // The assistant turn is present too — an empty reply is still the record of
    // a charge, which is exactly what used to vanish.
    expect(written.some((m) => m.role === 'assistant')).toBe(true);

    // 🔴 SIDE TWO — the session merely being VIEWED is not written. A brand-new
    // empty chat must not silently acquire another conversation's question.
    expect(
      writesFor(s2).map((s) => s.value),
      "Stop wrote under S2 — the session the viewer had switched to, not the one the " +
        'streaming turn belongs to. A new empty chat has acquired another conversation.',
    ).toHaveLength(0);

    // And the stream really was stopped, not merely persisted.
    expect(cancelFn).toHaveBeenCalled();
  });
});
