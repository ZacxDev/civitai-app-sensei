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
-- 🔴 TIMESTAMP CAST. `Message.timestamp` and `TurnRecord.submittedAt` are both
-- epoch MILLISECONDS (`Date.now()`, `number`). `(x)::timestamptz` on those
-- ERRORS OUT — the correct read is `to_timestamp(x::bigint / 1000.0)`, which is
-- what this file uses everywhere.
--
-- 🔴 DELETED SESSIONS ARE NOT IN HERE, BY CONSTRUCTION. `deleteSession` purges
-- `sensei:turns:<sessionId>:*` alongside the transcript, so a tidied-up chat
-- leaves no records to reconcile. If that purge ever regresses, this query's
-- (a) column climbs at the rate people delete chats — read query A2's
-- `session_transcript_exists` column before believing a spike.
-- ============================================================================

\echo '== A. PRODUCTION =='

WITH turn AS (
  SELECT
    k.block_instance_id,
    k.user_id,
    k.key,
    k.value ->> 'sessionId'                    AS session_id,
    k.value ->> 'messageId'                    AS message_id,
    (k.value ->> 'submittedAt')::bigint        AS submitted_at_ms,
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
  -- minutes is comfortably past any turn that is going to land.
  WHERE to_timestamp(t.submitted_at_ms / 1000.0) < now() - interval '5 minutes'
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
    (k.value ->> 'submittedAt')::bigint        AS submitted_at_ms,
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
WHERE to_timestamp(t.submitted_at_ms / 1000.0) < now() - interval '5 minutes'
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
-- changed, so it exercises the same joins, the same `to_timestamp` cast and the
-- same FILTER predicates against a store that is known to contain exactly one
-- lost answer.
--
-- EXPECTED: turn_records = 4, lost_answers = 1, a_continuation_never_ran = 1,
--           accepted_discarded = 1, lost_never_submitted = 1, everything else 0.
--
-- The four fixture turns are, in order: one that landed (must NOT count), one
-- charged and never persisted (the loss), one refused before any submit (no
-- workflow id — must not count as an answer), and one discarded by the
-- write-ownership gate (a known trade, counted apart).
--
-- ⚠️ A IS THE QUERY THAT RUNS IN PRODUCTION AND B IS A COPY OF ITS BODY. Editing
-- one without the other silently makes the control stop controlling anything;
-- change them together.
-- ============================================================================

\echo '== B. POSITIVE CONTROL (expect lost_answers = 1) =='

WITH kv(block_instance_id, user_id, key, value) AS (
  VALUES
    ('bi', 1, 'sensei:turns:session-A:1000000000000:msg-landed',
       '{"sessionId":"session-A","messageId":"msg-landed","submittedAt":1000000000000,"workflowIds":["wf-1"],"outcome":"saved"}'::jsonb),
    ('bi', 1, 'sensei:turns:session-A:1000000001000:msg-lost',
       '{"sessionId":"session-A","messageId":"msg-lost","submittedAt":1000000001000,"workflowIds":["wf-2"],"outcome":"pending"}'::jsonb),
    ('bi', 1, 'sensei:turns:session-A:1000000002000:msg-never-sent',
       '{"sessionId":"session-A","messageId":"msg-never-sent","submittedAt":1000000002000,"workflowIds":[],"outcome":"pending"}'::jsonb),
    ('bi', 1, 'sensei:turns:session-A:1000000003000:msg-superseded',
       '{"sessionId":"session-A","messageId":"msg-superseded","submittedAt":1000000003000,"workflowIds":["wf-3"],"outcome":"discarded"}'::jsonb),
    ('bi', 1, 'sensei:messages:session-A',
       '[{"id":"msg-user","role":"user","timestamp":1000000000000},{"id":"msg-landed","role":"assistant","timestamp":1000000000500}]'::jsonb)
),
turn AS (
  SELECT
    k.block_instance_id,
    k.user_id,
    k.key,
    k.value ->> 'sessionId'                    AS session_id,
    k.value ->> 'messageId'                    AS message_id,
    (k.value ->> 'submittedAt')::bigint        AS submitted_at_ms,
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
  WHERE to_timestamp(t.submitted_at_ms / 1000.0) < now() - interval '5 minutes'
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
