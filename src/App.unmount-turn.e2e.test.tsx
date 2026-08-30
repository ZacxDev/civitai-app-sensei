import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage } from './test-helpers.js';
import { POLL_INTERVAL_MS } from './lib/orchestrator-bridge.js';

/**
 * 🔴 UNMOUNT DURING A TURN — clawgate #425.
 *
 * Nothing aborts an in-flight turn when the component unmounts, so a turn
 * stranded by an unmount keeps polling and eventually WRITES. The decision on
 * that card is that it SHOULD write — the Buzz was spent at submit, and
 * discarding the reply is the same harm class the withhold and Stop paths were
 * fixed for. What must not happen is that it writes a STALE array.
 *
 * 🔴 WHY `turnSeqRef` CANNOT SEE THIS, which is the whole reason the card
 * existed. `turnSeqRef` is a `useRef`: it belongs to one component instance. A
 * remounted instance gets a fresh one at 0, so the stranded turn still evaluates
 * `turnSeqRef.current === mine` as TRUE and believes it owns state that a newer
 * instance now owns. The ownership check is structurally blind across an
 * unmount, and no abort predicate can see it either — the stranded turn was
 * never aborted.
 *
 * 🔴 HOW THE ORDERING IS MADE DETERMINISTIC RATHER THAN A RACE. `poll` is keyed
 * by `workflowId`, and a workflow settles ONLY once this test puts it in
 * `settling`. So turn 2 is held in flight for the whole test while turn 1 — the
 * stranded one — is released last. Without that, "turn 1 settled after turn 2"
 * would be a timing accident, and a green run would not mean the guard works.
 */

// ONE storage instance across both mounts. That is the point: the remounted
// component must load what the first one wrote, exactly as the real block does.
const storage = fakeAppStorage();

let submitCount = 0;
const submitFn = vi.fn(async () => {
  submitCount += 1;
  return { workflowId: `wf-${submitCount}`, status: 'pending' };
});

/** workflowId → the released reply. Absent means "still pending, forever". */
const settling = new Map<string, string>();
/**
 * workflowIds that settle as FAILED — the turn's OTHER exit.
 *
 * 🔴 THE ERROR EXIT NEEDS ITS OWN COVERAGE, and for a turn stranded by an
 * unmount it is at least as likely as the success one. A stranded workflow can
 * end `failed` / `expired` / `canceled`, be withheld, or simply outlive the
 * bridge's poll deadline — all of which land in `handleSend`'s `catch`, which
 * carries its own ownership gate on a DIFFERENT line from the success path's.
 * Without this arm a mutant deleting that second gate survives the whole suite.
 */
const failing = new Set<string>();
const pollFn = vi.fn(async (workflowId: string) => {
  if (failing.has(workflowId)) return { workflowId, status: 'failed' };
  const released = settling.get(workflowId);
  if (released !== undefined) return { workflowId, status: 'succeeded', textOutputs: [released] };
  return { workflowId, status: 'pending' };
});

/**
 * 🔴 HOISTED, NOT INLINE — the same trap `stop-stream.e2e.test.tsx` documents.
 * `useBuzzWorkflow` runs on every render; a fresh `vi.fn()` identity per render
 * changes the `useMemo` dep, rebuilds the adapter and discards the
 * `lastWorkflowId` it closes over.
 */
const estimateFn = vi
  .fn()
  .mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } });
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
  // 🔴 THE PREFIX IS `sensei:messages:`. A wrong prefix makes this return []
  // forever, so the test would pass for a reason unrelated to the persist.
  return storage.sets.filter((s) => s.key.startsWith('sensei:messages:'));
}

/** Wait past enough poll ticks for a released workflow to be observed. */
async function letPollsRun(ticks = 3) {
  const step = 50;
  for (let waited = 0; waited < POLL_INTERVAL_MS * ticks; waited += step) {
    await new Promise((r) => setTimeout(r, step));
  }
}

beforeEach(() => {
  storage.store.clear();
  storage.sets.length = 0;
  settling.clear();
  failing.clear();
  submitCount = 0;
  submitFn.mockClear();
  pollFn.mockClear();
  cancelFn.mockClear();
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify({ tools: [] }), { status: 200 }),
  ) as unknown as typeof globalThis.fetch;
});

describe('a turn stranded by unmount', () => {
  it('🔴 must not clobber a message written after it — REGRESSION, red before the fix', async () => {
    const first = render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'FIRST question' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(1));

    // The block is torn down mid-turn. Nothing aborts; `wf-1` keeps polling.
    first.unmount();

    // A FRESH instance against the same storage — a new `turnSeqRef` at 0, which
    // is precisely why the in-component ownership check cannot help here.
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'SECOND question' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(2));

    // Only NOW release the stranded turn. Turn 2 (`wf-2`) is never released, so
    // turn 1 is guaranteed to be the last writer — the exact ordering that makes
    // the clobber happen in production, reproduced without a race.
    settling.set('wf-1', 'the reply turn 1 paid for');
    await letPollsRun();

    // 🔴 THE INVARIANT. Once a write contains a user message, no later write may
    // omit it. Pre-fix the stranded turn writes `[FIRST, assistant]`, built
    // before "SECOND question" existed — and the viewer's message is gone from
    // storage permanently.
    const writes = messageWrites().map((s) => s.value as Array<{ role: string; content: string }>);
    const seen = new Set<string>();
    for (const [i, arr] of writes.entries()) {
      const users = new Set(arr.filter((m) => m.role === 'user').map((m) => m.content));
      for (const previously of seen) {
        expect(users.has(previously), `write ${i} dropped an earlier user message: ${previously}`).toBe(
          true,
        );
      }
      for (const u of users) seen.add(u);
    }

    // Positive control — without it the loop above is vacuous on a history that
    // never got two user messages into storage at all.
    expect(seen.has('FIRST question'), 'turn 1 never persisted its user message').toBe(true);
    expect(seen.has('SECOND question'), 'turn 2 never persisted its user message').toBe(true);

    // And what a reload would load must still carry the newer message.
    const committed = messageWrites().at(-1)!.value as Array<{ role: string; content: string }>;
    expect(committed.some((m) => m.content === 'SECOND question')).toBe(true);
  });

  it('still persists its reply when nothing supersedes it — INVARIANT GUARD, green before the fix', async () => {
    // 🔴 LABELLED HONESTLY: this does NOT go red on pre-change code, because
    // pre-change nothing stops the write. It is not regression coverage for
    // #425 — it is the guard on the DECISION. It fails if the fix is
    // implemented as abort-on-unmount, or if the ownership gate is written too
    // strictly and starts dropping writes nobody superseded. That is the
    // failure mode the fix itself could introduce, so it is worth pinning.
    const only = render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'paid for this' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(1));

    // Clear the send path's own write, so the assertion below can only be
    // satisfied by a write the STRANDED turn made after unmounting.
    storage.sets.length = 0;

    only.unmount();
    settling.set('wf-1', 'the answer the viewer paid for');
    await letPollsRun();

    const writes = messageWrites();
    expect(writes.length, 'the stranded turn wrote nothing — its Buzz bought nothing').toBeGreaterThan(
      0,
    );
    const written = writes.at(-1)!.value as Array<{ role: string; content: string }>;
    expect(written.some((m) => m.role === 'user' && m.content === 'paid for this')).toBe(true);
    expect(
      written.some((m) => m.role === 'assistant' && m.content === 'the answer the viewer paid for'),
      'the reply the viewer was charged for must reach storage',
    ).toBe(true);
  });
});

/**
 * 🔴 THE OTHER EXIT. `handleSend` has TWO deferred writes behind TWO separate
 * ownership gates: the success path's, and the one in the `catch` that handles
 * an error or a withhold. They are different lines, and a mutation deleting the
 * catch-path gate survived the entire suite while the success path stayed
 * covered — half the fix shipping untested.
 *
 * For a turn stranded by an unmount the error exit is at least as likely as the
 * success one: the workflow can end `failed` / `expired` / `canceled`, be
 * withheld, or outlive the bridge's poll deadline. All land here.
 */
describe('a turn stranded by unmount that ends in ERROR', () => {
  it('🔴 must not clobber a newer message from the CATCH path either', async () => {
    const first = render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'FIRST question' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(1));

    first.unmount();

    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'SECOND question' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(2));

    // The stranded turn FAILS rather than succeeding — the bridge throws, and
    // `handleSend` lands in its `catch`. `aborted()` is false there (nothing
    // stopped this turn), so the ownership gate is the only thing standing
    // between it and a write of `[FIRST, "Error: …"]` that deletes "SECOND".
    failing.add('wf-1');
    await letPollsRun();

    const writes = messageWrites().map((s) => s.value as Array<{ role: string; content: string }>);
    const seen = new Set<string>();
    for (const [i, arr] of writes.entries()) {
      const users = new Set(arr.filter((m) => m.role === 'user').map((m) => m.content));
      for (const previously of seen) {
        expect(users.has(previously), `write ${i} dropped an earlier user message: ${previously}`).toBe(
          true,
        );
      }
      for (const u of users) seen.add(u);
    }

    expect(seen.has('FIRST question'), 'turn 1 never persisted its user message').toBe(true);
    expect(seen.has('SECOND question'), 'turn 2 never persisted its user message').toBe(true);

    const committed = messageWrites().at(-1)!.value as Array<{ role: string; content: string }>;
    expect(committed.some((m) => m.content === 'SECOND question')).toBe(true);
  });
});
