/**
 * THE ONE FIXTURE SET BOTH RECONCILIATION COPIES ARE GRADED AGAINST.
 *
 * 🔴 WHY THIS FILE EXISTS. `eval/reconcile-turns.sql` produces the operator's
 * number; `eval/reconcile-turns.mjs` is the same predicate in JavaScript so the
 * suite can execute it. Both files already carried a comment saying they must be
 * edited together — and they disagreed on their very first day, on a record
 * whose `submittedAt` is absent or non-numeric. A comment is not a mechanism.
 *
 * 🔴 WHAT THIS MECHANISM DOES AND DOES NOT PIN, STATED PRECISELY, BECAUSE THE
 * TEMPTATION IS TO READ IT AS MORE.
 *   - IT PINS: that both copies are graded against the SAME inputs and the SAME
 *     declared expected outputs. `src/reconcile-turns.seam.test.ts` regenerates
 *     the SQL's fixture block and its `EXPECTED:` line from THIS file and
 *     asserts the SQL contains them verbatim, and separately runs
 *     `reconcileTurns` over these rows and asserts it produces the same numbers.
 *     Adding, changing or removing a fixture on either side goes red.
 *   - IT DOES NOT PIN: that the SQL's *predicate* agrees with the JavaScript
 *     one. Postgres is not available in CI, so nothing here EXECUTES the SQL. A
 *     wrong SQL predicate that still declares the right expected numbers passes
 *     this test. Closing that needs a human to run section B of the query
 *     against a database and compare — the manual step is written into the
 *     SQL's own header, and it is the only thing that settles the semantics.
 *
 * Plain `.mjs` with NO imports, matching `reconcile-turns.mjs`: it has to load
 * under bare `node` beside the rest of the eval tooling, with no build step.
 */

/**
 * Rows shaped exactly like `app_sensei.kv`.
 *
 * The six turns are, in order: one that landed (must NOT count), one charged and
 * never persisted (a loss), one refused before any submit (no workflow id — not
 * an answer), one discarded by the write-ownership gate (a known trade, counted
 * apart), and then the two malformed-timestamp records that this fixture set
 * exists to force both copies to agree about.
 *
 * 🔴 THE MALFORMED PAIR IS THE POINT. A record's KEY always carries a numeric
 * `submittedAt` — `turnRecordKey` builds it from a `number` — so a bad value can
 * only ever appear in the stored VALUE, which is what both copies read. Before
 * this pair existed, the JavaScript treated such a record as OLD and counted it,
 * while `(value->>'submittedAt')::bigint` made the SQL's age predicate NULL and
 * dropped the row outright — and on the non-numeric one that cast RAISED and
 * aborted the whole report. Production under-reported; the tested copy
 * over-reported.
 */
export const RECONCILE_FIXTURES = [
  {
    block_instance_id: 'bi',
    user_id: 1,
    key: 'sensei:turns:session-A:1000000000000:msg-landed',
    value: {
      sessionId: 'session-A',
      messageId: 'msg-landed',
      submittedAt: 1000000000000,
      workflowIds: ['wf-1'],
      outcome: 'saved',
    },
  },
  {
    block_instance_id: 'bi',
    user_id: 1,
    key: 'sensei:turns:session-A:1000000001000:msg-lost',
    value: {
      sessionId: 'session-A',
      messageId: 'msg-lost',
      submittedAt: 1000000001000,
      workflowIds: ['wf-2'],
      outcome: 'pending',
    },
  },
  {
    block_instance_id: 'bi',
    user_id: 1,
    key: 'sensei:turns:session-A:1000000002000:msg-never-sent',
    value: {
      sessionId: 'session-A',
      messageId: 'msg-never-sent',
      submittedAt: 1000000002000,
      workflowIds: [],
      outcome: 'pending',
    },
  },
  {
    block_instance_id: 'bi',
    user_id: 1,
    key: 'sensei:turns:session-A:1000000003000:msg-superseded',
    value: {
      sessionId: 'session-A',
      messageId: 'msg-superseded',
      submittedAt: 1000000003000,
      workflowIds: ['wf-3'],
      outcome: 'discarded',
    },
  },
  {
    block_instance_id: 'bi',
    user_id: 1,
    key: 'sensei:turns:session-A:1000000004000:msg-no-timestamp',
    value: {
      sessionId: 'session-A',
      messageId: 'msg-no-timestamp',
      workflowIds: ['wf-4'],
      outcome: 'pending',
    },
  },
  {
    block_instance_id: 'bi',
    user_id: 1,
    key: 'sensei:turns:session-A:1000000005000:msg-bad-timestamp',
    value: {
      sessionId: 'session-A',
      messageId: 'msg-bad-timestamp',
      submittedAt: 'not-a-number',
      workflowIds: ['wf-5'],
      outcome: 'write-failed',
    },
  },
  {
    block_instance_id: 'bi',
    user_id: 1,
    key: 'sensei:messages:session-A',
    value: [
      { id: 'msg-user', role: 'user', timestamp: 1000000000000 },
      { id: 'msg-landed', role: 'assistant', timestamp: 1000000000500 },
    ],
  },
];

/**
 * The counts BOTH copies must produce over {@link RECONCILE_FIXTURES}.
 *
 * Named with the SQL's column names, because those are what an operator reads
 * off the screen; the JavaScript's camelCase keys are mapped in the seam test.
 *
 * The three mechanism columns sum to `lost_answers` exactly — that arithmetic is
 * the cheapest check a reader has, and it is asserted rather than assumed.
 */
export const RECONCILE_EXPECTED = {
  turn_records: 6,
  lost_answers: 3,
  a_continuation_never_ran: 2,
  b_write_rejected: 1,
  c_overwritten: 0,
  accepted_discarded: 1,
  lost_never_submitted: 1,
};

/** Marker lines that delimit the generated regions of `reconcile-turns.sql`. */
export const SQL_FIXTURE_BEGIN = '-- >>> SHARED FIXTURE ROWS (generated from eval/reconcile-fixtures.mjs)';
export const SQL_FIXTURE_END = '-- <<< SHARED FIXTURE ROWS';
export const SQL_EXPECTED_BEGIN =
  '-- >>> SHARED FIXTURE EXPECTATION (generated from eval/reconcile-fixtures.mjs)';
export const SQL_EXPECTED_END = '-- <<< SHARED FIXTURE EXPECTATION';

/**
 * Render {@link RECONCILE_FIXTURES} as the SQL `VALUES` rows of section B.
 *
 * The seam test asserts the SQL file contains this text verbatim, so this
 * function — not a human — decides what those rows say.
 */
export function renderSqlFixtureRows() {
  const rows = RECONCILE_FIXTURES.map(
    (r) =>
      `    ('${r.block_instance_id}', ${r.user_id}, '${r.key}',\n` +
      `       '${JSON.stringify(r.value)}'::jsonb)`,
  );
  return [SQL_FIXTURE_BEGIN, rows.join(',\n'), SQL_FIXTURE_END].join('\n');
}

/** Render {@link RECONCILE_EXPECTED} as the SQL's `EXPECTED:` comment line. */
export function renderSqlExpectation() {
  const body = Object.entries(RECONCILE_EXPECTED)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  return [SQL_EXPECTED_BEGIN, `-- EXPECTED: ${body}`, SQL_EXPECTED_END].join('\n');
}
