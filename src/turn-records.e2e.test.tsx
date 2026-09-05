import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { UseAppStorage } from '@civitai/blocks-react';
import { App } from './App.js';
import { MAX_TURN_RECORDS, TURNS_PREFIX, turnRecordKey } from './lib/turn-records.js';
import { claimMessageWrite } from './lib/write-ownership.js';
// @ts-expect-error - plain .mjs with no types, by design. See the file header.
import { reconcileTurns } from '../eval/reconcile-turns.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE DETECTION INSTRUMENT FOR F1 — "generated, charged, never persisted".
//
// Two of the sixteen questions that ever reached production produced a complete,
// charged answer that never landed in the transcript, and NOTHING in the app
// could see it: the only per-turn artefact it leaves is the transcript, which is
// the thing that goes missing. `sensei:turns:*` is the second artefact.
//
// 🔴 WHAT MAKES OR BREAKS IT IS *WHEN* THE RECORD IS WRITTEN. One of the three
// rival mechanisms is "the post-completion continuation never ran". A record
// written from that continuation would be suppressed by the exact failure it
// exists to detect. Two cases below pin the placement rather than the value:
// the ordering case fails if the write moves after `await persist(...)`, and the
// stranded-turn case reproduces the production symptom — a transcript holding
// only the question — and shows the record survives it.
//
// 🔴 AND IT IS ON THE MONEY PATH, so two cases pin the posture: a record write
// that REJECTS must not delay, block or fail the send, and must not put a
// storage banner on screen.
// ─────────────────────────────────────────────────────────────────────────────

interface Recorded {
  key: string;
  value: unknown;
}

/**
 * A read-your-writes KV fake with INJECTABLE WRITE FAILURE.
 *
 * `failSet` decides per (key, value) whether `set` rejects — the only way to
 * drive the "the storage write was issued and rejected" arm, which is one of the
 * three mechanisms the record has to tell apart.
 */
function makeStorage() {
  const store = new Map<string, unknown>();
  const sets: Recorded[] = [];
  /**
   * Every `set` CALL, including the ones that reject.
   *
   * 🔴 `sets` ALONE CANNOT SEE AN ATTEMPT THAT FAILED, and that is exactly what
   * the money-path case has to assert: with the instrument absent, "no record
   * was written" and "the record write was rejected" produce an identical
   * `sets`, so a case built on `sets` would pass vacuously against code that has
   * no instrument at all.
   */
  const attempts: string[] = [];
  let failSet: (key: string, value: unknown) => boolean = () => false;

  const appStorage: UseAppStorage = {
    async get<T = unknown>(key: string) {
      return (store.has(key) ? (store.get(key) as T) : null) as T | null;
    },
    async set<T = unknown>(key: string, value: T) {
      attempts.push(key);
      if (failSet(key, value)) throw new Error('kv rejected');
      store.set(key, value);
      sets.push({ key, value });
      return { ok: true as const };
    },
    async delete(key: string) {
      return { ok: true as const, deleted: store.delete(key) };
    },
    async list(opts?: { prefix?: string; limit?: number; cursor?: string }) {
      const prefix = opts?.prefix;
      const keys = [...store.keys()].filter((k) => !prefix || k.startsWith(prefix));
      return { keys: keys.map((key) => ({ key, updatedAt: new Date() })) };
    },
    async getQuota() {
      return { usedBytes: 0, rowCount: store.size, limitBytes: 50_000_000, limitRows: 1_000_000 };
    },
  };

  return {
    appStorage,
    store,
    sets,
    attempts,
    setFailSet(f: (key: string, value: unknown) => boolean) {
      failSet = f;
    },
  };
}

const h = vi.hoisted(() => ({ storage: null as ReturnType<typeof makeStorage> | null }));

let submitCount = 0;
const submitFn = vi.fn(async () => {
  submitCount += 1;
  return { workflowId: `wf-${submitCount}`, status: 'pending' };
});

/**
 * workflowIds whose poll NEVER RESOLVES — a promise, not a timer.
 *
 * 🔴 A NEVER-RESOLVING PROMISE RATHER THAN A PERMANENTLY-PENDING STATUS, on
 * purpose. A poll that keeps answering "pending" leaves the bridge spinning on a
 * 1 s timer until its 60 s deadline, so the stranded turn eventually wakes up
 * and writes — after the test has returned, into a torn-down tree. Parking the
 * promise models the real thing better (the tab is gone; the continuation never
 * runs, ever) and leaves nothing behind to fire later.
 */
const hangingPolls = new Set<string>();

/**
 * A one-shot latch every non-hanging poll waits on, so a test can act while the
 * turn is IN FLIGHT.
 *
 * 🔴 THE SUPERSEDE CASES NEED A MOMENT THAT OTHERWISE DOES NOT EXIST. A turn is
 * superseded when somebody newer claims its transcript AFTER it started and
 * BEFORE it settles; with the poll resolving immediately there is no such
 * moment to reach from a test. `hangingPolls` cannot serve — it removes the
 * settle entirely, which is the case those tests are distinguishing themselves
 * from. Holding the poll and releasing it reproduces the real ordering: the
 * turn keeps running, and finishes into a world it no longer owns.
 */
let releasePolls: (() => void) | null = null;
let pollGate: Promise<void> | null = null;
function holdPolls() {
  pollGate = new Promise<void>((resolve) => {
    releasePolls = resolve;
  });
}
function letPollsThrough() {
  releasePolls?.();
  releasePolls = null;
  pollGate = null;
}

/**
 * When set, every poll reports the host WITHHELD the generated text.
 *
 * The bridge turns this into a `TextOutputWithheldError`, which is what puts
 * `handleSend` on its `catch` path — the second, separate pair of settle sites.
 * A withhold rather than a transport error on purpose: the Buzz was
 * unambiguously spent, so a reply lost here is a real charged loss.
 */
let withholdReason: string | null = null;

const pollFn = vi.fn(async (workflowId: string) => {
  if (hangingPolls.has(workflowId)) return new Promise(() => {});
  if (pollGate) await pollGate;
  if (withholdReason !== null) {
    return {
      workflowId,
      status: 'succeeded',
      cost: { total: 1 },
      textOutputWithheld: { reason: withholdReason },
    };
  }
  return {
    workflowId,
    status: 'succeeded',
    cost: { total: 1 },
    textOutputs: [`reply for ${workflowId}`],
  };
});

const estimateFn = vi
  .fn()
  .mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } });
const cancelFn = vi.fn(async () => undefined);

vi.mock('@civitai/blocks-react', () => ({
  useAppStorage: () => h.storage!.appStorage,
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

const originalFetch = globalThis.fetch;

beforeEach(() => {
  h.storage = makeStorage();
  hangingPolls.clear();
  letPollsThrough();
  withholdReason = null;
  submitCount = 0;
  submitFn.mockClear();
  pollFn.mockClear();
  // No tool declarations: this file is about the turn record, not tool calling.
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify({ tools: [] }), { status: 200 }),
  ) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  // A gate left held would park the next file's polls forever.
  letPollsThrough();
});

const st = () => h.storage!;

/** Turn-record keys currently in the store. */
function turnKeys(): string[] {
  return [...st().store.keys()].filter((k) => k.startsWith(TURNS_PREFIX));
}

function turnRecords(): Array<Record<string, unknown>> {
  return turnKeys().map((k) => st().store.get(k) as Record<string, unknown>);
}

function storedMessages(sessionId: string): Array<Record<string, unknown>> {
  return (st().store.get(`sensei:messages:${sessionId}`) as Array<Record<string, unknown>>) ?? [];
}

/** Everything in the store, shaped like the `app_sensei.kv` rows the query reads. */
function kvRows() {
  return [...st().store.entries()].map(([key, value]) => ({
    key,
    value,
    user_id: 1,
    block_instance_id: 'bi',
  }));
}

async function openNewChat() {
  const view = render(<App />);
  await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
  fireEvent.click(screen.getByTestId('new-session-button'));
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
  return view;
}

function send(text: string) {
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('send-button'));
}

describe('the turn record is written before the send path can lose it', () => {
  it('🔴 PLACEMENT: the record write is issued BEFORE the transcript write', async () => {
    await openNewChat();
    send('hello');

    await waitFor(() =>
      expect(st().sets.some((s) => s.key.startsWith('sensei:messages:'))).toBe(true),
    );

    const firstTurnWrite = st().sets.findIndex((s) => s.key.startsWith(TURNS_PREFIX));
    const firstMessageWrite = st().sets.findIndex((s) => s.key.startsWith('sensei:messages:'));

    expect(firstTurnWrite, 'no turn record was written at all').toBeGreaterThanOrEqual(0);
    // 🔴 THIS IS AN ASSERTION ABOUT ORDER, WHICH IS AN ASSERTION ABOUT WHICH
    // SIDE OF THE FIRST `await` THE WRITE SITS ON. The fake's `set` records
    // synchronously, so `sets` is call order: moving `startTurnRecord` below
    // `await persist('save your message', …)` inverts this and fails here.
    expect(firstTurnWrite).toBeLessThan(firstMessageWrite);
  });

  it('🔴 STRANDED TURN: the continuation never runs, and the record still exists', async () => {
    hangingPolls.add('wf-1');
    const view = await openNewChat();
    send('most popular models');

    await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(1));
    // The workflow id arrives from the bridge's `onWorkflow`, at the submit —
    // not from the resolved response, which never arrives here.
    await waitFor(() => expect(turnRecords()[0]?.workflowIds).toEqual(['wf-1']));

    // 🔴 THE TAB GOES AWAY MID-TURN, AND NOTHING ABORTS THE TURN. The poll is
    // parked on a promise that never settles, so `handleSend`'s continuation
    // past `await submit()` never runs — the (a) mechanism, reproduced rather
    // than simulated.
    view.unmount();
    const record = turnRecords()[0];
    const sessionId = record.sessionId as string;
    const messageId = record.messageId as string;

    // 🔴 THE PRODUCTION SYMPTOM, REPRODUCED: the stored transcript holds the
    // question and nothing else, exactly as
    // `sensei:messages:session-1788111407218-klvkhw` did on the live store.
    const persisted = storedMessages(sessionId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].role).toBe('user');
    expect(persisted.some((m) => m.id === messageId)).toBe(false);

    // …and the record is the artefact that makes it visible.
    expect(record.outcome).toBe('pending');
    expect(typeof record.submittedAt).toBe('number');

    // 🔴 THE POSITIVE CONTROL, END TO END: the reconciliation that will run
    // against `app_sensei.kv` counts this store's loss as ONE.
    const out = reconcileTurns(kvRows(), { now: (record.submittedAt as number) + 3_600_000 });
    expect(out.lostAnswers).toBe(1);
    expect(out.aContinuationNeverRan).toBe(1);
    expect(out.lost[0].messageId).toBe(messageId);
  });

  it('🔴 a STOPPED turn is not a lost answer, even though its record stays `pending`', async () => {
    // 🔴 THE FALSE-POSITIVE THIS CLOSES. `handleSend`'s abort exits return
    // without settling, so a stopped turn keeps `outcome: 'pending'` — the same
    // value a genuinely lost turn carries. What keeps it out of the count is
    // that `handleStopStream` persists the SAME assistant message id, so the
    // reconciliation finds a match. Stop is common; if this were wrong the
    // detector would report a loss every time somebody pressed the button.
    hangingPolls.add('wf-1');
    await openNewChat();
    send('a question I change my mind about');

    await waitFor(() => expect(screen.getByTestId('stop-button')).toBeTruthy());
    await waitFor(() => expect(turnRecords()[0]?.workflowIds).toEqual(['wf-1']));
    fireEvent.click(screen.getByTestId('stop-button'));

    const record = turnRecords()[0];
    await waitFor(() =>
      expect(
        storedMessages(record.sessionId as string).some((m) => m.id === record.messageId),
      ).toBe(true),
    );
    expect(record.outcome).toBe('pending');

    const out = reconcileTurns(kvRows(), { now: (record.submittedAt as number) + 3_600_000 });
    expect(out.turnRecords).toBe(1);
    expect(out.lostAnswers).toBe(0);
  });

  it('a turn that lands settles the record to `saved`, and reconciles as NO loss', async () => {
    await openNewChat();
    send('say ok');

    await waitFor(() => expect(turnRecords()[0]?.outcome).toBe('saved'));
    const record = turnRecords()[0];
    expect(record.workflowIds).toEqual(['wf-1']);

    const persisted = storedMessages(record.sessionId as string);
    expect(persisted.some((m) => m.id === record.messageId)).toBe(true);

    // 🔴 REPORTED AS A PAIR WITH THE CASE ABOVE. A detector that cannot return
    // zero on a healthy store is as useless as one that cannot return one.
    const out = reconcileTurns(kvRows(), { now: (record.submittedAt as number) + 3_600_000 });
    expect(out.turnRecords).toBe(1);
    expect(out.lostAnswers).toBe(0);
  });

  it('🔴 a reply write that REJECTS settles the record to `write-failed`', async () => {
    await openNewChat();
    // Fail only the write that carries the assistant reply: the user-message
    // write holds one element, the reply write holds two.
    st().setFailSet(
      (key, value) =>
        key.startsWith('sensei:messages:') && Array.isArray(value) && value.length >= 2,
    );
    send('say ok');

    await waitFor(() => expect(turnRecords()[0]?.outcome).toBe('write-failed'));
    const record = turnRecords()[0];

    // The reply really is missing from the transcript — this arm is mechanism
    // (b), and it is a real loss, not a bookkeeping difference.
    expect(storedMessages(record.sessionId as string).some((m) => m.id === record.messageId)).toBe(
      false,
    );

    const out = reconcileTurns(kvRows(), { now: (record.submittedAt as number) + 3_600_000 });
    expect(out.lostAnswers).toBe(1);
    expect(out.bWriteRejected).toBe(1);
    expect(out.aContinuationNeverRan).toBe(0);
  });

  it('🔴 MONEY PATH: a record write that rejects does not fail the send', async () => {
    // 🔴 THE SWALLOW IS ASSERTED, NOT ASSUMED. `startTurnRecord` never awaits
    // its own write, so a rejection that is not handled becomes an unhandled
    // rejection — which in a browser is a console error on the money path and
    // in some hosts a reported crash. The runner happens to fail the RUN on one,
    // but a run-level exit code names nothing; this listener makes the failure
    // land on this case, with this case's own message.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);

    await openNewChat();
    st().setFailSet((key) => key.startsWith(TURNS_PREFIX));
    send('say ok');

    // The reply arrives and is persisted, exactly as if the instrument were not
    // there.
    await waitFor(() => expect(screen.getByText('reply for wf-1')).toBeTruthy());
    const sessionKey = [...st().store.keys()].find((k) => k.startsWith('sensei:messages:'))!;
    await waitFor(() =>
      expect(st().store.get(sessionKey) as Array<Record<string, unknown>>).toHaveLength(2),
    );
    const persisted = st().store.get(sessionKey) as Array<Record<string, unknown>>;
    expect(persisted[1].content).toBe('reply for wf-1');

    // 🔴 THE WRITE WAS ATTEMPTED AND REJECTED — not simply absent. Without this
    // line the case passes against code carrying no instrument at all, which is
    // precisely the state it is supposed to distinguish itself from.
    expect(st().attempts.some((k) => k.startsWith(TURNS_PREFIX))).toBe(true);

    // 🔴 AND NO BANNER. The record deliberately does NOT go through `persist`,
    // so its failure cannot tell the viewer their chat was not saved when it
    // was. Nothing landed under the prefix either — the rejection is swallowed,
    // not retried.
    expect(screen.queryByTestId('storage-error')).toBeNull();
    expect(turnKeys()).toHaveLength(0);

    // Let the rejection be classified before reading the tally.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    process.off('unhandledRejection', onUnhandled);
    expect(
      unhandled.map((e) => (e instanceof Error ? e.message : String(e))),
      'the record write rejected and nobody caught it',
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE `discarded` OUTCOME IS THE ONE THAT KEEPS THE HEADLINE NUMBER HONEST,
// AND UNTIL THESE CASES EXISTED NOTHING ASSERTED IT.
//
// `handleSend` has TWO write-ownership gates — one on the success path, one on
// the error/withhold path — and each `else` arm settles the record `discarded`.
// Deleting either arm's `settle` leaves the turn `pending` with a non-empty
// `workflowIds`, which is the exact signature of `a_continuation_never_ran`. So
// the failure direction is OVER-report: a known, deliberate, event-emitting
// trade would be counted as a LOST ANSWER, inflating the one number this whole
// instrument exists to produce. Measured before these cases were written: both
// deletions survived the full suite.
//
// `correction-round.e2e.test.tsx` already reaches the success-path arm and
// asserts the EVENT (`reply_discarded_superseded`). The event and the record are
// two separate writes; asserting one says nothing about the other.
// ─────────────────────────────────────────────────────────────────────────────
describe('a SUPERSEDED turn is an accepted trade, not a lost answer', () => {
  /**
   * Send, hold the turn open, and let a newer writer take the transcript.
   *
   * `claimMessageWrite` is exactly what a remounted instance does at its first
   * send — calling it directly stages the supersede without needing a second
   * tree, and the turn is superseded WITHOUT ever being aborted, which is the
   * case no abort predicate can see.
   */
  async function sendAndSupersede(text: string) {
    holdPolls();
    await openNewChat();
    send(text);
    await waitFor(() => expect(turnRecords()[0]?.workflowIds).toEqual(['wf-1']), { timeout: 8000 });
    const sessionId = turnRecords()[0].sessionId as string;
    const writesBefore = st().sets.filter((s) => s.key === `sensei:messages:${sessionId}`).length;
    claimMessageWrite(sessionId);
    letPollsThrough();
    return { sessionId, writesBefore };
  }

  /** Message writes issued for one session since `sendAndSupersede` ran. */
  function messageWritesFor(sessionId: string) {
    return st().sets.filter((s) => s.key === `sensei:messages:${sessionId}`).length;
  }

  it('🔴 SUCCESS PATH: a superseded reply settles `discarded`, and reconciles as ZERO loss', async () => {
    const { sessionId, writesBefore } = await sendAndSupersede('what should I try next?');

    // The reply is generated and reaches the screen — the loss is at the WRITE,
    // which is what makes this a charged loss rather than a failed turn.
    await waitFor(() => expect(screen.getByText('reply for wf-1')).toBeTruthy(), { timeout: 8000 });
    await waitFor(
      () =>
        expect(
          turnRecords()[0]?.outcome,
          'a superseded reply must settle `discarded`; left `pending` it is counted as a lost answer',
        ).toBe('discarded'),
      { timeout: 8000 },
    );

    // The write really was refused, so this record genuinely has no matching
    // message — the predicate that would otherwise read as (a).
    expect(messageWritesFor(sessionId)).toBe(writesBefore);
    const record = turnRecords()[0];
    expect(storedMessages(sessionId).some((m) => m.id === record.messageId)).toBe(false);

    // 🔴 THE CONSEQUENCE, MEASURED. Without the settle these three numbers read
    // 0 / 1 / 1 — a deliberate trade reported as the defect being hunted.
    const out = reconcileTurns(kvRows(), { now: (record.submittedAt as number) + 3_600_000 });
    expect(out.acceptedDiscarded).toBe(1);
    expect(out.lostAnswers).toBe(0);
    expect(out.aContinuationNeverRan).toBe(0);
    // 🔴 20 s, ABOVE EVERY `waitFor` BELOW IT. At the 5 s default a `waitFor`
    // given 8 s can never report its own assertion — the RUN dies first and the
    // failure reads `Test timed out`, which names no guard. Measured while
    // mutating the settle site this case exists to kill.
  }, 20_000);

  it('🔴 WITHHOLD PATH: a superseded WITHHELD turn settles `discarded` too', async () => {
    // A separate `settle` site on a separate code path: the `catch` arm, reached
    // only when the turn threw. Nothing about the success-path case above
    // exercises it, and the Buzz was spent here just as certainly.
    withholdReason = 'This reply was withheld.';
    const { sessionId, writesBefore } = await sendAndSupersede('something the host will refuse');

    await waitFor(() => expect(screen.getByText('This reply was withheld.')).toBeTruthy(), {
      timeout: 8000,
    });
    await waitFor(
      () =>
        expect(
          turnRecords()[0]?.outcome,
          'a superseded WITHHELD reply must settle `discarded`; left `pending` it is counted as a lost answer',
        ).toBe('discarded'),
      { timeout: 8000 },
    );

    expect(messageWritesFor(sessionId)).toBe(writesBefore);
    const record = turnRecords()[0];
    const out = reconcileTurns(kvRows(), { now: (record.submittedAt as number) + 3_600_000 });
    expect(out.acceptedDiscarded).toBe(1);
    expect(out.lostAnswers).toBe(0);
    expect(out.aContinuationNeverRan).toBe(0);
  }, 20_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE MECHANISM SPLIT ON THE PATH WHERE THE MONEY WENT MISSING.
//
// The error/withhold path reads `persist`'s verdict exactly as the success path
// does, and only that read separates (b) "the write was issued and REJECTED"
// from (c) "it was written and later overwritten". `lost_answers` is the same
// either way, so nothing about the headline number can see this — which is why
// hardcoding this site to `'saved'` left the whole suite green. The split is the
// entire reason the record carries an `outcome` at all.
// ─────────────────────────────────────────────────────────────────────────────
describe('a withheld turn whose write REJECTS is reported as a rejection', () => {
  it('🔴 settles `write-failed`, not `saved` — the split, not the total', async () => {
    withholdReason = 'This reply was withheld.';
    await openNewChat();
    // Fail only the write carrying the withheld reply: the user-message write
    // holds one element, this one holds two.
    st().setFailSet(
      (key, value) =>
        key.startsWith('sensei:messages:') && Array.isArray(value) && value.length >= 2,
    );
    send('something the host will refuse');

    await waitFor(
      () =>
        expect(
          turnRecords()[0]?.outcome,
          'a withheld reply whose write REJECTED must settle `write-failed`, or (b) is reported as (c)',
        ).toBe('write-failed'),
      { timeout: 8000 },
    );

    const record = turnRecords()[0];
    // A real loss, not a bookkeeping difference: the reply is not in the
    // transcript, and the viewer was charged for it.
    expect(record.workflowIds).toEqual(['wf-1']);
    expect(storedMessages(record.sessionId as string).some((m) => m.id === record.messageId)).toBe(
      false,
    );

    // 🔴 THE DECOMPOSITION IS THE ASSERTION. `lostAnswers` is 1 whichever
    // outcome is written, so it cannot distinguish the two; these three
    // columns are the only thing that can.
    const out = reconcileTurns(kvRows(), { now: (record.submittedAt as number) + 3_600_000 });
    expect(out.lostAnswers).toBe(1);
    expect(out.bWriteRejected).toBe(1);
    expect(out.cOverwritten).toBe(0);
  }, 20_000);
});

describe('the boot sweep keeps the store bounded', () => {
  it('🔴 prunes on mount — the helper being correct is not the same as it being CALLED', async () => {
    // 🔴 `pruneTurnRecords` is unit-tested in `lib/turn-records.test.ts`. That
    // is a claim about the FUNCTION; this is the only thing that says the app
    // ever runs it. Nothing else in the app reads `sensei:turns:*`, so an
    // uncalled sweep is a leak nobody would notice.
    for (let i = 0; i < MAX_TURN_RECORDS + 3; i += 1) {
      const s = { sessionId: 'session-old', messageId: `m-${i}`, submittedAt: 1_700_000_000_000 + i };
      st().store.set(turnRecordKey(s), { ...s, workflowIds: [], outcome: 'saved' });
    }
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    await waitFor(() => expect(turnKeys()).toHaveLength(MAX_TURN_RECORDS));
  });
});

describe('deleting a chat takes its turn records with it', () => {
  it('🔴 otherwise every deleted chat reconciles as a lost answer', async () => {
    await openNewChat();
    send('first question');
    await waitFor(() => expect(turnRecords()[0]?.outcome).toBe('saved'));
    // 🔴 `saved` NO LONGER MEANS "THE TURN IS OVER", AND THAT IS THE FIX IT IS
    // REPORTING ON. The reply is now written the instant it arrives, while the
    // cosmetic replay is still typing it out — so the record settles a beat
    // BEFORE the composer reopens, and a Send clicked in that window finds the
    // Stop button and throws `Unable to find send-button`. Waiting for the
    // composer is what this step always meant; the record's outcome was a proxy
    // for it that has stopped being one. Nothing asserted here is relaxed — a
    // wait is added, not an expectation removed.
    await waitFor(() => expect(screen.getByTestId('send-button')).toBeTruthy());
    const first = turnRecords()[0].sessionId as string;

    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
    send('second question');
    await waitFor(() => expect(turnRecords()).toHaveLength(2));
    await waitFor(() =>
      expect(turnRecords().every((r) => r.outcome === 'saved')).toBe(true),
    );
    // Same reason as above: the delete below must not race turn 2's replay.
    await waitFor(() => expect(screen.getByTestId('send-button')).toBeTruthy());
    const second = turnRecords().map((r) => r.sessionId as string).find((s) => s !== first)!;

    fireEvent.click(screen.getByTestId(`delete-session-${first}`));

    await waitFor(() => expect(turnKeys()).toHaveLength(1));
    // The survivor belongs to the chat that was NOT deleted — a purge that took
    // both would pass a bare length check.
    expect(turnRecords()[0].sessionId).toBe(second);
    expect(st().store.has(`sensei:messages:${first}`)).toBe(false);

    // 🔴 THE CONSEQUENCE, MEASURED RATHER THAN ARGUED. With the deleted chat's
    // records left behind, this count would be 1 — an invented loss, produced at
    // the rate people tidy their chat list.
    const now = (turnRecords()[0].submittedAt as number) + 3_600_000;
    expect(reconcileTurns(kvRows(), { now }).lostAnswers).toBe(0);
  });
});
