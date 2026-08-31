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

function summarise(doc) {
  const byQ = new Map();
  for (const r of doc.results) {
    if (!byQ.has(r.questionId)) byQ.set(r.questionId, []);
    byQ.get(r.questionId).push(r);
  }
  const rows = [];
  for (const [qid, rs] of byQ) {
    const n = rs.length;
    const observed = rs.filter((r) => !r.withheld); // withheld = missing observation
    rows.push({
      qid,
      arm: rs[0].arm,
      expectTool: rs[0].expectTool,
      n,
      toolCalled: rs.filter((r) => r.toolCalled).length,
      expectationMet: rs.filter((r) => r.toolExpectationMet).length,
      argsOk: rs.filter((r) => r.argsIncludeOk !== false && r.argsOmitOk !== false).length,
      mentionsOk: rs[0].answerMentionsOk === null
        ? null
        : rs.filter((r) => r.answerMentionsOk).length,
      // null = no citations in that turn; only turns that CITED are judged
      fabricated: rs.filter((r) => r.groundedCitations === false).length,
      grounded: rs.filter((r) => r.groundedCitations === true).length,
      withheld: n - observed.length,
      buzz: rs.reduce((s, r) => s + r.buzz, 0),
      errors: rs.reduce((s, r) => s + r.errors.length, 0),
    });
  }
  return rows;
}

for (const f of files) {
  const doc = load(f);
  const rows = summarise(doc);
  console.log(`\n═══ ${doc.arm}  (${f}) ═══`);
  console.log(`model=${doc.model} temp=${doc.temperature} repeats=${doc.repeats} ` +
    `promptChars=${doc.systemPromptChars} buzz=${doc.buzzSpent}`);
  console.log(
    '\nQ    arm        expectTool  toolCalled  met   argsOk  mentions  grounded  fabricated  withheld'
  );
  for (const r of rows) {
    console.log(
      `${r.qid.padEnd(4)} ${r.arm.padEnd(10)} ${String(r.expectTool).padEnd(11)} ` +
        `${`${r.toolCalled}/${r.n}`.padEnd(11)} ${`${r.expectationMet}/${r.n}`.padEnd(5)} ` +
        `${`${r.argsOk}/${r.n}`.padEnd(7)} ` +
        `${(r.mentionsOk === null ? '-' : `${r.mentionsOk}/${r.n}`).padEnd(9)} ` +
        `${`${r.grounded}/${r.n}`.padEnd(9)} ${String(r.fabricated).padEnd(11)} ${r.withheld}`
    );
  }
  const arms = ['lookup', 'technique', 'identity'];
  console.log('\nper-arm tool-expectation rate:');
  for (const a of arms) {
    const rs = rows.filter((r) => r.arm === a);
    const met = rs.reduce((s, r) => s + r.expectationMet, 0);
    const tot = rs.reduce((s, r) => s + r.n, 0);
    console.log(`  ${a.padEnd(10)} ${met}/${tot}  (${Math.round((100 * met) / tot)}%)`);
  }
  const fab = rows.reduce((s, r) => s + r.fabricated, 0);
  const wh = rows.reduce((s, r) => s + r.withheld, 0);
  const er = rows.reduce((s, r) => s + r.errors, 0);
  console.log(`\nfabricated citations: ${fab}   withheld turns: ${wh}   turn errors: ${er}`);
}
