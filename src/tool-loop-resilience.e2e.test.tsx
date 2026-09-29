import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage } from './test-helpers.js';
import { clearCache } from './lib/research.js';

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 TWO TOOL-LOOP RESILIENCE PROPERTIES, END TO END, THROUGH THE REAL APP.
//
// `lib/tools.test.ts` proves what the per-call helper RENDERS. Neither property
// below is visible there:
//
//   1. a failed call in a PARALLEL round leaves the sibling result intact, and
//      the ids the failed call never returned ground nothing — while the turn
//      still completes, because the failure never reaches the loop as a throw;
//   2. a round that repeats the IMMEDIATELY PRECEDING round's calls byte for
//      byte ends the turn with the explanation path instead of billing another
//      submit for identical work.
//
// Every assertion reads the SUBMIT COUNT (what was spent), the CONSTRUCTED
// REQUEST BODY (what the model was shown), the PERSISTED TRANSCRIPT (what the
// viewer keeps), or the RENDERED DOM (what they see) — the same discipline
// `correction-round.e2e.test.tsx` states. Nothing reads an internal.
// ─────────────────────────────────────────────────────────────────────────────

const DREAMSHAPER = 4384;
const REALISTIC_VISION = 4201;
// The measured seam-probe ids, as correction-round.e2e.test.tsx uses them:
// pairwise distinct, and distinct from every constant an assertion names.
const DEAD_A = 4823;

const h = vi.hoisted(() => ({
  storage: null as ReturnType<typeof fakeAppStorage> | null,
}));

const estimateFn = vi
  .fn()
  .mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } });

/** Bodies as submitted, in order. A submit is the BILLED event — count these. */
let submittedBodies: Array<{ params: { messages: Array<Record<string, unknown>> } }> = [];

let pollQueue: Array<Record<string, unknown>> = [];
const pollFn = vi.fn(async () => {
  const next = pollQueue.shift();
  return (
    next ?? { workflowId: 'wf-x', status: 'succeeded', cost: { total: 1 }, textOutputs: ['done'] }
  );
});

const submitFn = vi.fn(async (body: unknown) => {
  submittedBodies.push(body as { params: { messages: Array<Record<string, unknown>> } });
  return { workflowId: `wf-${submittedBodies.length}`, status: 'pending' };
});

vi.mock('./lib/sdk-runtime.js', () => ({
  useAppStorage: () => h.storage!.appStorage,
  useBlockAnalytics: () => ({ track: vi.fn() }),
  useBlockContext: () => ({ ready: true, viewer: { id: 1 }, theme: 'dark' }),
  useBlockResize: () => {},
  // Fail-closed SFW — the production default. Why, and what actually tests the
  // policy: `lib/maturity.ts`. Not the contract; a literal.
  useDomainMaturity: () => ({ isSfw: true, isLevelAllowed: () => false }),
  useRequestConsent: () => ({ requestConsent: vi.fn() }),
  useRequestSignIn: () => ({ requestSignIn: vi.fn() }),
  useResourcePicker: () => ({ open: vi.fn().mockResolvedValue(null) }),
  useBlockToken: () => ({ raw: 'block-jwt-test', scopes: ['ai:write:budgeted', 'buzz:read:self'] }),
  useBuzzBalance: () => ({ balance: { blue: 100, green: 0, yellow: 200 } }),
  useBuzzWorkflow: () => ({
    estimate: estimateFn,
    submit: submitFn,
    poll: pollFn,
    cancel: vi.fn().mockResolvedValue(undefined),
    status: 'idle',
    result: null,
    error: null,
  }),
}));

const DECLARATIONS = [
  {
    type: 'function',
    function: {
      name: 'search_models',
      description: 'Search the Civitai model catalog',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  },
];

/** What a successful POST returns — i.e. what the catalog actually grounds. */
let toolItems: Array<Record<string, unknown>> = [];
/** POSTs whose `arguments.query` equals this fail with a 500. `null` = none fail. */
let failQuery: string | null = null;

let toolRequests: Array<{ method: string; body: unknown }> = [];

function toolCalls(calls: Array<{ id: string; query: string }>) {
  return {
    workflowId: 'wf-tc',
    status: 'succeeded',
    cost: { total: 1 },
    toolCalls: calls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: 'search_models', arguments: JSON.stringify({ query: c.query }) },
    })),
  };
}

function textSnapshot(text: string) {
  return { workflowId: 'wf-t', status: 'succeeded', cost: { total: 1 }, textOutputs: [text] };
}

let originalFetch: typeof globalThis.fetch;

function installFetch() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/v1/blocks/tools')) {
      if (method === 'GET') {
        return new Response(JSON.stringify({ tools: DECLARATIONS }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as {
        name: string;
        arguments: { query?: string };
      };
      toolRequests.push({ method, body });
      if (failQuery !== null && body.arguments?.query === failQuery) {
        return new Response(JSON.stringify({ error: 'upstream exploded' }), {
          status: 500,
          statusText: 'Internal Server Error',
        });
      }
      return new Response(JSON.stringify({ items: toolItems, truncated: 0 }), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [], metadata: {} }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

interface StoredRow {
  role: string;
  content: string;
  grounded?: string[];
}

/** Every write to a session's message key, oldest first. */
function messageWrites(): StoredRow[][] {
  return h
    .storage!.sets.filter((s) => s.key.startsWith('sensei:messages:'))
    .map((s) => s.value as StoredRow[]);
}

/** The last persisted transcript, or `[]` if nothing was ever written. */
function lastTranscript(): StoredRow[] {
  const writes = messageWrites();
  return writes.length > 0 ? writes[writes.length - 1] : [];
}

/** The rendered anchor for a model id, or null when Layer 1 refused it. */
function anchorFor(id: number): HTMLAnchorElement | null {
  return document.querySelector<HTMLAnchorElement>(`a[href*="/models/${id}"]`);
}

async function startChat() {
  render(<App />);
  await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
  fireEvent.click(screen.getByTestId('new-session-button'));
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
}

/**
 * Type and send; resolves once the reply is on screen AND the turn has settled.
 * Same shape and the same single-text-node caveat as `correction-round.e2e` —
 * every fixture ends in a plain-text clause this matches.
 */
async function send(question: string, expectInReply: RegExp) {
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: question } });
  fireEvent.click(screen.getByTestId('send-button'));
  await waitFor(() => expect(screen.getByText(expectInReply)).toBeTruthy(), { timeout: 8000 });
  await waitFor(() => expect(screen.queryByTestId('streaming-indicator')).toBeNull(), {
    timeout: 8000,
  });
}

describe('a failed tool call is an instructive result, not a dead round', () => {
  beforeEach(() => {
    h.storage = fakeAppStorage();
    pollQueue = [];
    toolItems = [];
    failQuery = null;
    toolRequests = [];
    submittedBodies = [];
    submitFn.mockClear();
    pollFn.mockClear();
    clearCache();
    installFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('🔴 completes the turn: the failed call gets its error string, the successful one keeps grounding', async () => {
    // Round 1 carries TWO parallel calls; the second POST fails with a 500.
    // Before per-call isolation this could have taken the whole round down;
    // with it, every issued `tool_call_id` gets exactly one response.
    failQuery = 'broken terms';
    toolItems = [{ id: DREAMSHAPER, name: 'DreamShaper', type: 'Checkpoint' }];
    pollQueue = [
      toolCalls([
        { id: 'call_ok', query: 'DreamShaper checkpoint' },
        { id: 'call_fail', query: 'broken terms' },
      ]),
      textSnapshot(`Try [DreamShaper](https://civitai.com/models/${DREAMSHAPER}) for portraits.`),
    ];
    await startChat();
    await send('what should I use?', /for portraits/);

    // The turn completed in the normal number of submits: the tool round plus
    // the answer. A round-level failure would have ended in the error path.
    expect(submitFn).toHaveBeenCalledTimes(2);
    // Both calls were ATTEMPTED — isolation is per call, not an early exit.
    expect(toolRequests.filter((r) => r.method === 'POST')).toHaveLength(2);

    // 🔴 THE WIRE. Round 2 carries the ask plus BOTH correlated answers.
    const round2 = submittedBodies[1].params.messages;
    const ask = round2.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(ask).toBeTruthy();
    const answers = round2.filter((m) => m.role === 'tool');
    expect(answers).toHaveLength(2);
    expect(answers.map((m) => m.tool_call_id).sort()).toEqual(['call_fail', 'call_ok']);

    // The failed call's message is the INSTRUCTIVE error — what failed, and
    // what to try instead — not a bare status and not catalog data.
    const failed = answers.find((m) => m.tool_call_id === 'call_fail');
    expect(String(failed?.content)).toContain('catalog lookup failed:');
    expect(String(failed?.content)).toContain('Retry with different or fewer search terms');
    // …and an error string is not catalog data: it must not smuggle the
    // items shape, which is what would ground ids nobody looked up.
    expect(String(failed?.content)).not.toContain('"items"');

    const ok = answers.find((m) => m.tool_call_id === 'call_ok');
    expect(String(ok?.content)).toContain('DreamShaper');

    // 🔴 THE GROUNDING SPLIT, observed where it is enforced. The successful
    // call's id IS grounded — the reply's link to it renders as an anchor —
    // while nothing from the failed call is (it returned no data to ground).
    // The reply cites no OTHER id, so there is nothing else to check.
    expect(anchorFor(DREAMSHAPER)).toBeTruthy();
    expect(anchorFor(DEAD_A)).toBeNull();
  });
});

describe('an identical repeat call ends the turn instead of billing it', () => {
  beforeEach(() => {
    h.storage = fakeAppStorage();
    pollQueue = [];
    toolItems = [];
    failQuery = null;
    toolRequests = [];
    submittedBodies = [];
    submitFn.mockClear();
    pollFn.mockClear();
    clearCache();
    installFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('🔴 a second round returning the SAME calls breaks the turn — one extra submit does not happen', async () => {
    // The model asks for the identical lookup twice. Without the short-circuit
    // this turn keeps going: the duplicate round executes (a second POST and a
    // third billed submit) and only the MESSAGE cap finally stops it. With it,
    // the turn ends after the first real round with the explanation path.
    toolItems = [{ id: DREAMSHAPER, name: 'DreamShaper', type: 'Checkpoint' }];
    const repeatCall = { id: 'call_abc', query: 'best checkpoint for anime faces' };
    pollQueue = [toolCalls([repeatCall]), toolCalls([repeatCall]), textSnapshot('unreachable')];
    await startChat();
    await send('what is the best checkpoint for anime faces?', /could not finish that/);

    // TWO submits: the first round and the one that returned the repeat. The
    // duplicate round itself was NEVER submitted and NEVER executed — the
    // unguarded loop would have reached three submits and two POSTs here.
    expect(submitFn).toHaveBeenCalledTimes(2);
    expect(toolRequests.filter((r) => r.method === 'POST')).toHaveLength(1);

    // 🔴 THE PERSISTED TRANSCRIPT IS THE ROUND-1 EVIDENCE: the user turn, the
    // assistant notice, and the ids round 1 actually returned. The skipped
    // round contributed nothing — no execution, so no grounding of its own.
    const stored = lastTranscript();
    const assistant = [...stored].reverse().find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe(
      'I looked things up 1 time and still could not finish that. Try asking something narrower.',
    );
    expect(assistant?.grounded).toEqual([String(DREAMSHAPER)]);
    // 🔴 20 s, not the 5 s default: this case's RED state (the short-circuit
    // absent) runs the unguarded loop to a THIRD submit and a plain answer, and
    // `send` waits that out before failing. A default timeout here would read
    // as a product hang rather than the failed guard it is.
  }, 20_000);

  it('🔴 a repeated NAME with DIFFERENT arguments does not short-circuit', async () => {
    // The boundary of the byte-identity rule: same tool, different query, is a
    // DIFFERENT lookup and must run. Kills a comparator that compares names
    // only.
    toolItems = [{ id: REALISTIC_VISION, name: 'Realistic Vision', type: 'Checkpoint' }];
    pollQueue = [
      toolCalls([{ id: 'call_a', query: 'anime faces' }]),
      toolCalls([{ id: 'call_b', query: 'realistic portraits' }]),
      textSnapshot('Answer without more lookups.'),
    ];
    await startChat();
    await send('compare those two styles', /Answer without more lookups/);

    expect(submitFn).toHaveBeenCalledTimes(3);
    expect(toolRequests.filter((r) => r.method === 'POST')).toHaveLength(2);
    expect(screen.queryByText(/could not finish that/)).toBeNull();
  });

  it('🔴 two identical calls WITHIN one round are one round, handled normally', async () => {
    // Invariant guard: the byte-identity rule compares ROUNDS, never calls
    // inside one response. A round that emits the same lookup twice (ids
    // differ) is handled the ordinary way — both execute, both answered.
    toolItems = [{ id: DREAMSHAPER, name: 'DreamShaper', type: 'Checkpoint' }];
    pollQueue = [
      toolCalls([
        { id: 'call_0', query: 'same query' },
        { id: 'call_1', query: 'same query' },
      ]),
      textSnapshot('Both looked up.'),
    ];
    await startChat();
    await send('look up the same thing twice', /Both looked up/);

    expect(submitFn).toHaveBeenCalledTimes(2);
    expect(toolRequests.filter((r) => r.method === 'POST')).toHaveLength(2);
    expect(screen.queryByText(/could not finish that/)).toBeNull();
    const round2 = submittedBodies[1].params.messages;
    expect(round2.filter((m) => m.role === 'tool')).toHaveLength(2);
  });
});