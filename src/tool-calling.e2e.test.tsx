import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage } from './test-helpers.js';
import { clearCache } from './lib/research.js';
import { MAX_TOOL_RESULT_MESSAGES } from './lib/tools.js';

interface SubmittedParams {
  model: string;
  messages: Array<{
    role: string;
    content?: string;
    tool_call_id?: string;
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  }>;
  maxTokens: number;
  temperature?: number;
  tools?: Array<{ type: string; function: { name: string } }>;
  tool_choice?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THIS SUITE ASSERTS ON THE CONSTRUCTED REQUEST BODY, NOT ON THE SCREEN —
// inherited deliberately from the retrieval suite this replaces.
//
// "The answer mentioned a model" is satisfied by a model that hallucinated one.
// The only thing that distinguishes a real tool round from a confident
// invention is what was actually PUT ON THE WIRE, so every assertion here reads
// the params the app handed to `submit` and the requests it handed to `fetch`.
//
// 🔴 AND IT PINS THE WIRE SPELLING. The app's field is `toolChoice`; the host
// reads `tool_choice`. Getting that backwards does not error — the orchestrator
// would ignore an unknown key and the feature would be silently inert — so the
// snake_case key is asserted explicitly rather than assumed.
// ─────────────────────────────────────────────────────────────────────────────

const submitted: SubmittedParams[] = [];
/** One snapshot per poll, in order. Lets a test drive round N's reply. */
let pollQueue: Array<Record<string, unknown>> = [];
let toolRequests: Array<{ url: string; method: string; authorization: string; body: unknown }> = [];

/**
 * 🔴 HOISTED, NOT INLINE. `useBuzzWorkflow` is called on every render, and an
 * inline `vi.fn()` here is a NEW function identity each time — which changes
 * the `useMemo` dep in `App`, rebuilds the orchestrator adapter, and silently
 * discards the `lastWorkflowId` it closes over. `cancel()` then no-ops. That
 * cost a real debugging cycle: the symptom looked like Stop failing to cancel.
 */
const estimateFn = vi.fn().mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } });

const submitFn = vi.fn(async (body: { params?: Record<string, unknown> }) => {
  if (body?.params) submitted.push(body.params as unknown as SubmittedParams);
  return { workflowId: `wf-${submitted.length}`, status: 'pending' };
});

const pollFn = vi.fn(async () => {
  const next = pollQueue.shift();
  return next ?? { workflowId: 'wf-x', status: 'succeeded', cost: { total: 1 }, textOutputs: ['done'] };
});

vi.mock('@civitai/blocks-react', () => ({
  useAppStorage: () => fakeAppStorage().appStorage,
  useBlockAnalytics: () => ({ track: vi.fn() }),
  useBlockContext: () => ({ ready: true, viewer: { id: 1 }, theme: 'dark' }),
  useBlockResize: () => {},
  useRequestConsent: () => ({ requestConsent: vi.fn() }),
  useRequestSignIn: () => ({ requestSignIn: vi.fn() }),
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

function toolCallSnapshot(args: string) {
  return {
    workflowId: 'wf-tc',
    status: 'succeeded',
    cost: { total: 1 },
    toolCalls: [{ id: 'call_abc', type: 'function', function: { name: 'search_models', arguments: args } }],
  };
}

/** N parallel calls in ONE round — the shape that broke the cap. */
function multiCallSnapshot(n: number) {
  return {
    workflowId: 'wf-mc',
    status: 'succeeded',
    cost: { total: 1 },
    toolCalls: Array.from({ length: n }, (_, i) => ({
      id: `call_${i}`,
      type: 'function',
      function: { name: 'search_models', arguments: JSON.stringify({ query: `q${i}` }) },
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
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.includes('/api/v1/blocks/tools')) {
      toolRequests.push({
        url,
        method,
        authorization: headers.Authorization ?? '',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const payload =
        method === 'GET'
          ? { tools: DECLARATIONS }
          : { items: [{ id: 1234, name: 'DreamShaper', type: 'Checkpoint' }], truncated: 0 };
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [], metadata: {} }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

async function sendMessage(text: string, expectSubmits = 1) {
  render(<App />);
  await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
  fireEvent.click(screen.getByTestId('new-session-button'));
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('send-button'));
  await waitFor(() => expect(submitted.length).toBeGreaterThanOrEqual(expectSubmits), {
    timeout: 8000,
  });
  return submitted;
}

describe('tool calling: the model forms its own query, one submit per round', () => {
  beforeEach(() => {
    submitted.length = 0;
    toolRequests = [];
    pollQueue = [];
    submitFn.mockClear();
    pollFn.mockClear();
    clearCache();
    installFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('FETCHES the declarations and puts them on the wire as `tools` + snake_case `tool_choice`', async () => {
    pollQueue = [textSnapshot('Here is an answer.')];
    const all = await sendMessage('what is DreamShaper?');

    // Fetched, not authored here — the model must not be shown a contract the
    // route does not enforce.
    const get = toolRequests.find((r) => r.method === 'GET');
    expect(get).toBeTruthy();
    expect(get?.authorization).toBe('Bearer block-jwt-test');

    const first = all[0];
    expect(first.tools?.[0].function.name).toBe('search_models');
    // 🔴 SNAKE_CASE ON THE WIRE. The app's own field is `toolChoice`; an
    // unknown key would be ignored and the feature silently inert.
    expect(first.tool_choice).toBe('auto');
    expect('toolChoice' in first).toBe(false);
  });

  it('drives a tool POST with the MODEL-authored arguments, then resubmits with the result', async () => {
    pollQueue = [
      toolCallSnapshot(JSON.stringify({ query: 'DreamShaper checkpoint' })),
      textSnapshot('DreamShaper is a checkpoint.'),
    ];
    const all = await sendMessage('what is DreamShaper?', 2);

    const post = toolRequests.find((r) => r.method === 'POST');
    expect(post?.authorization).toBe('Bearer block-jwt-test');
    // 🔴 THE QUERY IS THE MODEL'S. This is the entire argument for the change:
    // the old stopword stripper could only ever produce a subset of the user's
    // own words, never "DreamShaper checkpoint" from "what is DreamShaper?".
    expect(post?.body).toEqual({
      name: 'search_models',
      arguments: { query: 'DreamShaper checkpoint' },
    });

    // Round two carries the ask AND the answer, correlated.
    expect(all).toHaveLength(2);
    const second = all[1];
    const ask = second.messages.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(ask?.tool_calls?.[0].id).toBe('call_abc');
    // 🔴 THE ASK SURVIVES DESPITE HAVING NO CONTENT. `toStepMessages` drops
    // empty-content messages; without the tool_calls exemption this message
    // would vanish and the host would reject the answer below as uncorrelated.
    //
    // 🔴 ASSERT KEY ABSENCE, NOT AN `undefined` VALUE — the two are different on
    // this wire and only one of them is correct. The SDK transport is
    // postMessage, i.e. structured clone, which PRESERVES an explicit
    // `undefined` rather than dropping the key as `JSON.stringify` would; the
    // host's `content` is `.min(1)` WHEN PRESENT, so a preserved
    // `content: undefined` is a present key with an invalid value.
    // `toBeUndefined()` alone is satisfied by BOTH shapes, which is why the
    // mutant swapping the key-omission for `{ ...m, content: undefined }`
    // survived a fully green suite. This is the assertion that separates them.
    expect(ask && 'content' in ask).toBe(false);
    expect(ask?.content).toBeUndefined();

    const answer = second.messages.find((m) => m.role === 'tool');
    expect(answer?.tool_call_id).toBe('call_abc');
    expect(String(answer?.content)).toContain('DreamShaper');
  });

  it('terminates with the text answer once the model stops asking for tools', async () => {
    pollQueue = [
      toolCallSnapshot(JSON.stringify({ query: 'DreamShaper' })),
      textSnapshot('DreamShaper is a popular SD1.5 checkpoint.'),
    ];
    await sendMessage('what is DreamShaper?', 2);
    await waitFor(() => {
      expect(screen.getByText(/popular SD1\.5 checkpoint/)).toBeTruthy();
    });
    // Exactly two submits: one round of tools, then the answer.
    expect(submitted).toHaveLength(2);
  });

  it('stops at the round cap with a USER-VISIBLE message, not silently', async () => {
    // Always asks for a tool — the model never settles.
    pollQueue = Array.from({ length: MAX_TOOL_RESULT_MESSAGES + 2 }, () =>
      toolCallSnapshot(JSON.stringify({ query: 'loop' })),
    );
    await sendMessage('go in circles', MAX_TOOL_RESULT_MESSAGES + 1);

    // One initial submit plus MAX_TOOL_RESULT_MESSAGES tool rounds, then it stops.
    expect(submitted).toHaveLength(MAX_TOOL_RESULT_MESSAGES + 1);
    await waitFor(() => {
      expect(screen.getByText(/could not finish that/i)).toBeTruthy();
    });
  });

  it('🔴 ONE round of PARALLEL calls is bounded by MESSAGES, not rounds', async () => {
    // 🔴 THE MIRROR MUST MIRROR THE HOST'S QUANTITY. The host counts
    // `role:'tool'` MESSAGES in a `.superRefine`; this app used the same
    // constant as a count of ROUNDS. So a single round answering five parallel
    // calls put FIVE tool messages into one payload — over a mirrored cap of
    // three on the very first iteration — and the next submit was a
    // BAD_REQUEST for the whole turn, after the viewer had already paid for
    // that round.
    //
    // Five calls in round one exceeds the cap of three, so the loop must refuse
    // BEFORE executing them: one submit total, no tool POSTs, and the viewer
    // told why.
    pollQueue = [multiCallSnapshot(5), textSnapshot('unreachable')];
    await sendMessage('five at once', 1);

    await waitFor(() => {
      expect(screen.getByText(/could not finish that/i)).toBeTruthy();
    });
    // ISOLATING: had the bound counted rounds, this would be 2 (the round would
    // have run and resubmitted) and there would be five POSTs.
    expect(submitted).toHaveLength(1);
    expect(toolRequests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('parallel calls WITHIN the cap still run and are all answered', async () => {
    // POSITIVE CONTROL for the test above: the refusal must be the CAP, not an
    // inability to handle parallel calls at all. Three is exactly the cap.
    pollQueue = [multiCallSnapshot(3), textSnapshot('All three looked up.')];
    const all = await sendMessage('three at once', 2);

    expect(toolRequests.filter((r) => r.method === 'POST')).toHaveLength(3);
    const answers = all[1].messages.filter((m) => m.role === 'tool');
    expect(answers).toHaveLength(3);
    expect(answers.map((m) => m.tool_call_id).sort()).toEqual(['call_0', 'call_1', 'call_2']);
  });

  it('a MALFORMED arguments string is reported to the model, not thrown at the viewer', async () => {
    pollQueue = [toolCallSnapshot('{not json'), textSnapshot('I could not look that up.')];
    const all = await sendMessage('what is DreamShaper?', 2);

    // No POST was attempted — the arguments never parsed.
    expect(toolRequests.filter((r) => r.method === 'POST')).toHaveLength(0);
    // …but the model still got a readable result and the turn continued.
    const answer = all[1].messages.find((m) => m.role === 'tool');
    expect(String(answer?.content)).toContain('not valid JSON');
  });

  it('a WITHHELD reply carries no tool calls and does not hang the app', async () => {
    pollQueue = [
      {
        workflowId: 'wf-w',
        status: 'succeeded',
        cost: { total: 1 },
        textOutputWithheld: { reason: 'This response did not pass Civitai content policy.' },
      },
    ];
    await sendMessage('something disallowed', 1);
    await waitFor(() => {
      expect(screen.getByText(/did not pass Civitai content policy/)).toBeTruthy();
    });
    // The withhold ends the turn; no tool round is attempted off a withheld reply.
    expect(toolRequests.filter((r) => r.method === 'POST')).toHaveLength(0);
    expect(submitted).toHaveLength(1);
  });
});
