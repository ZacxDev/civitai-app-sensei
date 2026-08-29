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
// ─────────────────────────────────────────────────────────────────────────────

/** sessionId → the ticket number of the most recent claimant. */
const writeSeq = new Map<string, number>();

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
