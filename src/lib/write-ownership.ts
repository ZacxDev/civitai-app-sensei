// ─────────────────────────────────────────────────────────────────────────────
// 🔴 WRITE OWNERSHIP FOR A SESSION'S MESSAGE KEY — MODULE-SCOPED ON PURPOSE.
//
// `App` already has an ownership primitive: `turnSeqRef`, a monotonic turn
// counter answering "is my turn still the one that owns the shared state". This
// is the SAME concept at the SCOPE OF THE SHARED THING, and the scope is the
// whole point.
//
// `turnSeqRef` is a `useRef`, so it belongs to one component instance. When the
// block unmounts mid-turn nothing aborts the turn — it keeps polling and
// eventually writes — and if a NEW instance has mounted since, that instance has
// a fresh `turnSeqRef` starting at 0. The stranded turn therefore still
// evaluates `turnSeqRef.current === mine` as TRUE and believes it owns state it
// no longer owns. The in-component check is structurally blind across an
// unmount, and so is every abort predicate: the stranded turn was never aborted.
//
// The resource actually being protected is a STORAGE KEY, which outlives every
// component instance. So the ticket lives here, at module scope, where the
// resource does. (clawgate #425.)
//
// 🔴 WHY NOT READ-BACK-AND-MERGE, WHICH WOULD LOSE NOTHING. Because it is not
// available: `sessions.ts`'s header records the measurement that the deployed
// host CANNOT SERVE A BLOCK ITS OWN WRITE (civitai's QueryClient sets
// `staleTime: Infinity` and `APP_STORAGE_SET` performs no invalidation; the host
// fix, civitai #4456, is absent from the branch prod deploys from). A read is
// not a sound basis for a conditional write here, so the writer must decide from
// state it holds rather than from state it reads.
//
// 🔴 THE ACCEPTED TRADE, STATED RATHER THAN HIDDEN. When a stranded turn loses
// the ticket its reply is DISCARDED, so the viewer paid for a reply that never
// reaches storage. That is a real cost. It is accepted because the alternative
// is permanently deleting a NEWER message the viewer wrote — the defect measured
// on the live store — and because merging the two needs the read-back above.
//
// Growth is bounded by the number of sessions a single page life ever touches
// (a handful of entries, one small number each), so there is deliberately no
// eviction path to get wrong.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE TICKET ALONE IS NOT ENOUGH, AND THIS IS THE MEASURED HOLE IT LEAVES.
//
// `ownsMessageWrite` is asked BEFORE the write is issued, so it can only refuse
// a write ISSUED after somebody newer claimed. It says nothing about a write
// issued while this writer WAS the owner and still in flight when the next one
// claims — and an in-flight `set` cannot be revoked by anybody, ticket or not.
// On a last-writer-wins key the surviving value is decided by the order writes
// LAND, so an authorised-but-slow write landing last overwrites everything the
// newer claimant wrote in the meantime.
//
// MEASURED (rank 33). Turn 1's reply write is in flight; the viewer presses Stop
// and sends a second question inside that window. Turn 2 claims the ticket,
// writes its user message and then its reply — and turn 1's write, authorised
// before any of that existed, lands LAST. The stored array ends `[user,
// assistant]`: the second question and its paid-for reply are gone. Neither the
// ticket nor the reply-monotonicity ledger can see it — the ticket was valid
// when the write was issued, and the losing sequence GROWS rather than shortens.
//
// 🔴 SO THE SECOND MECHANISM IS ORDER, NOT PERMISSION. `serializeMessageWrite`
// chains every write of one session's message key behind the previous one, so
// writes LAND in the order they were ISSUED. Combined with the ticket that gives
// the property the key actually needs: a write lands only if its issuer owned
// the key when it was issued, and the last write to land is the newest one
// issued. There is no window left in which an older writer's array is the final
// value.
//
// 🔴 THE COST, STATED RATHER THAN HIDDEN: a write now WAITS for the previous
// write on the same session instead of racing it. In the ordinary case the chain
// is empty and nothing is delayed. When it is not — which is exactly the
// dangerous case — the newer writer is delayed by at most the round trips ahead
// of it, and `handleSend` awaits its own user-message write before submitting,
// so a genuinely stuck `set` now delays the next send instead of letting it
// proceed and lose data. Delaying a write is recoverable; losing one is not.
//
// 🔴 WHAT THIS DELIBERATELY DOES **NOT** DO. It does not merge, so a stopped
// turn's frozen partial reply can still be the array a later write is built
// from — that is the window documented on `StreamingTurn.replyPersisted`, and it
// is a content question, not an ordering one. And it does not resurrect the
// discarded-reply trade above: a write whose ticket is already stale when it is
// issued is still refused, and still counted.
// ─────────────────────────────────────────────────────────────────────────────

/** sessionId → the ticket number of the most recent claimant. */
const writeSeq = new Map<string, number>();

/**
 * sessionId → the tail of the promise chain ordering that session's writes.
 *
 * The tail has its rejection swallowed so ONE failed write cannot wedge the
 * session's queue for the life of the page; the caller still receives its own
 * write's rejection from {@link serializeMessageWrite}, which is what `persist`
 * turns into the viewer-visible banner and the `write-failed` turn outcome.
 *
 * Bounded exactly like `writeSeq` — one entry per session this page life ever
 * writes to — so there is deliberately no eviction path to get wrong.
 */
const writeChain = new Map<string, Promise<void>>();

const swallow = () => undefined;

/**
 * Take ownership of a session's message key and get a ticket for it.
 *
 * Call this at the moment a writer commits to a transcript — before its first
 * write — and hold the returned ticket for the life of that write sequence.
 * Claiming SUPERSEDES every earlier claimant on the same session, which is the
 * mechanism: a later writer does not have to find the stranded turn, it simply
 * makes the stranded turn's ticket stale.
 */
export function claimMessageWrite(sessionId: string): number {
  const next = (writeSeq.get(sessionId) ?? 0) + 1;
  writeSeq.set(sessionId, next);
  return next;
}

/**
 * Whether `ticket` is still the current claim on `sessionId`.
 *
 * A deferred write — one that settles after an `await` — must ask this before
 * writing. `false` means somebody newer owns the transcript now and this
 * writer's array predates theirs.
 */
export function ownsMessageWrite(sessionId: string, ticket: number): boolean {
  return writeSeq.get(sessionId) === ticket;
}

/**
 * Run `write` after every write already issued for `sessionId` has settled.
 *
 * 🔴 THIS IS THE ORDERING HALF OF THE FIX — see the header. The ticket decides
 * WHETHER a write may be issued; this decides WHEN it runs, and on a
 * last-writer-wins key the second question is the one that decides what
 * survives. Every write of a session's message key must go through here or the
 * guarantee is only as strong as the call site that forgot: `sessions.ts` routes
 * `saveMessages` and `deleteMessages` through it so no caller has to remember.
 *
 * Returns the write's own promise — its value and its rejection both reach the
 * caller unchanged, so `persist` still reports a failed write exactly as before.
 */
export function serializeMessageWrite<T>(sessionId: string, write: () => Promise<T>): Promise<T> {
  const previous = writeChain.get(sessionId) ?? Promise.resolve();
  const result = previous.then(write);
  writeChain.set(sessionId, result.then(swallow, swallow));
  return result;
}
