import type { AppStorage } from './sdk-runtime.js';

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
// to the message array of its own session (`eval/reconcile-turns.sql` — which,
// as its header says, still reads the legacy store and so sees no 0.2.0 record):
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
// OWN — AND IT DOES NOT ALL LAND ON ONE OUTCOME. Which value a stopped turn
// carries depends on WHERE the stop landed, because `turnRecord.settle` sits
// ABOVE the abort exit that follows the reply write, not below it:
//
//   stopped BEFORE the reply write (the common case — Stop pressed while the
//   workflow is still polling) reaches an abort exit that returns without
//   settling, so the record keeps `outcome: 'pending'`;
//
//   stopped AFTER the reply write has been persisted settles normally to
//   `'saved'` / `'write-failed'` / `'discarded'`, because the settle runs first
//   and only then does the abort exit return.
//
// Either way the record is NOT counted as lost, which is the point of this
// paragraph: `handleStopStream` persists that same `assistantMsg.id` with
// whatever was streamed, so the reconciliation FINDS a matching message. What
// surfaces is a stopped turn whose own write also failed, which is a real loss
// and is attributed to (a).
//
// 🔴 THIS USED TO SAY "`handleSend`'s TWO abort exits return without settling,
// so a stopped turn keeps `outcome: 'pending'`". Both halves were wrong after
// #55 moved the settle ahead of the replay: there are FOUR abort exits in
// `handleSend`, and the one after the reply write settles before it returns.
// Anyone reasoning about the lost-answer reconciliation off the old sentence
// would expect `pending` for every stop and mis-read a `saved` record as a
// different turn.
//
// 🔴 AND THIS ORDERING IS NOT PINNED BY ANY TEST — stated because the honest
// version of this paragraph is more useful than a confident one. It was
// MEASURED: inserting `if (aborted()) return;` immediately above the
// success-path `turnRecord.settle` — restoring exactly the pre-#55 ordering the
// old sentence described — leaves the whole `turn-records.e2e` file GREEN.
// The suite's stopped-turn case stops while the workflow is still POLLING, so
// it never reaches this line, and every case that does reach it has already let
// the settle run. A case written to close this has to abort in the window
// between `await persist(...)` resolving and the settle executing, which is a
// harder fixture than it looks and was not built. Until it is, the sentence
// above rests on reading the call order, not on a guard.
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
 * 🔴 THE STORE IS SHARED AND FINITE, NOT LOCAL DISK: `appStorage` is the
 * document store's private `kv` collection, which caps an app at 50 MB / 1M
 * documents across every viewer AND each viewer at 2 MB / 1,000 documents (the
 * SDK contract fake's defaults, `@civitai/sdk@0.14.0`; `info().limits` has the
 * live server's figures). So an unbounded `sensei:turns:*` is a
 * leak against a per-viewer ceiling that also holds the viewer's transcripts,
 * and the retention has to be a number rather than "prune eventually".
 *
 * WHY 200. The record only has to outlive the operator's reconciliation
 * cadence. Production's busiest viewer produced 16 turns across the 8 days the
 * app has had traffic; 200 is more than ten times that weekly ceiling, so a
 * weekly read sees a complete window while the row count per viewer is capped.
 * At the record's size (five small fields) 200 rows is a few tens of kilobytes.
 */
export const MAX_TURN_RECORDS = 200;

/**
 * 🔴 THE HOUSEKEEPING SHARE OF THE VIEWER'S WRITE RATE, and why it is small.
 *
 * The document store allows a viewer 120 private writes per minute per app (the
 * contract's `rate.privateWritesPerMinute`; `info().limits` has the live figure),
 * and a DELETE COUNTS AS A WRITE. Every write of the viewer's own turn — the
 * transcript, the session list, this module's records — draws on the same 120.
 * A sweep that spends 100 of them at boot left ~20 for the next minute, i.e.
 * about three questions: the fourth was CHARGED and then its saves were refused
 * `rate_limited`, losing a paid reply. Reproduced against the SDK fake with rate
 * limits on; `src/turn-records-rate-limit.e2e.test.tsx` pins it.
 *
 * So both sweeps share ONE rolling-minute allowance of
 * {@link HOUSEKEEPING_DELETES_PER_MINUTE}. What a sweep cannot afford now it
 * leaves for a later mount: retention is eventual, a lost answer is not.
 *
 * ⚠ WHAT THE ALLOWANCE DOES AND DOES NOT BOUND, stated honestly. It is MODULE
 * STATE: per tab (per page load), reset on every reload, and NOT shared across
 * tabs. The server's 120/min is per VIEWER. So within one tab housekeeping takes
 * at most 20 deletes a minute and leaves ≥100 for that tab's turns; a viewer
 * reloading repeatedly, or with several tabs open, can spend 20 per load/tab
 * against the same 120. The budgets make that a slow drain rather than the
 * single-mount 100 that lost a reply; they are not a cross-tab guarantee.
 */
export const HOUSEKEEPING_DELETES_PER_MINUTE = 20;

/** How many keys one prune sweep will delete (and never more than the pacer allows). */
export const PRUNE_DELETE_BUDGET = 20;

/** How many keys one session purge will delete; the rest stay until pushed past `MAX_TURN_RECORDS`. */
export const PURGE_DELETE_BUDGET = 20;

const MINUTE_MS = 60_000;
let housekeepingDeletes: number[] = [];

/** Housekeeping deletes still allowed in the current rolling minute. */
function housekeepingSlots(now: number): number {
  housekeepingDeletes = housekeepingDeletes.filter((t) => now - t < MINUTE_MS);
  return Math.max(0, HOUSEKEEPING_DELETES_PER_MINUTE - housekeepingDeletes.length);
}

/** Test seam: forget every delete the pacer has counted. */
export function __resetHousekeepingPacer(): void {
  housekeepingDeletes = [];
}

/**
 * Delete `keys` in order, spending at most `budget` and never more than the
 * pacer has left. A slot is taken BEFORE the call, so a delete that fails still
 * counts — the server charged it either way. Returns how many succeeded.
 */
async function pacedDelete(appStorage: AppStorage, keys: string[], budget: number): Promise<number> {
  let deleted = 0;
  let spent = 0;
  for (const key of keys) {
    if (spent >= budget) break;
    const now = Date.now();
    if (housekeepingSlots(now) === 0) break;
    housekeepingDeletes.push(now);
    spent += 1;
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
 * `list()` page size, and how many pages one sweep will walk.
 *
 * 🔴 100, NOT THE 500 THIS USED BEFORE 0.2.0. The document store REFUSES a
 * `limit` above 100 (`invalid_request`) rather than clamping it. The 500 was
 * already wrong on the legacy KV: its list route has capped `limit` at 200 since
 * 2026-06-13, so every legacy `list` was refused and — both sweeps swallowing
 * rejections — pruning and purging NEVER ran there. (`kv-store.ts` clamps too;
 * this keeps the request honest at the source.)
 *
 * 20 pages × 100 = 2,000 keys — twice the per-viewer document ceiling (1,000 in
 * the SDK contract fake), so a sweep walks a viewer's whole `kv`
 * collection: full pagination in practice, with a bound that still terminates
 * against a misbehaving cursor.
 */
const LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 20;

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
export function startTurnRecord(appStorage: AppStorage, seed: TurnRecordSeed): TurnRecorder {
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
async function listKeys(appStorage: AppStorage, prefix: string): Promise<string[]> {
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
 * per call and never more than the housekeeping pacer allows, so one mount
 * cannot spend the viewer's write rate clearing a backlog; a larger backlog
 * converges over successive mounts instead.
 *
 * 🔴 IT DOES NOT CONSULT THE SESSION LIST, ON PURPOSE. A version that also swept
 * "orphans" (records whose session was not in `sensei:sessions`) deleted LIVE,
 * charged, `pending` records whenever a session was merely unlisted — no list
 * document yet (a viewer sending on 0.2.0 before the cutover copy), or a
 * cross-tab last-writer-wins overwrite. Leftovers of a bounded
 * {@link purgeSessionTurnRecords} are removed by the cap like any other record
 * — bounded by count, not by time.
 * `turn-records.e2e.test.tsx` pins "unlisted is not deleted".
 */
export async function pruneTurnRecords(
  appStorage: AppStorage,
  max: number = MAX_TURN_RECORDS,
): Promise<number> {
  const keys = await listKeys(appStorage, TURNS_PREFIX);
  if (keys.length <= max) return 0;

  const oldestFirst = [...keys].sort((a, b) => submittedAtFromKey(a) - submittedAtFromKey(b));
  return pacedDelete(appStorage, oldestFirst.slice(0, keys.length - max), PRUNE_DELETE_BUDGET);
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
 * reconciliation to carry and trust a second piece of state; a completed purge
 * removes the false positive with nothing extra to keep in step. The cost is
 * named: a genuine loss inside a conversation that is later deleted becomes
 * undetectable. That is accepted because the transcript it would have been
 * reconciled against is gone too, so nothing could be recovered from knowing.
 *
 * 🔴 BOUNDED AND PACED like the prune ({@link PURGE_DELETE_BUDGET}, the shared
 * {@link HOUSEKEEPING_DELETES_PER_MINUTE}): a chat with hundreds of turns must
 * not spend the viewer's write rate in one click. What is left over is bounded
 * by COUNT, not by time: it goes only when the viewer has written enough newer
 * turns to push it past {@link MAX_TURN_RECORDS}, through the ordinary
 * oldest-first prune — at observed rates that can be months. Until then a
 * reconciliation of these records against transcripts counts them as losses. A
 * named cost,
 * chosen over any sweep keyed on the session list (see {@link pruneTurnRecords}
 * for why that one deleted live records).
 *
 * Returns how many keys it deleted.
 */
export async function purgeSessionTurnRecords(
  appStorage: AppStorage,
  sessionId: string,
): Promise<number> {
  const keys = await listKeys(appStorage, sessionTurnsPrefix(sessionId));
  return pacedDelete(appStorage, keys, PURGE_DELETE_BUDGET);
}
