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

/**
 * The `needs` a record's first round passed to recommend_resources: the UNION
 * over every recommend_resources call in the round, or `null` when the round
 * made no such call. Unparseable arguments count as no needs (and are flagged by
 * the probe separately).
 *
 * @param {Array<{name: string, arguments: string}>} toolCalls
 * @returns {string[] | null}
 */
export function needsOf(toolCalls) {
  const recs = (toolCalls ?? []).filter((c) => c.name === 'recommend_resources');
  if (recs.length === 0) return null;
  const out = new Set();
  for (const c of recs) {
    let args;
    try {
      args = JSON.parse(c.arguments || '{}');
    } catch {
      continue;
    }
    if (Array.isArray(args?.needs)) for (const n of args.needs) if (typeof n === 'string') out.add(n);
  }
  return [...out];
}

/**
 * Score `needs` against `expectedNeeds` (questionId -> any-of list; [] = none).
 *
 *   capability question (non-empty list): met when `needs` contains at least
 *     one listed capability. Extra capabilities are counted in `extra`.
 *   none question ([]): clean when `needs` is empty; NOISE otherwise.
 *   A record with `needs === null` (no recommend_resources call) is a tool miss:
 *     counted in `noRecommendCall`, excluded from both denominators.
 *   A question id with no `expectedNeeds` entry is skipped (it belongs to a
 *   set this scorer does not grade — e.g. the v1 21-question set), but its
 *   non-empty `needs` are tallied in `needsOnUngraded` for information.
 *
 * @param {Array<{questionId: string, needs: string[] | null}>} records
 * @param {Record<string, string[]>} expectedNeeds
 */
export function scoreNeeds(records, expectedNeeds) {
  const capability = { met: 0, n: 0, extra: 0 };
  const none = { clean: 0, n: 0, noise: 0 };
  const perQuestion = {};
  let noRecommendCall = 0;
  let needsOnUngraded = 0;
  for (const r of records) {
    const want = expectedNeeds[r.questionId];
    if (want === undefined) {
      if (r.needs && r.needs.length > 0) needsOnUngraded += 1;
      continue;
    }
    const pq = (perQuestion[r.questionId] ??= { expectedAnyOf: want, met: 0, n: 0, needs: [] });
    pq.needs.push(r.needs === null ? 'no-call' : r.needs.length ? r.needs.join('+') : '[]');
    if (r.needs === null) {
      noRecommendCall += 1;
      continue;
    }
    pq.n += 1;
    if (want.length > 0) {
      capability.n += 1;
      const ok = r.needs.some((c) => want.includes(c));
      capability.met += ok ? 1 : 0;
      pq.met += ok ? 1 : 0;
      if (r.needs.some((c) => !want.includes(c))) capability.extra += 1;
    } else {
      none.n += 1;
      const clean = r.needs.length === 0;
      none.clean += clean ? 1 : 0;
      none.noise += clean ? 0 : 1;
      pq.met += clean ? 1 : 0;
    }
  }
  return { capability, none, noRecommendCall, needsOnUngraded, perQuestion };
}
