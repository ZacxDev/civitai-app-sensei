import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RECOMMEND_TOOL_DECLARATION,
  RECOMMEND_TOOL_NAME,
  SHOWN_PER_KIND,
  MAX_IMAGE_DESCRIPTION_CHARS,
  HOST_MAX_TOOLS,
  HOST_MAX_TOOL_DESCRIPTION_CHARS,
  HOST_MAX_TOOL_PARAMETERS_CHARS,
  buildResourceIntentRequests,
  MAX_NEEDS,
  SHOWN_HOSTED,
  composeLocalTools,
  executeRecommend,
  parseHostedModels,
  parseRecommendArgs,
  type ShownHostedModel,
} from './recommend.js';
import {
  MAX_LOOKUP_LABEL_CHARS,
  callToolWithFallback,
  executeToolCalls,
  readQueryArgument,
  type ToolCall,
} from './tools.js';
import { groundedIdsFromToolResult, ungroundedModelIds } from './grounding.js';

// ─────────────────────────────────────────────────────────────────────────────
// `recommend_resources` — the app-executed recommendation tool.
//
// 🔴 THE FIXTURES BELOW ARE SHAPED LIKE THE ROUTE'S REAL BODY, read off
// civitai/civitai `src/server/schema/resource-intent.schema.ts`
// (`resourceIntentResponseSchema`, `ResourceIntentSuggestion`): `degraded`,
// `insightFallback`, `suggestions[]` with `modelId`/`versionId`/`modelName`/
// `modelType`/`baseModel`/`trainedWords`/`strength`. Model ids and version ids
// are pairwise DISTINCT and never equal, so a projection that swapped them —
// grounding a VERSION id as if it were a model id — cannot pass by coincidence.
// ─────────────────────────────────────────────────────────────────────────────

const AUTH = { token: 'block-jwt-abc' };
const ROUTE = 'https://civitai.com/api/v1/blocks/resource-intent';

interface Seen {
  url: string;
  method: string;
  auth: string;
  body: Record<string, unknown> | undefined;
}
let requests: Seen[] = [];
let originalFetch: typeof globalThis.fetch;

function install(handler: (body: Record<string, unknown> | undefined, url: string) => Response) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    requests.push({ url, method: init?.method ?? 'GET', auth: headers.Authorization ?? '', body });
    return handler(body, url);
  }) as unknown as typeof globalThis.fetch;
}

function suggestion(modelId: number, versionId: number, extra: Record<string, unknown> = {}) {
  return {
    versionId,
    modelId,
    modelName: `Model ${modelId}`,
    versionName: `v${versionId}`,
    baseModel: 'SDXL 1.0',
    modelType: 'LORA',
    strength: 0.8,
    minStrength: 0,
    maxStrength: 1,
    trainedWords: [],
    clipSkip: null,
    ...extra,
  };
}

// A real add-on answer carries the compiled stage-1 verdict in `criteria.role`
// (null only when degraded, or in checkpoint mode). The default here is a role
// that WANTS a resource; the "nothing needed" case sets `role: 'none'` itself.
function okBody(suggestions: unknown[], extra: Record<string, unknown> = {}) {
  return {
    degraded: false,
    insightFallback: false,
    intent: { role: { value: 'style', distribution: { style: 1 } } },
    criteria: { criteriaVersion: 2, role: 'style', styleFamily: 'photorealistic', modelTypes: null, baseModel: null },
    suggestions,
    noneProbability: 0.1,
    model: 'typesafe/jev-1.13-20260917',
    criteriaVersion: 2,
    maturity: { browsingLevel: 1, sfwOnly: true },
    ...extra,
  };
}

const DEGRADED = okBody([], { degraded: true, model: 'jev-unavailable', intent: null, criteria: null });
const NONE_NEEDED = okBody([], {
  intent: { role: { value: 'none', distribution: { none: 1 } } },
  criteria: { criteriaVersion: 2, role: 'none', styleFamily: 'other', modelTypes: null, baseModel: null },
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function recommendCall(args: Record<string, unknown> | string): ToolCall {
  return {
    id: 'call_r',
    type: 'function',
    function: {
      name: RECOMMEND_TOOL_NAME,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  };
}

// `true` explicitly: the tool ships off (`RECOMMEND_TOOL_ENABLED`), and these
// cases test the tool itself, not the shipped default.
const LOCAL = composeLocalTools(
  [{ type: 'function', function: { name: 'search_models', parameters: {} } }],
  true,
).local!;

const DESCRIPTION = 'clean commercial product photo of a perfume bottle on a marble counter, soft studio light';

beforeEach(() => {
  requests = [];
});
afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

// ── 1. The request body built from the model's arguments ────────────────────

describe('recommend — request bodies come from the model\'s arguments', () => {
  it('no base model ⇒ ONE add-on request, body exactly { prompt }', () => {
    const parsed = parseRecommendArgs({ image_description: `  ${DESCRIPTION}  ` });
    expect(parsed).toEqual({ ok: true, value: { imageDescription: DESCRIPTION, baseModel: null, needs: [] } });
    if (!parsed.ok) throw new Error('unreachable');
    expect(buildResourceIntentRequests(parsed.value)).toEqual([
      { kind: 'addon', body: { prompt: DESCRIPTION } },
    ]);
  });

  it('with a base model ⇒ add-on WITH baseModel, plus a checkpoint request', () => {
    const parsed = parseRecommendArgs({ image_description: DESCRIPTION, base_model: ' Illustrious ' });
    if (!parsed.ok) throw new Error('expected ok');
    expect(buildResourceIntentRequests(parsed.value)).toEqual([
      { kind: 'addon', body: { prompt: DESCRIPTION, baseModel: 'Illustrious' } },
      { kind: 'checkpoint', body: { prompt: DESCRIPTION, baseModel: 'Illustrious', kind: 'checkpoint' } },
    ]);
  });

  it('🔴 a BLANK base model is absent: no checkpoint request, no empty baseModel sent', () => {
    for (const base_model of ['', '   ', null]) {
      const parsed = parseRecommendArgs({ image_description: DESCRIPTION, base_model });
      if (!parsed.ok) throw new Error('expected ok');
      const reqs = buildResourceIntentRequests(parsed.value);
      expect(reqs).toHaveLength(1);
      expect(reqs[0].body).toEqual({ prompt: DESCRIPTION });
    }
  });

  it('on the wire: POSTs to the route with the block token, one body per kind', async () => {
    install(() => json(okBody([suggestion(101, 9001)])));
    const out = await executeRecommend({ image_description: DESCRIPTION, base_model: 'SDXL 1.0' }, AUTH);
    expect(out.ok).toBe(true);
    expect(requests.map((r) => [r.url, r.method, r.auth])).toEqual([
      [ROUTE, 'POST', 'Bearer block-jwt-abc'],
      [ROUTE, 'POST', 'Bearer block-jwt-abc'],
    ]);
    // Order of arrival is not part of the contract (they run in parallel).
    expect(requests.map((r) => r.body)).toEqual(
      expect.arrayContaining([
        { prompt: DESCRIPTION, baseModel: 'SDXL 1.0' },
        { prompt: DESCRIPTION, baseModel: 'SDXL 1.0', kind: 'checkpoint' },
      ]),
    );
  });

  it('🔴 NEVER requests checkpoints without a base model', async () => {
    install(() => json(okBody([suggestion(101, 9001)])));
    await executeRecommend({ image_description: DESCRIPTION }, AUTH);
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toEqual({ prompt: DESCRIPTION });
    expect(requests[0].body).not.toHaveProperty('kind');
    expect(requests[0].body).not.toHaveProperty('limit');
  });

  it('refuses bad arguments BEFORE any request', async () => {
    install(() => json(okBody([])));
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{}, /image_description is required/],
      [{ image_description: '   ' }, /image_description is required/],
      [{ image_description: 42 }, /image_description is required/],
      [{ query: DESCRIPTION }, /image_description is required/],
      [{ image_description: 'x'.repeat(MAX_IMAGE_DESCRIPTION_CHARS + 1) }, /longer than 6000/],
      [{ image_description: DESCRIPTION, base_model: 5 }, /base_model must be a string/],
      [{ image_description: DESCRIPTION, base_model: 'b'.repeat(65) }, /base_model is longer than 64/],
    ];
    for (const [args, reason] of cases) {
      const out = await executeRecommend(args, AUTH);
      expect(out.ok).toBe(false);
      if (out.ok) continue;
      expect(out.kind).toBe('arguments');
      expect(out.reason).toMatch(reason);
    }
    expect(requests).toHaveLength(0);
  });

  it('a description at exactly the route\'s maximum is accepted (the boundary is inclusive)', () => {
    const parsed = parseRecommendArgs({ image_description: 'y'.repeat(MAX_IMAGE_DESCRIPTION_CHARS) });
    expect(parsed.ok).toBe(true);
  });
});

// ── 2. Each response class ───────────────────────────────────────────────────

async function render(handler: (body: Record<string, unknown> | undefined) => Response, args: Record<string, unknown>) {
  install(handler);
  return callToolWithFallback(recommendCall(args), AUTH, LOCAL);
}

describe('recommend — every response class is told apart', () => {
  it('normal: top suggestions with name, type, base model, link and trigger words', async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      suggestion(100 + i, 9000 + i, i === 0 ? { trainedWords: ['glossy product', '  ', 'studio'] } : {}),
    );
    const out = await render(() => json(okBody(many)), { image_description: DESCRIPTION });
    const parsed = JSON.parse(out);
    expect(parsed.imageDescription).toBe(DESCRIPTION);
    expect(parsed.baseModel).toBeNull();
    expect(parsed.addons.status).toBe('ok');
    expect(parsed.addons.items).toHaveLength(SHOWN_PER_KIND);
    expect(parsed.addons.notShown).toBe(8 - SHOWN_PER_KIND);
    // No versionId: a second id beside modelId invites an ungrounded link.
    expect(parsed.addons.items[0]).toEqual({
      modelId: 100,
      name: 'Model 100',
      type: 'LORA',
      baseModel: 'SDXL 1.0',
      url: 'https://civitai.com/models/100',
      triggerWords: ['glossy product', 'studio'],
    });
    // No trigger words ⇒ the key is absent, not an empty list the model might read as "none needed".
    expect(parsed.addons.items[1]).not.toHaveProperty('triggerWords');
    expect(parsed.checkpoints.status).toBe('not_requested');
    expect(typeof parsed.howToPresent).toBe('string');
  });

  it('🔴 grounds the MODEL ids it shows — never the version ids, never the hidden tail', async () => {
    const many = Array.from({ length: 7 }, (_, i) => suggestion(200 + i, 7000 + i));
    const out = await render(() => json(okBody(many)), { image_description: DESCRIPTION });
    expect(groundedIdsFromToolResult(out).sort()).toEqual(['200', '201', '202', '203', '204']);
  });

  it('with a base model: add-ons and checkpoints, both shown; checkpoints carry no trigger words', async () => {
    const out = await render(
      (body) =>
        body?.kind === 'checkpoint'
          ? json(okBody([suggestion(301, 8301, { modelType: 'Checkpoint', trainedWords: ['x'] })], { kind: 'checkpoint' }))
          : json(okBody([suggestion(401, 8401, { trainedWords: ['neon'] })])),
      { image_description: DESCRIPTION, base_model: 'SDXL 1.0' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.baseModel).toBe('SDXL 1.0');
    expect(parsed.addons.items.map((i: { modelId: number }) => i.modelId)).toEqual([401]);
    expect(parsed.addons.items[0].triggerWords).toEqual(['neon']);
    expect(parsed.checkpoints.items.map((i: { modelId: number }) => i.modelId)).toEqual([301]);
    expect(parsed.checkpoints.items[0]).not.toHaveProperty('triggerWords');
    expect(groundedIdsFromToolResult(out).sort()).toEqual(['301', '401']);
  });

  it('🔴 DEGRADED + empty is a FAILURE — never rendered as "no models needed"', async () => {
    const out = await render(() => json(DEGRADED), { image_description: DESCRIPTION });
    const parsed = JSON.parse(out);
    // The error channel every failed lookup uses — not a result object.
    expect(Object.keys(parsed)).toEqual(['error']);
    expect(parsed.error).toMatch(/failed on this request and returned nothing/);
    expect(parsed.error).toMatch(/do not tell the user that no models are needed/i);
    expect(out).not.toMatch(/none_needed/);
    expect(groundedIdsFromToolResult(out)).toEqual([]);
  });

  it('EMPTY, NOT degraded, stage-1 role `none`: a real answer — the image needs no add-on', async () => {
    const out = await render(() => json(NONE_NEEDED), { image_description: DESCRIPTION });
    const parsed = JSON.parse(out);
    expect(parsed).not.toHaveProperty('error');
    expect(parsed.addons.status).toBe('none_needed');
    expect(parsed.addons.note).toMatch(/needs no add-on resource/);
    expect(parsed.addons).not.toHaveProperty('items');
  });

  it('🔴 EMPTY, NOT degraded, but the route WANTED a resource: nothing matched, NOT "none needed"', async () => {
    // The service returns this when role !== 'none' and nothing survives its
    // search, maturity clamp and hydration — and an absent verdict is the same.
    for (const body of [okBody([]), okBody([], { intent: null, criteria: null })]) {
      requests = [];
      const out = await render(() => json(body), { image_description: DESCRIPTION });
      const parsed = JSON.parse(out);
      expect(parsed.addons.status).toBe('none_found');
      expect(parsed.addons.note).toMatch(/does not mean none is needed/);
      expect(out).not.toMatch(/none_needed/);
    }
  });

  it('🔴 degraded add-ons beside working checkpoints: the add-on section says FAILED, not none_needed', async () => {
    const out = await render(
      (body) => (body?.kind === 'checkpoint' ? json(okBody([suggestion(501, 8501)])) : json(DEGRADED)),
      { image_description: DESCRIPTION, base_model: 'Pony' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.addons.status).toBe('failed');
    expect(parsed.addons.note).toMatch(/NOT a finding/);
    expect(parsed.checkpoints.status).toBe('ok');
    expect(groundedIdsFromToolResult(out)).toEqual(['501']);
  });

  it('401: the token was refused — reported, not retried', async () => {
    const out = await render(() => json({ error: 'Block token required' }, 401), {
      image_description: DESCRIPTION,
    });
    expect(requests).toHaveLength(1);
    expect(JSON.parse(out).error).toMatch(/rejected this app's token/);
  });

  // 🔴 THE FIRST FIXTURE IS THE MEASURED WIRE SHAPE, captured live from the route
  // (2026-10-12, an unknown base model on a checkpoint request): the zod issue
  // list arrives JSON-ENCODED inside `error.message`, not as an `issues` array.
  // The first version of this test used an `{ issues: [...] }` fixture the route
  // never sends, passed, and the live call then showed the model a raw JSON blob.
  const ZOD_ISSUE = "baseModel must be a known base model when kind is 'checkpoint'";
  const MEASURED_400 = {
    error: {
      name: 'ZodError',
      message: JSON.stringify(
        [{ code: 'custom', path: ['baseModel'], message: ZOD_ISSUE }],
        null,
        2,
      ),
    },
  };
  const EXPECTED_NOTE =
    `Civitai refused the checkpoint request as invalid: ${ZOD_ISSUE}. ` +
    'If the base model name "SDXL" may be wrong, use Civitai\'s exact base model name or omit base_model; ' +
    'otherwise say checkpoint suggestions are unavailable.';

  for (const [label, body400] of [
    ['as the route actually sends it (issues JSON-encoded in `message`)', MEASURED_400],
    ['as a bare `issues` array', { error: { issues: [{ code: 'custom', message: ZOD_ISSUE }] } }],
  ] as const) {
    it(`400: the route's own reason reaches the model — ${label}`, async () => {
      const out = await render(
        (body) => (body?.kind === 'checkpoint' ? json(body400, 400) : json(okBody([suggestion(601, 8601)]))),
        { image_description: DESCRIPTION, base_model: 'SDXL' },
      );
      const parsed = JSON.parse(out);
      expect(parsed.addons.status).toBe('ok');
      expect(parsed.checkpoints.status).toBe('failed');
      expect(parsed.checkpoints.note).toBe(EXPECTED_NOTE);
    });
  }

  it('🔴 an EMPTY add-on list WITH a base model names the typo reading (a bad name filters to nothing)', async () => {
    const out = await render(
      (body) => (body?.kind === 'checkpoint' ? json(MEASURED_400, 400) : json(okBody([]))),
      { image_description: DESCRIPTION, base_model: 'Not A Base Model' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.addons.status).toBe('none_found');
    expect(parsed.addons.note).toMatch(/if the base model name may be wrong, ask the user or retry without base_model/);
    expect(parsed.checkpoints.status).toBe('failed');
  });

  it('🔴 400 with a PLAIN-STRING reason (checkpoint flag dark) is "unavailable", not a bad base model', async () => {
    const out = await render(
      (body) =>
        body?.kind === 'checkpoint'
          ? json({ error: "kind 'checkpoint' is not enabled" }, 400)
          : json(okBody([suggestion(611, 8611)])),
      { image_description: DESCRIPTION, base_model: 'SDXL 1.0' },
    );
    const note = JSON.parse(out).checkpoints.note as string;
    expect(note).toBe(
      "Checkpoint recommendations are not available on Civitai right now (kind 'checkpoint' is not enabled). " +
        'This is not a problem with the arguments — do not retry with a different base model or description. ' +
        'Say so; you may use the model search tool instead.',
    );
  });

  it('404: the route is dark — says unavailable, grounds nothing', async () => {
    const out = await render(() => json({ error: 'Not found' }, 404), { image_description: DESCRIPTION });
    expect(JSON.parse(out).error).toMatch(/not available on Civitai right now/);
    expect(groundedIdsFromToolResult(out)).toEqual([]);
  });

  it('🔴 429 with Retry-After: retried ONCE, then reported with the wait, and no further call', async () => {
    const out = await render(
      () => json({ error: 'Rate limit exceeded, please retry shortly.' }, 429, { 'Retry-After': '1' }),
      { image_description: DESCRIPTION },
    );
    // One retry, honouring the header (1 s), then the answer.
    expect(requests).toHaveLength(2);
    const error = JSON.parse(out).error as string;
    expect(error).toMatch(/Civitai asked to wait 1 seconds/);
    expect(error).toMatch(/Do not call this tool again this turn/);
  }, 10_000);

  it('a 429 that clears on the retry is simply an answer', async () => {
    let n = 0;
    const out = await render(
      () => (n++ === 0 ? json({ error: 'slow down' }, 429, { 'Retry-After': '1' }) : json(okBody([suggestion(701, 8701)]))),
      { image_description: DESCRIPTION },
    );
    expect(requests).toHaveLength(2);
    expect(JSON.parse(out).addons.items[0].modelId).toBe(701);
  }, 10_000);

  it('a 200 this app cannot read is a failure, not "nothing needed"', async () => {
    for (const body of [{}, { degraded: false }, okBody([{ modelName: 'no id' }])]) {
      requests = [];
      const out = await render(() => json(body), { image_description: DESCRIPTION });
      expect(JSON.parse(out).error).toMatch(/could not read/);
    }
  });

  it('popularity-order fallback is disclosed', async () => {
    const out = await render(() => json(okBody([suggestion(801, 8801)], { coocFallback: true })), {
      image_description: DESCRIPTION,
    });
    expect(JSON.parse(out).addons.note).toMatch(/popularity order/);
  });
});

// ── 3. Rendering bounds ──────────────────────────────────────────────────────

describe('recommend — the rendered result stays sendable', () => {
  it('stays under the host message cap with every field at pathological length', async () => {
    const huge = Array.from({ length: 60 }, (_, i) =>
      suggestion(1000 + i, 5000 + i, {
        modelName: 'N'.repeat(5_000),
        modelType: 'T'.repeat(5_000),
        baseModel: 'B'.repeat(5_000),
        trainedWords: Array.from({ length: 50 }, () => 'w'.repeat(5_000)),
      }),
    );
    const out = await render(() => json(okBody(huge)), {
      image_description: 'd'.repeat(MAX_IMAGE_DESCRIPTION_CHARS),
      base_model: 'SDXL 1.0',
    });
    expect(out.length).toBeLessThanOrEqual(8_000);
    const parsed = JSON.parse(out);
    expect(parsed.addons.items).toHaveLength(SHOWN_PER_KIND);
    expect(parsed.imageDescription.length).toBeLessThan(MAX_IMAGE_DESCRIPTION_CHARS);
  });

  // Every field at its CHARACTER bound, made of characters JSON escapes, so the
  // serialized string far exceeds the bounded length — the gap between a
  // per-field bound and the per-message cap. `"` escapes to 2 chars, U+0001 to 6.
  const QUOTE = (n: number) => '"'.repeat(n);
  const CTRL = (n: number) => '\u0001'.repeat(n);
  const heavy = (base: number, nameOf: (n: number) => string) =>
    Array.from({ length: 8 }, (_, i) =>
      suggestion(base + i, base + 5000 + i, {
        modelName: nameOf(500),
        modelType: nameOf(500),
        baseModel: nameOf(500),
        trainedWords: Array.from({ length: 10 }, () => CTRL(500)),
      }),
    );

  it('🔴 reaches the escaping backstop: trigger words dropped, every shown record whole', async () => {
    const out = await render(
      (body) => json(okBody(body?.kind === 'checkpoint' ? heavy(3000, QUOTE) : heavy(2000, QUOTE))),
      { image_description: DESCRIPTION, base_model: 'SDXL 1.0' },
    );
    expect(out.length).toBeLessThanOrEqual(8_000);
    const parsed = JSON.parse(out);
    expect(parsed).not.toHaveProperty('error');
    expect(parsed.addons.items).toHaveLength(SHOWN_PER_KIND);
    expect(parsed.checkpoints.items).toHaveLength(SHOWN_PER_KIND);
    // Reached: the step that drops trigger words ran (the add-ons HAD them).
    expect(parsed.addons.items[0]).not.toHaveProperty('triggerWords');
    expect(parsed.addons.triggerWordsOmitted).toMatch(/cut to fit/);
    expect(parsed.checkpoints).not.toHaveProperty('triggerWordsOmitted');
    expect(groundedIdsFromToolResult(out)).toHaveLength(2 * SHOWN_PER_KIND);
  });

  it('…and past every step it REFUSES, with advice not to retry, rather than send an oversized message', async () => {
    const out = await render(
      (body) => json(okBody(body?.kind === 'checkpoint' ? heavy(3000, CTRL) : heavy(2000, CTRL))),
      { image_description: DESCRIPTION, base_model: 'SDXL 1.0' },
    );
    expect(out.length).toBeLessThanOrEqual(8_000);
    expect(JSON.parse(out)).toEqual({
      error:
        'catalog lookup failed: the recommendation result was too large to include. Do not call this tool ' +
        'again this turn; use the model search tool instead, or say the lookup failed.',
    });
  });

  it('neutralises `urn:air:` coming back in a name or trigger word', async () => {
    const out = await render(
      () => json(okBody([suggestion(901, 8901, { modelName: 'urn:air:sdxl:lora', trainedWords: ['URN:AIR:x'] })])),
      { image_description: DESCRIPTION },
    );
    expect(out.toLowerCase()).not.toContain('urn:air:');
  });
});

// ── 4. Wiring: declaration, dispatch, display ────────────────────────────────

describe('recommend — wiring into the tool loop', () => {
  const HOST = [{ type: 'function' as const, function: { name: 'search_models', parameters: {} } }];

  it('is added beside host tools, with an executor for exactly that name', () => {
    const { declarations, local } = composeLocalTools(HOST, true);
    expect(declarations.map((d) => d.function.name)).toEqual(['search_models', RECOMMEND_TOOL_NAME]);
    expect([...(local?.keys() ?? [])]).toEqual([RECOMMEND_TOOL_NAME]);
  });

  it('🔴 a host already at its tools cap ⇒ nothing added (the array would BAD_REQUEST every submit)', () => {
    const eight = Array.from({ length: HOST_MAX_TOOLS }, (_, i) => ({
      type: 'function' as const,
      function: { name: `host_tool_${i}`, parameters: {} },
    }));
    expect(composeLocalTools(eight, true)).toEqual({ declarations: eight, local: undefined });
    // Boundary: one below the cap still gets it.
    expect(composeLocalTools(eight.slice(1), true).declarations).toHaveLength(HOST_MAX_TOOLS);
  });

  it('🔴 the declaration fits the host\'s per-declaration bounds', () => {
    const fn = RECOMMEND_TOOL_DECLARATION.function;
    expect(fn.description!.length).toBeLessThanOrEqual(HOST_MAX_TOOL_DESCRIPTION_CHARS);
    expect(JSON.stringify(fn.parameters).length).toBeLessThanOrEqual(HOST_MAX_TOOL_PARAMETERS_CHARS);
    expect(fn.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('the switch off ⇒ no declaration and no executor', () => {
    const { declarations, local } = composeLocalTools(HOST, false);
    expect(declarations.map((d) => d.function.name)).toEqual(['search_models']);
    expect(local).toBeUndefined();
  });

  it('🔴 no host tools ⇒ nothing added (the degraded no-tools turn is unchanged)', () => {
    const { declarations, local } = composeLocalTools([], true);
    expect(declarations).toEqual([]);
    expect(local).toBeUndefined();
  });

  it('a host tool of the same name wins, and its calls are NOT routed locally', async () => {
    const hostOwned = [{ type: 'function' as const, function: { name: RECOMMEND_TOOL_NAME, parameters: {} } }];
    const { declarations, local } = composeLocalTools(hostOwned, true);
    expect(declarations).toEqual(hostOwned);
    install(() => json({ items: [] }));
    await executeToolCalls([recommendCall({ image_description: DESCRIPTION })], AUTH, local);
    expect(requests.map((r) => r.url)).toEqual(['https://civitai.com/api/v1/blocks/tools']);
  });

  it('a local call goes to the route, a sibling host call still goes to /tools — in call order', async () => {
    install((_body, url) => (url.endsWith('/tools') ? json({ items: [{ id: 11 }] }) : json(okBody([suggestion(12, 9912)]))));
    const host: ToolCall = {
      id: 'call_h',
      type: 'function',
      function: { name: 'search_models', arguments: '{"query":"perfume"}' },
    };
    const results = await executeToolCalls([host, recommendCall({ image_description: DESCRIPTION })], AUTH, LOCAL);
    expect(requests.map((r) => r.url).sort()).toEqual([ROUTE, 'https://civitai.com/api/v1/blocks/tools'].sort());
    expect(groundedIdsFromToolResult(results[0])).toEqual(['11']);
    expect(groundedIdsFromToolResult(results[1])).toEqual(['12']);
  });

  it('the declaration requires image_description and allows only its three arguments', () => {
    const params = RECOMMEND_TOOL_DECLARATION.function.parameters as {
      required: string[];
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(params.required).toEqual(['image_description']);
    expect(Object.keys(params.properties).sort()).toEqual(['base_model', 'image_description', 'needs']);
    expect(params.additionalProperties).toBe(false);
    // The rewrite instruction is the design — pinned so a "tidy" of the copy cannot drop it.
    expect(RECOMMEND_TOOL_DECLARATION.function.description).toMatch(/description of the IMAGE, not the user's question/);
    // 🔴 A VAGUE request is guessed, not bounced back (operator decision, 0.1.33):
    // the old "ask the user instead of calling" sentence made the model answer
    // "what models are best for professional content" with a clarifying question
    // and no lookup. Whole sentence pinned so a reword cannot restore the bounce.
    expect(RECOMMEND_TOOL_DECLARATION.function.description).toContain(
      "If the request is vague (for example 'models for professional content'), do not ask first: pick one " +
        'representative concrete image for it, call with that, and offer in your answer to narrow it down.',
    );
    expect(RECOMMEND_TOOL_DECLARATION.function.description).not.toMatch(/ask the user instead/i);
  });

  it('the viewer is shown the image description, the way a search shows its query', () => {
    expect(readQueryArgument(recommendCall({ image_description: `  ${DESCRIPTION} ` }))).toBe(DESCRIPTION);
    // A long rewrite is cut for the one-line label, not shown whole.
    const long = readQueryArgument(recommendCall({ image_description: 'z'.repeat(5_000) }));
    expect(long).toHaveLength(MAX_LOOKUP_LABEL_CHARS);
    expect(long!.endsWith('…')).toBe(true);
    // Cut by code point: an astral character at the boundary survives whole.
    const astral = readQueryArgument(recommendCall({ image_description: '🎨'.repeat(300) }));
    expect(Array.from(astral!)).toHaveLength(MAX_LOOKUP_LABEL_CHARS);
    // No LONE high surrogate (what a UTF-16 cut leaves; it renders as U+FFFD).
    // Measured: true on the old `slice(0, 199)` output, false on this one.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(astral!)).toBe(false);
    expect(astral!.slice(0, -1)).toBe('🎨'.repeat(MAX_LOOKUP_LABEL_CHARS - 1));
    // `query` still wins for search tools, unchanged.
    expect(readQueryArgument({ id: 'c', type: 'function', function: { name: 'search_models', arguments: '{"query":"anime"}' } })).toBe('anime');
  });

  it('🔴 a Stop mid-request ends the call as ABORTED, not as a per-kind failure', async () => {
    const controller = new AbortController();
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    ) as unknown as typeof globalThis.fetch;
    const pending = callToolWithFallback(
      recommendCall({ image_description: DESCRIPTION }),
      { ...AUTH, signal: controller.signal },
      LOCAL,
    );
    controller.abort();
    const out = await pending;
    // The plain abort shape the loop discards — no retry advice, no "failed" section.
    expect(JSON.parse(out)).toEqual({ error: 'Aborted' });
  });
});

// ── 5. Hosted models: `needs` out, `hostedModels` back (PROVISIONAL contract) ─
//
// 🔴 The fixture below is shaped like the civitai change that adds the catalog
// (not yet deployed): `{ key, name, maker, modelId, url, goodAt, capabilities }`.
// Hosted model ids are distinct from every suggestion id and version id in this
// file, so a grounding or projection that read the wrong list cannot pass by
// coincidence.

function hostedItem(modelId: number, extra: Record<string, unknown> = {}) {
  return {
    key: `Eco${modelId}`,
    name: `Hosted ${modelId}`,
    maker: `Maker ${modelId}`,
    modelId,
    url: `https://civitai.com/models/${modelId}`,
    goodAt: `Good at thing ${modelId}.`,
    capabilities: ['legible_text', 'image_editing'],
    ...extra,
  };
}

describe('recommend — hosted models', () => {
  it('🔴 the declaration pins the capability enum, its bound, and stays inside the host limits', () => {
    const params = RECOMMEND_TOOL_DECLARATION.function.parameters as {
      properties: { needs: { type: string; items: { type: string; enum: string[] }; maxItems: number } };
      required: string[];
    };
    expect(params.properties.needs.type).toBe('array');
    expect(params.properties.needs.items).toEqual({
      type: 'string',
      enum: [
        'legible_text',
        'design_layout',
        'photoreal',
        'image_editing',
        'character_consistency',
        'high_resolution',
        'transparent_background',
        'reference_images',
      ],
    });
    expect(params.properties.needs.maxItems).toBe(2);
    // 🔴 FOCUS, pinned whole (0.1.34): the route ranks hosted models by needs
    // matched, so a model that lists every plausible capability surfaces the
    // broadest generalist. Measured live: a keep-my-face selfie edit sent four
    // needs and Nano Banana never ranked. Both sentences below are the fix.
    const needsDescription = (params.properties.needs as unknown as { description: string }).description;
    expect(needsDescription).toContain(
      'Only the one or two capabilities the request hinges on, most important first — not every one that ' +
        'could apply; extras rank the wrong models ahead.',
    );
    expect(needsDescription).toContain(
      'Keeping a face, the same person or the same character is character_consistency (plus image_editing ' +
        'when changing their own photo).',
    );
    expect(params.required).not.toContain('needs');
    const fn = RECOMMEND_TOOL_DECLARATION.function;
    expect(fn.description!.length).toBeLessThanOrEqual(HOST_MAX_TOOL_DESCRIPTION_CHARS);
    expect(JSON.stringify(fn.parameters).length).toBeLessThanOrEqual(HOST_MAX_TOOL_PARAMETERS_CHARS);
  });

  it('needs: unknown values dropped, duplicates collapsed, capped at MAX_NEEDS; a non-list refused before any request', async () => {
    const parsed = parseRecommendArgs({
      image_description: DESCRIPTION,
      needs: ['legible_text', 'not_a_capability', ' photoreal ', 'legible_text', 7, 'image_editing', 'high_resolution', 'design_layout'],
    });
    if (!parsed.ok) throw new Error('expected ok');
    // The FIRST two known values survive — the model is told most important first.
    expect(parsed.value.needs).toEqual(['legible_text', 'photoreal']);
    expect(parsed.value.needs).toHaveLength(MAX_NEEDS);
    for (const needs of [undefined, null, []]) {
      const p = parseRecommendArgs({ image_description: DESCRIPTION, needs });
      expect(p.ok && p.value.needs).toEqual([]);
    }
    install(() => json(okBody([])));
    const out = await executeRecommend({ image_description: DESCRIPTION, needs: 'legible_text' }, AUTH);
    expect(out).toEqual({ ok: false, kind: 'arguments', reason: 'needs must be a list of capability names, or omitted' });
    expect(requests).toHaveLength(0);
  });

  it('🔴 needs is SENT only when non-empty, and only on the add-on request', async () => {
    install(() => json(okBody([suggestion(101, 9001)])));
    for (const needs of [undefined, [], ['nonsense']]) {
      requests = [];
      await executeRecommend({ image_description: DESCRIPTION, ...(needs ? { needs } : {}) }, AUTH);
      expect(requests).toHaveLength(1);
      expect(requests[0].body).toEqual({ prompt: DESCRIPTION });
    }
    requests = [];
    await executeRecommend(
      { image_description: DESCRIPTION, base_model: 'SDXL 1.0', needs: ['legible_text', 'design_layout'] },
      AUTH,
    );
    expect(requests.map((r) => r.body)).toEqual(
      expect.arrayContaining([
        { prompt: DESCRIPTION, baseModel: 'SDXL 1.0', needs: ['legible_text', 'design_layout'] },
        { prompt: DESCRIPTION, baseModel: 'SDXL 1.0', kind: 'checkpoint' },
      ]),
    );
    expect(requests).toHaveLength(2);
  });

  it('parseHostedModels: absent / not a list ⇒ null (no section)', () => {
    expect(parseHostedModels(okBody([]))).toBeNull();
    expect(parseHostedModels({ ...okBody([]), hostedModels: { 0: hostedItem(1532032) } })).toBeNull();
    expect(parseHostedModels({ ...okBody([]), hostedModels: 'GPT Image' })).toBeNull();
    expect(parseHostedModels(null)).toBeNull();
    expect(parseHostedModels('x')).toBeNull();
  });

  it('🔴 parseHostedModels: a malformed item is DROPPED, valid ones kept, url rebuilt from modelId', () => {
    const got = parseHostedModels({
      ...okBody([]),
      hostedModels: [
        hostedItem(1532032, { capabilities: ['legible_text', 'bogus', 'image_editing'] }),
        hostedItem(0),
        hostedItem(1111, { modelId: '1111' }),
        hostedItem(2222, { name: '   ' }),
        hostedItem(3333, { maker: undefined }),
        hostedItem(4444, { goodAt: 5 }),
        null,
        'GPT Image',
        [hostedItem(5555)],
        // A url pointing somewhere else is NOT what gets shown.
        hostedItem(1903424, { url: 'https://civitai.com/models/999999', capabilities: 'photoreal' }),
      ],
    });
    expect(got).toEqual([
      {
        modelId: 1532032,
        name: 'Hosted 1532032',
        maker: 'Maker 1532032',
        goodAt: 'Good at thing 1532032.',
        url: 'https://civitai.com/models/1532032',
        capabilities: ['legible_text', 'image_editing'],
      },
      {
        modelId: 1903424,
        name: 'Hosted 1903424',
        maker: 'Maker 1903424',
        goodAt: 'Good at thing 1903424.',
        url: 'https://civitai.com/models/1903424',
      },
    ]);
  });

  it('parseHostedModels: at most SHOWN_HOSTED, duplicates by modelId collapsed', () => {
    const got = parseHostedModels({
      hostedModels: [hostedItem(11), hostedItem(11), hostedItem(12), hostedItem(13), hostedItem(14)],
    });
    expect(got!.map((h) => h.modelId)).toEqual([11, 12, 13]);
    expect(SHOWN_HOSTED).toBe(3);
  });

  it('🔴 field ABSENT (today\'s route) with needs sent ⇒ no hosted section, result byte-identical to a call without needs', async () => {
    const body = okBody([suggestion(121, 9121)]);
    const without = await render(() => json(body), { image_description: DESCRIPTION });
    requests = [];
    const withNeeds = await render(() => json(body), { image_description: DESCRIPTION, needs: ['legible_text'] });
    expect(requests[0].body).toEqual({ prompt: DESCRIPTION, needs: ['legible_text'] });
    expect(withNeeds).toBe(without);
    expect(JSON.parse(withNeeds)).not.toHaveProperty('hostedModels');
  });

  it('valid hosted items render as their own labelled section beside add-ons', async () => {
    const out = await render(
      () => json({ ...okBody([suggestion(131, 9131)]), hostedModels: [hostedItem(1532032), hostedItem(1669468)] }),
      { image_description: DESCRIPTION, needs: ['legible_text'] },
    );
    const parsed = JSON.parse(out);
    expect(parsed.addons.items.map((i: { modelId: number }) => i.modelId)).toEqual([131]);
    expect(parsed.hostedModels.status).toBe('ok');
    expect(parsed.hostedModels.items.map((h: ShownHostedModel) => [h.modelId, h.name, h.maker, h.url])).toEqual([
      [1532032, 'Hosted 1532032', 'Maker 1532032', 'https://civitai.com/models/1532032'],
      [1669468, 'Hosted 1669468', 'Maker 1669468', 'https://civitai.com/models/1669468'],
    ]);
    expect(parsed.hostedModels.note).toMatch(/hosted single-model ecosystems/);
    expect(parsed.hostedModels.note).toMatch(/no add-ons/);
  });

  it('🔴 GROUNDING SEAM: hosted model links are grounded tool results, and nothing else is', async () => {
    const out = await render(
      () =>
        json({
          ...okBody([suggestion(141, 9141)]),
          hostedModels: [hostedItem(1532032), hostedItem(7, { name: '' }), hostedItem(1903424)],
        }),
      { image_description: DESCRIPTION, needs: ['image_editing'] },
    );
    const grounded = new Set(groundedIdsFromToolResult(out));
    expect([...grounded].sort()).toEqual(['141', '1532032', '1903424']);
    // What the renderer's link check does with a reply citing them.
    const reply =
      'Try [GPT Image](https://civitai.com/models/1532032) or [Nano Banana](https://civitai.com/models/1903424), ' +
      'with [Model 141](https://civitai.com/models/141); avoid https://civitai.com/models/7.';
    expect(ungroundedModelIds(reply, grounded)).toEqual(['7']);
  });

  it('🔴 a DEGRADED add-on answer still carries the hosted list: add-ons say failed, hosted are shown', async () => {
    const out = await render(() => json({ ...DEGRADED, hostedModels: [hostedItem(1951069)] }), {
      image_description: DESCRIPTION,
      needs: ['high_resolution'],
    });
    const parsed = JSON.parse(out);
    expect(parsed).not.toHaveProperty('error');
    expect(parsed.addons.status).toBe('failed');
    expect(parsed.addons.note).toMatch(/NOT a finding/);
    expect(parsed.hostedModels.items.map((h: ShownHostedModel) => h.modelId)).toEqual([1951069]);
    expect(groundedIdsFromToolResult(out)).toEqual(['1951069']);
  });

  it('an EMPTY (or all-malformed) hosted list says none matched and grounds nothing; it does not rescue a failed lookup', async () => {
    for (const hostedModels of [[], [hostedItem(0), { name: 'no id' }]]) {
      requests = [];
      const out = await render(() => json({ ...okBody([suggestion(151, 9151)]), hostedModels }), {
        image_description: DESCRIPTION,
        needs: ['photoreal'],
      });
      const parsed = JSON.parse(out);
      expect(parsed.hostedModels).toEqual({
        status: 'none_matched',
        note: 'No hosted model matched these needs. Do not suggest one from memory.',
      });
      expect(groundedIdsFromToolResult(out)).toEqual(['151']);
    }
    const failed = await render(() => json({ ...DEGRADED, hostedModels: [] }), {
      image_description: DESCRIPTION,
      needs: ['photoreal'],
    });
    expect(Object.keys(JSON.parse(failed))).toEqual(['error']);
  });

  it('a hosted list on a response that was NOT asked for one is ignored', async () => {
    const out = await render(
      (body) =>
        body?.kind === 'checkpoint'
          ? json({ ...okBody([suggestion(161, 9161)]), hostedModels: [hostedItem(1532032)] })
          : json({ ...okBody([suggestion(162, 9162)]), hostedModels: [hostedItem(1903424)] }),
      { image_description: DESCRIPTION, base_model: 'SDXL 1.0' },
    );
    const parsed = JSON.parse(out);
    expect(parsed).not.toHaveProperty('hostedModels');
    expect(groundedIdsFromToolResult(out).sort()).toEqual(['161', '162']);
  });
});
