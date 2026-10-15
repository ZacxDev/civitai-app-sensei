#!/usr/bin/env node
/**
 * FIRST-ROUND TOOL-CHOICE PROBE — which tool does the model reach for first?
 *
 * Calls OpenRouter's chat completions DIRECTLY (not through the Civitai host)
 * with the system prompt under test and the two tools the app offers on a
 * normal SFW turn, and records ONLY the tool(s) the model calls on the first
 * round — or none. No tool is executed and no second round is sent, so this
 * measures routing, not answer quality, grounding or the multi-round loop.
 *
 *   OPENROUTER_API_KEY=… node eval/tool-choice-probe.mjs --arm v5 \
 *     --prompt-file eval/prompt.rewrite.v5.txt --out eval/results/tool-choice/tool-choice-v5.json
 *   node eval/tool-choice-probe.mjs --self-test     # scorer controls, no network
 *
 * With `--expectations eval/tool-choice-expectations.needs-v1.json` it also
 * records the `needs` argument of every first-round recommend_resources call
 * and scores it against that file's `expectedNeeds` (`scoreNeeds`). Every
 * record carries `needs` regardless of which expectations file is used, so the
 * v1 21-question run also reports any `needs` it emitted (`needsOnUngraded`).
 *
 * 🔴 WHY NOT run-eval.mjs: that runner drives the live host and spends Buzz on
 * every submit. This one spends a fraction of a cent per call on the operator's
 * own OpenRouter key, and answers one narrower question.
 *
 * Tools offered, and why each is not hand-copied:
 *   - `search_models` — the HOST's declaration, saved verbatim from
 *     `GET /api/v1/blocks/tools` into `eval/host-search_models.fixture.json`.
 *     It is a snapshot: if the host's description changes, re-save it.
 *   - `recommend_resources` — imported from `src/lib/recommend.ts` and passed
 *     through the app's own `composeLocalTools`, so the probe offers exactly
 *     the declaration (and the array order) the shipped app sends.
 *
 * Key: `OPENROUTER_API_KEY` from the environment, or `--env-file <path>` to read
 * that one line from a dotenv file. Never printed, never written to a result.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { registerHooks } from 'node:module';
import { needsOf, score, scoreNeeds } from './tool-choice-score.mjs';

// ── self-test: the instrument's own controls, no network ─────────────────────
if (process.argv.includes('--self-test')) {
  const expected = { A: 'recommend_resources', B: 'search_models', C: 'none', D: 'none' };
  const records = [
    { questionId: 'A', firstRoundTools: ['recommend_resources'] }, // met
    { questionId: 'A', firstRoundTools: ['search_models'] }, // miss
    { questionId: 'A', firstRoundTools: ['search_models', 'recommend_resources'] }, // met (among)
    { questionId: 'B', firstRoundTools: ['search_models'] }, // met
    { questionId: 'B', firstRoundTools: [] }, // miss
    { questionId: 'C', firstRoundTools: [] }, // met
    { questionId: 'D', firstRoundTools: ['recommend_resources'] }, // miss + over-trigger
  ];
  const s = score(records, expected);
  const want = {
    met: 4,
    n: 7,
    imageKind: '2/3',
    namedOrRanking: '1/2',
    none: '1/2',
    recommendCalls: 3,
    overTriggersOnNone: 1,
  };
  const got = {
    met: s.met,
    n: s.n,
    imageKind: `${s.groups.imageKind.met}/${s.groups.imageKind.n}`,
    namedOrRanking: `${s.groups.namedOrRanking.met}/${s.groups.namedOrRanking.n}`,
    none: `${s.groups.none.met}/${s.groups.none.n}`,
    recommendCalls: s.recommendCalls,
    overTriggersOnNone: s.overTriggersOnNone,
  };
  const ok = JSON.stringify(got) === JSON.stringify(want);
  // `needs` scorer controls: a KNOWN answer, including a hit, a miss, an extra,
  // noise, a clean none, a tool miss and an ungraded record.
  const n = scoreNeeds(
    [
      { questionId: 'NA', needs: ['legible_text'] }, // met
      { questionId: 'NA', needs: ['photoreal'] }, // miss + extra
      { questionId: 'NA', needs: ['legible_text', 'photoreal'] }, // met + extra
      { questionId: 'NA', needs: null }, // tool miss
      { questionId: 'NZ', needs: [] }, // clean
      { questionId: 'NZ', needs: ['photoreal'] }, // noise
      { questionId: 'OLD', needs: ['design_layout'] }, // ungraded, tallied
    ],
    { NA: ['legible_text', 'design_layout'], NZ: [] },
  );
  const needsGot = [n.capability.met, n.capability.n, n.capability.extra, n.none.clean, n.none.n, n.none.noise, n.noRecommendCall, n.needsOnUngraded];
  const needsWant = [2, 3, 2, 1, 2, 1, 1, 1];
  const needsOk = JSON.stringify(needsGot) === JSON.stringify(needsWant);
  const extractOk =
    JSON.stringify(needsOf([{ name: 'search_models', arguments: '{}' }])) === 'null' &&
    JSON.stringify(
      needsOf([
        { name: 'recommend_resources', arguments: '{"image_description":"x","needs":["photoreal"]}' },
        { name: 'recommend_resources', arguments: '{"needs":["photoreal","legible_text"]}' },
        { name: 'recommend_resources', arguments: 'not json' },
      ]),
    ) === '["photoreal","legible_text"]' &&
    JSON.stringify(needsOf([{ name: 'recommend_resources', arguments: '{"image_description":"x"}' }])) === '[]';
  // Negative control: an unknown question id must throw, not score silently.
  let threw = false;
  try {
    score([{ questionId: 'Z', firstRoundTools: [] }], expected);
  } catch {
    threw = true;
  }
  console.log(
    JSON.stringify({ got, want, scorerMatches: ok, unknownIdThrows: threw, needsGot, needsWant, needsOk, extractOk }),
  );
  process.exit(ok && threw && needsOk && extractOk ? 0 : 1);
}

// ── import the shipped declaration ───────────────────────────────────────────
// `src/` uses `.js` specifiers for `.ts` files (the bundler resolves them); Node
// does not, so map a failed `./x.js` under `src/` to `./x.ts`. Node strips the
// types itself (erasable syntax, Node >= 22.18 / 23.6).
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw e;
    }
  },
});
const { composeLocalTools } = await import('../src/lib/recommend.ts');

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const ARM = arg('arm', 'shipped');
// A SUBDIRECTORY, not `eval/results/` itself: `src/eval-reply-outcome.test.ts`
// reads every `eval/results/*.json` as a run-eval result file, and this probe's
// shape is not one.
const OUT = arg('out', `eval/results/tool-choice/tool-choice-${ARM}.json`);
const MODEL = arg('model', 'deepseek/deepseek-v4-flash-0731');
const TEMPERATURE = Number(arg('temperature', '0.7'));
// 2048 = the shipped `DEFAULT_SETTINGS.maxTokens`. A first try at 512 truncated
// 9 of 63 turns (`finish_reason: length`), 4 of them with NO tool call yet —
// reasoning or preamble ate the budget before the model reached its decision,
// so "no call" there was a fact about the ceiling, not about the routing.
const MAX_TOKENS = Number(arg('max-tokens', '2048'));
const REPEATS = Number(arg('repeats', '3'));
const SPEND_CAP_USD = Number(arg('spend-cap', '0.40'));
const CONCURRENCY = Number(arg('concurrency', '4'));
const PROMPT_FILE = arg('prompt-file');
const EXPECT_PATH = arg('expectations', 'eval/tool-choice-expectations.v1.json');
const EXPECT = JSON.parse(readFileSync(EXPECT_PATH, 'utf8'));

function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  const envFile = arg('env-file');
  if (envFile) {
    const line = readFileSync(envFile, 'utf8')
      .split('\n')
      .find((l) => /^\s*(export\s+)?OPENROUTER_API_KEY\s*=/.test(l));
    if (line) return line.replace(/^\s*(export\s+)?OPENROUTER_API_KEY\s*=\s*/, '').trim().replace(/^['"]|['"]$/g, '');
  }
  console.error('OPENROUTER_API_KEY is required (env var, or --env-file <dotenv path>).');
  process.exit(2);
}
const KEY = apiKey();

/** Same extraction as run-eval.mjs: the shipped default, read from src/types.ts. */
function shippedPrompt() {
  const src = readFileSync('src/types.ts', 'utf8');
  const m = src.match(/export const DEFAULT_SYSTEM_PROMPT = `([\s\S]*?)`;/);
  if (!m) throw new Error('could not read DEFAULT_SYSTEM_PROMPT from src/types.ts');
  return m[1];
}
const SYSTEM_PROMPT = PROMPT_FILE ? readFileSync(PROMPT_FILE, 'utf8').trim() : shippedPrompt();

const hostSearch = JSON.parse(readFileSync('eval/host-search_models.fixture.json', 'utf8'));
const { declarations: TOOLS } = composeLocalTools([hostSearch], true);
const toolNames = TOOLS.map((t) => t.function.name);
if (!toolNames.includes('recommend_resources') || !toolNames.includes('search_models')) {
  throw new Error(`expected both tools on the wire, got ${toolNames.join(',')}`);
}

const questions = [];
for (const setPath of EXPECT.sets) {
  for (const q of JSON.parse(readFileSync(setPath, 'utf8')).questions) questions.push({ id: q.id, text: q.text });
}
for (const q of EXPECT.extraQuestions) questions.push({ id: q.id, text: q.text });
for (const q of questions) {
  if (!EXPECT.expected[q.id]) throw new Error(`no pre-registered expectation for ${q.id}`);
}

async function call(question) {
  const body = {
    model: MODEL,
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    tool_choice: 'auto',
    tools: TOOLS,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: question.text },
    ],
    usage: { include: true },
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (res.ok && json?.choices?.[0]) return { json };
    if (attempt === 3 || (res.status < 500 && res.status !== 429)) {
      return { error: `HTTP ${res.status}: ${(json?.error?.message ?? text).slice(0, 200)}` };
    }
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
}

const jobs = [];
for (const q of questions) for (let rep = 1; rep <= REPEATS; rep++) jobs.push({ q, rep });

const records = [];
let spentUsd = 0;
let stoppedForCap = false;
let next = 0;
async function worker() {
  while (next < jobs.length) {
    if (spentUsd >= SPEND_CAP_USD) {
      stoppedForCap = true;
      return;
    }
    const { q, rep } = jobs[next++];
    const r = await call(q);
    if (r.error) {
      records.push({ questionId: q.id, repeat: rep, error: r.error });
      console.error(`[${q.id} ${rep}] ERROR ${r.error}`);
      continue;
    }
    const choice = r.json.choices[0];
    const calls = choice.message?.tool_calls ?? [];
    const cost = Number(r.json.usage?.cost ?? 0);
    spentUsd += cost;
    const firstRoundTools = calls.map((c) => c.function?.name);
    records.push({
      questionId: q.id,
      repeat: rep,
      firstRoundTools,
      toolCalls: calls.map((c) => ({ name: c.function?.name, arguments: c.function?.arguments })),
      needs: needsOf(calls.map((c) => ({ name: c.function?.name, arguments: c.function?.arguments }))),
      finishReason: choice.finish_reason ?? null,
      textChars: (choice.message?.content ?? '').length,
      textHead: (choice.message?.content ?? '').slice(0, 400),
      reasoningChars: (choice.message?.reasoning ?? '').length,
      // A turn cut off by max_tokens BEFORE any tool call never showed its
      // routing decision: an UNOBSERVED turn, excluded from the score and counted.
      unobserved: choice.finish_reason === 'length' && calls.length === 0,
      provider: r.json.provider ?? null,
      costUsd: cost,
      promptTokens: r.json.usage?.prompt_tokens ?? null,
      completionTokens: r.json.usage?.completion_tokens ?? null,
    });
    console.error(`[${q.id} ${rep}] ${firstRoundTools.join('+') || 'none'} (${choice.finish_reason})`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const order = new Map(questions.map((q, i) => [q.id, i]));
records.sort((a, b) => order.get(a.questionId) - order.get(b.questionId) || a.repeat - b.repeat);
const scored = records.filter((r) => !r.error && !r.unobserved);
const s = score(scored, EXPECT.expected);
const ns = scoreNeeds(scored, EXPECT.expectedNeeds ?? {});

const out = {
  arm: ARM,
  probe: 'tool-choice-probe v1 (first round only, no tool execution)',
  startedAt: new Date().toISOString(),
  model: MODEL,
  temperature: TEMPERATURE,
  maxTokens: MAX_TOKENS,
  repeats: REPEATS,
  promptFile: PROMPT_FILE ?? '(shipped DEFAULT_SYSTEM_PROMPT)',
  systemPromptChars: SYSTEM_PROMPT.length,
  systemPrompt: SYSTEM_PROMPT,
  tools: toolNames,
  expectations: EXPECT_PATH,
  spentUsd: Number(spentUsd.toFixed(6)),
  stoppedForCap,
  errors: records.filter((r) => r.error).length,
  truncated: records.filter((r) => r.finishReason === 'length').length,
  unobserved: records.filter((r) => r.unobserved).length,
  score: s,
  needsScore: ns,
  records,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);

const g = (k) => (s.groups[k] ? `${s.groups[k].met}/${s.groups[k].n}` : '-');
console.log(
  `arm=${ARM} chars=${SYSTEM_PROMPT.length} n=${scored.length} errors=${out.errors} truncated=${out.truncated} unobserved=${out.unobserved} ` +
    `| recommend-first on image-kind ${g('imageKind')} | search_models on named/ranking ${g('namedOrRanking')} ` +
    `| none kept ${g('none')} (over-triggers ${s.overTriggersOnNone}) | recommend calls ${s.recommendCalls} ` +
    `| overall ${s.met}/${s.n} | spent $${out.spentUsd}${stoppedForCap ? ' STOPPED AT CAP' : ''} -> ${OUT}`,
);
for (const [id, pq] of Object.entries(s.perQuestion)) {
  console.log(`  ${id.padEnd(6)} expect=${pq.expected.padEnd(19)} ${pq.met}/${pq.n}  ${pq.tools.join(', ')}`);
}
console.log(
  `needs: capability met ${ns.capability.met}/${ns.capability.n} (with extras ${ns.capability.extra}) ` +
    `| none clean ${ns.none.clean}/${ns.none.n} (noise ${ns.none.noise}) | no recommend call ${ns.noRecommendCall} ` +
    `| needs on ungraded questions ${ns.needsOnUngraded}`,
);
for (const [id, pq] of Object.entries(ns.perQuestion)) {
  console.log(`  ${id.padEnd(6)} anyOf=${(pq.expectedAnyOf.join('|') || '[]').padEnd(36)} ${pq.met}/${pq.n}  ${pq.needs.join(', ')}`);
}
