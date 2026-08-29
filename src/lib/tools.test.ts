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

// The handler may return a promise: the abort-path fixtures need a request that
// is genuinely IN FLIGHT when the signal fires, which a synchronous return
// cannot express. The wrapper below already `return`s it from an async function,
// so both shapes flatten identically at runtime — only the type was narrower
// than the helper's own behaviour.
function install(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
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

describe('abort timing inside the 429 retry', () => {
  beforeEach(() => {
    requests = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * 🔴 REGRESSION: an abort landing between the 429 RESPONSE and the SLEEP
   * STARTING issued the retry the viewer had already abandoned.
   *
   * `abortableSleep` registers an `abort` listener — and `addEventListener`
   * on an ALREADY-ABORTED signal never fires. Without the early return, the
   * sleep therefore ran its full clamped duration (up to 15 s) and then
   * resolved `true`, so the caller retried. The early return is what makes an
   * abort that arrived a moment too early behave like one that arrived a moment
   * later.
   *
   * The mutant that removes it survived all 259 tests before this.
   */
  it('🔴 an abort that lands BEFORE the sleep starts still cancels the retry', async () => {
    const controller = new AbortController();
    install(() => {
      // Abort as a side effect of producing the 429: by the time `abortableSleep`
      // is reached the signal is already aborted, which is the window that had
      // no coverage.
      controller.abort();
      return new Response('slow down', { status: 429, headers: { 'retry-after': '120' } });
    });

    const started = Date.now();
    const out = await callTool(call('{"query":"x"}'), { ...AUTH, signal: controller.signal });
    const elapsed = Date.now() - started;

    // Exactly one request: the retry was refused, not merely delayed.
    expect(requests).toHaveLength(1);
    // And it did not wait out the clamp first. The clamp is 15 s; anything in
    // that neighbourhood means the sleep ran to completion and the early return
    // was absent.
    expect(elapsed).toBeLessThan(2000);
    // The caller gets a tool-level error string, never a throw.
    expect(JSON.parse(out).error).toBeTruthy();
  });
});

describe('combineSignals fallback (runtimes without AbortSignal.any)', () => {
  let savedAny: unknown;
  beforeEach(() => {
    requests = [];
    savedAny = (AbortSignal as unknown as Record<string, unknown>).any;
    // Force the fallback. On this runtime `AbortSignal.any` exists, so the
    // fallback is otherwise unreachable and every assertion about it would be
    // vacuous.
    delete (AbortSignal as unknown as Record<string, unknown>).any;
  });
  afterEach(() => {
    (AbortSignal as unknown as Record<string, unknown>).any = savedAny;
    globalThis.fetch = originalFetch;
  });

  it('🔴 positive control: the fallback is actually the code under test here', () => {
    expect((AbortSignal as unknown as Record<string, unknown>).any).toBeUndefined();
  });

  it('🔴 does not accumulate a listener on the caller signal per request', async () => {
    // The fallback is only reachable while `AbortSignal.any` is absent. Assert
    // it here rather than trusting the hook: if this ever holds, every listener
    // assertion below is about the NATIVE path and proves nothing.
    expect((AbortSignal as unknown as Record<string, unknown>).any).toBeUndefined();
    install(() => new Response(JSON.stringify({ items: [] }), { status: 200 }));

    const controller = new AbortController();
    // 🔴 CAPTURE THE SIGNAL ONCE. Instrumenting `controller.signal.addEventListener`
    // and then passing `controller.signal` again reads the accessor twice, and
    // the object identity across those reads is not something this test should
    // be asserting by accident — instrument and pass the SAME reference.
    const signal = controller.signal;
    let added = 0;
    let removed = 0;
    const realAdd = signal.addEventListener.bind(signal);
    const realRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: unknown[]) => {
      if (args[0] === 'abort') added += 1;
      return (realAdd as unknown as (...a: unknown[]) => void)(...args);
    }) as unknown as typeof signal.addEventListener;
    signal.removeEventListener = ((...args: unknown[]) => {
      if (args[0] === 'abort') removed += 1;
      return (realRemove as unknown as (...a: unknown[]) => void)(...args);
    }) as unknown as typeof signal.removeEventListener;

    for (let i = 0; i < 5; i += 1) {
      await callTool(call('{"query":"x"}'), { ...AUTH, signal });
    }

    // Positive control #1: the calls actually reached the network layer. A
    // `callTool` that bailed on its arguments would never call `combineSignals`
    // at all, and every listener assertion below would be about nothing.
    expect(requests).toHaveLength(5);
    // Positive control #2: the fallback really did register on the caller
    // signal. Without this a broken instrument reading 0/0 would "pass".
    expect(added).toBe(5);
    // 🔴 THE POINT: each request's listener is removed when the OTHER signal
    // wins. `{ once: true }` retires only the listener that FIRED, so the loser
    // stayed registered for the caller signal's whole lifetime — one dead
    // listener per tool request, measured 10 added / 0 removed before this.
    expect(removed).toBe(added);
  });

  it("🔴 the caller's abort REACHES the request signal through the fallback", async () => {
    // 🔴 THIS TEST USED TO BE VACUOUS, AND IT IS WORTH SAYING HOW. The fixture
    // threw `AbortError` itself and the only assertion was that the returned
    // JSON had a truthy `error` — which `callTool`'s own catch supplies for ANY
    // rejection. Measured: making the fallback ignore the caller signal
    // entirely (returning the bare timeout from `combineSignals`) left this
    // test green; it died only in the listener-accounting test next door. So a
    // test named for the abort path was pinned by a neighbouring guard.
    //
    // The isolating fact is that the CALLER's abort must show up on the signal
    // the REQUEST was given. Nothing else in the chain can produce that.
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    install((_url, init) => {
      requestSignal = (init as { signal?: AbortSignal })?.signal;
      // Park, so the abort lands while the request is genuinely in flight
      // rather than after it has already failed for its own reasons.
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
        queueMicrotask(() => controller.abort());
      });
    });

    const out = await callTool(call('{"query":"x"}'), { ...AUTH, signal: controller.signal });

    // Positive control: the fixture really did receive a signal to forward to.
    expect(requestSignal, 'the request was given no signal at all').toBeDefined();
    // 🔴 ISOLATING: the caller's abort propagated onto the request's own signal.
    expect(
      requestSignal!.aborted,
      "the fallback did not forward the caller's abort to the request",
    ).toBe(true);
    expect(JSON.parse(out).error).toBeTruthy();
  });

  it('🔴 the request signal is STILL LIVE while the body is read', async () => {
    // 🔴 REGRESSION: `dispose()` ran in a `finally` around `fetch()`, but a
    // resolved fetch means HEADERS — `res.json()` is a second await on a stream
    // that can stall just as long. Measured on this arm: once `toolsFetch`
    // returned, aborting the caller no longer reached the request signal
    // (`aborted === false`), where the native arm read `true`. That is a window
    // in which neither Stop nor the 15 s deadline can end a hung body, which is
    // precisely what the deadline exists to prevent — reintroduced by the fix
    // for a listener leak.
    //
    // Pinned at the moment that matters: while `json()` is executing, an abort
    // must still land on the request's signal.
    const controller = new AbortController();
    let abortedDuringBodyRead: boolean | null = null;
    install((_url, init) => {
      const signal = (init as { signal?: AbortSignal })?.signal;
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        json: async () => {
          // The body is being read. Abort now and observe whether the request
          // signal — the one the fetch was handed — still sees it.
          controller.abort();
          abortedDuringBodyRead = signal?.aborted ?? null;
          return { items: [{ id: 1, name: 'X' }], truncated: 0 };
        },
      } as unknown as Response);
    });

    await callTool(call('{"query":"x"}'), { ...AUTH, signal: controller.signal });

    expect(
      abortedDuringBodyRead,
      'the combined signal was disposed before the body was read, so a stalled ' +
        'body could not be aborted by Stop or by the request deadline',
    ).toBe(true);
  });
});
