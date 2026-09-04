/**
 * Reconcile `sensei:turns:*` records against `sensei:messages:*` transcripts.
 *
 * 🔴 WHAT THIS IS FOR, AND WHAT IT IS NOT. `eval/reconcile-turns.sql` is the
 * query that runs against production; this is the same predicate in JavaScript
 * so it can be EXECUTED by the unit suite. Its job is the positive control the
 * SQL cannot have in CI — a store containing a known lost answer must make the
 * count move — and to pin the seam between the record shape written by
 * `src/lib/turn-records.ts` and the field names the reconciliation reads. A
 * renamed field breaks a test here instead of silently returning zero forever.
 *
 * ⚠️ TWO COPIES OF ONE PREDICATE, STATED RATHER THAN HIDDEN. The SQL is what
 * produces the operator's number; this is what proves the number can be
 * non-zero. They must be edited together. The seam test in
 * `src/reconcile-turns.test.ts` feeds a record produced by the REAL writer, so
 * at least the field names cannot drift silently on this side.
 *
 * Plain `.mjs` with NO imports, matching `reply-outcome.mjs`: it must load under
 * bare `node` and be importable by a test without a build step.
 */

/** Grace period, ms. A turn younger than this may still be in flight. */
export const SETTLE_GRACE_MS = 5 * 60_000;

/**
 * @param {Array<{key: string, value: any, user_id?: number|string, block_instance_id?: string}>} rows
 *   Rows straight out of `app_sensei.kv` (or, in a test, a fake KV's contents).
 * @param {{now?: number, graceMs?: number}} [opts]
 */
export function reconcileTurns(rows, opts = {}) {
  const now = opts.now ?? Date.now();
  const graceMs = opts.graceMs ?? SETTLE_GRACE_MS;
  const scope = (r) => `${r.block_instance_id ?? ''}|${r.user_id ?? ''}`;

  // Every message id that IS persisted, keyed by (scope, session).
  const persisted = new Map();
  const transcripts = new Set();
  for (const r of rows) {
    if (!r.key.startsWith('sensei:messages:')) continue;
    if (!Array.isArray(r.value)) continue;
    const sessionId = r.key.split(':')[2];
    const k = `${scope(r)}|${sessionId}`;
    transcripts.add(k);
    let ids = persisted.get(k);
    if (!ids) persisted.set(k, (ids = new Set()));
    for (const m of r.value) if (m && typeof m.id === 'string') ids.add(m.id);
  }

  const out = {
    turnRecords: 0,
    lostAnswers: 0,
    aContinuationNeverRan: 0,
    bWriteRejected: 0,
    cOverwritten: 0,
    acceptedDiscarded: 0,
    lostNeverSubmitted: 0,
    lost: [],
  };

  for (const r of rows) {
    if (!r.key.startsWith('sensei:turns:')) continue;
    const v = r.value ?? {};
    const submittedAt = Number(v.submittedAt);
    // Epoch MILLISECONDS, the same convention as `Message.timestamp`. A record
    // with no usable timestamp is treated as old rather than dropped — dropping
    // it would hide a loss behind a malformed field.
    const ageOk = !Number.isFinite(submittedAt) || submittedAt < now - graceMs;
    if (!ageOk) continue;

    out.turnRecords += 1;

    const k = `${scope(r)}|${v.sessionId}`;
    const ids = persisted.get(k);
    const lost = !(ids && ids.has(v.messageId));
    if (!lost) continue;

    const outcome = typeof v.outcome === 'string' ? v.outcome : 'pending';
    const workflowCount = Array.isArray(v.workflowIds) ? v.workflowIds.length : 0;

    if (workflowCount === 0) {
      // Never reached the orchestrator, so nothing was charged. Not F1.
      out.lostNeverSubmitted += 1;
    } else if (outcome === 'discarded') {
      // The write-ownership gate refused the write — a known, deliberate trade.
      out.acceptedDiscarded += 1;
    } else {
      out.lostAnswers += 1;
      if (outcome === 'write-failed') out.bWriteRejected += 1;
      else if (outcome === 'saved') out.cOverwritten += 1;
      else out.aContinuationNeverRan += 1;
    }

    out.lost.push({
      key: r.key,
      sessionId: v.sessionId,
      messageId: v.messageId,
      submittedAt,
      outcome,
      workflowIds: Array.isArray(v.workflowIds) ? v.workflowIds : [],
      sessionTranscriptExists: transcripts.has(k),
    });
  }

  return out;
}
