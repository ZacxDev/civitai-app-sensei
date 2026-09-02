/**
 * How a finished turn ENDED — the split that rank 5 exists to make.
 *
 * 🔴 THIS MODULE EXISTS BECAUSE A FIELD NAMED FOR A CAUSE WAS COMPUTED FROM A
 * SYMPTOM, AND EVERYONE DOWNSTREAM READ IT AS THE CAUSE — INCLUDING ITS AUTHOR.
 * `run-eval.mjs` used to emit
 *
 *     withheld: lastStatus === 'succeeded' && finalText.trim().length === 0
 *
 * which never reads a moderation verdict at all. On that basis a content-policy
 * incident was reported to the operator that does not exist, and every
 * `withheld` figure in this arc's history — the #430-era ones included — means
 * "empty reply". Two of the three retractions in that family were made AFTER
 * the first was written down, which is why the fix is a rename rather than a
 * resolution to be careful.
 *
 * 🔴 THE HOST DOES PUBLISH A REAL VERDICT AND THE EVAL SIMPLY NEVER READ IT.
 * `src/lib/orchestrator-bridge.ts` branches on `snap.textOutputWithheld` BEFORE
 * it looks at released text, for exactly this reason ("a withhold is not an
 * error and not an empty response — the Buzz was spent, the host scanned the
 * reply and refused it"). The shipped path has always distinguished the two.
 * The instrument did not, so it could not see a disagreement it was the only
 * thing positioned to notice.
 *
 * The two outcomes are MUTUALLY EXCLUSIVE by construction, and that is the
 * point: `withheld` is an observation of a verdict, `emptyReply` is the absence
 * of any explanation. The second is clawgate #476's population — succeeded,
 * charged, zero characters, nobody knows why — and it is only countable once
 * the withholds are taken out of it.
 *
 * Plain `.mjs` with NO imports: `run-eval.mjs` and `summarize.mjs` both load it
 * under plain Node, and a test can import it without spawning the runner (whose
 * top level exits when no bearer is present).
 */

/**
 * @param {{status: string|null, textOutputWithheld?: {reason?: string}|null, text: string}} turn
 * @returns {{withheld: boolean, withheldReason: string|null, emptyReply: boolean}}
 */
export function classifyReplyOutcome({ status, textOutputWithheld, text }) {
  // A verdict READ BACK, never inferred. Presence of the field is the signal —
  // the host only attaches it on a withhold — so an empty `reason` string is
  // still a withhold, and `null` reason is recorded rather than invented.
  const withheld = Boolean(textOutputWithheld);
  const withheldReason = withheld ? (textOutputWithheld.reason ?? null) : null;

  // 🔴 `succeeded` is load-bearing: a turn that ended `failed`/`expired` has an
  // obvious reason to carry no text and must not be counted as the unexplained
  // defect. And `withheld` is subtracted because a withhold EXPLAINS the
  // emptiness — leaving it in is precisely the conflation this module undoes.
  const emptyReply = !withheld && status === 'succeeded' && text.trim().length === 0;

  return { withheld, withheldReason, emptyReply };
}
