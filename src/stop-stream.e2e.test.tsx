import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage } from './test-helpers.js';
import { POLL_INTERVAL_MS } from './lib/orchestrator-bridge.js';

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
let pollMode: 'never' | 'pending' | 'queue' = 'never';
/**
 * Snapshots for `'queue'` mode — the tool-calling shape.
 *
 * 🔴 WITHOUT THIS THE WHOLE SUITE WAS BLIND TO THE TOOL PATH. Every test here
 * stubbed `GET /tools` to `{tools: []}`, so the app took the degraded no-tools
 * branch and the tool loop never ran even once. The abort exit INSIDE that loop
 * was therefore unreachable by any test in the file written to guard Stop.
 */
let toolPollQueue: Array<Record<string, unknown>> = [];
const pollFn = vi.fn(() => {
  if (pollMode === 'never') return new Promise<never>(() => {});
  if (pollMode === 'queue') {
    const next = toolPollQueue.shift();
    return Promise.resolve(next ?? { workflowId: 'wf-1', status: 'pending' });
  }
  return Promise.resolve({ workflowId: 'wf-1', status: 'pending' });
});
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
    // 🔴 DERIVED, NOT MIRRORED. This was a hardcoded `2_500` with a comment
    // explaining it as 2.5 poll intervals — a mirror of a module-private
    // constant that nothing tied it to. Raising the interval would have left
    // this window too short to see the overwrite, and the test would have gone
    // green for the wrong reason: it fails OPEN.
    const BOUND_MS = POLL_INTERVAL_MS * 2.5;
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

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE THIRD EXIT: Stop DURING A TOOL POST.
//
// The two describes above cover Stop on the never-settling shape and Stop on
// the ordinary abort path — both of which leave the send through the CATCH.
// They cannot see this one, and not by accident: every test above stubs
// `GET /tools` to `{tools: []}`, so the app takes the degraded no-tools branch
// and the tool loop never runs. The abort exit inside that loop was unreachable
// by the entire suite written to guard Stop.
//
// `callTool` never throws on abort — it converts the AbortError into a tool
// error STRING — so this path leaves the loop by `break` and falls out of the
// try normally, never touching the catch. It then reached
// `persist('save the reply', …)` and overwrote the transcript Stop had just
// written, losing every earlier round's prose from storage.
// ─────────────────────────────────────────────────────────────────────────────
describe('Stop DURING a tool call must not overwrite its own write', () => {
  let releaseToolPost: (() => void) | null = null;

  beforeEach(() => {
    pollMode = 'queue';
    releaseToolPost = null;
    storage.sets.length = 0;
    submitFn.mockClear();
    pollFn.mockClear();
    cancelFn.mockClear();
    toolPollQueue = [
      // Round 1: the model asks for a tool and writes prose alongside it.
      {
        workflowId: 'wf-tc',
        status: 'succeeded',
        cost: { total: 1 },
        textOutputs: ['Round one prose.'],
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'search_models', arguments: JSON.stringify({ query: 'dream' }) },
          },
        ],
      },
      // Never reached once Stop lands — present so a REGRESSION (the loop
      // continuing past the abort) has something to resubmit into, which is
      // what makes the "one submit" assertion below isolating.
      { workflowId: 'wf-t', status: 'succeeded', cost: { total: 1 }, textOutputs: ['Round two.'] },
    ];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/api/v1/blocks/tools')) {
        if (method === 'GET') {
          return new Response(
            JSON.stringify({
              tools: [
                {
                  type: 'function',
                  function: {
                    name: 'search_models',
                    description: 'Search the Civitai model catalog',
                    parameters: { type: 'object', properties: { query: { type: 'string' } } },
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        // HELD IN FLIGHT until the test releases it — this is the window in
        // which Stop is pressed, and the whole point of the fixture.
        return new Promise<Response>((resolve) => {
          releaseToolPost = () =>
            resolve(
              new Response(JSON.stringify({ items: [{ id: 1, name: 'X' }], truncated: 0 }), {
                status: 200,
              }),
            );
        });
      }
      return new Response(JSON.stringify({ items: [], metadata: {} }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
  });

  it('🔴 keeps Stop’s transcript when the abort lands during a tool POST', async () => {
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'tell me about DreamShaper' },
    });
    fireEvent.click(screen.getByTestId('send-button'));

    // Wait until the tool POST is actually in flight. Without this the Stop
    // could land before the loop is reached and the test would pass on the
    // pre-change code — a fixture that cannot reach the path proves nothing.
    await waitFor(() => expect(releaseToolPost).not.toBeNull(), { timeout: 5000 });

    // Only writes caused by Stop or by what follows it are of interest.
    storage.sets.length = 0;

    fireEvent.click(await screen.findByTestId('stop-button'));
    await waitFor(() => expect(messageWrites().length).toBeGreaterThan(0), { timeout: 3000 });
    const afterStop = JSON.stringify(messageWrites().at(-1)!.value);

    // Now let the held POST resolve. Pre-fix this is where the loop `break`s on
    // the abort and falls through to the reply persist.
    releaseToolPost!();

    const BOUND_MS = POLL_INTERVAL_MS * 2.5;
    const step = 50;
    for (let waited = 0; waited < BOUND_MS && messageWrites().length < 2; waited += step) {
      await new Promise((r) => setTimeout(r, step));
    }

    // 🔴 ISOLATING: exactly one write, and the stored array is byte-identical to
    // what Stop wrote. Pre-fix a second write landed and replaced it.
    expect(messageWrites()).toHaveLength(1);
    expect(JSON.stringify(messageWrites().at(-1)!.value)).toBe(afterStop);

    // And the loop really did stop: no second submit for a turn the viewer
    // abandoned. Had the abort exit been missing, the queued round-two snapshot
    // above would have been submitted and billed.
    expect(submitFn).toHaveBeenCalledTimes(1);
  });
});

/**
 * 🔴 REGRESSION: the abort guards read a MUTABLE REF, not the turn they belong to.
 *
 * `abortControllerRef.current` is replaced by every send. `handleStopStream`
 * clears `isStreaming` synchronously, so a viewer can send again immediately —
 * and that second send installs a FRESH, UN-ABORTED controller. Turn 1, still in
 * flight, then asked turn 2's controller "are we aborted?" and every guard
 * answered false. Measured before the fix:
 *
 *   write 2: [u:"FIRST",  a:""]                  ← Stop's own transcript
 *   write 3: [u:"FIRST",  a:"", u:"SECOND"]      ← turn 2's send
 *   write 4: [u:"FIRST",  a:"Error: Aborted"]    ← turn 1's catch, guard bypassed
 *
 * Turn 2's user message is gone. This is why four consecutive rounds of abort
 * fixes did not catch it: EVERY existing test runs a single turn, so the ref and
 * the turn are the same object and the bug is unreachable by construction.
 *
 * 🔴 THE ASSERTION IS A MONOTONICITY INVARIANT, not a final-state check. In some
 * orderings turn 2's own completion later restores the array, so a final-state
 * assertion passes over the defect; the loss is only permanent when turn 1
 * settles last. What is always true, and is what the viewer actually loses, is
 * that no write may DROP a message an earlier write already contained.
 */
describe('a second send while the first turn is still in flight', () => {
  beforeEach(() => {
    pollMode = 'pending';
    storage.sets.length = 0;
    submitFn.mockClear();
    pollFn.mockClear();
    cancelFn.mockClear();
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ tools: [] }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
  });

  it("🔴 turn 1's abort exit must not clobber turn 2 — no write may drop a message an earlier one had", async () => {
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'FIRST question' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(1));

    // Stop turn 1 — then send turn 2 immediately, which is the ordinary thing a
    // viewer does and the thing that swaps the ref out from under turn 1.
    fireEvent.click(await screen.findByTestId('stop-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'SECOND question' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(2));

    // Let turn 1's abort reach its catch. The bridge only observes the abort at
    // the top of its next poll tick, so the window is real and bounded by the
    // poll interval — derived, not hand-copied.
    const BOUND_MS = POLL_INTERVAL_MS * 2.5;
    const step = 50;
    for (let waited = 0; waited < BOUND_MS; waited += step) {
      await new Promise((r) => setTimeout(r, step));
    }

    // 🔴 THE INVARIANT. Once a write contains a user message, no later write may
    // omit it. Pre-fix, write 4 dropped "SECOND question" — the viewer's message
    // vanished from storage because turn 1 wrote a transcript built before it
    // existed.
    const writes = messageWrites().map(
      (s) => s.value as Array<{ role: string; content: string }>,
    );
    expect(writes.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const [i, arr] of writes.entries()) {
      const users = new Set(arr.filter((m) => m.role === 'user').map((m) => m.content));
      for (const previously of seen) {
        expect(
          users.has(previously),
          `write ${i} dropped an earlier user message: ${previously}`,
        ).toBe(true);
      }
      for (const u of users) seen.add(u);
    }

    // Positive control: this test is only meaningful if BOTH turns actually got
    // as far as being persisted. Without it the loop above is vacuous on an
    // empty or single-message history.
    expect(seen.has('FIRST question')).toBe(true);
    expect(seen.has('SECOND question')).toBe(true);
  });
});

/**
 * 🔴 REGRESSION: Stop was a no-op against the DECLARATIONS GET, and a submit was
 * billed after it.
 *
 * `fetchToolDeclarations` was called with no caller signal, so Stop could not
 * reach it; and even once the signal was threaded, the `catch` that degrades a
 * failed fetch to `[]` swallows an AbortError identically to a 500 — so the turn
 * continued and issued a BILLED submit for a turn the viewer had abandoned. The
 * catch guard then suppressed the write, leaving a charge with no record.
 *
 * Passing the signal ends the REQUEST; the abort check after it ends the TURN.
 * Both are needed, which is why this asserts on `submitFn`, not on storage.
 */
describe('Stop during the tool-declarations fetch', () => {
  beforeEach(() => {
    pollMode = 'pending';
    storage.sets.length = 0;
    submitFn.mockClear();
    pollFn.mockClear();
    cancelFn.mockClear();
  });

  it('🔴 must not bill a submit for a turn abandoned before the declarations landed', async () => {
    let releaseDeclarations: (() => void) | null = null;
    let fetchAborted = false;
    globalThis.fetch = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          releaseDeclarations = () =>
            resolve(new Response(JSON.stringify({ tools: [] }), { status: 200 }));
          // Honour the signal the way a real fetch does, so this fixture cannot
          // pass merely because it ignores aborts.
          init?.signal?.addEventListener('abort', () => {
            fetchAborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    ) as unknown as typeof globalThis.fetch;

    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'a question' } });
    fireEvent.click(screen.getByTestId('send-button'));

    // Parked in the declarations GET: nothing has been submitted yet.
    await waitFor(() => expect(releaseDeclarations).not.toBeNull());
    expect(submitFn).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByTestId('stop-button'));

    // 🔴 STOP MUST REACH THE REQUEST ITSELF, not merely the turn around it.
    // Asserting only on billing is satisfied by the post-fetch abort check
    // alone, so a mutant that drops the `signal` from `fetchToolDeclarations`
    // survives — measured. Without the signal the GET runs to its own 15 s
    // deadline (45 s if it 429s), holding the turn "in flight" with Stop
    // already pressed. This is the assertion that pins the signal.
    await waitFor(() => expect(fetchAborted).toBe(true), { timeout: 2000 });

    // Release it anyway — a real fetch that ignored the abort must still not
    // resume the turn. Pre-fix this is where it resumed and billed.
    releaseDeclarations!();
    for (let waited = 0; waited < 1000; waited += 50) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(submitFn).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 REGRESSION: the turn's `finally` wrote SHARED state without checking whether
 * the turn still owned it.
 *
 * `setIsStreaming(false)` / `streamingRef.current = false` ran unconditionally,
 * so a SUPERSEDED turn settling late switched them off underneath the turn that
 * owned them. Measured, an ordinary Stop → send → send with no second Stop:
 *
 *   1. turn 1's `finally` lands ~1 poll after turn 2 begins
 *   2. turn 2's Stop button disappears; `onChunk`'s `!streamingRef.current`
 *      guard then drops turn 2's chunks
 *   3. the reopened send gate accepts a THIRD send
 *   4. turn 2 settles last and persists an array built before turn 3 existed:
 *      ["user:FIRST","assistant:","user:SECOND","assistant:TWO reply"]
 *
 * `THIRD question` and its BILLED reply are gone permanently.
 *
 * 🔴 NO ABORT PREDICATE CAN SEE THIS, which is why the previous round's
 * "fixed structurally" claim was too broad. Turns 2 and 3 involve no Stop at all;
 * the question is OWNERSHIP, not abortion. `turnSeqRef` answers it and
 * `App.abort-scope.test.ts` deliberately says nothing about it.
 */
describe('a superseded turn must not clear the shared streaming state', () => {
  beforeEach(() => {
    pollMode = 'pending';
    storage.sets.length = 0;
    submitFn.mockClear();
    pollFn.mockClear();
    cancelFn.mockClear();
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ tools: [] }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
  });

  it("🔴 turn 1 settling late must not switch off turn 2's stream", async () => {
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'FIRST question' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByTestId('stop-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'SECOND question' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(2));

    // Turn 2 is in flight, so its Stop button must be on screen. Positive
    // control: without this the assertion after the wait could pass on a render
    // that never had one.
    expect(screen.queryByTestId('stop-button')).not.toBeNull();

    // Let turn 1's abort reach its catch and run its `finally`. The bridge only
    // observes the abort at the top of its next poll tick, so the window is real
    // and bounded by the poll interval — imported, not hand-copied.
    const BOUND_MS = POLL_INTERVAL_MS * 2.5;
    for (let waited = 0; waited < BOUND_MS; waited += 50) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // 🔴 THE INVARIANT. Turn 1 has finished; turn 2 has not. Pre-fix, turn 1's
    // `finally` cleared the shared state and this button was gone.
    expect(
      screen.queryByTestId('stop-button'),
      "turn 1's finally cleared isStreaming while turn 2 was still in flight",
    ).not.toBeNull();

    // 🔴 AND THE CONSEQUENCE THAT COSTS A MESSAGE: the send gate stays shut.
    // Pre-fix it reopened, the send control came back while turn 2 was still
    // streaming, and a third send was accepted whose reply turn 2 then overwrote
    // out of existence.
    //
    // Asserted as the ABSENCE of the send control rather than by clicking it:
    // while a turn is live the composer renders Stop in its place, so a click
    // would throw on the missing element instead of measuring the gate. The
    // absence is the same fact and it is the one that is observable in both
    // arms — pre-fix this query returns an element.
    expect(
      screen.queryByTestId('send-button'),
      'the send gate reopened while turn 2 was still streaming',
    ).toBeNull();
  });
});

/**
 * 🔴 THE POST-LOOP ABORT GUARD, REACHED BY A SECOND TURN.
 *
 * An audit walk placed a wrong-turn read at the post-loop guard ONLY and it
 * survived the entire suite: the two-turn test above uses the `{tools: []}`
 * fixture, so it exits through the `catch` and never reaches that line, while
 * every test that DOES reach it runs a single turn — where the ref and the turn
 * are the same object and the defect is unreachable by construction.
 *
 * This is the seam: turn 1 inside the tool loop while turn 2 runs.
 */
describe('the post-loop abort guard, with a second turn in flight', () => {
  let releaseToolPost: (() => void) | null = null;

  beforeEach(() => {
    pollMode = 'queue';
    releaseToolPost = null;
    storage.sets.length = 0;
    submitFn.mockClear();
    pollFn.mockClear();
    cancelFn.mockClear();
    toolPollQueue = [
      {
        workflowId: 'wf-tc',
        status: 'succeeded',
        cost: { total: 1 },
        textOutputs: ['Round one prose.'],
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'search_models', arguments: JSON.stringify({ query: 'dream' }) },
          },
        ],
      },
      { workflowId: 'wf-t', status: 'succeeded', cost: { total: 1 }, textOutputs: ['Turn two.'] },
      { workflowId: 'wf-t', status: 'succeeded', cost: { total: 1 }, textOutputs: ['Turn two.'] },
    ];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/api/v1/blocks/tools')) {
        if (method === 'GET') {
          return new Response(
            JSON.stringify({
              tools: [
                {
                  type: 'function',
                  function: {
                    name: 'search_models',
                    description: 'Search the Civitai model catalog',
                    parameters: { type: 'object', properties: { query: { type: 'string' } } },
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Promise<Response>((resolve) => {
          releaseToolPost = () =>
            resolve(
              new Response(JSON.stringify({ items: [{ id: 1, name: 'X' }], truncated: 0 }), {
                status: 200,
              }),
            );
        });
      }
      return new Response(JSON.stringify({ items: [], metadata: {} }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
  });

  it('🔴 turn 1 leaving the tool loop must not clobber turn 2', async () => {
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'FIRST question' } });
    fireEvent.click(screen.getByTestId('send-button'));

    // Turn 1 must actually be inside the tool loop — the whole point of the
    // fixture. A Stop landing before it gets there proves nothing.
    await waitFor(() => expect(releaseToolPost).not.toBeNull(), { timeout: 5000 });

    fireEvent.click(await screen.findByTestId('stop-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    // Turn 2, while turn 1 is still parked in its tool POST.
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'SECOND question' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(submitFn.mock.calls.length).toBeGreaterThanOrEqual(2));

    // Now release turn 1's POST so it leaves the loop and reaches the post-loop
    // guard — the line the audit's walk survived at.
    releaseToolPost!();

    const BOUND_MS = POLL_INTERVAL_MS * 2.5;
    for (let waited = 0; waited < BOUND_MS; waited += 50) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // 🔴 MONOTONICITY, not final state: in some orderings turn 2 restores the
    // array, so a final-state check passes over the defect. What the viewer
    // actually loses is a message an earlier write already had.
    const writes = messageWrites().map((s) => s.value as Array<{ role: string; content: string }>);
    const seen = new Set<string>();
    for (const [i, arr] of writes.entries()) {
      const users = new Set(arr.filter((m) => m.role === 'user').map((m) => m.content));
      for (const previously of seen) {
        expect(users.has(previously), `write ${i} dropped an earlier user message: ${previously}`)
          .toBe(true);
      }
      for (const u of users) seen.add(u);
    }
    expect(seen.has('FIRST question')).toBe(true);
    expect(seen.has('SECOND question')).toBe(true);
  });
});

/**
 * 🔴 `onChunk`'s `!streamingRef.current` guard is the only thing stopping a
 * stopped turn's chunks from rendering, and disabling it survived the whole
 * suite.
 *
 * The bridge replays released text through `simulateStreaming` at ~20 ms/word
 * and does NOT observe the abort signal while doing so (pre-existing on trunk,
 * unchanged here — it is a rendering concern, not the persist bug). So after
 * Stop the chunks keep arriving; what must not happen is that they keep landing
 * in the transcript the viewer is looking at.
 *
 * 🔴 THE ASSERTION MOVED FROM "DID NOT GROW" TO "IS EXACTLY THE STORED REPLY",
 * AND IT IS STRICTLY STRONGER RATHER THAN RELAXED. Stop now SETTLES the bubble
 * on the reply that is already durably stored instead of freezing it mid-word —
 * see {@link StreamingTurn.persistedReply}: freezing left React `messages`
 * holding an abandoned partial that the next send re-serialised over the
 * complete stored reply, which cost a production viewer 743 of 953 characters
 * they had paid for.
 *
 * The old form (`not.toContain('word59')`) is unavailable against a settled
 * bubble — the settled text legitimately contains every word — but it was only
 * ever a proxy for "no chunk landed after Stop", and equality tests that
 * directly: `onChunk` APPENDS, so a chunk landing after the settle can only
 * produce `<reply> word34 word35 …`, which is not equal to `<reply>`. Deleting
 * the `!streamingRef.current` guard is therefore still caught, and now so is a
 * settle that puts the WRONG text on screen — a case the old form could not see
 * at all.
 */
describe('a stopped turn must stop RENDERING, not just stop billing', () => {
  beforeEach(() => {
    pollMode = 'queue';
    storage.sets.length = 0;
    submitFn.mockClear();
    pollFn.mockClear();
    cancelFn.mockClear();
    // 60 words ≈ 1.2 s of replay, so Stop lands mid-stream with margin.
    toolPollQueue = [
      {
        workflowId: 'wf-1',
        status: 'succeeded',
        cost: { total: 1 },
        textOutputs: [Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')],
      },
    ];
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ tools: [] }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
  });

  it('🔴 chunks arriving after Stop do not extend the transcript', async () => {
    const REPLY = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'a question' } });
    fireEvent.click(screen.getByTestId('send-button'));

    // Wait until the replay has actually started, so Stop lands MID-stream.
    const bubble = () => document.body.textContent ?? '';
    await waitFor(() => expect(bubble()).toContain('word0'), { timeout: 5000 });

    // 🔴 THE POSITIVE CONTROL IS NOW READ BEFORE THE CLICK, NOT AFTER IT. Stop
    // settles the bubble synchronously, so a sample taken afterwards can no
    // longer answer "was the replay still running when Stop landed" — it would
    // report the settled text in BOTH arms and the control would be vacuous.
    const beforeStop = bubble();
    fireEvent.click(await screen.findByTestId('stop-button'));
    await new Promise((r) => setTimeout(r, 100));

    // Let the rest of the replay run to COMPLETION. `simulateStreaming` is not
    // abortable, so the chunks DO keep coming — only the guard stops them
    // landing.
    //
    // 🔴 THE WAIT MUST OUTLAST THE WHOLE REPLAY OR THE TEST CANNOT DISCRIMINATE.
    // A first version waited 700 ms against a 60-word × 20 ms ≈ 1.2 s replay, so
    // `word59` had not been emitted yet in EITHER arm — the mutant survived and
    // the test passed for the same reason the real code does. Derived from the
    // fixture rather than guessed: 60 words × 20 ms, doubled for jsdom timer
    // slop.
    await new Promise((r) => setTimeout(r, 60 * 20 * 2));

    // 🔴 POSITIVE CONTROL: the replay must genuinely have been incomplete when
    // Stop landed, or every assertion below is trivially true of a stream that
    // had already finished on its own.
    expect(beforeStop, 'Stop landed after the replay had already finished').not.toContain('word59');

    // 🔴 ISOLATING: the bubble is EXACTLY the stored reply. `onChunk` appends,
    // so any chunk that reached the transcript after Stop shows up here as a
    // duplicated tail (`…word59 word34 word35 …`) and this equality fails.
    const content = screen.getAllByTestId('message-content').at(-1)!.textContent ?? '';
    expect(content.trim(), 'a stopped turn did not settle on its stored reply').toBe(REPLY);
    // 🔴 THE BUDGET IS EXPLICIT BECAUSE THIS TEST'S OWN SLEEPS EAT HALF THE
    // DEFAULT, AND THE SHORTFALL IS SILENT. vitest's default is 5 s; the waits
    // above are a fixed 100 ms + 60 × 20 × 2 = 2,400 ms, so ~2.5 s is spent
    // before boot, session creation and the replay reaching `word0` get any of
    // it. Measured in CI: 2,544 ms on the run that passed, 5,009 ms on the run
    // that did NOT — one test doubling while its siblings moved ~4%, which is
    // the signature of a thin budget rather than a loaded runner.
    //
    // 🔴 AND THE `{ timeout: 5000 }` ON THE `word0` waitFor ABOVE WAS
    // STRUCTURALLY UNREACHABLE: the per-test budget was also 5 s, so the test
    // died before that waitFor could ever spend its own allowance. Raising the
    // per-test budget is what makes that inner timeout mean anything.
    //
    // Deliberately NOT fixed by shortening the 2,400 ms wait: the comment above
    // derives it from the fixture (60 words × 20 ms, doubled for jsdom slop),
    // and a shorter wait is exactly the version that let the mutant survive.
    // Nothing here is weakened — only the clock is widened.
  }, 30_000);
});
