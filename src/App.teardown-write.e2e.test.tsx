import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage } from './test-helpers.js';
import { POLL_INTERVAL_MS } from './lib/orchestrator-bridge.js';

/**
 * 🔴 A TURN THAT SETTLES AFTER THE ENVIRONMENT IS GONE — rank 7.
 *
 * The symptom this pins is `npx vitest run` exiting **rc=1 while every test
 * PASSES**: an unhandled `ReferenceError: window is not defined` thrown out of
 * React's `dispatchSetState`, from `handleSend`'s post-await continuation.
 *
 * 🔴 WHY IT IS A REAL DEFECT AND NOT A TEST ARTIFACT. Nothing aborts an
 * in-flight turn on unmount (that is #425's DECIDED invariant — the Buzz was
 * spent, so the reply must still be persisted). So a stranded turn keeps
 * polling and eventually runs its continuation against a component that is
 * gone. In the suite the jsdom environment is torn down underneath it and the
 * state write throws; in a browser the same write lands on a dead instance.
 * Either way a React state write is being attempted after unmount.
 *
 * 🔴 WHY THIS IS FORCED RATHER THAN WAITED FOR. The organic flake is ~4% — the
 * published "20 consecutive clean runs" gate has only ~56% power against it, so
 * a fix that changes NOTHING passes it more often than not. This drives the
 * exact teardown deterministically instead: strand a turn, remove the global
 * the way vitest's environment teardown does, then release the turn.
 *
 * 🔴 THE ORDERING IS REAL, NOT INVENTED. `test-setup.ts` runs `cleanup()` in
 * `afterEach`, so the component is ALREADY unmounted by the time vitest tears
 * the environment down after the file. Unmount-then-teardown is the production
 * order of events, which is why a mounted guard is the fix.
 */

const storage = fakeAppStorage();

let submitCount = 0;
const submitFn = vi.fn(async () => {
  submitCount += 1;
  return { workflowId: `wf-${submitCount}`, status: 'pending' };
});

/** workflowId → released reply. Absent means "pending, forever". */
const settling = new Map<string, string>();
const pollFn = vi.fn(async (workflowId: string) => {
  const released = settling.get(workflowId);
  if (released !== undefined) return { workflowId, status: 'succeeded', textOutputs: [released] };
  return { workflowId, status: 'pending' };
});

// Hoisted, not inline — a fresh identity per render rebuilds the adapter and
// discards the `lastWorkflowId` it closes over.
const estimateFn = vi
  .fn()
  .mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } });
const cancelFn = vi.fn(async () => undefined);

vi.mock('@civitai/blocks-react', () => ({
  useAppStorage: () => storage.appStorage,
  useBlockAnalytics: () => ({ track: vi.fn() }),
  useBlockContext: () => ({ ready: true, viewer: { id: 1 }, theme: 'dark' }),
  useBlockResize: () => {},
  // 🔴 FAIL-CLOSED SFW, WHICH IS WHAT A GREEN/BLUE-DOMAIN VIEWER REALLY GETS —
  // and also what the hook returns before BLOCK_INIT lands. So every case in this
  // file runs with NSFW mode hidden and the SFW arm on the wire, which is the
  // production default. The real policy math is tested against the SDK's own
  // `isLevelAllowed`/`effectiveBrowsingCeiling` in `lib/maturity.test.ts`, and the
  // component gate (including the red-domain-but-viewer-opted-out case) in
  // `components/SettingsBar.test.tsx`. Do not read this literal as the contract.
  useDomainMaturity: () => ({ isSfw: true, isLevelAllowed: () => false }),
  useRequestConsent: () => ({ requestConsent: vi.fn() }),
  useRequestSignIn: () => ({ requestSignIn: vi.fn() }),
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

async function letPollsRun(ticks = 3) {
  const step = 50;
  for (let waited = 0; waited < POLL_INTERVAL_MS * ticks; waited += step) {
    await new Promise((r) => setTimeout(r, step));
  }
}

function messageWrites() {
  return storage.sets.filter((s) => s.key.startsWith('sensei:messages:'));
}

/**
 * Capture rejections that reach the process with no handler — the exact shape
 * vitest reports as `Errors 1 error` while every test still passes.
 */
let rejections: unknown[] = [];
const onRejection = (reason: unknown) => rejections.push(reason);

beforeEach(() => {
  storage.store.clear();
  storage.sets.length = 0;
  settling.clear();
  submitCount = 0;
  submitFn.mockClear();
  pollFn.mockClear();
  rejections = [];
  process.on('unhandledRejection', onRejection);
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify({ tools: [] }), { status: 200 }),
  ) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  process.off('unhandledRejection', onRejection);
});

/**
 * Remove `window` the way the environment teardown does, run `fn`, then put it
 * back no matter what. A bare `window` reference with the global ABSENT is a
 * ReferenceError, which is the reported signature.
 */
async function withoutWindow(fn: () => Promise<void>) {
  // 🔴 DRAIN REACT'S SCHEDULER BEFORE THE GLOBAL DISAPPEARS, OR THIS FIXTURE
  // MANUFACTURES THE VERY DEFECT IT EXISTS TO CATCH.
  //
  // React schedules work through `setImmediate` (`performWorkUntilDeadline` in
  // scheduler.development.js), and `unmount()` leaves a callback queued. If
  // `window` is removed while one is still pending, that callback runs without
  // it and throws an UNCAUGHT `ReferenceError: window is not defined` — from
  // the SCHEDULER, with no frame in `src/`, which is indistinguishable in the
  // runner's output from the production defect this file pins.
  //
  // MEASURED, and this is why the drain is here rather than assumed: without
  // it, 1 of 24 consecutive full-suite runs at `988d133` exited rc=1 with all
  // 643 tests passing and one unhandled error attributed to this file — the
  // exact `rc=1`-with-everything-green signature rank 7 was fixing. A test that
  // re-creates the flake it guards against is worse than no test.
  //
  // Two ticks, not one: the first lets a queued callback run, the second lets
  // anything it queued in turn drain before the global goes.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const real = Object.getOwnPropertyDescriptor(globalThis, 'window');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).window;
  try {
    await fn();
  } finally {
    if (real) Object.defineProperty(globalThis, 'window', real);
    // Symmetric drain: let anything queued while the global was absent run now
    // that it is back, rather than after the test has returned.
    await new Promise((r) => setImmediate(r));
  }
}

describe('a turn settling after the environment is torn down', () => {
  it('🔴 must not attempt a React state write once unmounted — REGRESSION, red before the fix', async () => {
    const first = render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'a stranded question' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(1));

    // Torn down mid-turn. Nothing aborts it — that is #425's decision.
    first.unmount();

    // Only now does the turn settle, and it settles into a world with no
    // `window`. Pre-fix the continuation's `setMessages` reaches React's
    // `dispatchSetState`, which reads `window` and throws.
    await withoutWindow(async () => {
      settling.set('wf-1', 'the reply the viewer paid for');
      await letPollsRun();
    });

    // Let the rejection reach the process, exactly as it does in a real run.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const windowErrors = rejections.filter((r) =>
      /window is not defined|Cannot read properties of undefined \(reading 'event'\)/.test(
        r instanceof Error ? r.message : String(r),
      ),
    );
    // 🔴 THE STACK IS IN THE MESSAGE ON PURPOSE, not debug residue. The message
    // alone is the same string for every unguarded write, so it cannot tell you
    // WHICH one fired — and the site is the whole diagnosis. Naming it is what
    // showed the thrower here was `setStorageError` inside `persist`, not the
    // `setMessages` continuation the audit had named; a fix aimed at the latter
    // alone leaves this test red.
    expect(
      windowErrors,
      `the stranded turn attempted a state write after unmount: ${windowErrors
        .map((e) => (e instanceof Error ? `${e.message}\n${e.stack}` : String(e)))
        .join(' | ')}`,
    ).toHaveLength(0);
  });

  it('still persists its reply after unmount — INVARIANT GUARD, green before the fix', async () => {
    // 🔴 LABELLED HONESTLY: green pre-change. This is NOT regression coverage —
    // it is the guard on #425's DECISION, and it is what stops the rank-7 fix
    // being implemented as abort-on-unmount or as a mounted guard drawn so wide
    // that it swallows the PERSISTENCE too. A reply the viewer was charged for
    // must still reach storage from a stranded turn.
    const only = render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'paid for this' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(1));

    only.unmount();

    settling.set('wf-1', 'THE PAID REPLY');
    await letPollsRun();

    const committed = messageWrites().at(-1)?.value as
      | Array<{ role: string; content: string }>
      | undefined;
    expect(committed, 'the stranded turn never persisted at all').toBeTruthy();
    expect(
      committed!.some((m) => m.content === 'THE PAID REPLY'),
      'the stranded turn dropped the reply the viewer paid for',
    ).toBe(true);
  });
});
