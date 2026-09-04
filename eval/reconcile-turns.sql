-- ============================================================================
-- RECONCILE PER-TURN SUBMIT RECORDS AGAINST PERSISTED TRANSCRIPTS.
--
-- WHAT IT COUNTS. `sensei:turns:*` holds one record per turn, written by
-- `src/lib/turn-records.ts` BEFORE the send path's first `await`. A record whose
-- `messageId` does not appear in its own session's stored message array is an
-- answer the app started, and in most cases paid for, that never reached the
-- transcript. That is failure mode F1 in the 2026-09-04 reliability diagnosis:
-- two of the sixteen questions that ever reached production were generated,
-- charged, and never landed.
--
-- WHERE TO RUN IT. Against the App Blocks KV database — schema `app_sensei`,
-- table `kv` — as a READ-ONLY query:
--
--   psql "$APPS_DB" -f eval/reconcile-turns.sql
--
-- The connection string is an operator credential and deliberately is not in
-- this repo; the cluster it points at is named in the infra runbook.
--
-- HOW TO READ THE RESULT.
--   lost_answers            > 0  ⇒ F1 is live. Split by the three columns below.
--   a_continuation_never_ran> 0  ⇒ the turn's persist never ran — tab closed,
--                                  unmount, or a superseded turn. The record was
--                                  written at submit and never updated.
--   b_write_rejected        > 0  ⇒ the storage write was issued and REJECTED.
--   c_overwritten           > 0  ⇒ it was written and later overwritten by a
--                                  stale transcript.
--   accepted_discarded      > 0  ⇒ the write-ownership gate refused the write.
--                                  A known, deliberate trade (it also emits
--                                  `reply_discarded_superseded`), NOT a new
--                                  defect. Counted apart from `lost_answers`.
--   lost_never_submitted    > 0  ⇒ the turn ended before it reached the
--                                  orchestrator, so no Buzz was spent. Not F1.
--
-- 🔴 LIMIT, STATED RATHER THAN GLOSSED. Mechanisms (b) and (c) are read off the
-- record's `outcome`, which is updated over the SAME storage as the write it
-- reports on. If the transcript write fails AND that update also fails, the
-- record stays `pending` and (b) is reported as (a). The (a) column is therefore
-- an upper bound on (a), not a measurement of it.
--
-- 🔴 A ZERO HERE HAS TWO CAUSES, AND ONLY ONE OF THEM IS GOOD NEWS. The limit
-- above is about a store that starts failing AFTER submit. If `appStorage.set`
-- is rejecting AT submit — quota, the host's 64 KB per-value ceiling, an
-- anonymous viewer — then NO record is written at all, and a store-wide write
-- failure produces exactly the same `lost_answers = 0` as a healthy app. The
-- discriminator is not in these columns: it is `turn_records` collapsing below
-- the number of questions the app is known to have received, together with the
-- `storage_error` event on the analytics stream. Read `turn_records` FIRST; a
-- zero in the loss columns means nothing until that count looks plausible.
--
-- 🔴 TIMESTAMP CAST. `Message.timestamp` and `TurnRecord.submittedAt` are both
-- epoch MILLISECONDS (`Date.now()`, `number`). `(x)::timestamptz` on those
-- ERRORS OUT — the correct read is `to_timestamp(x::bigint / 1000.0)`, which is
-- what this file uses everywhere.
--
-- 🔴 A MALFORMED `submittedAt` IS TREATED AS OLD, SO THE RECORD STAYS VISIBLE.
-- The cast is guarded by a digits-only test rather than applied directly, and
-- the age filter admits a NULL result. Both halves are load-bearing and neither
-- is defensive boilerplate:
--   - applied directly, `(value->>'submittedAt')::bigint` RAISES on a
--     non-numeric value and aborts the whole report — the instrument fails
--     closed on one bad row;
--   - without `IS NULL OR`, a row whose cast yielded NULL makes the age
--     predicate NULL and is dropped, so a loss disappears behind a malformed
--     field. That is the failure this instrument exists to hunt, hidden by the
--     instrument itself.
-- The digit bound also keeps a 30-digit value from overflowing bigint and
-- raising in its own right. This matches `eval/reconcile-turns.mjs`, which
-- treats a non-finite `submittedAt` as old for the same stated reason: for a
-- detector, a spurious row is caught the moment someone reads it, while a
-- suppressed one is invisible by construction.
--
-- 🔴 DELETED SESSIONS ARE ALMOST NEVER IN HERE — "BY CONSTRUCTION" WAS TOO
-- STRONG. `deleteSession` purges `sensei:turns:<sessionId>:*` alongside the
-- transcript, so a tidied-up chat normally leaves no records to reconcile. But
-- the purge is not gated on an in-flight turn, and `deleteSession` does not take
-- the write-ownership ticket, so a turn that was running keeps `ownsMessageWrite`
-- and its continuation re-creates the record after the purge. That does NOT by
-- itself manufacture a loss: the same continuation's `saveMessages` re-creates
-- `sensei:messages:<sessionId>` carrying the very `messageId` the record names,
-- so record and transcript come back together and the join still matches. It is
-- a strong tendency, not a construction — which matters only because the two
-- read the same way until they don't. If the purge ever regresses, this query's
-- (a) column climbs at the rate people delete chats — read query A2's
-- `session_transcript_exists` column before believing a spike.
--
-- ⚠️ TWO COPIES OF ONE PREDICATE, AND WHAT ACTUALLY HOLDS THEM TOGETHER.
-- `eval/reconcile-turns.mjs` is this predicate in JavaScript so the unit suite
-- can execute it. They are checked against ONE shared fixture set,
-- `eval/reconcile-fixtures.mjs`: `src/reconcile-turns.seam.test.ts` regenerates
-- section B's fixture rows and its `EXPECTED:` line from that file and asserts
-- this file contains them verbatim, so a fixture added on one side goes red.
-- 🔴 THAT PINS THE INPUTS AND THE DECLARED ANSWER — IT DOES NOT PIN THE SQL'S
-- SEMANTICS. Postgres is not available in CI, so nothing executes this file; a
-- wrong predicate here that still declares the right numbers passes every test.
-- The only thing that settles it is a human running section B and comparing:
--
--   psql "$APPS_DB" -f eval/reconcile-turns.sql   # then read section B's row
--                                                 # against its EXPECTED line
--
-- Do that whenever either copy's predicate changes. It needs no production data
-- — section B is literal fixtures — so it is a safe read on any database.
-- ============================================================================

\echo '== A. PRODUCTION =='

WITH turn AS (
  SELECT
    k.block_instance_id,
    k.user_id,
    k.key,
    k.value ->> 'sessionId'                    AS session_id,
    k.value ->> 'messageId'                    AS message_id,
    CASE
      WHEN (k.value ->> 'submittedAt') ~ '^-?[0-9]{1,18}$'
        THEN (k.value ->> 'submittedAt')::bigint
    END                                        AS submitted_at_ms,
    COALESCE(k.value ->> 'outcome', 'pending') AS outcome,
    CASE
      WHEN jsonb_typeof(k.value -> 'workflowIds') = 'array'
        THEN jsonb_array_length(k.value -> 'workflowIds')
      ELSE 0
    END                                        AS workflow_count
  FROM app_sensei.kv k
  WHERE k.key LIKE 'sensei:turns:%'
),
msg AS (
  SELECT
    k.block_instance_id,
    k.user_id,
    split_part(k.key, ':', 3) AS session_id,
    m ->> 'id'                AS message_id
  FROM app_sensei.kv k
  CROSS JOIN LATERAL jsonb_array_elements(k.value) m
  WHERE k.key LIKE 'sensei:messages:%'
    AND jsonb_typeof(k.value) = 'array'
),
graded AS (
  SELECT
    t.*,
    to_timestamp(t.submitted_at_ms / 1000.0) AS submitted_at,
    NOT EXISTS (
      SELECT 1 FROM msg m
      WHERE m.block_instance_id = t.block_instance_id
        AND m.user_id           = t.user_id
        AND m.session_id        = t.session_id
        AND m.message_id        = t.message_id
    ) AS lost
  FROM turn t
  -- A turn still in flight is not a loss. The bridge's poll deadline is 60 s and
  -- the reply is then replayed to the screen before it is written, so five
  -- minutes is comfortably past any turn that is going to land. A record with no
  -- usable timestamp counts as old rather than being dropped — see the header.
  WHERE t.submitted_at_ms IS NULL
     OR to_timestamp(t.submitted_at_ms / 1000.0) < now() - interval '5 minutes'
)
SELECT
  count(*)                                                                          AS turn_records,
  count(*) FILTER (WHERE lost AND workflow_count > 0 AND outcome <> 'discarded')     AS lost_answers,
  -- 🔴 SPELLED AS A COMPLEMENT, NOT AS `= 'pending'`, SO THE THREE MECHANISM
  -- COLUMNS SUM TO `lost_answers` EXACTLY. An outcome this query has never heard
  -- of would otherwise vanish from the decomposition while still being counted
  -- as a loss, and the arithmetic is the cheapest check a reader has.
  count(*) FILTER (WHERE lost AND workflow_count > 0
                   AND outcome NOT IN ('write-failed', 'saved', 'discarded'))       AS a_continuation_never_ran,
  count(*) FILTER (WHERE lost AND workflow_count > 0 AND outcome = 'write-failed')   AS b_write_rejected,
  count(*) FILTER (WHERE lost AND workflow_count > 0 AND outcome = 'saved')          AS c_overwritten,
  count(*) FILTER (WHERE lost AND workflow_count > 0 AND outcome = 'discarded')      AS accepted_discarded,
  count(*) FILTER (WHERE lost AND workflow_count = 0)                                AS lost_never_submitted
FROM graded;

\echo '== A2. THE LOST TURNS THEMSELVES =='

WITH turn AS (
  SELECT
    k.block_instance_id,
    k.user_id,
    k.value ->> 'sessionId'                    AS session_id,
    k.value ->> 'messageId'                    AS message_id,
    CASE
      WHEN (k.value ->> 'submittedAt') ~ '^-?[0-9]{1,18}$'
        THEN (k.value ->> 'submittedAt')::bigint
    END                                        AS submitted_at_ms,
    COALESCE(k.value ->> 'outcome', 'pending') AS outcome,
    CASE
      WHEN jsonb_typeof(k.value -> 'workflowIds') = 'array'
        THEN k.value -> 'workflowIds'
      ELSE '[]'::jsonb
    END                                        AS workflow_ids
  FROM app_sensei.kv k
  WHERE k.key LIKE 'sensei:turns:%'
),
msg AS (
  SELECT
    k.block_instance_id,
    k.user_id,
    split_part(k.key, ':', 3) AS session_id,
    m ->> 'id'                AS message_id
  FROM app_sensei.kv k
  CROSS JOIN LATERAL jsonb_array_elements(k.value) m
  WHERE k.key LIKE 'sensei:messages:%'
    AND jsonb_typeof(k.value) = 'array'
)
SELECT
  t.user_id,
  t.session_id,
  t.message_id,
  to_timestamp(t.submitted_at_ms / 1000.0) AS submitted_at,
  t.outcome,
  t.workflow_ids,
  -- Distinguishes "the transcript exists and this message is not in it" from
  -- "there is no transcript at all", which is what a regressed delete-purge
  -- would look like.
  EXISTS (
    SELECT 1 FROM app_sensei.kv s
    WHERE s.block_instance_id = t.block_instance_id
      AND s.user_id           = t.user_id
      AND s.key               = 'sensei:messages:' || t.session_id
  ) AS session_transcript_exists
FROM turn t
-- Same age rule as query A, including the malformed-timestamp arm. A NULL
-- `submitted_at` sorts first under `DESC`, which puts any malformed record at
-- the top of the listing where it will be noticed.
WHERE (t.submitted_at_ms IS NULL
       OR to_timestamp(t.submitted_at_ms / 1000.0) < now() - interval '5 minutes')
  AND NOT EXISTS (
    SELECT 1 FROM msg m
    WHERE m.block_instance_id = t.block_instance_id
      AND m.user_id           = t.user_id
      AND m.session_id        = t.session_id
      AND m.message_id        = t.message_id
  )
ORDER BY submitted_at DESC
LIMIT 100;

-- ============================================================================
-- B. POSITIVE CONTROL — run it in the same session as A.
--
-- 🔴 A ZERO FROM QUERY A IS INDISTINGUISHABLE FROM A QUERY WIRED TO NOTHING
-- until this has been watched return a NON-ZERO count. It is query A's grading
-- body with the two source CTEs replaced by literal fixtures and nothing else
-- changed, so it exercises the same joins, the same guarded cast, the same
-- `to_timestamp` and the same FILTER predicates against a store that is known to
-- contain exactly three lost answers.
--
-- 🔴 IT IS ALSO THE CROSS-CHECK AGAINST THE JAVASCRIPT COPY. The fixture rows
-- and the EXPECTED line below are GENERATED from `eval/reconcile-fixtures.mjs`
-- and asserted verbatim by `src/reconcile-turns.seam.test.ts`, which runs
-- `eval/reconcile-turns.mjs` over the same rows and requires the same numbers.
-- Editing either block by hand fails that test. Running THIS query and reading
-- its row against the EXPECTED line is the step no test can perform, because
-- Postgres is not available in CI — it is the only check on the SQL's semantics.
--
-- The last two fixture turns carry a malformed `submittedAt` (absent, and
-- non-numeric). Against the pre-2026-09-04 form of this query the first was
-- silently dropped and the second RAISED, so they are the negative control for
-- the guarded cast as well as fixtures.
-- ============================================================================

\echo '== B. POSITIVE CONTROL (expect lost_answers = 3) =='

-- >>> SHARED FIXTURE EXPECTATION (generated from eval/reconcile-fixtures.mjs)
-- EXPECTED: turn_records=6 lost_answers=3 a_continuation_never_ran=2 b_write_rejected=1 c_overwritten=0 accepted_discarded=1 lost_never_submitted=1
-- <<< SHARED FIXTURE EXPECTATION

WITH kv(block_instance_id, user_id, key, value) AS (
  VALUES
-- >>> SHARED FIXTURE ROWS (generated from eval/reconcile-fixtures.mjs)
    ('bi', 1, 'sensei:turns:session-A:1000000000000:msg-landed',
       '{"sessionId":"session-A","messageId":"msg-landed","submittedAt":1000000000000,"workflowIds":["wf-1"],"outcome":"saved"}'::jsonb),
    ('bi', 1, 'sensei:turns:session-A:1000000001000:msg-lost',
       '{"sessionId":"session-A","messageId":"msg-lost","submittedAt":1000000001000,"workflowIds":["wf-2"],"outcome":"pending"}'::jsonb),
    ('bi', 1, 'sensei:turns:session-A:1000000002000:msg-never-sent',
       '{"sessionId":"session-A","messageId":"msg-never-sent","submittedAt":1000000002000,"workflowIds":[],"outcome":"pending"}'::jsonb),
    ('bi', 1, 'sensei:turns:session-A:1000000003000:msg-superseded',
       '{"sessionId":"session-A","messageId":"msg-superseded","submittedAt":1000000003000,"workflowIds":["wf-3"],"outcome":"discarded"}'::jsonb),
    ('bi', 1, 'sensei:turns:session-A:1000000004000:msg-no-timestamp',
       '{"sessionId":"session-A","messageId":"msg-no-timestamp","workflowIds":["wf-4"],"outcome":"pending"}'::jsonb),
    ('bi', 1, 'sensei:turns:session-A:1000000005000:msg-bad-timestamp',
       '{"sessionId":"session-A","messageId":"msg-bad-timestamp","submittedAt":"not-a-number","workflowIds":["wf-5"],"outcome":"write-failed"}'::jsonb),
    ('bi', 1, 'sensei:messages:session-A',
       '[{"id":"msg-user","role":"user","timestamp":1000000000000},{"id":"msg-landed","role":"assistant","timestamp":1000000000500}]'::jsonb)
-- <<< SHARED FIXTURE ROWS
),
turn AS (
  SELECT
    k.block_instance_id,
    k.user_id,
    k.key,
    k.value ->> 'sessionId'                    AS session_id,
    k.value ->> 'messageId'                    AS message_id,
    CASE
      WHEN (k.value ->> 'submittedAt') ~ '^-?[0-9]{1,18}$'
        THEN (k.value ->> 'submittedAt')::bigint
    END                                        AS submitted_at_ms,
    COALESCE(k.value ->> 'outcome', 'pending') AS outcome,
    CASE
      WHEN jsonb_typeof(k.value -> 'workflowIds') = 'array'
        THEN jsonb_array_length(k.value -> 'workflowIds')
      ELSE 0
    END                                        AS workflow_count
  FROM kv k
  WHERE k.key LIKE 'sensei:turns:%'
),
msg AS (
  SELECT
    k.block_instance_id,
    k.user_id,
    split_part(k.key, ':', 3) AS session_id,
    m ->> 'id'                AS message_id
  FROM kv k
  CROSS JOIN LATERAL jsonb_array_elements(k.value) m
  WHERE k.key LIKE 'sensei:messages:%'
    AND jsonb_typeof(k.value) = 'array'
),
graded AS (
  SELECT
    t.*,
    to_timestamp(t.submitted_at_ms / 1000.0) AS submitted_at,
    NOT EXISTS (
      SELECT 1 FROM msg m
      WHERE m.block_instance_id = t.block_instance_id
        AND m.user_id           = t.user_id
        AND m.session_id        = t.session_id
        AND m.message_id        = t.message_id
    ) AS lost
  FROM turn t
  WHERE t.submitted_at_ms IS NULL
     OR to_timestamp(t.submitted_at_ms / 1000.0) < now() - interval '5 minutes'
)
SELECT
  count(*)                                                                          AS turn_records,
  count(*) FILTER (WHERE lost AND workflow_count > 0 AND outcome <> 'discarded')     AS lost_answers,
  -- 🔴 SPELLED AS A COMPLEMENT, NOT AS `= 'pending'`, SO THE THREE MECHANISM
  -- COLUMNS SUM TO `lost_answers` EXACTLY. An outcome this query has never heard
  -- of would otherwise vanish from the decomposition while still being counted
  -- as a loss, and the arithmetic is the cheapest check a reader has.
  count(*) FILTER (WHERE lost AND workflow_count > 0
                   AND outcome NOT IN ('write-failed', 'saved', 'discarded'))       AS a_continuation_never_ran,
  count(*) FILTER (WHERE lost AND workflow_count > 0 AND outcome = 'write-failed')   AS b_write_rejected,
  count(*) FILTER (WHERE lost AND workflow_count > 0 AND outcome = 'saved')          AS c_overwritten,
  count(*) FILTER (WHERE lost AND workflow_count > 0 AND outcome = 'discarded')      AS accepted_discarded,
  count(*) FILTER (WHERE lost AND workflow_count = 0)                                AS lost_never_submitted
FROM graded;
