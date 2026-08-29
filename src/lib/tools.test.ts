import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchToolDeclarations,
  callTool,
  readQueryArgument,
  MAX_TOOL_ROUNDS,
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
    expect(MAX_TOOL_ROUNDS).toBe(3);
  });
});
