import type { UseAppStorage } from '@civitai/blocks-react';

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 ONE DURABLE RECORD PER TURN, WRITTEN AT SUBMIT — THE ONLY ARTEFACT A LOST
// ANSWER LEAVES BEHIND.
//
// THE DEFECT THIS EXISTS TO SEE. Two of the 16 questions that ever reached
// production were generated, CHARGED, and never landed in the transcript:
// `session-1787879266275-h93jqp` (2026-08-28, 328 characters, 4 Buzz) and
// `session-1788111407218-klvkhw` (2026-08-30, 796 characters, 6 Buzz). The
// second's stored message array has `created_at == updated_at` and holds only
// the user's question, while the orchestrator's own record shows a complete
// charged answer 1.6 s later.
//
// 🔴 IT IS INVISIBLE TO EVERY INSTRUMENT THE APP HAS, AND THAT IS STRUCTURAL,
// NOT AN OVERSIGHT. The only per-turn artefact the app leaves is the transcript
// — which is the thing that goes missing. Its absence is indistinguishable from
// "the viewer never asked". So the record here is deliberately a SECOND
// artefact, under its own key, whose survival does not depend on the write that
// fails.
//
// 🔴 THE LOAD-BEARING PROPERTY IS *WHEN*: `startTurnRecord` issues its `set`
// SYNCHRONOUSLY, before `handleSend`'s first `await`. One of the three rival
// mechanisms is precisely "the post-completion continuation never ran" — a
// record written from that continuation would be suppressed by the exact
// failure it exists to detect. An instrument that shares the step you doubt is
// not an instrument.
//
// WHAT THE RECORD DISCRIMINATES, given a reconciliation that joins each record
// to the message array of its own session (`eval/reconcile-turns.sql`):
//   - record present, no matching message, `workflowIds` NON-EMPTY, outcome
//     `pending`      ⇒ (a) the continuation never ran — tab closed / unmount /
//                          superseded turn. Buzz was spent.
//   - record present, no matching message, outcome `write-failed`
//                    ⇒ (b) the storage write was issued and REJECTED.
//   - record present, no matching message, outcome `saved`
//                    ⇒ (c) it was written and later overwritten.
//   - record present, no matching message, `workflowIds` EMPTY
//                    ⇒ the turn ended before it ever reached the orchestrator,
//                      so nothing was charged. Reported separately; not (a).
//   - outcome `discarded` ⇒ the write-ownership gate refused the write. Already
//                      a known, deliberate, event-emitting loss
//                      (`reply_discarded_superseded`), not a new defect.
//
// 🔴 WHAT IT CANNOT DISCRIMINATE, STATED RATHER THAN GLOSSED. The outcome
// update travels over the SAME `appStorage` as the write it reports on. If the
// transcript write fails AND this record's own update also fails, the record
// stays `pending` and (b) is misread as (a).
//
// 🔴 AND THE WIDER CASE, WHICH THAT PARAGRAPH USED TO UNDERSTATE. It held only
// for a store that starts failing AFTER submit; the `pending`/`workflowIds` half
// survives that because it was written first. If `appStorage.set` is rejecting
// AT SUBMIT — quota, the host's per-value ceiling, an anonymous viewer — then
// the FIRST write fails too and NO record exists. The reconciliation then
// reports `lost_answers = 0`, which is also what a perfectly healthy app
// reports: a store-wide write failure is the one shape this instrument renders
// as good news.
//
// The discriminator exists and is not in the loss columns: `turn_records`
// COLLAPSING below the number of questions the app is known to have received,
// together with the `storage_error` event on the analytics stream (emitted by
// `persist`, over a channel that is not `appStorage`). Read the record COUNT
// before reading any zero in the loss columns. `eval/reconcile-turns.sql`'s
// header says the same thing at the other end of the pipeline.
//
// 🔴 A STOPPED TURN IS NOT A LOST ANSWER AND DOES NOT NEED AN OUTCOME OF ITS
// OWN. `handleSend`'s two abort exits return without settling, so a stopped turn
// keeps `outcome: 'pending'` — but `handleStopStream` persists that same
// `assistantMsg.id` with whatever was streamed, so the reconciliation FINDS a
// matching message and the record is not counted as lost. What surfaces is a
// stopped turn whose own write also failed, which is a real loss and is
// attributed to (a).
//
// COST AND POSTURE. This is the money path. Nothing here is awaited by the
// caller, every rejection is swallowed, and no failure here can reach
// `persist()` and put a "Couldn't …" banner on screen. A detection instrument
// that can break a send is worse than the defect it detects.
// ─────────────────────────────────────────────────────────────────────────────

/** Key prefix every turn record lives under. */
export const TURNS_PREFIX = 'sensei:turns:';

/**
 * How many turn records a viewer keeps.
 *
 * 🔴 THE STORE IS SHARED AND FINITE, NOT LOCAL DISK: `appStorage` is the host's
 * KV over postMessage, backed by `app_sensei.kv`, and the host's documented
 * ceiling is 50 MB and ~1M rows PER APP — across every viewer, not each. So an
 * unbounded `sensei:turns:*` is a slow app-wide leak, and the retention has to
 * be a number rather than "prune eventually".
 *
 * WHY 200. The record only has to outlive the operator's reconciliation
 * cadence. Production's busiest viewer produced 16 turns across the 8 days the
 * app has had traffic; 200 is more than ten times that weekly ceiling, so a
 * weekly read sees a complete window while the row count per viewer is capped.
 * At the record's size (five small fields) 200 rows is a few tens of kilobytes.
 */
export const MAX_TURN_RECORDS = 200;

/** How many keys one prune sweep will delete. Bounds the work done at mount. */
export const PRUNE_DELETE_BUDGET = 100;

/** `list()` page size, and how many pages one sweep will walk. */
const LIST_PAGE_SIZE = 500;
const MAX_LIST_PAGES = 4;

/**
 * How the turn ended, from the writer's own point of view.
 *
 * `pending` is the value written at submit and is what a record keeps when the
 * continuation never ran.
 */
export type TurnOutcome = 'pending' | 'saved' | 'write-failed' | 'discarded';

export interface TurnRecord {
  sessionId: string;
  /**
   * The id of the ASSISTANT message this turn will write — the thing that goes
   * missing, so the thing the reconciliation looks for.
   */
  messageId: string;
  /**
   * Epoch MILLISECONDS, the same convention as `Message.timestamp`
   * (`Date.now()`, typed `number`). Deliberately not an ISO string: a query
   * that joins the two must cast them the same way, and
   * `(x)::timestamptz` on an epoch-ms number errors out — read it with
   * `to_timestamp(x::bigint / 1000.0)`.
   */
  submittedAt: number;
  /**
   * Orchestrator workflow ids this turn was charged for, in the order they
   * arrived — one per submit, and a tool-using turn makes several.
   *
   * EMPTY means the turn never reached the orchestrator, so no Buzz was spent.
   * That distinction is what keeps a refused or stopped-before-submit turn out
   * of the charged-loss count.
   */
  workflowIds: string[];
  outcome: TurnOutcome;
}

export interface TurnRecordSeed {
  sessionId: string;
  messageId: string;
  submittedAt: number;
}

/**
 * The storage key for one turn.
 *
 * 🔴 THE LAYOUT IS READ BY BOTH SWEEPS, so it is built in one place. Session id
 * first, so `purgeSessionTurnRecords` can hand the host a `prefix` instead of
 * filtering everything client-side; `submittedAt` next, so `pruneTurnRecords`
 * can order by age without reading a single value. Neither `sessionId`
 * (`session-<ms>-<rand>`) nor `messageId` (`msg-<ms>-<rand>`) can contain a
 * colon, so the segments are unambiguous.
 */
export function turnRecordKey(seed: TurnRecordSeed): string {
  return `${TURNS_PREFIX}${seed.sessionId}:${seed.submittedAt}:${seed.messageId}`;
}

/** Every turn record belonging to one session. */
export function sessionTurnsPrefix(sessionId: string): string {
  return `${TURNS_PREFIX}${sessionId}:`;
}

/**
 * The `submittedAt` embedded in a turn key.
 *
 * A key that does not parse yields `0` — it sorts OLDEST, so a malformed key is
 * pruned first rather than pinned forever at the head of the list.
 */
export function submittedAtFromKey(key: string): number {
  const n = Number(key.split(':')[3]);
  return Number.isFinite(n) ? n : 0;
}

export interface TurnRecorder {
  /** The key this recorder writes. Exposed so a test can name it exactly. */
  readonly key: string;
  /** Note a workflow this turn was charged for. Ignores blanks and repeats. */
  workflow(id: string | undefined | null): void;
  /** Record how the turn ended. */
  settle(outcome: TurnOutcome): void;
}

/**
 * Begin a turn record and write it NOW.
 *
 * 🔴 `appStorage.set` IS CALLED INSIDE THIS FUNCTION BODY, not from a `.then`,
 * so the write is issued on the caller's own synchronous stack. Call it before
 * the send path's first `await`; everything after that point is a continuation
 * that a lost turn may never reach.
 *
 * Later updates are CHAINED off that first promise rather than fired
 * independently, so two updates cannot land out of order and leave the store
 * holding an older snapshot than the one already written.
 */
export function startTurnRecord(appStorage: UseAppStorage, seed: TurnRecordSeed): TurnRecorder {
  const key = turnRecordKey(seed);
  const record: TurnRecord = {
    sessionId: seed.sessionId,
    messageId: seed.messageId,
    submittedAt: seed.submittedAt,
    workflowIds: [],
    outcome: 'pending',
  };

  // Never rejects, and never throws: a `set` that rejects, or an `appStorage`
  // that throws synchronously, must not surface anywhere on the send path.
  const write = (): Promise<void> => {
    try {
      return Promise.resolve(
        appStorage.set(key, { ...record, workflowIds: [...record.workflowIds] }),
      ).then(
        () => undefined,
        () => undefined,
      );
    } catch {
      return Promise.resolve();
    }
  };

  let chain = write();

  return {
    key,
    workflow(id) {
      if (typeof id !== 'string' || id === '') return;
      if (record.workflowIds.includes(id)) return;
      record.workflowIds.push(id);
      chain = chain.then(write, write);
    },
    settle(outcome) {
      if (record.outcome === outcome) return;
      record.outcome = outcome;
      chain = chain.then(write, write);
    },
  };
}

/** Walk `list()` pages for a prefix, bounded so a huge store still terminates. */
async function listKeys(appStorage: UseAppStorage, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const res = await appStorage.list({
      prefix,
      limit: LIST_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    for (const entry of res.keys) out.push(entry.key);
    cursor = res.nextCursor;
    if (!cursor || res.keys.length === 0) break;
  }
  return out;
}

/**
 * Drop the oldest turn records beyond {@link MAX_TURN_RECORDS}.
 *
 * Returns how many keys it deleted. Deletes at most {@link PRUNE_DELETE_BUDGET}
 * per call, so one mount cannot spend an unbounded number of postMessage round
 * trips clearing a backlog; a backlog larger than the budget converges over
 * successive mounts instead.
 */
export async function pruneTurnRecords(
  appStorage: UseAppStorage,
  max: number = MAX_TURN_RECORDS,
): Promise<number> {
  const keys = await listKeys(appStorage, TURNS_PREFIX);
  if (keys.length <= max) return 0;

  const oldestFirst = [...keys].sort((a, b) => submittedAtFromKey(a) - submittedAtFromKey(b));
  const doomed = oldestFirst.slice(0, Math.min(keys.length - max, PRUNE_DELETE_BUDGET));

  let deleted = 0;
  for (const key of doomed) {
    try {
      await appStorage.delete(key);
      deleted += 1;
    } catch {
      // A key that will not delete must not stop the rest of the sweep.
    }
  }
  return deleted;
}

/**
 * Drop every turn record belonging to one session.
 *
 * 🔴 CALLED FROM `deleteSession`, AND WITHOUT IT THE INSTRUMENT MANUFACTURES
 * FALSE POSITIVES AT THE RATE PEOPLE TIDY THEIR CHAT LIST. Deleting a session
 * deletes `sensei:messages:<id>` outright, so every turn record pointing into it
 * would reconcile as "a record with no matching assistant message" — the exact
 * predicate that means "lost answer".
 *
 * PURGE RATHER THAN TOMBSTONE, deliberately. Marking the records instead would
 * keep a deleted conversation's history readable, but it needs the
 * reconciliation to carry and trust a second piece of state; purging makes the
 * predicate true by construction with nothing extra to keep in step. The cost is
 * named: a genuine loss inside a conversation that is later deleted becomes
 * undetectable. That is accepted because the transcript it would have been
 * reconciled against is gone too, so nothing could be recovered from knowing.
 *
 * Returns how many keys it deleted.
 */
export async function purgeSessionTurnRecords(
  appStorage: UseAppStorage,
  sessionId: string,
): Promise<number> {
  const keys = await listKeys(appStorage, sessionTurnsPrefix(sessionId));
  let deleted = 0;
  for (const key of keys) {
    try {
      await appStorage.delete(key);
      deleted += 1;
    } catch {
      // Same reason as the prune sweep: one bad key must not strand the rest.
    }
  }
  return deleted;
}
