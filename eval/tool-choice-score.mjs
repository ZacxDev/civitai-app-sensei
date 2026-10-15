/**
 * Pure scorer for `tool-choice-probe.mjs`. Kept in its own module, with no I/O,
 * so `--self-test` can feed it a fabricated result with a KNOWN score — the
 * positive and negative control for the instrument — without a network call.
 *
 * A record is one question x one repeat: `{ questionId, firstRoundTools: string[] }`
 * where `firstRoundTools` are the tool names the model called on the FIRST round
 * (empty = answered without a tool).
 *
 * Match rule, per expected label:
 *   recommend_resources | search_models — that name is AMONG the first round's
 *     calls (a parallel call of the other tool alongside it still counts, and is
 *     reported separately as `alsoOther`);
 *   none   — no call at all;
 *   either — at least one of the two tools.
 */

export const GROUP_OF = {
  recommend_resources: 'imageKind',
  search_models: 'namedOrRanking',
  none: 'none',
  either: 'either',
};

export function matches(expected, tools) {
  switch (expected) {
    case 'recommend_resources':
    case 'search_models':
      return tools.includes(expected);
    case 'none':
      return tools.length === 0;
    case 'either':
      return tools.includes('recommend_resources') || tools.includes('search_models');
    default:
      throw new Error(`unknown expectation label: ${expected}`);
  }
}

/**
 * @param {Array<{questionId: string, firstRoundTools: string[]}>} records
 * @param {Record<string, string>} expected  questionId -> label
 */
export function score(records, expected) {
  const groups = {};
  const perQuestion = {};
  let recommendCalls = 0;
  let overTriggersOnNone = 0;
  for (const r of records) {
    const label = expected[r.questionId];
    if (!label) throw new Error(`no expectation for ${r.questionId}`);
    const group = GROUP_OF[label];
    const ok = matches(label, r.firstRoundTools);
    groups[group] ??= { met: 0, n: 0 };
    groups[group].met += ok ? 1 : 0;
    groups[group].n += 1;
    const pq = (perQuestion[r.questionId] ??= { expected: label, met: 0, n: 0, tools: [] });
    pq.met += ok ? 1 : 0;
    pq.n += 1;
    pq.tools.push(r.firstRoundTools.length ? r.firstRoundTools.join('+') : 'none');
    recommendCalls += r.firstRoundTools.filter((t) => t === 'recommend_resources').length;
    if (label === 'none' && r.firstRoundTools.length > 0) overTriggersOnNone += 1;
  }
  const met = Object.values(groups).reduce((a, g) => a + g.met, 0);
  return {
    met,
    n: records.length,
    groups,
    recommendCalls,
    overTriggersOnNone,
    perQuestion,
  };
}
