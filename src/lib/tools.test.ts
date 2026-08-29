import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchToolDeclarations,
  callTool,
  readQueryArgument,
  stripAirReferences,
  boundToolResponse,
  MAX_TOOL_RESULT_MESSAGES,
  type ToolCall,
} from './tools.js';
import * as researchLib from './research.js';

const AUTH = { token: 'block-jwt-abc' };

function call(args: string, name = 'search_models'): ToolCall {
  return { id: 'call_1', type: 'function', function: { name, arguments: args } };
}

let requests: Array<{ url: string; method: string; auth: string; body: unknown }> = [];
let originalFetch: typeof globalThis.fetch;

function install(handler: (url: string, init?: RequestInit) => Response) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({
      url,
      method: init?.method ?? 'GET',
      auth: headers.Authorization ?? '',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return handler(url, init);
  }) as unknown as typeof globalThis.fetch;
}

describe('tools — the heuristic it replaced is GONE from the module surface', () => {
  // 🔴 ASSERTED ON THE MODULE, NOT ON THE ABSENCE OF TESTS. Deleting a suite
  // proves nothing about whether the code still ships — an exported function
  // with no tests is exactly the "both paths live" state this change exists to
  // avoid. This reads the real export surface.
  it('research exports none of deriveSearchQuery / resultsLookRelated / narrowQuery / retrieveForTurn', () => {
    for (const gone of [
      'deriveSearchQuery',
      'resultsLookRelated',
      'narrowQuery',
      'retrieveForTurn',
      // Their exclusive support, which became unreachable with them.
      'shouldRetrieve',
      'formatCatalogContext',
      'MAX_QUERY_TERMS',
    ]) {
      expect(gone in researchLib).toBe(false);
    }
  });

  it('but the catalog CLIENT the Research panel uses survived', () => {
    // The positive control for the assertion above: if this module were simply
    // failing to import, every `in` check would also be false and the test
    // above would pass for the wrong reason entirely.
    for (const kept of ['searchModels', 'searchImages', 'findModelInResults', 'formatStat']) {
      expect(kept in researchLib).toBe(true);
    }
  });
});

describe('tools — declarations are fetched from the host', () => {
  beforeEach(() => {
    requests = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('GETs /tools with the block token and returns the declarations', async () => {
    install(
      () =>
        new Response(
          JSON.stringify({
            tools: [{ type: 'function', function: { name: 'search_models', parameters: {} } }],
          }),
          { status: 200 },
        ),
    );
    const decls = await fetchToolDeclarations(AUTH);
    expect(decls).toHaveLength(1);
    expect(decls[0].function.name).toBe('search_models');
    expect(requests[0].url).toContain('/api/v1/blocks/tools');
    expect(requests[0].auth).toBe('Bearer block-jwt-abc');
  });

  it('drops a malformed declaration rather than handing it to the model', async () => {
    install(
      () =>
        new Response(
          JSON.stringify({
            tools: [
              { type: 'function', function: { name: 'good', parameters: {} } },
              { type: 'function', function: {} },
              { type: 'notafunction', function: { name: 'bad' } },
              null,
            ],
          }),
          { status: 200 },
        ),
    );
    const decls = await fetchToolDeclarations(AUTH);
    expect(decls.map((d) => d.function.name)).toEqual(['good']);
  });

  it('returns [] when the host serves no tools array', async () => {
    install(() => new Response(JSON.stringify({}), { status: 200 }));
    expect(await fetchToolDeclarations(AUTH)).toEqual([]);
  });
});

describe('tools — callTool reports failure TO THE MODEL rather than throwing', () => {
  beforeEach(() => {
    requests = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs the parsed arguments as an object, not the raw string', async () => {
    install(() => new Response(JSON.stringify({ items: [{ id: 1 }] }), { status: 200 }));
    const out = await callTool(call('{"query":"DreamShaper checkpoint","limit":2}'), AUTH);
    expect(requests[0].method).toBe('POST');
    // The provider hands `arguments` back as a STRING; the route validates an
    // OBJECT against the tool's schema.
    expect(requests[0].body).toEqual({
      name: 'search_models',
      arguments: { query: 'DreamShaper checkpoint', limit: 2 },
    });
    expect(out).toContain('items');
  });

  it('🔴 a malformed arguments string yields a readable result and NO request', async () => {
    install(() => new Response('{}', { status: 200 }));
    const out = await callTool(call('{not json'), AUTH);
    expect(requests).toHaveLength(0);
    expect(JSON.parse(out)).toEqual({ error: 'arguments were not valid JSON' });
  });

  it('🔴 non-object arguments are refused before the request', async () => {
    install(() => new Response('{}', { status: 200 }));
    for (const bad of ['[1,2]', '"a string"', 'null', '42']) {
      requests = [];
      const out = await callTool(call(bad), AUTH);
      expect(requests).toHaveLength(0);
      expect(JSON.parse(out).error).toMatch(/must be a JSON object/);
    }
  });

  it('🔴 an HTTP failure becomes a tool result, not an exception', async () => {
    install(() => new Response('nope', { status: 429, statusText: 'Too Many Requests' }));
    // Throwing here would abort the whole turn and charge the viewer for a
    // conversation with no answer — strictly worse than an answer that says the
    // lookup failed.
    const out = await callTool(call('{"query":"x"}'), AUTH);
    expect(JSON.parse(out).error).toMatch(/429/);
  });

  it('🔴 a 429 retry does NOT outlive the caller’s Stop', async () => {
    // 🔴 THE SLEEP USED TO IGNORE THE SIGNAL ENTIRELY. `Retry-After` is
    // server-controlled, so `Retry-After: 120` wedged the turn for two minutes
    // with "Searching" stuck on and Stop unable to end it — the loop's abort
    // checks are unreachable while this sleep is pending.
    install(() => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }));
    const controller = new AbortController();
    const started = Date.now();
    const pending = callTool(call('{"query":"x"}'), { ...AUTH, signal: controller.signal });
    // Abort well inside the 120s the server asked for.
    setTimeout(() => controller.abort(), 20);
    const out = await pending;
    const elapsed = Date.now() - started;

    // ISOLATING: without the signal race this cannot return in under 120s.
    // The bound is generous enough not to be timing-flaky and still two orders
    // of magnitude below the unclamped wait.
    expect(elapsed).toBeLessThan(3_000);
    // It still reports to the model rather than throwing — the existing contract.
    expect(JSON.parse(out)).toHaveProperty('error');
    // Exactly one request: the retry was abandoned, not issued.
    expect(requests).toHaveLength(1);
  });

  it('🔴 a hostile `Retry-After` is CLAMPED even with no signal to race', async () => {
    // A viewer who never presses Stop must not be held either. Clamped to the
    // per-request timeout, so a retry can never outlive the budget the call
    // already had.
    install(() => new Response('slow down', { status: 429, headers: { 'retry-after': '99999' } }));
    const started = Date.now();
    await callTool(call('{"query":"x"}'), AUTH);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it('bounds the result to the host message cap', async () => {
    install(
      () => new Response(JSON.stringify({ blob: 'x'.repeat(20_000) }), { status: 200 }),
    );
    const out = await callTool(call('{"query":"x"}'), AUTH);
    // 8,000 is a hard REJECT of the whole next request server-side, not a
    // truncation, so exceeding it would lose the conversation.
    expect(out.length).toBeLessThanOrEqual(8_000);
  });
});

describe('tools — readQueryArgument is total', () => {
  it('reads the model-authored query', () => {
    expect(readQueryArgument(call('{"query":"  DreamShaper  "}'))).toBe('DreamShaper');
  });

  it('returns null rather than throwing on anything unusable', () => {
    expect(readQueryArgument(undefined)).toBeNull();
    expect(readQueryArgument(call('{not json'))).toBeNull();
    expect(readQueryArgument(call('{"query":""}'))).toBeNull();
    expect(readQueryArgument(call('{"query":123}'))).toBeNull();
    expect(readQueryArgument(call('[]'))).toBeNull();
  });
});

describe('tools — the round cap', () => {
  it('mirrors the host value', () => {
    // 🔴 A MIRROR, NOT THE ENFORCEMENT. The host counts `role:'tool'` messages
    // in a `.superRefine` on both the estimate and the submit path. This pin
    // exists so a change to the local constant is a visible decision rather
    // than a silent divergence from the host that shows up as a BAD_REQUEST.
    expect(MAX_TOOL_RESULT_MESSAGES).toBe(3);
  });
});

describe('tools — the `urn:air:` strip', () => {
  // 🔴 SCOPE, ESTABLISHED FROM `origin/trunk` RATHER THAN ASSUMED. On trunk the
  // strip had exactly ONE call site: the tail of `formatCatalogContext`, i.e.
  // catalog text the app injected itself. Its successor is the tool result,
  // which the host now projects through `neutralizeAirLiterals` server-side —
  // so this is defence in depth for a property the app cannot verify, not a
  // restored regression. Text the VIEWER types was never covered and still is
  // not; that is recorded in the source, not silently widened here.
  it('neutralises the literal in every casing', () => {
    expect(stripAirReferences('see urn:air:sdxl:checkpoint')).toBe('see urn-air-sdxl:checkpoint');
    expect(stripAirReferences('URN:AIR:x')).toBe('urn-air-x');
    expect(stripAirReferences('Urn:Air:x')).toBe('urn-air-x');
  });

  it('leaves ordinary prose alone', () => {
    expect(stripAirReferences('an urn in the air')).toBe('an urn in the air');
  });

  it('🔴 a tool RESULT carrying the literal is neutralised before it can reach the wire', async () => {
    // A single `urn:air:` anywhere in the built input is a hard FORBIDDEN at the
    // host, thrown BEFORE the Buzz quote — so one unstripped record bounces the
    // next round after the viewer has already paid for this one.
    install(() =>
      new Response(JSON.stringify({ items: [{ name: 'urn:air:sd1:checkpoint:civitai:4384' }] }), {
        status: 200,
      }),
    );
    const out = await callTool(call(JSON.stringify({ query: 'x' })), AUTH);
    expect(out).not.toContain('urn:air:');
    // POSITIVE CONTROL — the raw upstream body DOES carry the literal, so the
    // assertion above is testing the strip and not a fixture that never had one.
    expect(JSON.stringify({ items: [{ name: 'urn:air:sd1:checkpoint:civitai:4384' }] })).toContain(
      'urn:air:',
    );
    expect(out).toContain('urn-air-');
  });
});

describe('tools — bounding a result keeps it valid JSON', () => {
  // 🔴 A `slice()` ON THE SERIALIZED STRING CUTS MID-TOKEN, handing the model a
  // fragment that is not parseable at all. The deleted `formatCatalogContext`
  // made this exact argument — drop whole records, never cut one — and the
  // argument was deleted with it.
  const big = (n: number) =>
    ({ items: Array.from({ length: n }, (_, i) => ({ id: i, blurb: 'x'.repeat(900) })), truncated: 0 });

  it('passes a small response through untouched', () => {
    const body = { items: [{ id: 1 }], truncated: 0 };
    expect(boundToolResponse(body)).toBe(JSON.stringify(body));
  });

  it('🔴 drops whole records rather than cutting one, and the result still parses', () => {
    const out = boundToolResponse(big(20));
    expect(out.length).toBeLessThanOrEqual(8_000);
    // The whole point: parseable. A mid-string slice throws here.
    const parsed = JSON.parse(out) as { items: unknown[] };
    // Fewer than the input, or the bound did nothing.
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.items.length).toBeLessThan(20);
    // ISOLATING: every surviving record is COMPLETE, which a tail-slice cannot
    // guarantee even when it happens to parse.
    for (const item of parsed.items as Array<{ id?: number; blurb?: string }>) {
      expect(typeof item.id).toBe('number');
      expect(item.blurb?.length).toBe(900);
    }
  });

  it('🔴 RE-COUNTS `truncated` — a bound that misreports itself is worse than none', () => {
    // The host emits `{ items, truncated }` and `truncated` is what IT dropped.
    // Spreading the record carried that number through unchanged while this
    // function dropped more on top of it, handing the model a short list
    // alongside an assertion that nothing was left out. The model then reports
    // it to the viewer as the complete set.
    const out = boundToolResponse(big(20));
    const parsed = JSON.parse(out) as { items: unknown[]; truncated: number };
    expect(parsed.items.length).toBeLessThan(20);
    // ISOLATING: the exact count dropped, not merely "nonzero" — a `truncated`
    // that is nonzero but wrong is the same class of lie.
    expect(parsed.truncated).toBe(20 - parsed.items.length);
  });

  it('🔴 ADDS to the host’s own `truncated` rather than replacing it', () => {
    // The host already dropped 7 before we saw the payload. Reporting only what
    // WE dropped would under-count by 7 and tell the model more of the catalog
    // was covered than actually was.
    const body = {
      items: Array.from({ length: 20 }, (_, i) => ({ id: i, blurb: 'x'.repeat(900) })),
      truncated: 7,
    };
    const parsed = JSON.parse(boundToolResponse(body)) as { items: unknown[]; truncated: number };
    expect(parsed.truncated).toBe(7 + (20 - parsed.items.length));
  });

  it('a response with no `truncated` field gets an honest count, not NaN', () => {
    const body = { items: Array.from({ length: 20 }, (_, i) => ({ id: i, blurb: 'x'.repeat(900) })) };
    const parsed = JSON.parse(boundToolResponse(body)) as { items: unknown[]; truncated: number };
    expect(Number.isFinite(parsed.truncated)).toBe(true);
    expect(parsed.truncated).toBe(20 - parsed.items.length);
  });

  it('falls back to a valid JSON error when nothing can fit', () => {
    const out = boundToolResponse({ items: [{ blurb: 'x'.repeat(20_000) }] });
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out)).toHaveProperty('error');
  });

  it('falls back for a response with no bounded array', () => {
    const out = boundToolResponse({ blob: 'x'.repeat(20_000) });
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out)).toHaveProperty('error');
  });
});
