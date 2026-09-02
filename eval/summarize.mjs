#!/usr/bin/env node
/**
 * Summarise one or two eval result files into the per-arm rates clawgate #433
 * criterion 2 asks to be recorded on the card.
 *
 *   node eval/summarize.mjs eval/results/baseline-<date>.json [eval/results/rewrite-<date>.json]
 *
 * 🔴 Every rate is n/3 from THREE draws. Three repeats distinguishes always /
 * never / sometimes; it does NOT give a confidence interval, so a 2/3 -> 3/3
 * move is not an improvement and must not be reported as one.
 */
import { readFileSync } from 'node:fs';

const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node eval/summarize.mjs <result.json> [<result.json>]');
  process.exit(2);
}

/**
 * 🔴 A SCHEMA-1 FILE'S `withheld` IS NEITHER A WITHHOLD NOR AN EMPTY REPLY —
 * IT IS "NO TEXT", AND THE FILE CANNOT TELL YOU WHICH CAUSE PRODUCED IT.
 *
 * Before 2026-09-02 the runner emitted `withheld: succeeded && no text`, which
 * never read a moderation verdict; a content-policy incident that does not
 * exist was reported off exactly that field.
 *
 * 🔴 AND THE FIRST ATTEMPT AT THIS REMAP (#37) GOT IT WRONG IN THE MIRROR
 * DIRECTION — read that before "simplifying" what follows. It mapped the old
 * field onto `emptyReply` and called that "its true meaning". It is not:
 *
 *     schema-1 `withheld`  =  succeeded && no text       <- a UNION
 *     schema-2 `emptyReply`=  succeeded && no text && NO VERDICT   <- a SUBSET
 *
 * A real withhold also lands in the schema-1 set, because the host publishes
 * `textOutputs` only on release, so a withheld turn reaches the old expression
 * as `succeeded` with zero characters. Mapping the union onto the subset
 * asserts "none of these were withholds", which was never observed — the
 * original defect inverted, and it is how "4 empty replies (#476)" was printed
 * for four turns that all followed a successful catalog lookup, i.e. the exact
 * shape clawgate #430 measured as scanner-tripping.
 *
 * So a legacy file reports the OBSERVATION and refuses both causes: `noText`,
 * with `withheld` and `emptyReply` alike marked NOT OBSERVED. The file cannot
 * separate them and neither can this reader.
 *
 * Detected by the stamp, falling back to key-presence for the handful of files
 * written between the two (there are none, but a missing stamp must not be read
 * as schema 2 — that would silently restore the wrong meaning).
 */
function schemaOf(doc) {
  if (typeof doc.resultSchema === 'number') return doc.resultSchema;
  return doc.results.some((r) => 'emptyReply' in r) ? 2 : 1;
}

function summarise(doc) {
  const legacy = schemaOf(doc) < 2;
  const byQ = new Map();
  for (const r of doc.results) {
    if (!byQ.has(r.questionId)) byQ.set(r.questionId, []);
    byQ.get(r.questionId).push(r);
  }
  const rows = [];
  for (const [qid, rs] of byQ) {
    const n = rs.length;
    // Both outcomes are MISSING OBSERVATIONS of answer quality, so both leave
    // the denominator — but they are counted separately, because one is the
    // policy working and the other is clawgate #476.
    // ⚠️ PRE-EXISTING, DELIBERATELY NOT CHANGED HERE: the old comment on this
    // line said withheld turns are "excluded from correctness rates
    // downstream", but every rate below is computed over `rs` — the full set —
    // so they never were. Making them exclusive would move every number already
    // recorded in `eval/results/`, which is a scoring change and not this one.
    // Recorded rather than quietly fixed.
    // The OBSERVATION, available on both schemas: the turn produced no text.
    // On schema 1 that is all there is; on schema 2 it decomposes into the two
    // causes below.
    const isNoText = (r) => (legacy ? Boolean(r.withheld) : Boolean(r.emptyReply) || Boolean(r.withheld));
    const isEmpty = (r) => !legacy && Boolean(r.emptyReply);
    const isWithheld = (r) => !legacy && Boolean(r.withheld);
    rows.push({
      qid,
      arm: rs[0].arm,
      expectTool: rs[0].expectTool,
      n,
      toolCalled: rs.filter((r) => r.toolCalled).length,
      // null expectTool (seam probe) => not scored on tool expectation at all
      expectationMet:
        rs[0].expectTool === null ? null : rs.filter((r) => r.toolExpectationMet).length,
      argsOk: rs.filter((r) => r.argsIncludeOk !== false && r.argsOmitOk !== false).length,
      mentionsOk: rs[0].answerMentionsOk === null
        ? null
        : rs.filter((r) => r.answerMentionsOk).length,
      // 🔴 Only turns that actually CITED are judged. A turn with no citations is
      // null = NOT APPLICABLE, never "ungrounded" — counting it as a miss made the
      // technique rows read 0/3 as though they had failed, when they had simply
      // named no model. `cited` is the denominator that makes `grounded` readable.
      cited: rs.filter((r) => r.groundedCitations !== null).length,
      fabricated: rs.filter((r) => r.groundedCitations === false).length,
      grounded: rs.filter((r) => r.groundedCitations === true).length,
      noText: rs.filter(isNoText).length,
      // `null` = NOT OBSERVED, and it must stay distinguishable from 0. A
      // legacy file showing `withheld: 0` would read as "policy withheld
      // nothing", which is a claim nobody made a measurement for.
      withheld: legacy ? null : rs.filter(isWithheld).length,
      emptyReply: legacy ? null : rs.filter(isEmpty).length,
      buzz: rs.reduce((s, r) => s + r.buzz, 0),
      errors: rs.reduce((s, r) => s + r.errors.length, 0),
    });
  }
  return rows;
}

for (const f of files) {
  const doc = load(f);
  const rows = summarise(doc);
  const legacy = schemaOf(doc) < 2;
  console.log(`\n═══ ${doc.arm}  (${f}) ═══`);
  console.log(`model=${doc.model} temp=${doc.temperature} repeats=${doc.repeats} ` +
    `promptChars=${doc.systemPromptChars} buzz=${doc.buzzSpent}`);
  if (legacy) {
    console.log(
      '🔴 SCHEMA 1 — this file never read a moderation verdict. Its `withheld` is\n' +
        '   reported below as noText: the turn produced no text, and this file CANNOT\n' +
        '   say whether policy withheld it or it is the empty-reply defect (#476).\n' +
        '   Both cause columns read `?` = NOT OBSERVED, which is not the same as 0.\n' +
        '   Quote neither a withhold rate nor a #476 rate off this file.'
    );
  }
  console.log(
    '\nQ    arm        expectTool  toolCalled  met   mentions  cited  grounded  FABRICATED  noText  empty  withheld'
  );
  for (const r of rows) {
    console.log(
      `${r.qid.padEnd(4)} ${r.arm.padEnd(10)} ${String(r.expectTool).padEnd(11)} ` +
        `${`${r.toolCalled}/${r.n}`.padEnd(11)} ` +
        `${(r.expectationMet === null ? '-' : `${r.expectationMet}/${r.n}`).padEnd(5)} ` +
        `${(r.mentionsOk === null ? '-' : `${r.mentionsOk}/${r.n}`).padEnd(9)} ` +
        `${String(r.cited).padEnd(6)} ` +
        `${(r.cited === 0 ? '-' : `${r.grounded}/${r.cited}`).padEnd(9)} ` +
        `${String(r.fabricated).padEnd(11)} ${String(r.noText).padEnd(7)} ` +
        `${(r.emptyReply === null ? '?' : String(r.emptyReply)).padEnd(6)} ` +
        `${r.withheld === null ? '?' : r.withheld}`
    );
  }
  const arms = [...new Set(rows.map((r) => r.arm))];
  console.log('\nper-arm tool-expectation rate:');
  for (const a of arms) {
    const rs = rows.filter((r) => r.arm === a && r.expectationMet !== null);
    if (!rs.length) {
      console.log(`  ${a.padEnd(10)} n/a (not scored on tool expectation)`);
      continue;
    }
    const met = rs.reduce((s, r) => s + r.expectationMet, 0);
    const tot = rs.reduce((s, r) => s + r.n, 0);
    console.log(`  ${a.padEnd(10)} ${met}/${tot}  (${Math.round((100 * met) / tot)}%)`);
  }
  const fab = rows.reduce((s, r) => s + r.fabricated, 0);
  const nt = rows.reduce((s, r) => s + r.noText, 0);
  const emp = legacy ? null : rows.reduce((s, r) => s + r.emptyReply, 0);
  const wh = legacy ? null : rows.reduce((s, r) => s + r.withheld, 0);
  const er = rows.reduce((s, r) => s + r.errors, 0);
  const unobserved = 'NOT OBSERVED (schema 1)';
  console.log(
    `\nfabricated citations: ${fab}   no-text turns: ${nt}   ` +
      `empty replies (#476): ${emp === null ? unobserved : emp}   ` +
      `withheld turns: ${wh === null ? unobserved : wh}   turn errors: ${er}`
  );
}
