import { describe, it, expect, vi } from 'vitest';
import type { UseAppStorage } from '@civitai/blocks-react';
import { fakeAppStorage } from '../test-helpers.js';
import {
  MAX_TURN_RECORDS,
  PRUNE_DELETE_BUDGET,
  TURNS_PREFIX,
  pruneTurnRecords,
  purgeSessionTurnRecords,
  sessionTurnsPrefix,
  startTurnRecord,
  submittedAtFromKey,
  turnRecordKey,
} from './turn-records.js';

const seed = { sessionId: 'session-1', messageId: 'msg-1', submittedAt: 1_700_000_000_000 };

describe('the turn key carries what both sweeps need', () => {
  it('is prefix-addressable per session and parseable by age', () => {
    const key = turnRecordKey(seed);
    expect(key.startsWith(sessionTurnsPrefix('session-1'))).toBe(true);
    expect(submittedAtFromKey(key)).toBe(seed.submittedAt);
  });

  it('a key that does not parse sorts OLDEST, so it is pruned rather than pinned', () => {
    expect(submittedAtFromKey('sensei:turns:session-1:not-a-number:msg-1')).toBe(0);
    expect(submittedAtFromKey('sensei:turns:mangled')).toBe(0);
  });
});

describe('startTurnRecord writes on the caller`s own stack', () => {
  it('🔴 issues the `set` SYNCHRONOUSLY — nothing awaited, no microtask first', () => {
    const storage = fakeAppStorage();
    startTurnRecord(storage.appStorage, seed);
    // 🔴 NO `await` ANYWHERE ABOVE THIS LINE. If the write were deferred into a
    // `.then` — which is what "record it in the completion continuation" looks
    // like — `sets` would still be empty here.
    expect(storage.sets.map((s) => s.key)).toEqual([turnRecordKey(seed)]);
    expect(storage.sets[0].value).toEqual({ ...seed, workflowIds: [], outcome: 'pending' });
  });

  it('appends workflow ids as they arrive, ignoring blanks and repeats', async () => {
    const storage = fakeAppStorage();
    const rec = startTurnRecord(storage.appStorage, seed);
    rec.workflow('wf-1');
    rec.workflow('wf-1');
    rec.workflow('');
    rec.workflow(undefined);
    rec.workflow('wf-2');
    await new Promise((r) => setTimeout(r, 0));
    const stored = storage.store.get(turnRecordKey(seed)) as { workflowIds: string[] };
    expect(stored.workflowIds).toEqual(['wf-1', 'wf-2']);
    // Two ids, two extra writes — the blanks and the repeat cost nothing.
    expect(storage.sets).toHaveLength(3);
  });

  it('🔴 a rejecting store neither throws nor leaves an unhandled rejection', async () => {
    const rejecting = {
      ...fakeAppStorage().appStorage,
      set: vi.fn(async () => {
        throw new Error('kv rejected');
      }),
    } as unknown as UseAppStorage;
    const rec = startTurnRecord(rejecting, seed);
    rec.workflow('wf-1');
    rec.settle('saved');
    await new Promise((r) => setTimeout(r, 0));
    expect(rejecting.set).toHaveBeenCalled();
  });

  it('a later update cannot land before an earlier one — the writes are chained', async () => {
    const order: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const storage = {
      ...fakeAppStorage().appStorage,
      set: vi.fn(async (_key: string, value: { outcome: string }) => {
        if (first) {
          first = false;
          await gate;
        }
        order.push(value.outcome);
        return { ok: true as const };
      }),
    } as unknown as UseAppStorage;

    const rec = startTurnRecord(storage, seed);
    rec.settle('saved');
    release!();
    await new Promise((r) => setTimeout(r, 0));
    // 🔴 `pending` FIRST EVEN THOUGH IT WAS THE SLOW ONE. Fired independently,
    // the settle would land first and the stalled initial write would then
    // overwrite it with the older snapshot — a turn that finished reading as one
    // that never did.
    expect(order).toEqual(['pending', 'saved']);
  });
});

describe('retention keeps `sensei:turns:*` bounded', () => {
  function seedRecords(count: number, sessionId = 'session-1') {
    const store: Record<string, unknown> = {};
    for (let i = 0; i < count; i += 1) {
      const s = { sessionId, messageId: `msg-${i}`, submittedAt: 1_700_000_000_000 + i };
      store[turnRecordKey(s)] = { ...s, workflowIds: [], outcome: 'saved' };
    }
    return store;
  }

  it('leaves a store at the cap alone', async () => {
    const storage = fakeAppStorage(seedRecords(MAX_TURN_RECORDS));
    expect(await pruneTurnRecords(storage.appStorage)).toBe(0);
    expect([...storage.store.keys()]).toHaveLength(MAX_TURN_RECORDS);
  });

  it('🔴 drops the OLDEST beyond the cap, and keeps the newest', async () => {
    const storage = fakeAppStorage(seedRecords(MAX_TURN_RECORDS + 5));
    expect(await pruneTurnRecords(storage.appStorage)).toBe(5);
    const left = [...storage.store.keys()].map(submittedAtFromKey).sort((a, b) => a - b);
    expect(left).toHaveLength(MAX_TURN_RECORDS);
    // The five oldest submittedAt values are the ones that went.
    expect(left[0]).toBe(1_700_000_000_005);
  });

  it('deletes at most the per-sweep budget, so one mount cannot stall on a backlog', async () => {
    const storage = fakeAppStorage(seedRecords(MAX_TURN_RECORDS + PRUNE_DELETE_BUDGET + 25));
    expect(await pruneTurnRecords(storage.appStorage)).toBe(PRUNE_DELETE_BUDGET);
  });

  it('never touches a key outside the prefix', async () => {
    const storage = fakeAppStorage({
      ...seedRecords(MAX_TURN_RECORDS + 3),
      'sensei:sessions': { sessions: [] },
      'sensei:messages:session-1': [],
    });
    await pruneTurnRecords(storage.appStorage);
    expect(storage.store.has('sensei:sessions')).toBe(true);
    expect(storage.store.has('sensei:messages:session-1')).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 THE SORT IS NUMERIC, AND THE CASES ABOVE CANNOT SEE THAT.
  //
  // `seedRecords` gives every record ONE sessionId and a uniform-width
  // `submittedAt`, and under exactly those two conditions lexicographic order
  // over the whole key and numeric order over its `submittedAt` segment agree.
  // So replacing the comparator with a bare `sort()` leaves every case above
  // green — measured, not assumed.
  //
  // The two cases below are the two ways production breaks that agreement, and
  // each one INVERTS which record is dropped. They are what makes the
  // comparator's presence a tested fact rather than a stated one.
  // ───────────────────────────────────────────────────────────────────────────

  /** One record, addressed by the fields the key is built from. */
  function record(sessionId: string, submittedAt: number, messageId: string) {
    const s = { sessionId, messageId, submittedAt };
    return [turnRecordKey(s), { ...s, workflowIds: [], outcome: 'saved' }] as const;
  }

  it('🔴 ACROSS SESSIONS the oldest TURN goes, not the lowest session id', async () => {
    // An old chat carrying a NEW turn, against a new chat carrying an OLDER
    // one. Lexicographically the key's leading segment is the sessionId, so a
    // string sort ranks these by which conversation started first — which is
    // not what "oldest" means and, here, is the exact opposite of it.
    const newTurnInOldChat = record('session-1786000000000-aaa', 1_788_600_000_000, 'msg-a');
    const oldTurnInNewChat = record('session-1788000000000-bbb', 1_788_116_400_000, 'msg-b');
    const storage = fakeAppStorage(
      Object.fromEntries([newTurnInOldChat, oldTurnInNewChat]) as Record<string, unknown>,
    );

    expect(await pruneTurnRecords(storage.appStorage, 1)).toBe(1);

    const left = [...storage.store.values()] as Array<{ sessionId: string }>;
    expect(left).toHaveLength(1);
    expect(
      left[0].sessionId,
      'the surviving record must be the NEWER TURN, whichever chat it belongs to',
    ).toBe('session-1786000000000-aaa');
  });

  it('🔴 WITHIN one session a SHORTER `submittedAt` is smaller, not larger', async () => {
    // Epoch-ms is not a fixed-width field: it was 12 digits until 2001-09-09 and
    // is 13 until 2286, and a record can carry a truncated or clock-skewed value
    // at any time. A string sort reads '9…' as greater than '1…', so the older
    // of these two is ranked NEWEST and the sweep drops the wrong one.
    const older = record('session-1', 999_999_999_999, 'msg-c');
    const newer = record('session-1', 1_700_000_000_000, 'msg-d');
    const storage = fakeAppStorage(Object.fromEntries([older, newer]) as Record<string, unknown>);

    expect(await pruneTurnRecords(storage.appStorage, 1)).toBe(1);

    const left = [...storage.store.values()] as Array<{ submittedAt: number }>;
    expect(left).toHaveLength(1);
    expect(left[0].submittedAt, 'the survivor must be the numerically NEWER record').toBe(
      1_700_000_000_000,
    );
  });
});

describe('purgeSessionTurnRecords is scoped to one conversation', () => {
  it('🔴 removes that session`s records and nothing else', async () => {
    const a = { sessionId: 'session-a', messageId: 'm1', submittedAt: 1 };
    const b = { sessionId: 'session-b', messageId: 'm2', submittedAt: 2 };
    const storage = fakeAppStorage({
      [turnRecordKey(a)]: a,
      [turnRecordKey(b)]: b,
      'sensei:messages:session-b': [],
    });

    expect(await purgeSessionTurnRecords(storage.appStorage, 'session-a')).toBe(1);
    expect([...storage.store.keys()].filter((k) => k.startsWith(TURNS_PREFIX))).toEqual([
      turnRecordKey(b),
    ]);
    expect(storage.store.has('sensei:messages:session-b')).toBe(true);
  });

  it('a session id that is a PREFIX of another does not purge the other', async () => {
    // `session-1` vs `session-10`: the prefix ends in the separator, so the
    // longer id is not swept by the shorter one's purge.
    const one = { sessionId: 'session-1', messageId: 'm1', submittedAt: 1 };
    const ten = { sessionId: 'session-10', messageId: 'm2', submittedAt: 2 };
    const storage = fakeAppStorage({
      [turnRecordKey(one)]: one,
      [turnRecordKey(ten)]: ten,
    });
    expect(await purgeSessionTurnRecords(storage.appStorage, 'session-1')).toBe(1);
    expect([...storage.store.keys()]).toEqual([turnRecordKey(ten)]);
  });
});
