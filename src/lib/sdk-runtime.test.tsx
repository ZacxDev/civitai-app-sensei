// The ONLY file that drives `lib/sdk-runtime.ts` for real.
//
// 🔴 WHY IT HAS TO EXIST, AND WHY THE REST OF THE SUITE DOES NOT COVER THIS.
// This app's 23 dom test files `vi.mock` the hook module wholesale — before the
// port that was `@civitai/blocks-react`, after it this module. So they assert what
// the APP does given hooks that answer, and nothing about whether the hooks answer
// correctly. That was equally true before the port; what it means now is that
// every line in `sdk-runtime.ts` and `sdk-transport.ts` is covered here or nowhere.
//
// The two halves are driven at their real boundaries, which are different:
//   - the handshake half (snapshot, host UI, analytics) through
//     `@civitai/sdk/testing`'s `createFakeTransport()`;
//   - the data half (app storage, the four workflow ops) through a `fetch` fake,
//     `../dev-rest.ts`, because after the port those are HTTP and a transport-level
//     fake would answer a conversation nobody is having.
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowsingLevel } from '@civitai/app-sdk/blocks';
// 🔴 FROM THE BRIDGE PACKAGE ON PURPOSE, NOT FROM `./sdk-runtime.js` — this is the
// STRONGER assertion. `sdk-runtime.ts` re-exports these two, so importing them from
// there would make every `instanceof` below trivially true whatever it re-exported.
// Reaching for the bridge's own classes is what pins that the app throws THOSE, so
// `orchestrator-bridge.ts`'s branches (which resolve through the re-export) cannot
// be satisfied by a look-alike.
import { WorkflowEstimateError, WorkflowSubmitError } from '@civitai/blocks-react';
import { createFakeTransport, type FakeTransport } from '@civitai/sdk/testing';

import { createRestFake, type RestFakeOptions } from '../dev-rest.js';
import { nsfwModeAllowed } from './maturity.js';
import {
  configureSdkRuntime,
  resetSdkRuntime,
  useAppStorage,
  useBlockAnalytics,
  useBlockContext,
  useBlockResize,
  useBlockToken,
  useBuzzWorkflow,
  useDomainMaturity,
  useRequestConsent,
  useRequestSignIn,
  useResourcePicker,
} from './sdk-runtime.js';

let transport: FakeTransport;
/** Every REST call the fake answered, in order — the observation seam. */
let calls: Array<{ path: string; method: string; body: Record<string, unknown> }>;

function install(
  snapshot: Parameters<typeof createFakeTransport>[0] = {},
  rest: Omit<RestFakeOptions, 'onRequest'> = {},
) {
  transport = createFakeTransport(snapshot);
  calls = [];
  configureSdkRuntime({
    transport,
    fetch: createRestFake({ ...rest, onRequest: (c) => calls.push(c) }),
  });
  return transport;
}

beforeEach(() => {
  // `test-setup.ts` already resets between cases; this makes each `describe` below
  // independent of whichever one ran first.
  resetSdkRuntime();
});

afterEach(() => {
  resetSdkRuntime();
});

// ---------------------------------------------------------------------------
// Group 1 — the snapshot
// ---------------------------------------------------------------------------

describe('useBlockContext', () => {
  it('reads ready / viewer / theme off the live snapshot', () => {
    install({ ready: true, viewer: { id: 42, username: 'zed' }, theme: 'dark' });
    const { result } = renderHook(() => useBlockContext());
    expect(result.current).toEqual({
      ready: true,
      viewer: { id: 42, username: 'zed' },
      theme: 'dark',
    });
  });

  it('re-renders when the host pushes a theme change', () => {
    const t = install({ theme: 'dark' });
    const { result } = renderHook(() => useBlockContext());
    expect(result.current.theme).toBe('dark');

    act(() => t.setSnapshot({ theme: 'light' }));
    expect(result.current.theme).toBe('light');
  });

  // 🔴 THE RE-RENDER LOOP GUARD, one level above `sdk-transport.test.ts`'s identity
  // case. `useBlockContext` composes `{ready, viewer, theme}` — if it composed
  // inside the `useSyncExternalStore` selector instead of in a `useMemo`, the store
  // would never compare equal and this hook would re-render forever. A stable
  // identity across two reads with no snapshot change is what says it does not.
  it('returns a STABLE object identity while the snapshot is unchanged', () => {
    install({ theme: 'dark' });
    const { result, rerender } = renderHook(() => useBlockContext());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

describe('useBlockToken', () => {
  it('exposes the raw JWT and its scopes', () => {
    install({
      token: { raw: 'jwt-abc', scopes: ['ai:write:budgeted'], expiresAt: new Date(0) },
    });
    const { result } = renderHook(() => useBlockToken());
    expect(result.current).toEqual({ raw: 'jwt-abc', scopes: ['ai:write:budgeted'] });
  });

  it('follows a token re-mint', () => {
    const t = install({ token: { raw: 'old', scopes: [], expiresAt: new Date(0) } });
    const { result } = renderHook(() => useBlockToken());
    expect(result.current.raw).toBe('old');

    act(() =>
      t.setSnapshot({
        token: { raw: 'new', scopes: ['ai:write:budgeted'], expiresAt: new Date(0) },
      }),
    );
    expect(result.current).toEqual({ raw: 'new', scopes: ['ai:write:budgeted'] });
  });
});

describe('useDomainMaturity', () => {
  // 🔴 THE INTERSECTION IS THE WHOLE POINT, AND THE SDK DOES NOT DO IT. Its
  // snapshot passes the host's `effectiveBrowsingLevel` straight through, so a
  // binding that simply read the field would trust a number the bridge hook
  // verified — on the one axis where being wrong means showing mature media to a
  // viewer who asked not to see any.
  //
  // The fixture is DISCRIMINATING: the host claims an effective level carrying the
  // `X` bit while the DOMAIN ceiling does not, i.e. a host shipping a wider value
  // than it is entitled to. A pass-through binding answers "X allowed"; the
  // intersection answers "no".
  it('never widens past the domain ceiling, even if the host claims a wider effective level', () => {
    const domainCeiling = BrowsingLevel.PG | BrowsingLevel.PG13;
    install({
      maxBrowsingLevel: domainCeiling,
      effectiveBrowsingLevel: domainCeiling | BrowsingLevel.X,
    });
    const { result } = renderHook(() => useDomainMaturity());

    expect(result.current.isLevelAllowed(BrowsingLevel.X)).toBe(false);
    expect(nsfwModeAllowed(result.current)).toBe(false);
    expect(result.current.isSfw).toBe(true);
  });

  it('honours a genuine mature ceiling', () => {
    const ceiling = BrowsingLevel.PG | BrowsingLevel.R | BrowsingLevel.X;
    install({ maxBrowsingLevel: ceiling, effectiveBrowsingLevel: ceiling });
    const { result } = renderHook(() => useDomainMaturity());

    expect(result.current.isLevelAllowed(BrowsingLevel.X)).toBe(true);
    expect(nsfwModeAllowed(result.current)).toBe(true);
    expect(result.current.isSfw).toBe(false);
  });

  // 🔴 THE `undefined` ARM, PRESERVED EXACTLY. `effectiveBrowsingCeiling` always
  // returns a NUMBER, so calling it unconditionally would turn "the host told us
  // nothing" into a concrete ceiling. `lib/maturity.ts` depends on the fail-closed
  // SFW answer for the whole pre-`BLOCK_INIT` window, which is when the toggle
  // would otherwise flash on screen.
  it('fails closed to SFW before BLOCK_INIT, with no ceiling invented', () => {
    install({ ready: false, maxBrowsingLevel: undefined, effectiveBrowsingLevel: undefined });
    const { result } = renderHook(() => useDomainMaturity());

    expect(result.current.effectiveBrowsingLevel).toBeUndefined();
    expect(result.current.isSfw).toBe(true);
    expect(nsfwModeAllowed(result.current)).toBe(false);
  });

  // The mid-session flip `App.tsx`'s `activeModel` dependency array exists for.
  it('follows a mid-session narrowing of the effective level', () => {
    const ceiling = BrowsingLevel.PG | BrowsingLevel.R | BrowsingLevel.X;
    const t = install({ maxBrowsingLevel: ceiling, effectiveBrowsingLevel: ceiling });
    const { result } = renderHook(() => useDomainMaturity());
    expect(nsfwModeAllowed(result.current)).toBe(true);

    act(() => t.setSnapshot({ effectiveBrowsingLevel: BrowsingLevel.PG | BrowsingLevel.R }));
    expect(nsfwModeAllowed(result.current)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — host-mediated
// ---------------------------------------------------------------------------

describe('host-mediated bindings', () => {
  it('useRequestSignIn notifies REQUEST_SIGN_IN', () => {
    const t = install();
    const { result } = renderHook(() => useRequestSignIn());
    act(() => result.current.requestSignIn());
    expect(t.sent).toEqual([{ type: 'REQUEST_SIGN_IN', payload: {} }]);
  });

  // 🔴 `TRACK_EVENT` ON THE WIRE, NOT A NO-OP SHIM. `BREAKING.md` files it as "not
  // carried" because no host has a sink wired TODAY — so a shim would look
  // identical right now and delete the capability the day one is. This pins that
  // the same message the bridge hook sent still goes out, payload shape included.
  it('useBlockAnalytics still emits TRACK_EVENT with the bridge payload shape', () => {
    const t = install();
    const { result } = renderHook(() => useBlockAnalytics());
    act(() => result.current.track('block_error', { message: 'boom' }));
    expect(t.sent).toEqual([
      { type: 'TRACK_EVENT', payload: { eventName: 'block_error', properties: { message: 'boom' } } },
    ]);
  });

  it('useResourcePicker resolves the host’s selection', async () => {
    const t = install();
    t.handle('OPEN_RESOURCE_PICKER', () => ({ selected: { versionId: 991, modelId: 7 } }));

    const { result } = renderHook(() => useResourcePicker());
    await expect(result.current.open({ resourceType: 'LORA' })).resolves.toMatchObject({
      versionId: 991,
    });
    expect(t.sent).toEqual([{ type: 'OPEN_RESOURCE_PICKER', payload: { resourceType: 'LORA' } }]);
  });

  // The dismissal path `App.tsx` reads as `if (!picked) return;`. The SDK
  // normalises an absent `selected` to `null`; a binding that let `undefined`
  // through would still satisfy that call site, so this asserts the literal.
  it('useResourcePicker normalises a dismissal to null', async () => {
    const t = install();
    t.handle('OPEN_RESOURCE_PICKER', () => ({}));
    const { result } = renderHook(() => useResourcePicker());
    await expect(result.current.open({ resourceType: 'Checkpoint' })).resolves.toBeNull();
  });

  // 🔴 FIRE-AND-FORGET, AND THE REFUSAL MUST NOT SURFACE. The SDK's
  // `requestGrants` is awaitable where the bridge's notify was not, and a viewer
  // who closes the dialog resolves NEITHER arm. The call site is a click handler,
  // so an unhandled rejection here is a console error a viewer can produce at will.
  it('useRequestConsent notifies REQUEST_CONSENT and swallows the refusal', async () => {
    const t = install({ token: { raw: 'j', scopes: [], expiresAt: new Date(0) } });
    const { result } = renderHook(() => useRequestConsent());

    act(() => result.current.requestConsent({ scopes: ['ai:write:budgeted', 'buzz:read:self'] }));

    await waitFor(() =>
      expect(t.sent).toEqual([
        {
          type: 'REQUEST_CONSENT',
          payload: { scopes: ['ai:write:budgeted', 'buzz:read:self'] },
        },
      ]),
    );

    // The host says it cannot be granted. Nothing must throw out of this.
    act(() => t.push('CONSENT_UNAVAILABLE', { reason: 'anonymous' }));
    await Promise.resolve();
  });

  // 🔴 THE 0.53.1 BEHAVIOUR, CARRIED OVER RATHER THAN DROPPED. The patch existed
  // because a root mounting on a LATER render left the observer attached to
  // nothing. This drives exactly that: first commit has no element, a later one
  // does, and the resize must still be reported.
  it('useBlockResize attaches to an element that only appears on a later render', async () => {
    // 🔴 jsdom 25 SHIPS NO `ResizeObserver`, and `host.autoResize` RETURNS A NO-OP
    // when it is absent rather than throwing. Without this stub the case would be
    // vacuous — `sent` stays empty whatever the binding does, so an assertion that
    // the resize IS reported would fail, and an assertion that it is not would pass
    // for the wrong reason. Stubbing it is what makes the observation about the
    // binding.
    const observed: Element[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly cb: () => void) {}
        observe(el: Element) {
          observed.push(el);
          this.cb();
        }
        disconnect() {}
        unobserve() {}
      },
    );

    const t = install();

    // 🔴 THE ELEMENT IS MOUNTED THROUGH A REAL COMMIT, AND THE PREVIOUS FIXTURE
    // WAS NOT. It assigned `ref.current` INSIDE the render function, which React
    // never does: React attaches refs during COMMIT, after render returns. So the
    // old fixture handed the hook a ref that was already populated at render
    // time — which is exactly the thing the hook must not rely on — and the case
    // passed against a hook that reads `ref.current` during render and puts
    // `[element]` in its dependency array. Against React's real timing that hook
    // is one render behind: on the render that introduces the element,
    // `ref.current` is still `null`, the dep array does not change, and the
    // effect never re-runs. That is the `blocks-react@0.53.1` bug verbatim.
    //
    // This fixture renders the element conditionally, so React does the
    // attaching, in the commit, at the moment it really happens.
    function Probe({ attach }: { attach: boolean }) {
      const ref = useRef<HTMLDivElement | null>(null);
      useBlockResize(ref);
      return attach ? <div ref={ref} data-testid="probe-root" /> : null;
    }

    const { rerender } = render(<Probe attach={false} />);
    expect(t.sent).toEqual([]);

    rerender(<Probe attach />);
    await waitFor(() => expect(t.sent.map((s) => s.type)).toContain('RESIZE_IFRAME'));
    // The positive control for the stub itself: the observer really was pointed at
    // the element, so a green above is not "the stub fired unconditionally".
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBeInstanceOf(HTMLDivElement);
  });
});

// ---------------------------------------------------------------------------
// Group 3 — REST
// ---------------------------------------------------------------------------

describe('useAppStorage over /api/v1/blocks/app-storage', () => {
  it('reads a seeded key', async () => {
    install({}, { storage: { seed: { 'sensei:sessions': [{ id: 's1' }] } } });
    const { result } = renderHook(() => useAppStorage());

    await expect(result.current.get('sensei:sessions')).resolves.toEqual([{ id: 's1' }]);
    expect(calls).toEqual([
      { path: 'blocks/app-storage/get', method: 'POST', body: { key: 'sensei:sessions' } },
    ]);
  });

  it('writes through POST blocks/app-storage/set and reads its own write back', async () => {
    install();
    const { result } = renderHook(() => useAppStorage());

    await expect(result.current.set('k', { a: 1 })).resolves.toMatchObject({ ok: true });
    await expect(result.current.get('k')).resolves.toEqual({ a: 1 });
    expect(calls.map((c) => c.path)).toEqual([
      'blocks/app-storage/set',
      'blocks/app-storage/get',
    ]);
  });

  it('lists by prefix and deletes idempotently', async () => {
    install({}, { storage: { seed: { 'sensei:turns:1': 1, 'sensei:turns:2': 2, other: 3 } } });
    const { result } = renderHook(() => useAppStorage());

    const listed = await result.current.list({ prefix: 'sensei:turns:' });
    expect(listed.keys.map((k) => k.key)).toEqual(['sensei:turns:1', 'sensei:turns:2']);
    // `updatedAt` is revived to a real Date by the SDK client, as the bridge hook did.
    expect(listed.keys[0]!.updatedAt).toBeInstanceOf(Date);

    await expect(result.current.delete('sensei:turns:1')).resolves.toEqual({
      ok: true,
      deleted: true,
    });
    await expect(result.current.delete('sensei:turns:1')).resolves.toEqual({
      ok: true,
      deleted: false,
    });
  });

  it('reports quota with both ceilings', async () => {
    install({}, { storage: { seed: { a: 1 }, limitBytes: 999, limitRows: 7 } });
    const { result } = renderHook(() => useAppStorage());
    await expect(result.current.getQuota()).resolves.toEqual({
      usedBytes: 1,
      rowCount: 1,
      limitBytes: 999,
      limitRows: 7,
    });
  });

  // The façade goes into `App.tsx`'s `deps` memo, and the bridge hook documented
  // itself as stable. A fresh object per render would rebuild `deps` every render.
  it('returns a STABLE identity across renders', () => {
    install();
    const { result, rerender } = renderHook(() => useAppStorage());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

describe('useBuzzWorkflow over /api/v1/blocks/workflows', () => {
  it('estimate posts { body } and resolves a priced snapshot', async () => {
    install({}, { workflows: { estimate: { workflowId: 'whatif', status: 'pending', cost: { total: 12 } } } });
    const { result } = renderHook(() => useBuzzWorkflow());

    await expect(result.current.estimate({ kind: 'step' } as never)).resolves.toMatchObject({
      cost: { total: 12 },
    });
    expect(calls).toEqual([
      {
        path: 'blocks/workflows/estimate',
        method: 'POST',
        body: { body: { kind: 'step' } },
      },
    ]);
  });

  // 🔴 `0` IS A REAL PRICE AND IT IS FALSY. The test is `typeof … !== 'number'`,
  // never `!cost?.total`; a truthiness check would reject a free estimate.
  it('estimate accepts a cost of 0', async () => {
    install({}, { workflows: { estimate: { workflowId: 'whatif', status: 'pending', cost: { total: 0 } } } });
    const { result } = renderHook(() => useBuzzWorkflow());
    await expect(result.current.estimate({} as never)).resolves.toMatchObject({
      cost: { total: 0 },
    });
  });

  // 🔴 BOTH REJECTION ARMS ARE LOAD-BEARING, and they are separate producers of
  // one observable ("resolved, but no usable price"). Keying on status alone
  // leaves the second resolving into a dead "Cost unavailable" control;
  // `orchestrator-bridge.ts` branches on `err.code` to say which.
  it('estimate REJECTS a failed reply as WorkflowEstimateError(failed)', async () => {
    install({}, { workflows: { estimate: { workflowId: 'whatif', status: 'failed', error: 'nope', cost: { total: 3 } } } });
    const { result } = renderHook(() => useBuzzWorkflow());

    await expect(result.current.estimate({} as never)).rejects.toSatisfy(
      (e: unknown) => e instanceof WorkflowEstimateError && e.code === 'failed',
    );
  });

  it('estimate REJECTS a cost-less non-failed reply as WorkflowEstimateError(no-cost)', async () => {
    install({}, { workflows: { estimate: { workflowId: 'whatif', status: 'pending' } } });
    const { result } = renderHook(() => useBuzzWorkflow());

    await expect(result.current.estimate({} as never)).rejects.toSatisfy(
      (e: unknown) => e instanceof WorkflowEstimateError && e.code === 'no-cost',
    );
  });

  // 🔴 THE ROUTE REQUIRES `idempotencyKey` AND THE CONSEQUENCE OF OMITTING IT IS A
  // DOUBLE CHARGE. `submit.ts`: on a public HTTP surface retry-on-timeout is the
  // default behaviour of most clients, and without a client key a retry mints a
  // second workflow and a second debit. The key must also match the route's
  // `/^[A-Za-z0-9_-]{1,64}$/`, so the assertion is the regex, not "is a string".
  it('submit sends an idempotencyKey matching the route’s charset bound', async () => {
    install();
    const { result } = renderHook(() => useBuzzWorkflow());
    await result.current.submit({} as never);

    const key = calls[0]!.body.idempotencyKey;
    expect(typeof key).toBe('string');
    expect(key as string).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  // 🔴 FRESH PER CALL, matching the bridge's `generateIdempotencyKey()` default.
  // Reusing one across calls would collapse two deliberate generations into one —
  // the viewer's second question silently answered by the first turn's workflow.
  it('submit mints a FRESH key per call', async () => {
    install();
    const { result } = renderHook(() => useBuzzWorkflow());
    await result.current.submit({} as never);
    await result.current.submit({} as never);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.idempotencyKey).not.toBe(calls[1]!.body.idempotencyKey);
  });

  // 🔴 `randomUUID` IS `[SecureContext]`, AND WITHOUT A FALLBACK ITS ABSENCE TAKES
  // OUT THE WHOLE GENERATE PATH WITH A GIBBERISH MESSAGE. An unguarded
  // `globalThis.crypto.randomUUID()` throws
  // `TypeError: globalThis.crypto.randomUUID is not a function` where the API is
  // missing; `orchestrator-bridge.ts` re-throws anything that is not a
  // `WorkflowSubmitError` with its own message, and `failureBody` renders that
  // string to the viewer. Fail-closed (nothing is charged) but total, and the
  // viewer is shown an internal type error. The bridge's
  // `generateIdempotencyKey()` — which this function's docblock claims to match —
  // guards and falls back to `Date.now()` + `Math.random()`.
  //
  // The key must still satisfy the route's `BLOCK_IDEMPOTENCY_KEY_REGEX`
  // (`/^[A-Za-z0-9_-]{1,64}$/`), so the fallback is asserted against that regex
  // and not merely against "is a string" — a separator leaking in would reach the
  // orchestrator `externalId` derived from it.
  it('submit still mints a valid key where crypto.randomUUID is unavailable', async () => {
    install();
    const { result } = renderHook(() => useBuzzWorkflow());

    const realCrypto = globalThis.crypto;
    // A SecureContext-less realm, modelled the way one actually presents: the
    // `crypto` object exists (`getRandomValues` and the rest are not
    // secure-context-gated) and `randomUUID` simply is not on it.
    vi.stubGlobal('crypto', { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });
    try {
      await result.current.submit({} as never);
      await result.current.submit({} as never);
    } finally {
      vi.stubGlobal('crypto', realCrypto);
    }

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.body.idempotencyKey as string).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
    // Still FRESH per call — the whole point of the key. A fallback that returned
    // a constant would satisfy the regex and collapse two deliberate generations
    // into one.
    expect(calls[0]!.body.idempotencyKey).not.toBe(calls[1]!.body.idempotencyKey);
  });

  // 🔴 A BUDGET REFUSAL RESOLVES. The server answers a spend-cap rejection by
  // RESOLVING with a failure-shaped snapshot that QUOTES the price it declined to
  // charge, expressly so the block can open a top-up flow. Turning this arm into a
  // throw is the one change that would break the recovery path.
  it('submit RESOLVES a failed-but-priced budget refusal', async () => {
    install({}, { workflows: { submit: { workflowId: 'whatif', status: 'failed', cost: { total: 40 }, error: 'insufficient funds' } } });
    const { result } = renderHook(() => useBuzzWorkflow());

    await expect(result.current.submit({} as never)).resolves.toMatchObject({
      status: 'failed',
      cost: { total: 40 },
    });
  });

  it('submit REJECTS a failed AND cost-less reply as WorkflowSubmitError(workflow-failed)', async () => {
    install({}, { workflows: { submit: { workflowId: 'wf-9', status: 'failed', error: 'boom' } } });
    const { result } = renderHook(() => useBuzzWorkflow());

    await expect(result.current.submit({} as never)).rejects.toSatisfy(
      (e: unknown) => e instanceof WorkflowSubmitError && e.code === 'workflow-failed',
    );
  });

  // 🔴 AND IT MUST NOT REJECT AN ORDINARY IN-FLIGHT REPLY. `{status:'pending'}` is
  // cost-less too, so dropping the `status === 'failed'` clause would reject every
  // successful submit. The reference implementation's own note says a mutation
  // sweep that only DELETES clauses cannot see that widening, so it is pinned by
  // its own fixture.
  it('submit RESOLVES a cost-less pending reply', async () => {
    install({}, { workflows: { submit: { workflowId: 'wf-1', status: 'pending' } } });
    const { result } = renderHook(() => useBuzzWorkflow());
    await expect(result.current.submit({} as never)).resolves.toMatchObject({ status: 'pending' });
  });

  it('poll posts { workflowId } with NO waitSeconds and returns the snapshot', async () => {
    install({}, { workflows: { poll: { workflowId: 'wf-1', status: 'succeeded', textOutputs: ['hi'] } } });
    const { result } = renderHook(() => useBuzzWorkflow());

    await expect(result.current.poll('wf-1')).resolves.toMatchObject({
      status: 'succeeded',
      textOutputs: ['hi'],
    });
    expect(calls).toEqual([
      { path: 'blocks/workflows/poll', method: 'POST', body: { workflowId: 'wf-1' } },
    ]);
    expect(calls[0]!.body).not.toHaveProperty('waitSeconds');
  });

  it('cancel posts { workflowId }', async () => {
    install();
    const { result } = renderHook(() => useBuzzWorkflow());
    await expect(result.current.cancel('wf-1')).resolves.toMatchObject({ status: 'canceled' });
    expect(calls).toEqual([
      { path: 'blocks/workflows/cancel', method: 'POST', body: { workflowId: 'wf-1' } },
    ]);
  });

  // 🔴 A REPLY WITHOUT A SNAPSHOT IS A FAILURE, NOT A RESULT. Returning `undefined`
  // would make `poll` resolve with a non-snapshot and leave
  // `orchestrator-bridge.ts`'s watch loop — whose stop condition reads
  // `snapshot.status` — spinning against a server answering with nothing.
  it('throws on a reply carrying no snapshot', async () => {
    install({}, { workflows: { poll: () => ({ status: 200, body: { snapshot: null } }) } });
    const { result } = renderHook(() => useBuzzWorkflow());
    await expect(result.current.poll('wf-1')).rejects.toThrow(/malformed response/i);
  });

  // 🔴 THE ONE BEHAVIOUR DIFFERENCE THE PORT INTRODUCES, PINNED RATHER THAN
  // DESCRIBED. Over the bridge a procedure that THREW came back as a
  // host-synthesised failure SNAPSHOT and surfaced as
  // `WorkflowSubmitError(code:'exception')`. Over REST a throw is a non-2xx, so it
  // arrives as the SDK's `ApiError` and never becomes a `WorkflowSubmitError` at
  // all. `orchestrator-bridge.ts`'s catch re-throws anything that is not one, with
  // the server's own message — so this asserts BOTH halves: not that class, and
  // the message survives.
  it('a server-side throw arrives as a non-WorkflowSubmitError carrying the server message', async () => {
    install({}, {
      workflows: {
        submit: () => ({ status: 500, body: { message: 'orchestrator unavailable' } }),
      },
    });
    const { result } = renderHook(() => useBuzzWorkflow());

    const err = await result.current.submit({} as never).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(WorkflowSubmitError);
    expect((err as Error).message).toContain('orchestrator unavailable');
  });

  // 🔴 THE FAKE'S OWN NEGATIVE CONTROL, and it is about this repo rather than the
  // platform: `dev-rest.ts` answers an unknown path with a LOUD 404 naming it, so a
  // typo'd route surfaces as a failure instead of a quietly empty screen. That is
  // the failure mode this whole port is most able to introduce, and a fake that
  // answered `{}` would hide it.
  it('the REST fake refuses an unknown route instead of answering empty', async () => {
    install();
    const fetchFake = createRestFake();
    const response = await fetchFake('https://civitai.com/api/v1/blocks/nope', { method: 'POST' });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('blocks/nope'),
    });
  });
});

describe('configureSdkRuntime / resetSdkRuntime', () => {
  // The client is bound to the transport AND to the injected `fetch`, so installing
  // new options mid-file must drop it. Without this a second case in one file would
  // answer from the first case's store.
  it('a re-configure drops the AppClient built under the previous fetch', async () => {
    install({}, { storage: { seed: { k: 'first' } } });
    const first = renderHook(() => useAppStorage());
    await expect(first.result.current.get('k')).resolves.toBe('first');

    install({}, { storage: { seed: { k: 'second' } } });
    const second = renderHook(() => useAppStorage());
    await expect(second.result.current.get('k')).resolves.toBe('second');
  });

  // 🔴 A REJECTED `initialize()` MUST NOT BECOME THE PERMANENT ANSWER.
  //
  // `initialize()` awaits `ready(transport, 10_000)` and REJECTS with
  // `BridgeError('unavailable', 'BLOCK_INIT')` when no host answers in time.
  // `appPromise ??= initialize(…)` never reassigns a SETTLED promise, rejected
  // included — so ONE slow host boot made that rejection the answer to every
  // later `app()` call for the life of the page: app storage, all four workflow
  // operations and token refresh, out together and silently. Nothing in
  // production could clear it. `configureSdkRuntime`/`resetSdkRuntime` are test
  // seams, and the bridge-identity swap in `transport()` cannot fire because the
  // bridge's `getTransport()` caches its singleton forever.
  //
  // The fixture fails `initialize` the CHEAP way — `snapshot.get()` throws, which
  // `ready()` reads first — rather than waiting out a 10-second deadline. What is
  // pinned is the CACHING of a settled rejection, not the deadline that produces
  // it in production.
  it('does not cache a REJECTED initialize forever — a later call re-tries', async () => {
    const fake = createFakeTransport({ ready: true, viewer: { id: 1, username: 'zed' } });
    let boom: Error | null = new Error('host never answered BLOCK_INIT');
    const flaky = {
      ...fake,
      snapshot: {
        get: () => {
          if (boom) throw boom;
          return fake.snapshot.get();
        },
        subscribe: (listener: () => void) => fake.snapshot.subscribe(listener),
      },
    };

    calls = [];
    configureSdkRuntime({
      transport: flaky as never,
      fetch: createRestFake({
        storage: { seed: { k: 'after-recovery' } },
        onRequest: (c) => calls.push(c),
      }),
    });

    const { result } = renderHook(() => useAppStorage());

    await expect(result.current.get('k')).rejects.toThrow(/host never answered BLOCK_INIT/);
    // The boot failed, so nothing reached the wire — without this, a green second
    // read could not be told apart from a first read that had quietly succeeded.
    expect(calls).toEqual([]);

    // The host answers on the next attempt: the ordinary transient this defect
    // turned permanent. Under `??=` this rejects again with the FIRST call's own
    // error, which is the defect's signature.
    boom = null;
    await expect(result.current.get('k')).resolves.toBe('after-recovery');
    expect(calls.map((c) => c.path)).toEqual(['blocks/app-storage/get']);
  });

  // 🔴 THE OTHER DIRECTION, because the obvious over-correction is to drop the
  // memo entirely and stand up a fresh AppClient — and a fresh token session —
  // per call.
  //
  // ⚠ WHY THIS IS A RELATIONSHIP AND NOT A COUNT OF `initialize` CALLS, said
  // plainly because the count is what a reader will reach for first: `initialize`
  // cannot be observed from here. `vi.mock('@civitai/sdk', …)` does NOT reach
  // `sdk-runtime.ts`'s own import of it — measured, the spy stays at 0 while the
  // real function runs — and a per-client side effect does not exist either
  // (`createHostSession` registers no listeners and `initialize` issues no
  // request). What IS observable is that `initialize` calls `transport.snapshot
  // .get()` once, via `ready()`, on top of whatever a request costs. So the FIRST
  // read pays init + request and the second pays request only:
  //
  //   memoised      → delta(read 2) <  delta(read 1)
  //   re-initialised → delta(read 2) == delta(read 1)
  //
  // Asserted as that inequality rather than as a literal, so an SDK patch that
  // legitimately changes how many times it reads the snapshot cannot redden this
  // gate for nothing.
  it('still builds the AppClient ONCE when initialize succeeds, not per call', async () => {
    const fake = createFakeTransport({ ready: true, viewer: { id: 1, username: 'zed' } });
    let gets = 0;
    const counting = {
      ...fake,
      snapshot: {
        get: () => {
          gets += 1;
          return fake.snapshot.get();
        },
        subscribe: (listener: () => void) => fake.snapshot.subscribe(listener),
      },
    };

    calls = [];
    configureSdkRuntime({
      transport: counting as never,
      fetch: createRestFake({ storage: { seed: { k: 1 } }, onRequest: (c) => calls.push(c) }),
    });

    const { result, rerender } = renderHook(() => useAppStorage());

    const before1 = gets;
    await result.current.get('k');
    const firstReadGets = gets - before1;

    rerender();
    const before2 = gets;
    await result.current.get('k');
    const secondReadGets = gets - before2;

    // Both reads happened, so the comparison is between two real reads.
    expect(calls).toHaveLength(2);
    expect(firstReadGets).toBeGreaterThan(0);
    expect(secondReadGets).toBeLessThan(firstReadGets);
  });

  it('resetSdkRuntime clears the injected transport', () => {
    const t = install();
    const { result } = renderHook(() => useRequestSignIn());
    act(() => result.current.requestSignIn());
    expect(t.sent).toHaveLength(1);

    resetSdkRuntime();
    // Nothing is asserted about what the next `transport()` returns — in jsdom it
    // falls back to the bridge singleton, which is `test-setup.ts`'s business. What
    // matters is that the fake is no longer the runtime's transport.
    const after = renderHook(() => useRequestSignIn());
    act(() => after.result.current.requestSignIn());
    expect(t.sent).toHaveLength(1);
  });
});

// A guard on the module's own import surface rather than on behaviour: the point of
// the port is that the app's runtime composition no longer reaches the bare bridge
// package, and `sdk-runtime.ts` is the ONE production module that still may.
describe('the port’s composition', () => {
  it('App.tsx takes its runtime hooks from this module, not from the bridge package', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    // 🔴 `process.cwd()`, not `import.meta.url`: under the jsdom project
    // `import.meta.url` is an http URL (jsdom's document base), so a `new URL(…)`
    // against it is not a file URL and `readFileSync` rejects it. Same reason
    // `bootSkeleton.test.tsx` reads `index.html` this way.
    const source = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

    // 🔴 THE WHOLE NORMALISED IMPORT, not a keyword. A guard that grepped for
    // `sdk-runtime` would still pass if the bare `@civitai/blocks-react` import
    // came back alongside it.
    expect(source).toContain("} from './lib/sdk-runtime.js';");
    expect(source).not.toMatch(/from '@civitai\/blocks-react';/);
    // `/ui` legitimately stays until starters#328 — asserted so "no bare import"
    // cannot be satisfied by deleting the pack import too.
    expect(source).toContain("from '@civitai/blocks-react/ui'");
  });

  it('no production runtime module imports the bare bridge package except the adapter', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join, resolve } = await import('node:path');

    // `process.cwd()` for the same reason as the case above.
    const srcRoot = `${resolve(process.cwd(), 'src')}/`;
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );

    const offenders = walk(srcRoot)
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => !/(test-helpers|test-setup|test-dom-helpers|dev-transport|Harness)\./.test(f))
      .filter((f) => /from '@civitai\/blocks-react';/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(srcRoot.length));

    // 🔴 AN EXACT LEDGER, FAILING WHEN THE SET GROWS *OR* SHRINKS — both directions
    // watched to fail, not assumed. Two modules legitimately still reach the bridge
    // package: the adapter (that is its job — one transport serves both packages
    // until starters#328) and this runtime, which re-exports the bridge's two
    // workflow error classes so `orchestrator-bridge.ts`'s `instanceof` branches
    // keep one class identity. A third is a regression; losing one means the port
    // was partly undone.
    //
    // ⚠ WHAT IT MEASURES IS THE IMPORT FORM, NOT RUNTIME REACH, and the difference
    // is worth stating because the sentence above could be read as the stronger
    // claim: the pattern is anchored on the closing `';` so it counts the bare
    // specifier only (`/ui` and `/testing` are excluded by construction), and it
    // counts an `import type` as an importer even though a type reference reaches no
    // transport at all. That is deliberate — the port's deliverable is the
    // composition, and the three per-subpath counts in the PR body are measured the
    // same way — but it is not a claim that these two files are the only ones whose
    // CODE can reach the bridge.
    expect(offenders.sort()).toEqual(['lib/sdk-runtime.ts', 'lib/sdk-transport.ts']);
  });
});
