import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage, fakeBlockCatalogApi } from './test-helpers.js';
import { clearCache, CATALOG_CONTEXT_MARKER } from './lib/research.js';

interface SubmittedParams {
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens: number;
  temperature?: number;
}

/**
 * 🔴 STRUCTURAL, NOT SPELLED. The app's own system prompt NAMES the catalog
 * label so the model recognises it, so `messages.some(m =>
 * m.content.includes(MARKER))` is true even when retrieval returned nothing —
 * it matches the prompt. That exact mistake made three assertions here pass
 * vacuously on the first run. The catalog message is identified by POSITION and
 * ROLE (a `system` message that is not the leading app prompt); the marker is
 * only a secondary check.
 */
function catalogMessages(params: SubmittedParams) {
  return params.messages.filter(
    (m, i) => i > 0 && m.role === 'system' && m.content.includes(CATALOG_CONTEXT_MARKER),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THIS SUITE ASSERTS ON THE CONSTRUCTED REQUEST BODY, NOT ON THE SCREEN.
//
// "The answer mentioned a model" is satisfied by a model that hallucinated one.
// The only thing that distinguishes real grounding from a confident invention
// is what was actually PUT ON THE WIRE — so every assertion here reads the
// params object the app handed to `submit`, and the URL/headers it handed to
// `fetch`.
//
// It is also the one place that pins the `.strict()` contract end to end: the
// exact key set `{model, messages, maxTokens, temperature}`. One assertion,
// every rejected param at once.
// ─────────────────────────────────────────────────────────────────────────────

const submitted: Array<Record<string, unknown>> = [];

const submitFn = vi.fn(async (body: { params?: Record<string, unknown> }) => {
  if (body?.params) submitted.push(body.params);
  return { workflowId: 'wf-1', status: 'pending' };
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
    estimate: vi.fn().mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } }),
    submit: submitFn,
    poll: vi.fn().mockResolvedValue({
      workflowId: 'wf-1',
      status: 'succeeded',
      cost: { total: 1 },
      textOutputs: ['Test Model (id 1234) is the closest match.'],
    }),
    cancel: vi.fn().mockResolvedValue(undefined),
    status: 'idle',
    result: null,
    error: null,
  }),
}));

async function sendMessage(text: string) {
  render(<App />);
  await waitFor(() => {
    expect(screen.queryByTestId('app-loading')).toBeNull();
  });
  fireEvent.click(screen.getByTestId('new-session-button'));
  await waitFor(() => {
    expect(screen.getByTestId('chat-input')).toBeTruthy();
  });
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('send-button'));
  await waitFor(() => {
    expect(submitted.length).toBeGreaterThan(0);
  }, { timeout: 5000 });
  return submitted[submitted.length - 1] as unknown as SubmittedParams;
}

describe('Route A: retrieve → inject → one completion', () => {
  let api: ReturnType<typeof fakeBlockCatalogApi>;

  beforeEach(() => {
    submitted.length = 0;
    submitFn.mockClear();
    clearCache();
    api = fakeBlockCatalogApi();
  });

  afterEach(() => {
    api.restore();
  });

  it('fetches the block catalog with the block token, using the DERIVED query', async () => {
    // 🔴 THIS USED TO ASSERT `query === 'best anime lora'` — the user's sentence,
    // sent verbatim to a KEYWORD search. Measured against the live endpoint,
    // both HTTP 200: "best anime lora" → "Best Studio Ghibli LoRA Style";
    // "anime lora" → "Anime LoRA - Makoto Shinkai Anime Style". The sentence
    // matches on its own filler words, and the wrong models are then injected as
    // authoritative catalog context.
    await sendMessage('best anime lora');
    const catalogCalls = api.calls.filter((c) => c.url.includes('/api/v1/blocks/models'));
    expect(new URL(catalogCalls[0].url).searchParams.get('query')).toBe('anime lora');
    expect(catalogCalls[0].authorization).toBe('Bearer block-jwt-test');
  });

  it('retries ONCE, narrowed, when the hits carry none of the query terms', async () => {
    // The stock fixture returns "Test Model" / "Private Stats Model", whose
    // names share no term with "anime lora" — the shape that produced the
    // DreamShaper failure. At most two requests, and never any Buzz: retrieval
    // is plain HTTP.
    await sendMessage('best anime lora');
    const catalogCalls = api.calls.filter((c) => c.url.includes('/api/v1/blocks/models'));
    expect(catalogCalls).toHaveLength(2);
    expect(new URL(catalogCalls[1].url).searchParams.get('query')).toBe('anime');
    expect(catalogCalls.every((c) => c.authorization === 'Bearer block-jwt-test')).toBe(true);
  });

  it('injects the retrieved catalog data into the submitted messages', async () => {
    const params = await sendMessage('best anime lora');
    const catalog = catalogMessages(params);
    expect(catalog).toHaveLength(1);
    // Real data from the fixture — an id and a canonical link the model can cite.
    expect(catalog[0].content).toContain('[id 1234]');
    expect(catalog[0].content).toContain('Test Model');
    expect(catalog[0].content).toContain('https://civitai.com/models/1234');
  });

  it('places the catalog message immediately BEFORE the user turn', async () => {
    const params = await sendMessage('best anime lora');
    const catalogIdx = params.messages.indexOf(catalogMessages(params)[0]);
    expect(catalogIdx).toBeGreaterThan(0);
    expect(params.messages[catalogIdx + 1]).toEqual({
      role: 'user',
      content: 'best anime lora',
    });
  });

  it('submits EXACTLY {model, messages, maxTokens, temperature} — no tools, no stream', async () => {
    const params = await sendMessage('best anime lora');
    // The host's chatCompletionParamsSchema is `.strict()`. Every key outside
    // this set is a BAD_REQUEST for the whole request.
    expect(Object.keys(params).sort()).toEqual(['maxTokens', 'messages', 'model', 'temperature']);
    expect(params).not.toHaveProperty('tools');
    expect(params).not.toHaveProperty('tool_choice');
    expect(params).not.toHaveProperty('stream');
    expect(params).not.toHaveProperty('max_tokens');
    expect(params).not.toHaveProperty('response_format');
  });

  it('sends exactly ONE completion per turn — one charge, no tool rounds', async () => {
    await sendMessage('best anime lora');
    expect(submitFn).toHaveBeenCalledTimes(1);
  });

  it('never sends a role the host rejects', async () => {
    const params = await sendMessage('best anime lora');
    for (const m of params.messages) {
      expect(['system', 'user', 'assistant']).toContain(m.role);
    }
  });

  it('carries no `urn:air:` literal into the submitted messages', async () => {
    api.restore();
    api = fakeBlockCatalogApi({
      models: () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: 1234,
                name: 'Air Model',
                description: 'load with urn:air:sdxl:checkpoint:civitai/1234',
                type: 'Checkpoint',
                tags: [],
                stats: {
                  downloadCount: 5,
                  thumbsUpCount: 1,
                  thumbsDownCount: 0,
                  commentCount: 0,
                  tippedAmountCount: 0,
                },
                modelVersions: [],
              },
            ],
            metadata: {},
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    const params = await sendMessage('air model');
    const joined = JSON.stringify(params).toLowerCase();
    // Positive control: the grounding DID land, so the absence below is a strip
    // rather than an empty injection.
    expect(joined).toContain('air model');
    expect(joined).toContain('urn-air-');
    expect(joined).not.toContain('urn:air:');
  });

  it('SKIPS retrieval for a bare pleasantry', async () => {
    const params = await sendMessage('thanks');
    expect(api.calls.filter((c) => c.url.includes('/api/v1/blocks/'))).toHaveLength(0);
    expect(catalogMessages(params)).toHaveLength(0);
    // The turn still goes through — skipping retrieval must not skip the answer.
    expect(submitFn).toHaveBeenCalledTimes(1);
  });

  it('still answers when the catalog fetch FAILS, with no injected context', async () => {
    api.restore();
    api = fakeBlockCatalogApi({ models: () => new Response('down', { status: 503 }) });
    const params = await sendMessage('best anime lora');
    expect(catalogMessages(params)).toHaveLength(0);
    expect(submitFn).toHaveBeenCalledTimes(1);
  });

  it('sends no catalog message when the search returns zero items', async () => {
    api.restore();
    api = fakeBlockCatalogApi({
      models: () =>
        new Response(JSON.stringify({ items: [], metadata: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    const params = await sendMessage('zxqwv nothing matches this');
    // An empty `content` would be a `.min(1)` BAD_REQUEST — the whole turn.
    for (const m of params.messages) expect(m.content.length).toBeGreaterThan(0);
    expect(catalogMessages(params)).toHaveLength(0);
  });

  it("the system prompt does NOT claim tool access", async () => {
    const params = await sendMessage('best anime lora');
    const appPrompt = params.messages[0];
    expect(appPrompt.role).toBe('system');
    expect(appPrompt.content).toMatch(/cannot browse, search, or call tools/i);
    expect(appPrompt.content).not.toMatch(/You can search the Civitai model catalog/i);
  });
});
