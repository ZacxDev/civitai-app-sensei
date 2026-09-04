import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error - plain .mjs with no types, by design. See the file header.
import { reconcileTurns } from '../eval/reconcile-turns.mjs';
import {
  RECONCILE_FIXTURES,
  RECONCILE_EXPECTED,
  renderSqlFixtureRows,
  renderSqlExpectation,
  // @ts-expect-error - same arrangement: plain .mjs, no build step.
} from '../eval/reconcile-fixtures.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE SEAM BETWEEN THE TWO RECONCILIATION COPIES.
//
// `eval/reconcile-turns.sql` produces the operator's number. `eval/
// reconcile-turns.mjs` is the same predicate in JavaScript so the suite can
// execute it. Both files carried a comment saying they must be edited together,
// and they DISAGREED ON DAY ONE: on a record whose `submittedAt` is absent or
// non-numeric, the JavaScript deliberately treated it as OLD (so a loss cannot
// hide behind a malformed field) while `(value->>'submittedAt')::bigint` made
// the SQL's age predicate NULL and dropped the row — and on a non-numeric value
// that cast RAISED and aborted the whole report. Production under-reported, the
// tested copy over-reported, and nothing could see it. A comment is not a
// mechanism.
//
// 🔴 WHAT THIS FILE PINS, AND WHAT IT DOES NOT. It pins that both copies are
// graded against ONE fixture set and ONE declared answer: the SQL's fixture
// rows and its `EXPECTED:` line are GENERATED from `eval/reconcile-fixtures.mjs`
// and asserted verbatim, and the JavaScript is executed over the same rows and
// required to produce the same numbers. Change a fixture on either side and this
// goes red.
//
// It does NOT pin that the SQL's predicate agrees with the JavaScript one.
// Postgres is not available in CI, so nothing here EXECUTES the SQL; a wrong
// predicate that still declares the right numbers passes every case below. That
// is why the last case pins the *shape* of the two expressions the two copies
// most recently disagreed about — a structural check is weaker than running the
// query, and it is stated as such — and why the SQL's own header carries the
// manual step (`psql -f eval/reconcile-turns.sql`, read section B against its
// EXPECTED line) as the only thing that settles the semantics.
//
// Measured against a live Postgres on 2026-09-04, over exactly these fixtures:
// the fixed query returns 6|3|2|1|0|1|1, matching `reconcileTurns` and the
// EXPECTED line. The pre-fix query ABORTED with `invalid input syntax for type
// bigint: "not-a-number"`, and with that row removed returned 4|1|1|0|0|1|1 —
// dropping the absent-timestamp record and one charged loss with it.
// ─────────────────────────────────────────────────────────────────────────────

const SQL = readFileSync(resolve(process.cwd(), 'eval/reconcile-turns.sql'), 'utf8');

/** `reconcileTurns`' camelCase output, under the SQL's column names. */
function jsCountsAsSqlColumns(out: Record<string, number>) {
  return {
    turn_records: out.turnRecords,
    lost_answers: out.lostAnswers,
    a_continuation_never_ran: out.aContinuationNeverRan,
    b_write_rejected: out.bWriteRejected,
    c_overwritten: out.cOverwritten,
    accepted_discarded: out.acceptedDiscarded,
    lost_never_submitted: out.lostNeverSubmitted,
  };
}

describe('the SQL and the JavaScript reconciliation answer one fixture set', () => {
  it('🔴 the JavaScript copy produces the declared expectation', () => {
    // The fixtures are timestamped in 2001, so any real clock puts every one of
    // them outside the settle grace window — the same thing `now() - interval
    // '5 minutes'` does on the SQL side.
    const out = reconcileTurns(RECONCILE_FIXTURES, { now: Date.now() });
    expect(jsCountsAsSqlColumns(out)).toEqual(RECONCILE_EXPECTED);
  });

  it('🔴 the three mechanism columns sum to `lost_answers`', () => {
    // The decomposition arithmetic both copies claim in their own comments. A
    // fixture carrying an outcome neither copy has heard of would break it.
    const e = RECONCILE_EXPECTED as Record<string, number>;
    expect(e.a_continuation_never_ran + e.b_write_rejected + e.c_overwritten).toBe(e.lost_answers);
  });

  it('🔴 the SQL grades the SAME fixtures — generated, not hand-copied', () => {
    const expectedBlock = renderSqlFixtureRows();
    expect(
      SQL.includes(expectedBlock),
      'eval/reconcile-turns.sql section B no longer contains the fixture rows generated from ' +
        'eval/reconcile-fixtures.mjs. Regenerate it with renderSqlFixtureRows(). Expected block:\n' +
        expectedBlock,
    ).toBe(true);
  });

  it('🔴 the SQL declares the SAME expected answer', () => {
    const expectedLine = renderSqlExpectation();
    expect(
      SQL.includes(expectedLine),
      'eval/reconcile-turns.sql section B no longer declares the expectation generated from ' +
        'eval/reconcile-fixtures.mjs. Regenerate it with renderSqlExpectation(). Expected:\n' +
        expectedLine,
    ).toBe(true);
  });

  it('🔴 a malformed `submittedAt` is VISIBLE in both copies, not dropped', () => {
    // The direction decision itself, asserted rather than described: for a
    // detector, a spurious row is caught the moment somebody reads it while a
    // suppressed one is invisible by construction, so both copies fail toward
    // visibility. This is the JavaScript half.
    const malformed = RECONCILE_FIXTURES.filter(
      (r: { key: string; value: Record<string, unknown> }) =>
        r.key.startsWith('sensei:turns:') && typeof r.value.submittedAt !== 'number',
    );
    expect(malformed, 'the fixture set must contain the case the two copies disagreed on').toHaveLength(
      2,
    );

    const out = reconcileTurns(RECONCILE_FIXTURES, { now: Date.now() });
    const lostIds = new Set(out.lost.map((l: { messageId: string }) => l.messageId));
    for (const r of malformed) {
      expect(
        lostIds.has(r.value.messageId as string),
        `${r.value.messageId as string} must be reported, not dropped for having a malformed timestamp`,
      ).toBe(true);
    }
  });

  it('🔴 the SQL half: every timestamp cast is guarded and every age filter admits NULL', () => {
    // ⚠️ STRUCTURAL, AND WEAKER THAN RUNNING THE QUERY. This cannot tell you the
    // SQL is correct; it can only tell you nobody has reverted the two
    // expressions the copies most recently disagreed about. The semantics are
    // settled by the manual step in the SQL's header, not here.
    //
    // Three `turn` CTEs (A, A2, B) and three age filters, so each count is 3.
    const guardedCasts = SQL.match(
      /WHEN \(k\.value ->> 'submittedAt'\) ~ '\^-\?\[0-9\]\{1,18\}\$'/g,
    );
    expect(guardedCasts, 'the digits-guarded cast must appear in all three queries').toHaveLength(3);

    const nullTolerantFilters = SQL.match(/t\.submitted_at_ms IS NULL/g);
    expect(
      nullTolerantFilters,
      'all three age filters must admit a NULL timestamp, or a loss hides behind a malformed field',
    ).toHaveLength(3);

    // 🔴 THE NEGATIVE HALF, AND THE ONE THAT ACTUALLY BITES. The counts above
    // stay correct if somebody ADDS an unguarded cast beside the guarded ones,
    // which is exactly how the defect returns.
    expect(
      SQL.includes("(k.value ->> 'submittedAt')::bigint        AS submitted_at_ms"),
      'an unguarded ::bigint cast is back — it RAISES on a non-numeric value and aborts the report',
    ).toBe(false);
  });
});
