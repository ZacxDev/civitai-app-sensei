import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { UseAppStorage } from '@civitai/blocks-react';
import { App } from './App.js';
import { fakeAppStorage } from './test-helpers.js';
import { POLL_INTERVAL_MS } from './lib/orchestrator-bridge.js';

/**
 * 🔴 STOP + A SECOND SEND INSIDE TURN 1'S IN-FLIGHT WRITE — rank 33.
 *
 * MEASURED SYMPTOM. The viewer presses Stop and then asks a second question
 * while turn 1's reply write is still travelling. Turn 2 claims the write ticket
 * and stores its user message and its reply — and turn 1's write, authorised
 * before any of that existed, lands LAST. The stored array ends `[user,
 * assistant]`: the second question and its 849-character paid-for reply are gone
 * permanently.
 *
 * 🔴 WHY THE OWNERSHIP TICKET CANNOT SEE IT, which is the whole reason this file
 * exists beside `App.unmount-turn.e2e.test.tsx`. `ownsMessageWrite` is asked
 * BEFORE the write is issued. Turn 1 asked it while it still owned the key, so
 * its answer was correct — and an in-flight `set` cannot be revoked by a claim
 * taken afterwards. The ticket refuses writes ISSUED late; this defect is a
 * write issued in time and LANDING late.
 *
 * 🔴 AND THE REPLY-MONOTONICITY LEDGER CANNOT SEE IT EITHER: it watches for a
 * stored sequence that SHORTENS, and every write here grows. The losing write is
 * a two-element array that was never shorter than its own predecessor.
 *
 * 🔴 HOW THE INTERLEAVING IS MADE DETERMINISTIC RATHER THAN A RACE. `holdWrite`
 * arms the storage fake to hold the FIRST matching `set` open until the test
 * releases it, so "still in flight" is a state the test controls instead of a
 * window it hopes to hit. `settling` does the same for the workflows, exactly as
 * `App.unmount-turn.e2e.test.tsx` does.
 *
 * ⚠️ HONEST SCOPE — THE HELD WRITE IS ARTIFICIAL. This pins that the app is
 * CORRECT under that interleaving; it does NOT establish that a real storage
 * round trip on the deployed host is long enough for a viewer to press Stop and
 * send again inside it. That has not been measured. What IS measured is the
 * production outcome the interleaving produces, quoted above.
 */

const base = fakeAppStorage();

/**
 * The first `set` matching this predicate is held open until `release()`.
 *
 * 🔴 ONE MATCH ONLY, DISARMED ON FIRE. A predicate that keeps matching would
 * hold the SECOND turn's writes too, and the test would then be pinning a
 * deadlock rather than an ordering.
 */
let holdWhen: (key: string, value: unknown) => boolean = () => false;
let release: (() => void) | null = null;
let heldCount = 0;
/**
 * Whether the held write has COMMITTED.
 *
 * 🔴 THE CONTROL HAS TO WATCH THE WRITE ITSELF, NOT ITS TEXT. The first version
 * of this file asked whether the reply text had appeared in any committed write,
 * and on the catch path that is TRUE before the held write lands: `handleSend`
 * puts `Error: …` into React state first, so turn 2's own array carries the
 * string. The control fired on turn 2's write and reported an interleaving that
 * had in fact happened correctly. This flag is set inside the held call, so it
 * cannot be satisfied by anybody else's write.
 */
let heldCommitted = false;

const appStorage: UseAppStorage = {
  ...base.appStorage,
  async set<T = unknown>(key: string, value: T) {
    if (holdWhen(key, value)) {
      holdWhen = () => false;
      heldCount += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      const result = await base.appStorage.set(key, value);
      heldCommitted = true;
      return result;
    }
    return base.appStorage.set(key, value);
  },
};

let submitCount = 0;
const submitFn = vi.fn(async () => {
  submitCount += 1;
  return { workflowId: `wf-${submitCount}`, status: 'pending' };
});

/** workflowId → the released reply. Absent means "still pending, forever". */
const settling = new Map<string, string>();
/** workflowIds that settle as FAILED — the exit that lands in `handleSend`'s catch. */
const failing = new Set<string>();
const pollFn = vi.fn(async (workflowId: string) => {
  if (failing.has(workflowId)) return { workflowId, status: 'failed' };
  const released = settling.get(workflowId);
  if (released !== undefined) return { workflowId, status: 'succeeded', textOutputs: [released] };
  return { workflowId, status: 'pending' };
});

// Hoisted, not inline — a fresh identity per render rebuilds the orchestrator
// adapter and discards the `lastWorkflowId` it closes over, so `cancel()` no-ops.
const estimateFn = vi
  .fn()
  .mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } });
const cancelFn = vi.fn(async () => undefined);

vi.mock('@civitai/blocks-react', () => ({
  useAppStorage: () => appStorage,
  useBlockAnalytics: () => ({ track: vi.fn() }),
  useBlockContext: () => ({ ready: true, viewer: { id: 1 }, theme: 'dark' }),
  useBlockResize: () => {},
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

type StoredRow = { role: string; content: string };

/**
 * Every COMMITTED write of a message key, in the order it landed.
 *
 * 🔴 THE PREFIX IS `sensei:messages:`. A wrong prefix makes this return `[]`
 * forever, so every assertion below would be vacuous rather than wrong.
 */
function messageWrites(): StoredRow[][] {
  return base.sets
    .filter((s) => s.key.startsWith('sensei:messages:'))
    .map((s) => s.value as StoredRow[]);
}

function committedTexts(): string[] {
  return messageWrites().flat().map((m) => m.content);
}

/** Wait past enough poll ticks for a released workflow to be observed. */
async function letPollsRun(ticks = 3) {
  const step = 50;
  for (let waited = 0; waited < POLL_INTERVAL_MS * ticks; waited += step) {
    await new Promise((r) => setTimeout(r, step));
  }
}

/**
 * The invariant, applied across the whole write history.
 *
 * Once a write contains a user message, no LATER write may omit it — that is
 * exactly what "a user message was permanently deleted" means on a
 * last-writer-wins key, and it is the same shape `App.unmount-turn.e2e.test.tsx`
 * asserts for the unmount route.
 */
function expectNoUserMessageEverDropped(writes: StoredRow[][]) {
  const seen = new Set<string>();
  for (const [i, arr] of writes.entries()) {
    const users = new Set(arr.filter((m) => m.role === 'user').map((m) => m.content));
    for (const previously of seen) {
      expect(
        users.has(previously),
        `write ${i} dropped an earlier user message: ${previously}\n` +
          `full write log: ${JSON.stringify(writes.map((w) => w.map((m) => `${m.role}:${m.content.slice(0, 24)}`)))}`,
      ).toBe(true);
    }
    for (const u of users) seen.add(u);
  }
}

beforeEach(() => {
  base.store.clear();
  base.sets.length = 0;
  base.attempts.length = 0;
  settling.clear();
  failing.clear();
  submitCount = 0;
  heldCount = 0;
  heldCommitted = false;
  holdWhen = () => false;
  release = null;
  submitFn.mockClear();
  pollFn.mockClear();
  cancelFn.mockClear();
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify({ tools: [] }), { status: 200 }),
  ) as unknown as typeof globalThis.fetch;
});

/** Open a chat and send the first question, leaving turn 1 in flight. */
async function startFirstTurn() {
  render(<App />);
  await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
  fireEvent.click(screen.getByTestId('new-session-button'));
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'FIRST question' } });
  fireEvent.click(screen.getByTestId('send-button'));
  await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(1));
}

/** Press Stop, then ask the second question — both inside the held window. */
async function stopThenSendSecond() {
  fireEvent.click(await screen.findByTestId('stop-button'));
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'SECOND question' } });
  fireEvent.click(screen.getByTestId('send-button'));
}

describe("a write in flight across a Stop and the viewer's next send", () => {
  it(
    '🔴 must not clobber the second exchange — SUCCESS path, REGRESSION',
    async () => {
      await startFirstTurn();

      // Hold turn 1's REPLY write open. `REPLY ONE` appears in no other write,
      // so the predicate cannot latch onto the user-message write by accident.
      holdWhen = (key, value) =>
        key.startsWith('sensei:messages:') && JSON.stringify(value).includes('REPLY ONE');
      settling.set('wf-1', 'REPLY ONE');
      settling.set('wf-2', 'REPLY TWO');
      await waitFor(() => expect(heldCount).toBe(1), { timeout: 10_000 });

      await stopThenSendSecond();

      // Give the pre-fix code room to finish the WHOLE second exchange while
      // turn 1's write is still held — that ordering IS the defect. Post-fix
      // turn 2's writes are queued behind the held one and nothing happens here.
      await letPollsRun(3);

      // 🔴 POSITIVE CONTROL ON THE INSTRUMENT. If turn 1's write had already
      // landed, the Stop and the send did not happen inside its flight and this
      // whole test would be pinning an interleaving it never produced.
      expect(heldCount, 'the hold never fired — no write was in flight').toBe(1);
      expect(
        heldCommitted,
        "turn 1's reply write was NOT still in flight across the Stop and the send",
      ).toBe(false);
      expect(
        committedTexts().includes('REPLY ONE'),
        'turn 1\'s reply reached storage without the held write committing',
      ).toBe(false);
      expect(release, 'nothing is holding the write').not.toBeNull();

      // Only now does turn 1's write land.
      release!();

      // Post-fix this is where turn 2 actually runs; pre-fix it ran already.
      await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(2), { timeout: 10_000 });
      await waitFor(() => expect(heldCommitted).toBe(true), { timeout: 10_000 });
      await waitFor(() => expect(committedTexts()).toContain('REPLY TWO'), { timeout: 10_000 });
      await letPollsRun(2);

      const writes = messageWrites();
      expectNoUserMessageEverDropped(writes);

      // What a reload would read.
      const committed = writes.at(-1)!;
      expect(
        committed.some((m) => m.role === 'user' && m.content === 'SECOND question'),
        `the viewer's second question is gone from storage: ${JSON.stringify(committed)}`,
      ).toBe(true);
      expect(
        committed.some((m) => m.role === 'assistant' && m.content === 'REPLY TWO'),
        `the paid-for second reply is gone from storage: ${JSON.stringify(committed)}`,
      ).toBe(true);
      expect(
        committed.some((m) => m.role === 'user' && m.content === 'FIRST question'),
        'the first question is gone from storage',
      ).toBe(true);
    },
    30_000,
  );

  it(
    '🔴 must not clobber the second exchange — CATCH/withhold path, REGRESSION',
    async () => {
      // 🔴 THE OTHER EXIT, AND IT IS A DIFFERENT LINE. `handleSend` writes from
      // two places behind two separate ownership gates; the catch's write is
      // just as authorised, just as slow, and just as capable of landing last.
      // A fix applied to one exit is not a fix to the other, so both are driven.
      await startFirstTurn();

      holdWhen = (key, value) =>
        key.startsWith('sensei:messages:') && JSON.stringify(value).includes('Error:');
      settling.set('wf-2', 'REPLY TWO');
      failing.add('wf-1');
      await waitFor(() => expect(heldCount).toBe(1), { timeout: 10_000 });

      await stopThenSendSecond();
      await letPollsRun(3);

      expect(heldCount, 'the hold never fired — no write was in flight').toBe(1);
      expect(
        heldCommitted,
        "turn 1's error write was NOT still in flight across the Stop and the send",
      ).toBe(false);
      expect(release, 'nothing is holding the write').not.toBeNull();

      release!();

      await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(2), { timeout: 10_000 });
      await waitFor(() => expect(heldCommitted).toBe(true), { timeout: 10_000 });
      await waitFor(() => expect(committedTexts()).toContain('REPLY TWO'), { timeout: 10_000 });
      await letPollsRun(2);

      const writes = messageWrites();
      expectNoUserMessageEverDropped(writes);

      const committed = writes.at(-1)!;
      expect(
        committed.some((m) => m.role === 'user' && m.content === 'SECOND question'),
        `the viewer's second question is gone from storage: ${JSON.stringify(committed)}`,
      ).toBe(true);
      expect(
        committed.some((m) => m.role === 'assistant' && m.content === 'REPLY TWO'),
        `the paid-for second reply is gone from storage: ${JSON.stringify(committed)}`,
      ).toBe(true);
    },
    30_000,
  );

  it(
    "Stop must not blank a turn's stored ERROR text by rescuing over it — GUARD, green before the fix",
    async () => {
      // 🔴 THE CATCH PATH'S HALF OF THE DEFERRED RESCUE, AND IT NEEDS ITS OWN
      // CASE. `replyPersisted` is set only on the success path, so nothing else
      // in the suite stops Stop from writing its partial over a stored error or
      // withhold reason — and once writes are ordered, that partial lands AFTER
      // the error write every time. The reason the viewer was charged would be
      // replaced by an empty assistant bubble, durably.
      //
      // 🔴 LABELLED HONESTLY: measured GREEN on pre-change code, so it is not
      // regression coverage. Unordered, the artificially held error write lands
      // LAST in this fixture and happens to win the race. It is the guard on the
      // half of THIS change that ordering makes necessary — deleting
      // `turn.replyWrite = writing` from the catch path turns it red, and
      // nothing else in the suite notices.
      //
      // No second send here on purpose: this is about the two writes of ONE
      // turn, so the second exchange would only add noise.
      await startFirstTurn();

      holdWhen = (key, value) =>
        key.startsWith('sensei:messages:') && JSON.stringify(value).includes('Error:');
      failing.add('wf-1');
      await waitFor(() => expect(heldCount).toBe(1), { timeout: 10_000 });

      fireEvent.click(await screen.findByTestId('stop-button'));
      await letPollsRun(1);

      expect(heldCommitted, "turn 1's error write was not still in flight").toBe(false);
      release!();
      await waitFor(() => expect(heldCommitted).toBe(true), { timeout: 10_000 });
      await letPollsRun(2);

      const committed = messageWrites().at(-1)!;
      const assistant = committed.filter((m) => m.role === 'assistant');
      expect(assistant, 'the turn wrote no assistant row at all').toHaveLength(1);
      expect(
        assistant[0].content,
        `the stored reason the viewer was charged was overwritten: ${JSON.stringify(committed)}`,
      ).toMatch(/^Error:/);
    },
    30_000,
  );

  it(
    'still stores a lone turn with nothing racing it — INVARIANT GUARD, green before the fix',
    async () => {
      // 🔴 LABELLED HONESTLY: green on pre-change code. It is not regression
      // coverage — it is the guard on the SHAPE of the fix. Ordering writes can
      // be implemented as a queue that never drains (a write awaiting a chain
      // entry nothing resolves), and that failure is invisible to the two cases
      // above, which release everything they hold. A turn with no contention
      // must still reach storage promptly.
      await startFirstTurn();
      settling.set('wf-1', 'THE ONLY REPLY');
      await letPollsRun(3);

      const committed = messageWrites().at(-1);
      expect(committed, 'the turn never persisted at all').toBeTruthy();
      expect(
        committed!.some((m) => m.role === 'user' && m.content === 'FIRST question'),
        'the question the viewer paid for is not in storage',
      ).toBe(true);
      expect(
        committed!.some((m) => m.role === 'assistant' && m.content === 'THE ONLY REPLY'),
        'the reply the viewer paid for is not in storage',
      ).toBe(true);
      expect(heldCount, 'this case must not hold anything').toBe(0);
    },
    30_000,
  );
});
