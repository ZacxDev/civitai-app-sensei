import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { UseAppStorage } from '@civitai/blocks-react';
import { App } from './App.js';
import { MAX_TURN_RECORDS, TURNS_PREFIX, turnRecordKey } from './lib/turn-records.js';
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
const pollFn = vi.fn(async (workflowId: string) => {
  if (hangingPolls.has(workflowId)) return new Promise(() => {});
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
    const first = turnRecords()[0].sessionId as string;

    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
    send('second question');
    await waitFor(() => expect(turnRecords()).toHaveLength(2));
    await waitFor(() =>
      expect(turnRecords().every((r) => r.outcome === 'saved')).toBe(true),
    );
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
