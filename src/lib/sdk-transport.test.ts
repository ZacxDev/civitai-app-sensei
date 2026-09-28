import { describe, expect, it, vi } from 'vitest';

const sendTypedRequest = vi.hoisted(() => vi.fn());

vi.mock('@civitai/blocks-react', () => ({
  getTransport: () => {
    throw new Error('the singleton must not be reached in these tests — pass a fake');
  },
  sendTypedRequest,
}));

const { createSdkTransportAdapter, HUMAN_INTERACTION_TIMEOUT_MS } = await import(
  './sdk-transport.js'
);
const { initialize } = await import('@civitai/sdk');

/**
 * A stand-in for the bridge transport. Only the five members the adapter touches
 * are real; `getSnapshot` returns whatever object the test last set, so identity
 * is under the test's control — which is the point of most of these cases.
 */
function fakeBridge(overrides: Record<string, unknown> = {}) {
  const base = { ready: true, token: null, viewer: null } as Record<string, unknown>;
  const state = { snapshot: base, hostOrigin: null as string | null };
  const listeners = new Set<() => void>();
  const bridge = {
    getSnapshot: () => state.snapshot,
    getHostOrigin: () => state.hostOrigin,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    sendMessage: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    ...overrides,
  };
  return { bridge, state, listeners };
}

describe('sdk-transport adapter — snapshot identity', () => {
  // 🔴 THE REGRESSION TEST. Composing `{...snap, hostOrigin}` fresh on every call
  // returns a new object each time; `useSyncExternalStore` bails out on
  // `Object.is`, so a non-memoised adapter re-renders forever.
  it('returns the SAME object identity while neither input has changed', () => {
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    const a = t.snapshot.get();
    const b = t.snapshot.get();
    const c = t.snapshot.get();

    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('returns a NEW identity when the underlying snapshot changes', () => {
    const { bridge, state } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    const before = t.snapshot.get();
    state.snapshot = { ready: true, token: 'fresh', viewer: null };
    const after = t.snapshot.get();

    expect(after).not.toBe(before);
    expect((after as { token: string }).token).toBe('fresh');
  });

  it('returns a NEW identity when hostOrigin alone changes', () => {
    const { bridge, state } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    const before = t.snapshot.get();
    expect((before as { hostOrigin: string | null }).hostOrigin).toBeNull();

    state.hostOrigin = 'https://civitai.com';
    const after = t.snapshot.get();

    expect(after).not.toBe(before);
    expect((after as { hostOrigin: string | null }).hostOrigin).toBe('https://civitai.com');
  });

  // 🔴 SECURITY INVARIANT, not a null-handling nit. The bridge documents
  // `getHostOrigin()` as returning only an allowlist-validated origin, because the
  // value becomes the base URL a money-scoped bearer token is sent to. A
  // not-yet-established origin must stay null; substituting `location.origin` or a
  // parent's origin here would convert a not-ready state into an exfiltration
  // vector. This pins that the adapter invents nothing.
  it('propagates a null hostOrigin as null and never substitutes a fallback', () => {
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    const snap = t.snapshot.get() as Record<string, unknown>;

    // `toBeNull()` is the WHOLE guard, and it is sufficient: any substituted
    // default — `location.origin`, `document.referrer`, `''`, a parent origin —
    // makes this non-null and fails here.
    expect(snap.hostOrigin).toBeNull();
  });

  it('forwards subscribe through to the bridge', () => {
    const { bridge, listeners } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    const listener = vi.fn();
    const off = t.snapshot.subscribe(listener);
    expect(listeners.size).toBe(1);
    off();
    expect(listeners.size).toBe(0);
  });
});

describe('sdk-transport adapter — request', () => {
  it('maps REQUEST_TOKEN to the TOKEN_REFRESH_RESPONSE reply type', async () => {
    sendTypedRequest.mockReset();
    sendTypedRequest.mockResolvedValue({ token: 'tok' });
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    await expect(t.request('REQUEST_TOKEN', { blockInstanceId: 'bi-1' })).resolves.toEqual({
      token: 'tok',
    });

    expect(sendTypedRequest).toHaveBeenCalledTimes(1);
    const [passedBridge, request, responseType] = sendTypedRequest.mock.calls[0]!;
    expect(passedBridge).toBe(bridge);
    expect(request).toEqual({ type: 'REQUEST_TOKEN', payload: { blockInstanceId: 'bi-1' } });
    // The literal is the whole point of the mapping — assert it, not its shape.
    expect(responseType).toBe('TOKEN_REFRESH_RESPONSE');
  });

  it('maps OPEN_RESOURCE_PICKER to the RESOURCE_PICKER_RESULT reply type', async () => {
    sendTypedRequest.mockReset();
    sendTypedRequest.mockResolvedValue({ selected: { versionId: 7 } });
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    await expect(t.request('OPEN_RESOURCE_PICKER', { resourceType: 'LORA' })).resolves.toEqual({
      selected: { versionId: 7 },
    });

    const [, request, responseType] = sendTypedRequest.mock.calls[0]!;
    expect(request).toEqual({
      type: 'OPEN_RESOURCE_PICKER',
      payload: { resourceType: 'LORA' },
    });
    expect(responseType).toBe('RESOURCE_PICKER_RESULT');
  });

  // 🔴 THE DEADLINE, AND IT IS THE ONE THING THIS ADAPTER ADDS OVER THE REFERENCE
  // PORT'S. `@civitai/blocks-react`'s `useResourcePicker` passed
  // `HUMAN_INTERACTION_TIMEOUT_MS`; the bridge's own default is 30s, which
  // civitai/civitai#4158 showed rejects WHILE THE VIEWER'S DIALOG IS STILL OPEN.
  // Routing the same message through this adapter without the opt-out would drop a
  // model pick 30 seconds after the modal opened, and nothing about the call site
  // would look different.
  //
  // Pinned as the LITERAL, not as "some timeout": the failure mode is a wrong
  // number, and a `toBeDefined()` would pass on 30_000.
  it('passes the 10-minute human-interaction deadline for OPEN_RESOURCE_PICKER', async () => {
    sendTypedRequest.mockReset();
    sendTypedRequest.mockResolvedValue({ selected: null });
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    await t.request('OPEN_RESOURCE_PICKER', { resourceType: 'Checkpoint' });

    expect(HUMAN_INTERACTION_TIMEOUT_MS).toBe(600_000);
    expect(sendTypedRequest.mock.calls[0]![3]).toEqual({ timeoutMs: 600_000 });
  });

  // The other side of the same table: a `'protocol'` request must NOT carry an
  // override, so the bridge applies its own 30s default. Sending
  // `{ timeoutMs: undefined }` would be observably different from sending nothing
  // only in a strict-equality assertion, which is why this asserts `undefined`
  // rather than `not.toEqual({timeoutMs: 600_000})`.
  it('passes NO deadline override for REQUEST_TOKEN, leaving the bridge default', async () => {
    sendTypedRequest.mockReset();
    sendTypedRequest.mockResolvedValue({ token: 'tok' });
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    await t.request('REQUEST_TOKEN', {});

    expect(sendTypedRequest.mock.calls[0]![3]).toBeUndefined();
  });

  // 🔴 A wrong reply type does not fail loudly — it waits for the request timeout
  // and surfaces as an unresponsive host. So an unmapped type must REFUSE rather
  // than guess, and the refusal must say what to do.
  it('throws for an unmapped request type instead of guessing a reply type', () => {
    sendTypedRequest.mockReset();
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    expect(() => t.request('OPEN_BUZZ_PURCHASE', {})).toThrow(/no response type mapped/i);
    expect(sendTypedRequest).not.toHaveBeenCalled();
  });

  it('rejects immediately when the caller passes an already-aborted signal', async () => {
    sendTypedRequest.mockReset();
    sendTypedRequest.mockResolvedValue({ token: 'tok' });
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    const ac = new AbortController();
    ac.abort(new Error('caller gave up'));

    await expect(t.request('REQUEST_TOKEN', {}, { signal: ac.signal })).rejects.toThrow(
      /caller gave up/,
    );
  });

  it('rejects when the signal aborts while the request is in flight', async () => {
    sendTypedRequest.mockReset();
    // Never settles — the abort is the only thing that can end this.
    sendTypedRequest.mockReturnValue(new Promise(() => {}));
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    const ac = new AbortController();
    const pending = t.request('REQUEST_TOKEN', {}, { signal: ac.signal });
    ac.abort(new Error('timed out upstream'));

    await expect(pending).rejects.toThrow(/timed out upstream/);
  });

  it('resolves normally when no signal is supplied', async () => {
    sendTypedRequest.mockReset();
    sendTypedRequest.mockResolvedValue('ok');
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    await expect(t.request('REQUEST_TOKEN', {})).resolves.toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// 🔴 THE TOKEN `kind`, WHICH IS THE INPUT TO THE SDK's ONLY ALARM AGAINST THE
// SUBSTITUTION `sdk-runtime.ts`'s own banner WARNS ABOUT.
//
// `@civitai/sdk` gates two behaviours on one predicate:
//   `holdsBlockToken = () => snapshot().viewer !== null && snapshot().token.kind === 'block'`
// (`dist/app/index.js`). Its consumers are `refuseBlockToken` — the EAGER,
// pre-request refusal of every `app.orchestration.*` call — and
// `explainApiRefusal`, which annotates a 401/403 outside `blocks/*`.
//
// `@civitai/blocks-react`'s `tokenFromWrapped` builds
// `{ raw, scopes, expiresAt, buzzBudget }` and DROPS `kind`
// (`dist/internal/transport.js`); its own `BlockToken` type does not declare it,
// and neither does `@civitai/app-sdk@0.45.0`'s `WrappedToken`, even though the
// host DOES put it on the wire (civitai `PageBlockHost.tsx` spreads
// `...(tokenKind ? { kind: tokenKind } : {})` into all three token pushes). So
// through this adapter `kind` arrives `undefined`, `holdsBlockToken()` is
// permanently `false`, and BOTH consumers are dead code.
//
// WHY THAT MATTERS EVEN THOUGH THIS APP CALLS `app.orchestration` NOWHERE TODAY:
// the next porter substitutes `app.orchestration.submitWorkflow(...)` for the
// `blocks/workflows/*` routes. It compiles. The SDK's explicit refusal never
// fires, the call reaches `orchestration.civitai.com`, comes back a bare 401, and
// the author debugs a token problem — while the change has silently dropped the
// per-call `buzzBudget`, the per-viewer and per-app daily caps, the browsing-level
// clamp and the `app-block:<appId>` attribution. `WORKFLOW_ROUTES`' banner in
// `sdk-runtime.ts` exists for exactly that reader; this is the machine-checkable
// half of it.
//
// ⚠ BEHAVIOURAL, NOT STRUCTURAL. Asserting `snapshot.token.kind === 'block'`
// would pass while the SDK read some other field; what is pinned here is that the
// refusal actually fires and that NOTHING reached `fetch`.
// ---------------------------------------------------------------------------
describe('sdk-transport adapter — token kind', () => {
  /** A bridge snapshot shaped like the real post-`BLOCK_INIT` one. */
  const liveSnapshot = () => ({
    ready: true,
    token: { raw: 'block-jwt', scopes: ['ai:write:budgeted'], expiresAt: new Date(0) },
    viewer: { id: 1, username: 'zed' },
    context: { slotId: 'app.page' },
    settings: { publisherSettings: {}, userSettings: {} },
    theme: 'dark' as const,
    blockInstanceId: 'bi-1',
  });

  it('🔴 lets the SDK refuse an app.orchestration call EAGERLY, before any fetch', async () => {
    const snapshot = liveSnapshot();
    const fetchSpy = vi.fn(
      async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const { bridge } = fakeBridge({ getSnapshot: () => snapshot });

    const client = await initialize({
      transport: createSdkTransportAdapter(bridge as never) as never,
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });

    await expect(client.orchestration.getWorkflow('wf-1')).rejects.toThrow(
      /does not accept a block-scoped token/i,
    );
    // The half that makes it "eagerly": a refusal raised AFTER the request would
    // satisfy the assertion above while the money path had already been reached.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // The POSITIVE CONTROL for the case above, and it is not optional: the
  // rejection could come from a broken transport, a missing session or any other
  // failure inside `initialize`. This proves the SAME client happily reaches
  // `fetch` on the surface the block token IS minted for — so the refusal above
  // is about the destination, not about the fixture.
  it('…while a blocks/* site call on the same client DOES reach fetch', async () => {
    const snapshot = liveSnapshot();
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ snapshot: { status: 'pending' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const { bridge } = fakeBridge({ getSnapshot: () => snapshot });

    const client = await initialize({
      transport: createSdkTransportAdapter(bridge as never) as never,
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });

    await expect(client.site.post('blocks/workflows/poll', { workflowId: 'wf-1' })).resolves.toEqual(
      { snapshot: { status: 'pending' } },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // 🔴 AND AN ANONYMOUS VIEWER MUST NOT BE REFUSED, because the predicate's other
  // half is `viewer !== null` and its scope is deliberate: an anonymous viewer has
  // no OAuth token whatever the manifest says, so the manifest advice would send
  // them at the wrong fix (theirs is `host.requestSignIn()`). Supplying `kind`
  // unconditionally must not widen that.
  it('does not fire the refusal for an anonymous viewer', async () => {
    const snapshot = { ...liveSnapshot(), viewer: null };
    const fetchSpy = vi.fn(
      async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const { bridge } = fakeBridge({ getSnapshot: () => snapshot });

    const client = await initialize({
      transport: createSdkTransportAdapter(bridge as never) as never,
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });

    await client.orchestration.getWorkflow('wf-1').catch(() => {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // The adapter SUPPLIES `kind` rather than forwarding it, so the day the bridge
  // starts carrying the host's own value it must win — otherwise a block that
  // gains `auth: "oauth"` would be told the orchestrator refuses a token it in
  // fact accepts, which is a refusal of legitimate work.
  it('defers to a kind the bridge does carry, rather than overwriting it', () => {
    const snapshot = { ...liveSnapshot(), token: { ...liveSnapshot().token, kind: 'oauth' } };
    const { bridge } = fakeBridge({ getSnapshot: () => snapshot });
    const t = createSdkTransportAdapter(bridge as never);
    expect((t.snapshot.get() as { token: { kind: string } }).token.kind).toBe('oauth');
  });
});

describe('sdk-transport adapter — notify and on', () => {
  it('forwards notify to the bridge sendMessage, shape intact', () => {
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    t.notify({ type: 'TRACK_EVENT', payload: { eventName: 'sent', properties: { n: 1 } } });

    expect(bridge.sendMessage).toHaveBeenCalledWith({
      type: 'TRACK_EVENT',
      payload: { eventName: 'sent', properties: { n: 1 } },
    });
  });

  it('forwards on() to onMessage and returns its unsubscribe', () => {
    const off = vi.fn();
    const { bridge } = fakeBridge({ onMessage: vi.fn(() => off) });
    const t = createSdkTransportAdapter(bridge as never);

    const handler = vi.fn();
    const returned = t.on('TOKEN_REFRESH_RESPONSE', handler);

    expect(bridge.onMessage).toHaveBeenCalledWith('TOKEN_REFRESH_RESPONSE', handler);
    returned();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
