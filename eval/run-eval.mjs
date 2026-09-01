#!/usr/bin/env node
/**
 * Run `prompt-eval-set.v1.json` against a live sensei turn and score it.
 *
 * Criterion 2 of clawgate #433 requires the rewrite to be scored against the
 * SAME instrument as the baseline, so this runner is the instrument: it lives
 * in the repo, takes the prompt as an argument, and writes a machine-readable
 * result file per arm.
 *
 *   node eval/run-eval.mjs --arm baseline --out eval/results/baseline.json
 *   node eval/run-eval.mjs --arm rewrite --prompt-file eval/prompt.rewrite.txt ...
 *
 * Auth: CIVITAI_OAUTH_TOKEN (a bearer the civitai CLI already holds). The
 * bearer mints ONE short-lived block page token up front; every later call uses
 * that, so an OAuth token expiring mid-run does not kill the run.
 *
 * 🔴 SPENDS REAL BUZZ — 4 per submit at maxTokens 2048. A lookup turn is two
 * submits. Budget the whole arm before starting: ~51 submits ~= 204 Buzz.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE = process.env.CIVITAI_BASE ?? 'https://civitai.com';
const SLUG = process.env.SENSEI_SLUG ?? 'sensei';
const OAUTH = process.env.CIVITAI_OAUTH_TOKEN;
if (!OAUTH) {
  console.error('CIVITAI_OAUTH_TOKEN is required (the civitai CLI bearer).');
  process.exit(2);
}

// 🔴 Cloudflare 1010-bans a default scripting User-Agent and answers 403 — the
// SAME status the app returns for "Apps are restricted to the Civitai team".
// Without a browser UA a permissions failure and a bot block are indistinguishable.
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const ARM = arg('arm', 'baseline');
const OUT = arg('out', `eval/results/${ARM}.json`);
const SET = JSON.parse(readFileSync(arg('set', 'eval/prompt-eval-set.v1.json'), 'utf8'));
const PROMPT_FILE = arg('prompt-file');

/** The prompt under test. Defaults to the SHIPPED default, read from src/types.ts. */
function shippedPrompt() {
  const src = readFileSync('src/types.ts', 'utf8');
  const m = src.match(/export const DEFAULT_SYSTEM_PROMPT = `([\s\S]*?)`;/);
  if (!m) throw new Error('could not read DEFAULT_SYSTEM_PROMPT from src/types.ts');
  return m[1];
}
const SYSTEM_PROMPT = PROMPT_FILE ? readFileSync(PROMPT_FILE, 'utf8').trim() : shippedPrompt();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { body, token, method } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      Origin: BASE,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text.slice(0, 500) };
  }
  return { status: res.status, json };
}

/** tRPC(superjson) + the block-workflow envelope: result.data.json.snapshot */
function snapshotOf(resp) {
  const d = resp?.result?.data?.json ?? resp?.result?.data ?? resp;
  return d && typeof d === 'object' && 'snapshot' in d ? d.snapshot : d;
}

async function submitAndPoll(blockToken, messages, declarations, maxTokens) {
  const body = {
    kind: 'step',
    step: 'chat-completion',
    params: {
      model: SET.model,
      messages,
      maxTokens,
      temperature: SET.temperature,
      ...(declarations.length ? { tools: declarations, toolChoice: 'auto' } : {}),
    },
  };
  const sub = await api('/api/trpc/blocks.submitWorkflow', {
    body: { json: { blockToken, body } },
  });
  if (sub.status !== 200) {
    return { error: `submit ${sub.status}: ${JSON.stringify(sub.json).slice(0, 300)}`, buzz: 0 };
  }
  let snap = snapshotOf(sub.json);
  const workflowId = snap?.workflowId;
  let buzz = snap?.cost?.total ?? 0;
  if (!workflowId) return { error: 'no workflowId in submit reply', buzz };

  const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'cancelled', 'expired']);
  for (let i = 0; i < 20; i++) {
    const pol = await api('/api/trpc/blocks.pollWorkflow', {
      body: { json: { blockToken, workflowId, waitSeconds: 15 } },
    });
    if (pol.status !== 200) {
      return { error: `poll ${pol.status}`, buzz, workflowId };
    }
    snap = snapshotOf(pol.json);
    if (TERMINAL.has(String(snap?.status ?? '').toLowerCase())) break;
    await sleep(1500);
  }
  return { snap, buzz, workflowId };
}

/**
 * One full turn: submit, and while the model returns tool calls, execute them
 * and feed the results back. Bounded by SET.maxToolRounds so a loop cannot
 * spend without limit.
 */
async function runTurn(blockToken, declarations, question, repeat) {
  /**
   * 🔴 THE CACHE-BUSTER, AND WITHOUT IT `repeats` MEASURES NOTHING.
   *
   * An identical step input is REPLAYED from a server-side cache — measured:
   * two submits of the same body returned the SAME provider-generated
   * `tool_call` id (`call_dkitt…`), across different workflowIds, hours apart.
   * A provider mints those ids randomly, so an identical id cannot be a
   * re-sample. 🔴 AND THE REPLAY IS STILL CHARGED 4 BUZZ — a cached arm costs
   * full price and returns one observation wearing three hats, which is worse
   * than useless because the 3/3 rate reads as agreement.
   *
   * `maxTokens` is the one input that is semantically inert here: answers run
   * ~300 tokens against a 2048 ceiling, so the ceiling is never reached and
   * moving it by ±2 cannot change a generation — but it DOES change the input
   * hash. Measured: 2049 produced a different id and different argument
   * formatting, i.e. a genuinely fresh draw. Cost is unchanged (4 at both).
   *
   * The question text, the system prompt and the temperature are all untouched
   * — perturbing any of those would change what is being measured.
   */
  const maxTokens = SET.maxTokens + (repeat - 1);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question.text },
  ];
  const toolCallsMade = [];
  const toolResultIds = new Set();
  let buzz = 0;
  let rounds = 0;
  let finalText = '';
  let lastStatus = null;
  const errors = [];

  for (let round = 0; round <= SET.maxToolRounds; round++) {
    rounds++;
    const { snap, buzz: b, error } = await submitAndPoll(blockToken, messages, declarations, maxTokens);
    buzz += b ?? 0;
    if (error) {
      errors.push(error);
      break;
    }
    lastStatus = snap?.status ?? null;
    const calls = Array.isArray(snap?.toolCalls) ? snap.toolCalls : [];
    const texts = Array.isArray(snap?.textOutputs) ? snap.textOutputs : [];

    if (calls.length === 0) {
      // 🔴 textOutputs ALSO carries every tool call's raw `arguments`, so prose is
      // what remains after removing the argument strings — the host guarantees the
      // set filter is complete (see orchestrator-bridge.ts).
      finalText = texts.join('\n\n');
      break;
    }

    // The assistant turn that DECLARES the calls. `content` is OMITTED, not '' —
    // the host's content is .min(1) when present.
    messages.push({ role: 'assistant', tool_calls: calls });
    for (const c of calls) {
      toolCallsMade.push({
        name: c.function?.name,
        rawArguments: c.function?.arguments,
      });
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(c.function?.arguments ?? '{}');
      } catch {
        /* recorded raw above */
      }
      const exec = await api('/api/v1/blocks/tools', {
        body: { name: c.function?.name, arguments: parsedArgs },
        token: blockToken,
      });
      if (exec.status !== 200) errors.push(`tool ${exec.status}`);
      for (const item of exec.json?.result?.items ?? []) {
        if (item?.id != null) toolResultIds.add(String(item.id));
      }
      messages.push({
        role: 'tool',
        tool_call_id: c.id,
        content: JSON.stringify(exec.json).slice(0, 8000),
      });
    }
    if (round === SET.maxToolRounds) errors.push('hit maxToolRounds without a prose answer');
  }

  // ── scoring, all mechanical ────────────────────────────────────────────────
  const first = toolCallsMade[0];
  let firstArgs = null;
  try {
    firstArgs = first ? JSON.parse(first.rawArguments ?? '{}') : null;
  } catch {
    firstArgs = null;
  }
  const checks = question.checks ?? {};
  const argKeys = firstArgs ? Object.keys(firstArgs) : [];

  // A citation to an id NO tool returned is a fabrication. null = no citations.
  const cited = [...finalText.matchAll(/civitai\.com\/models\/(\d+)/g)].map((m) => m[1]);
  const groundedCitations = cited.length === 0 ? null : cited.every((id) => toolResultIds.has(id));

  return {
    questionId: question.id,
    arm: question.arm,
    status: lastStatus,
    buzz,
    rounds,
    maxTokens,
    toolCalled: toolCallsMade.length > 0,
    toolCalls: toolCallsMade,
    firstToolArgs: firstArgs,
    expectTool: question.expectTool,
    // 🔴 `expectTool: null` means BOTH behaviours are acceptable and the question
    // is not scored on it — the seam probe grades on `groundedCitations` instead,
    // because there "looked it up first" and "named no model" are both correct and
    // only "named a model without grounding it" is the defect. Scoring null as a
    // miss would mark the desired fix as a regression.
    toolExpectationMet:
      question.expectTool === null ? null : toolCallsMade.length > 0 === question.expectTool,
    argsIncludeOk: checks.toolArgsMustInclude
      ? checks.toolArgsMustInclude.every((k) => argKeys.includes(k))
      : null,
    argsOmitOk: checks.toolArgsMustOmit
      ? checks.toolArgsMustOmit.every((k) => !argKeys.includes(k))
      : null,
    answerMentionsOk: checks.answerMustMention
      ? checks.answerMustMention.every((w) => finalText.toLowerCase().includes(w.toLowerCase()))
      : null,
    citedIds: cited,
    groundedCitations,
    // 🔴 A withheld turn is a MISSING OBSERVATION, not a wrong answer. Kept in
    // its own field and excluded from correctness rates downstream.
    withheld: lastStatus === 'succeeded' && finalText.trim().length === 0,
    answerChars: finalText.length,
    answer: finalText,
    errors,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
const mint = await api('/api/v1/blocks/dev-token', { body: { slug: SLUG }, token: OAUTH });
if (mint.status !== 200) {
  console.error('mint failed', mint.status, JSON.stringify(mint.json).slice(0, 300));
  process.exit(1);
}
const blockToken = mint.json.token;
console.error(`[mint] scopes=${mint.json.scopes} budget=${mint.json.buzzBudget}`);

const toolsRes = await api('/api/v1/blocks/tools', { token: blockToken });
const declarations = toolsRes.json?.tools ?? [];
console.error(`[tools] ${declarations.map((t) => t.function?.name).join(', ') || '(none)'}`);

const results = [];
let spent = 0;
const started = new Date().toISOString();
mkdirSync(dirname(OUT), { recursive: true });

const flush = () =>
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        arm: ARM,
        startedAt: started,
        set: SET.version,
        model: SET.model,
        temperature: SET.temperature,
        repeats: SET.repeats,
        systemPromptChars: SYSTEM_PROMPT.length,
        systemPrompt: SYSTEM_PROMPT,
        declaredTools: declarations.map((t) => t.function?.name),
        buzzSpent: spent,
        results,
      },
      null,
      2
    )
  );

for (const q of SET.questions) {
  for (let rep = 1; rep <= SET.repeats; rep++) {
    const t0 = Date.now();
    const r = await runTurn(blockToken, declarations, q, rep);
    r.repeat = rep;
    r.seconds = Math.round((Date.now() - t0) / 1000);
    spent += r.buzz;
    results.push(r);
    flush(); // incremental — a crash mid-arm keeps everything already paid for
    console.error(
      `[${q.id} ${rep}/${SET.repeats}] tool=${r.toolCalled} expect=${q.expectTool} ` +
        `ok=${r.toolExpectationMet} withheld=${r.withheld} buzz=${r.buzz} ${r.seconds}s ` +
        `${r.errors.length ? 'ERR:' + r.errors.join('|') : ''}`
    );
    await sleep(1200); // stay clear of the per-token catalog rate limit
  }
}

flush();
console.error(`\nDONE arm=${ARM} turns=${results.length} buzz=${spent} -> ${OUT}`);
