import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage } from './test-helpers.js';
import { clearCache } from './lib/research.js';
import { RECOMMEND_TOOL_NAME } from './lib/recommend.js';

// ─────────────────────────────────────────────────────────────────────────────
// `recommend_resources` THROUGH THE REAL COMPONENT TREE.
//
// `lib/recommend.test.ts` pins the tool in isolation. This file builds the
// combined state nobody else does: the declaration on the WIRE beside the host's,
// the call ROUTED to the recommendation route rather than to `/tools`, the
// model-authored image description SHOWN while the lookup runs, the result
// returned to the model as the `role:'tool'` message, and the returned ids
// GROUNDED so the reply's links render — without spending a correction round.
//
// Assertions read what was put on the wire (the submitted params and the fetch
// log), for the reason `tool-calling.e2e.test.tsx` gives: "the answer mentioned
// a model" is satisfied by a model that invented one.
// ─────────────────────────────────────────────────────────────────────────────

interface SubmittedParams {
  messages: Array<{ role: string; content?: string; tool_call_id?: string }>;
  tools?: Array<{ type: string; function: { name: string } }>;
}

const submitted: SubmittedParams[] = [];
let pollQueue: Array<Record<string, unknown>> = [];
let intentRequests: Array<Record<string, unknown>> = [];
let toolPosts = 0;
let releaseIntent: (() => void) | null = null;
let intentResponder: (body: Record<string, unknown>) => unknown = () => ({});

const estimateFn = vi.fn().mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } });
const submitFn = vi.fn(async (body: { params?: Record<string, unknown> }) => {
  if (body?.params) submitted.push(body.params as unknown as SubmittedParams);
  return { workflowId: `wf-${submitted.length}`, status: 'pending' };
});
const pollFn = vi.fn(async () => {
  const next = pollQueue.shift();
  return next ?? { workflowId: 'wf-x', status: 'succeeded', cost: { total: 1 }, textOutputs: ['done'] };
});

vi.mock('./lib/sdk-runtime.js', () => ({
  useAppStorage: () => fakeAppStorage().appStorage,
  useBlockAnalytics: () => ({ track: vi.fn() }),
  useBlockContext: () => ({ ready: true, viewer: { id: 1 }, theme: 'dark' }),
  useBlockResize: () => {},
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

const HOST_DECLARATIONS = [
  {
    type: 'function',
    function: {
      name: 'search_models',
      description: 'Search the Civitai model catalog',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  },
];

const DESCRIPTION = 'neon cyberpunk street at night, rain-slick asphalt, cinematic lighting';

function suggestion(modelId: number, versionId: number, name: string, type: string) {
  return {
    versionId,
    modelId,
    modelName: name,
    versionName: 'v1',
    baseModel: 'SDXL 1.0',
    modelType: type,
    strength: 0.8,
    minStrength: 0,
    maxStrength: 1,
    trainedWords: type === 'LORA' ? ['neon glow'] : [],
    clipSkip: null,
  };
}

function okBody(suggestions: unknown[]) {
  return {
    degraded: false,
    insightFallback: false,
    intent: null,
    criteria: null,
    suggestions,
    noneProbability: 0.1,
    model: 'm',
    criteriaVersion: 2,
    maturity: { browsingLevel: 1, sfwOnly: true },
  };
}

function recommendRound(args: Record<string, unknown>) {
  return {
    workflowId: 'wf-rec',
    status: 'succeeded',
    cost: { total: 1 },
    toolCalls: [
      { id: 'call_rec', type: 'function', function: { name: RECOMMEND_TOOL_NAME, arguments: JSON.stringify(args) } },
    ],
  };
}

function textSnapshot(text: string) {
  return { workflowId: 'wf-t', status: 'succeeded', cost: { total: 1 }, textOutputs: [text] };
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  submitted.length = 0;
  pollQueue = [];
  intentRequests = [];
  toolPosts = 0;
  releaseIntent = null;
  submitFn.mockClear();
  pollFn.mockClear();
  clearCache();
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/v1/blocks/tools')) {
      if (method === 'GET') return new Response(JSON.stringify({ tools: HOST_DECLARATIONS }), { status: 200 });
      toolPosts += 1;
      return new Response(JSON.stringify({ items: [], truncated: 0 }), { status: 200 });
    }
    if (url === 'https://civitai.com/api/v1/blocks/resource-intent' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      intentRequests.push(body);
      // Held open for the FIRST request so the in-flight label is observable.
      if (intentRequests.length === 1) {
        await new Promise<void>((resolve) => {
          releaseIntent = resolve;
        });
      }
      return new Response(JSON.stringify(intentResponder(body)), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${method} ${url}`);
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  releaseIntent?.();
  globalThis.fetch = originalFetch;
});

async function startAndSend(text: string) {
  render(<App />);
  await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
  fireEvent.click(screen.getByTestId('new-session-button'));
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('send-button'));
}

function anchorFor(id: number): HTMLAnchorElement | null {
  return document.querySelector<HTMLAnchorElement>(`a[href*="/models/${id}"]`);
}

describe('recommend_resources through the app', () => {
  it('declared, routed, shown, returned to the model and grounded — in one turn', async () => {
    intentResponder = (body) =>
      body.kind === 'checkpoint'
        ? okBody([suggestion(4402, 7402, 'Night City XL', 'Checkpoint')])
        : okBody([suggestion(4401, 7401, 'Neon Glow', 'LORA')]);
    pollQueue = [
      recommendRound({ image_description: DESCRIPTION, base_model: 'SDXL 1.0' }),
      textSnapshot(
        'For that image: [Neon Glow](https://civitai.com/models/4401) (trigger: neon glow) on ' +
          '[Night City XL](https://civitai.com/models/4402).',
      ),
    ];
    await startAndSend('what should I use for a cyberpunk city poster? I use SDXL');

    // The declaration rode beside the host's on the first submit.
    await waitFor(() => expect(submitted.length).toBeGreaterThanOrEqual(1), { timeout: 8000 });
    expect(submitted[0].tools?.map((t) => t.function.name)).toEqual(['search_models', RECOMMEND_TOOL_NAME]);

    // The viewer sees the model's rewrite WHILE the lookup runs.
    await waitFor(() => expect(screen.getByTestId('lookup-query').textContent).toContain(DESCRIPTION), {
      timeout: 8000,
    });
    await waitFor(() => expect(releaseIntent).not.toBeNull());
    releaseIntent!();

    await waitFor(() => expect(submitted.length).toBe(2), { timeout: 8000 });
    // Routed to the recommendation route — add-ons AND checkpoints, never /tools.
    expect(toolPosts).toBe(0);
    expect(intentRequests).toEqual(
      expect.arrayContaining([
        { prompt: DESCRIPTION, baseModel: 'SDXL 1.0' },
        { prompt: DESCRIPTION, baseModel: 'SDXL 1.0', kind: 'checkpoint' },
      ]),
    );
    expect(intentRequests).toHaveLength(2);

    // The model got the result, correlated to its call.
    const toolMsg = submitted[1].messages.find((m) => m.role === 'tool');
    expect(toolMsg?.tool_call_id).toBe('call_rec');
    const payload = JSON.parse(toolMsg?.content ?? '{}');
    expect(payload.addons.items.map((i: { modelId: number }) => i.modelId)).toEqual([4401]);
    expect(payload.checkpoints.items.map((i: { modelId: number }) => i.modelId)).toEqual([4402]);

    // Grounded: both links render, and NO correction round was spent (2 submits, not 3).
    // (The reply is typed out, so the second link arrives after the first.)
    await waitFor(
      () => {
        expect(anchorFor(4401)).not.toBeNull();
        expect(anchorFor(4402)).not.toBeNull();
      },
      { timeout: 8000 },
    );
    await waitFor(() => expect(screen.queryByTestId('streaming-indicator')).toBeNull(), { timeout: 8000 });
    expect(submitted).toHaveLength(2);
    expect(screen.queryByTestId('lookup-query')).toBeNull();
  }, 20_000);

  it('🔴 a DEGRADED answer reaches the model as a failure, never as "no models needed"', async () => {
    intentResponder = () => ({ ...okBody([]), degraded: true, model: 'jev-unavailable' });
    pollQueue = [
      recommendRound({ image_description: DESCRIPTION }),
      textSnapshot('The recommendation lookup is unavailable right now.'),
    ];
    await startAndSend('what lora for a cyberpunk poster?');

    await waitFor(() => expect(releaseIntent).not.toBeNull(), { timeout: 8000 });
    releaseIntent!();
    await waitFor(() => expect(submitted.length).toBe(2), { timeout: 8000 });

    // No base model ⇒ exactly one add-on request, no checkpoint request.
    expect(intentRequests).toEqual([{ prompt: DESCRIPTION }]);
    const toolMsg = submitted[1].messages.find((m) => m.role === 'tool');
    const payload = JSON.parse(toolMsg?.content ?? '{}');
    expect(Object.keys(payload)).toEqual(['error']);
    expect(payload.error).toMatch(/This is a failure, NOT a finding/);
  }, 20_000);
});
