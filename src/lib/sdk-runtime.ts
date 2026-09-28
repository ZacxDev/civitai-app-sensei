// The ten runtime bindings this app used to take from `@civitai/blocks-react`,
// re-expressed on `@civitai/sdk`'s `initialize({ transport })`.
//
// WHY A MODULE AND NOT TEN INLINE REWRITES: the SDK is not hook-shaped. It is one
// async `initialize()` returning clients, so every consumer would otherwise have
// to solve the same three problems — when the client exists, how a snapshot field
// reaches React without re-rendering forever, and which operations are still
// messages rather than HTTP. Those answers belong in one place.
//
// THE SPLIT, WHICH IS THE WHOLE DESIGN. Three groups, and they differ in kind:
//
//   1. SNAPSHOT (ready/viewer/theme/token/browsing levels) — available
//      SYNCHRONOUSLY from the transport, before `initialize()` resolves, because
//      the bridge transport already holds `BLOCK_INIT`. These must not wait on
//      anything: the app paints its boot skeleton off `ready`/`theme`.
//   2. HOST-MEDIATED (resize, sign-in, consent, the resource picker, analytics) —
//      still postMessage. `createHost(transport)` is synchronous, so only consent
//      needs the AppClient at all.
//   3. REST (app storage, the four workflow operations) — these moved off the
//      bridge onto `/api/v1/blocks/*`, and they are the only group that must wait
//      for `initialize({ transport })` to resolve, because only the AppClient
//      carries the http client bound to the token session.
//
// 🔴 ONE TRANSPORT, AND IT IS THE BRIDGE'S. `./sdk-transport.ts` explains why
// (`/ui`'s `BlockGate` wraps the production root and keeps constructing the bridge
// singleton, so a bare `initialize()` would stand up a second one).
//
// 🔴 WHAT THAT MEANS FOR THIS REPO'S TESTS, stated because it is the one thing a
// reader will get wrong. This app's 23 dom test files do NOT drive a mock host:
// they `vi.mock` the hook module wholesale. Before the port that module was
// `@civitai/blocks-react`; after it, it is THIS file. So those tests exercised the
// bridge hooks no more than they now exercise these bindings — the port neither
// adds nor removes coverage there, it re-points it. The code in this file is
// covered by `sdk-runtime.test.tsx`, which drives the real bindings against a fake
// transport and a `fetch`-level fake (`../dev-rest.ts`).

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';

import { getTransport } from '@civitai/blocks-react';
// 🔴 VALUE IMPORTS, AND REUSED ON PURPOSE RATHER THAN RE-DECLARED. `lib/
// orchestrator-bridge.ts` branches on `instanceof` against these two classes and
// its `estimateRejectionMessage`/`submitRejectionMessage` read `err.code`; the
// `/api/v1/blocks/workflows/*` routes' own docblocks say they preserve exactly the
// resolve-vs-reject boundary those classes encode ("`@civitai/blocks-react`'s
// `useBuzzWorkflow` reads exactly that"). Declaring a second pair here would give
// the app two class identities for one contract and silently falsify every
// `instanceof` in that file.
import { WorkflowEstimateError, WorkflowSubmitError } from '@civitai/blocks-react';

/**
 * 🔴 RE-EXPORTED SO THE APP HAS EXACTLY ONE IDENTITY FOR EACH CLASS, BY
 * CONSTRUCTION RATHER THAN BY ARGUMENT. `lib/orchestrator-bridge.ts` branches on
 * `instanceof` against the same two classes this module THROWS; having it import
 * them from here means the thrower and the catcher cannot end up holding different
 * constructors however the dependency tree is resolved. It also keeps the bare
 * `@civitai/blocks-react` import confined to this module and the adapter, which is
 * what `sdk-runtime.test.tsx`'s importer ledger pins.
 */
export { WorkflowEstimateError, WorkflowSubmitError };
import {
  effectiveBrowsingCeiling,
  isLevelAllowed as isLevelAllowedCeiling,
  isSfwCeiling,
} from '@civitai/app-sdk/blocks';
import type {
  BlockWorkflowSnapshot,
  ColorDomain,
  WorkflowBody,
} from '@civitai/app-sdk/blocks';
import { createHost, initialize } from '@civitai/sdk';
import type {
  AppClient,
  BlockSnapshot,
  BlockTransport,
  Host,
  PickedResource,
  ResourcePickerType,
  Scope,
  Theme,
  ViewerInfo,
} from '@civitai/sdk';

import { createSdkTransportAdapter, HUMAN_INTERACTION_TIMEOUT_MS } from './sdk-transport.js';

export interface SdkRuntimeOptions {
  /**
   * The transport the SDK reads. Defaults to the bridge singleton adapted by
   * `createSdkTransportAdapter()`; a test passes a fake so no iframe is needed.
   */
  transport?: BlockTransport;
  /**
   * Injected into `initialize`, so group 3 (the REST calls) can be answered at the
   * `fetch` boundary. 🔴 THIS IS THE SEAM THE PORT CREATES. Before the port, app
   * storage and the four workflow operations were postMessage conversations a mock
   * HOST could answer; after it they are HTTP and the host never sees them, so a
   * test that kept seeding the host would pass while exercising nothing.
   */
  fetch?: typeof globalThis.fetch;
  /** Override the site base URL (`https://civitai.com/api/v1` by default) — dev harness only. */
  siteUrl?: string;
}

let options: SdkRuntimeOptions = {};
let transportSingleton: BlockTransport | null = null;
let bridgeWrapped: unknown = null;
let appPromise: Promise<AppClient> | null = null;

/**
 * Set the runtime's options — the transport, the `fetch` the REST calls use, and
 * the site base URL. `src/main.tsx` calls it for the dev harness; production needs
 * no call at all, because every default is already right there.
 *
 * 🔴 IT DISCARDS ANY AppClient BUILT UNDER THE PREVIOUS OPTIONS, and that is the
 * whole contract: the hazard a mid-flight `fetch` swap creates is a STALE CLIENT,
 * and dropping the client removes it where refusing the call would merely report
 * it (and would refuse a legitimate case — a test that renders the app twice in
 * one case).
 *
 * It is NOT a full reset: `resetSdkRuntime` is what tests use between cases,
 * because that also clears options back to the defaults.
 */
export function configureSdkRuntime(next: SdkRuntimeOptions): void {
  options = next;
  transportSingleton = next.transport ?? null;
  bridgeWrapped = null;
  appPromise = null;
}

/**
 * Drop all runtime state. A test seam, and the counterpart every singleton needs:
 * without it the first test's transport and `fetch` leak into every later test in
 * the same file.
 */
export function resetSdkRuntime(): void {
  options = {};
  transportSingleton = null;
  bridgeWrapped = null;
  appPromise = null;
}

/**
 * The one transport.
 *
 * 🔴 THE CACHE IS KEYED ON THE BRIDGE TRANSPORT'S IDENTITY, AND THAT IS REQUIRED
 * BY THIS REPO'S TEST SETUP RATHER THAN DEFENSIVE POLISH. The bridge's transport
 * is a process-wide singleton that `resetTransport()` NULLS, so the next
 * `getTransport()` returns a brand-new object; `src/test-setup.ts` calls
 * `resetHarnessTransport()` in a global `beforeEach`, i.e. before EVERY dom test. A
 * plain `??=` would therefore wrap the first test's transport and keep wrapping it
 * after it had been disposed — every later test reading a dead snapshot. The
 * AppClient is bound to the transport too (its session and host both close over
 * it), so a swap must drop that as well.
 *
 * An explicitly configured transport is never re-derived: a test that passed one
 * owns it, and silently replacing it with the singleton would be worse than any
 * staleness this guards against.
 */
function transport(): BlockTransport {
  if (options.transport) return options.transport;
  const bridge = getTransport();
  if (transportSingleton === null || bridge !== bridgeWrapped) {
    bridgeWrapped = bridge;
    transportSingleton = createSdkTransportAdapter(bridge) as BlockTransport;
    appPromise = null;
  }
  return transportSingleton;
}

/** The one AppClient promise, created on first use. */
function app(): Promise<AppClient> {
  appPromise ??= initialize({
    transport: transport(),
    fetch: options.fetch,
    ...(options.siteUrl === undefined ? {} : { siteUrl: options.siteUrl }),
  });
  return appPromise;
}

/** The host client. Synchronous — `createHost` needs only the transport. */
function host(): Host {
  return createHost(transport());
}

// ---------------------------------------------------------------------------
// Group 1 — the snapshot
// ---------------------------------------------------------------------------

/**
 * Read one field out of the live snapshot.
 *
 * 🔴 `select` MUST RETURN A FIELD, NEVER A FRESH OBJECT. `useSyncExternalStore`
 * bails out on `Object.is`, so a selector composing `{ a, b }` returns a new
 * identity every call, never compares equal, and re-renders forever. The transport
 * adapter memoises the snapshot itself for exactly this reason; a composing
 * selector here would throw that away one layer up. Compose with `useMemo` on the
 * fields instead, as `useBlockContext` does below.
 */
export function useBlockSnapshot<T>(select: (snapshot: BlockSnapshot) => T): T {
  const t = transport();
  const subscribe = useCallback((onChange: () => void) => t.snapshot.subscribe(onChange), [t]);
  const get = useCallback(() => select(t.snapshot.get()), [t, select]);
  return useSyncExternalStore(subscribe, get, get);
}

const selectReady = (s: BlockSnapshot) => s.ready;
const selectViewer = (s: BlockSnapshot) => s.viewer;
const selectTheme = (s: BlockSnapshot) => s.theme;
const selectToken = (s: BlockSnapshot) => s.token;
const selectDomain = (s: BlockSnapshot) => s.domain;
const selectMaxBrowsingLevel = (s: BlockSnapshot) => s.maxBrowsingLevel;
const selectEffectiveBrowsingLevel = (s: BlockSnapshot) => s.effectiveBrowsingLevel;

export interface BlockContextValue {
  ready: boolean;
  viewer: ViewerInfo | null;
  theme: Theme;
}

/** `{ ready, viewer, theme }`, as the bridge hook of the same name returned. */
export function useBlockContext(): BlockContextValue {
  const ready = useBlockSnapshot(selectReady);
  const viewer = useBlockSnapshot(selectViewer);
  const theme = useBlockSnapshot(selectTheme);
  return useMemo(() => ({ ready, viewer, theme }), [ready, viewer, theme]);
}

export interface BlockTokenValue {
  raw: string;
  scopes: string[];
}

/**
 * The block JWT and the scopes it carries.
 *
 * ⚠ NO `refresh()`, AND THAT IS NOT A NARROWING OF ANYTHING THIS APP USED. The
 * bridge hook exposed one; `git grep 'token_\.' src` finds `raw` and `scopes`
 * only, and `App.tsx` memoises its client on the `raw` STRING. The SDK refreshes
 * the token itself — `createHttp` retries once on a 401 with `getToken({ fresh:
 * true })`, which goes out as `REQUEST_TOKEN` over the adapter — so the 401 path
 * the bridge made the app's business is now the client's.
 *
 * ⚠ ONE DELIBERATE IMPROVEMENT, and `App.tsx`'s comment about it is now stale
 * rather than wrong: the bridge returned `{...token, refresh}`, a FRESH object
 * every render, which is why the app memoises on `token.raw`. This returns a value
 * memoised on the snapshot's token identity, so the object is stable between
 * mints. The app's `raw`-keyed memo stays correct either way and is left in place
 * because it is the narrower claim.
 */
export function useBlockToken(): BlockTokenValue {
  const token = useBlockSnapshot(selectToken);
  return useMemo(() => ({ raw: token.raw, scopes: token.scopes }), [token]);
}

/**
 * The domain/viewer maturity projection, field-for-field as the bridge's
 * `useDomainMaturity` returned it.
 *
 * 🔴 THE INTERSECTION IS RE-APPLIED HERE, AND DROPPING IT WOULD HAVE WIDENED WHAT
 * THIS APP SHOWS. The bridge hook did this for us and the SDK does NOT: its
 * snapshot passes the host's `effectiveBrowsingLevel` straight through from
 * `BLOCK_INIT`. The bridge hook's own comment says why it re-derived rather than
 * trusted — "so the never-wider property holds even against a host that ships a
 * wrong value" — and `effectiveBrowsingCeiling` additionally refuses junk. Reading
 * the raw field would have made this module trust a number it previously verified,
 * on the one axis where being wrong means showing mature media to a viewer who
 * asked not to see any.
 *
 * 🔴 AND THE `undefined` ARM IS PRESERVED EXACTLY. `effectiveBrowsingCeiling`
 * always returns a NUMBER, so calling it unconditionally would turn "the host told
 * us nothing" into a concrete ceiling. `isSfwCeiling(undefined)` and
 * `isLevelAllowed(level, undefined)` are the fail-closed SFW answers `lib/
 * maturity.ts` depends on for the pre-`BLOCK_INIT` window, so the absence must
 * still short-circuit — which is precisely what the bridge hook did.
 */
export interface DomainMaturityValue {
  domain?: ColorDomain | null;
  maxBrowsingLevel?: number;
  effectiveBrowsingLevel?: number;
  isSfw: boolean;
  isLevelAllowed: (level: number) => boolean;
}

export function useDomainMaturity(): DomainMaturityValue {
  const domain = useBlockSnapshot(selectDomain);
  const maxBrowsingLevel = useBlockSnapshot(selectMaxBrowsingLevel);
  const hostEffective = useBlockSnapshot(selectEffectiveBrowsingLevel);
  return useMemo(() => {
    const effective =
      maxBrowsingLevel === undefined
        ? undefined
        : effectiveBrowsingCeiling(maxBrowsingLevel, hostEffective);
    return {
      domain,
      maxBrowsingLevel,
      effectiveBrowsingLevel: effective,
      isSfw: isSfwCeiling(effective),
      isLevelAllowed: (level: number) => isLevelAllowedCeiling(level, effective),
    };
  }, [domain, maxBrowsingLevel, hostEffective]);
}

// ---------------------------------------------------------------------------
// Group 2 — host-mediated, still postMessage
// ---------------------------------------------------------------------------

/**
 * Keep the host iframe sized to `ref`'s content.
 *
 * `host.autoResize(element)` owns the observer and the initial report and returns
 * its own teardown, so this hook is a lifecycle wrapper and nothing more.
 *
 * 🔴 THE `ref.current` RE-CHECK ON EVERY COMMIT IS THE `@civitai/blocks-react@
 * 0.53.1` FIX, CARRIED OVER RATHER THAN DROPPED. That patch existed because a root
 * mounting on a LATER render left the observer attached to nothing — the effect
 * had already run with `ref.current === null` and a ref carries no subscription.
 * `App.tsx`'s three top-level returns all render `<div ref={rootRef}>`, so the
 * element is there on the first commit today; the guard is here so the app does
 * not depend on that staying true. It re-runs on every commit (no dependency
 * array) and no-ops while the element is unchanged, because `autoResize`'s own
 * teardown/rebuild is a `ResizeObserver` pair and nothing more.
 */
export function useBlockResize(ref: RefObject<HTMLElement | null>): void {
  const element = ref.current;
  useEffect(() => {
    if (!element) return;
    return host().autoResize(element);
  }, [element]);
}

/** `{ requestSignIn }` — asks the host to open its sign-in flow. */
export function useRequestSignIn(): { requestSignIn: () => void } {
  const requestSignIn = useCallback(() => host().requestSignIn(), []);
  return useMemo(() => ({ requestSignIn }), [requestSignIn]);
}

/**
 * How long a pending consent request is held open before its listeners are
 * released. The viewer is not on a clock — the host's dialog is theirs to leave
 * open — so this is deliberately generous; it exists only so a declined request
 * cannot retain a snapshot subscription for the life of the page.
 */
const CONSENT_WAIT_MS = 5 * 60_000;

/**
 * `{ requestConsent }` — fire-and-forget, exactly as the bridge hook was.
 *
 * 🔴 THE SDK's `requestGrants` IS AWAITABLE AND THE BRIDGE's WAS NOT, AND THAT
 * DIFFERENCE HAD TO BE HANDLED RATHER THAN CAST AWAY. `requestGrants` resolves
 * `true` when the re-minted token carries the scopes, `false` on
 * `CONSENT_UNAVAILABLE` — and against a viewer who simply closes the dialog it
 * resolves NEITHER, holding a snapshot subscription and a message listener per
 * press. The app's call site is fire-and-forget by design (on grant the host
 * re-mints and the snapshot flips `hasGenerateScope`; declining changes nothing and
 * must raise no error), so:
 *
 *   - the promise is not awaited, preserving the call site's semantics;
 *   - it is bounded by a signal, so an abandoned dialog releases its listeners;
 *   - the rejection that abort produces is swallowed HERE, because an unhandled
 *     rejection in a click handler is a console error a viewer can produce at will
 *     by closing a dialog.
 *
 * ⚠ `scopes` IS THE SDK's `Scope` UNION, NOT `string[]` — a deliberate tightening:
 * a scope this platform does not define is now a compile error at the call site
 * instead of a runtime `CONSENT_UNAVAILABLE` nobody traces back to a typo. The
 * app's own constants in `src/scopes.ts` are `const` string literals, so they
 * satisfy it unchanged.
 */
export function useRequestConsent(): {
  requestConsent: (args: { scopes: readonly Scope[] }) => void;
} {
  const requestConsent = useCallback(({ scopes }: { scopes: readonly Scope[] }) => {
    void app()
      .then((client) =>
        client.requestGrants(scopes, { signal: AbortSignal.timeout(CONSENT_WAIT_MS) }),
      )
      .catch(() => {
        /* declined, abandoned, or aborted — all "nothing changed", never an error */
      });
  }, []);
  return useMemo(() => ({ requestConsent }), [requestConsent]);
}

/**
 * civitai's own resource picker. Resolves the chosen resource, or `null` when the
 * viewer dismissed it.
 *
 * 🔴 THE 10-MINUTE DEADLINE IS RESTORED EXPLICITLY, TWICE OVER, AND NEITHER COPY
 * IS REDUNDANT. The bridge hook passed `HUMAN_INTERACTION_TIMEOUT_MS` to
 * `sendTypedRequest`; the SDK left client deadlines behind entirely and documents
 * `signal` as the replacement. So:
 *   - `sdk-transport.ts`'s table passes `timeoutMs` to the BRIDGE, which is what
 *     stops its 30s default rejecting while the viewer's modal is still open
 *     (civitai/civitai#4158);
 *   - the `signal` here is what bounds the SDK-side promise, so a host that never
 *     answers at all cannot leave this awaiting forever.
 * Same number on purpose: two layers, one policy.
 *
 * ⚠ `resourceType` is the SDK's `ResourcePickerType`. `App.tsx` casts into it for
 * the LoRA family the host accepts and the published union does not yet name — see
 * the comment at that call site; the cast is unchanged by the port because it was
 * never about which package sent the message.
 */
export function useResourcePicker(): {
  open: (opts: {
    resourceType: ResourcePickerType;
    baseModelGroup?: string;
  }) => Promise<PickedResource | null>;
} {
  const open = useCallback(
    (opts: { resourceType: ResourcePickerType; baseModelGroup?: string }) =>
      host().openResourcePicker(opts, {
        signal: AbortSignal.timeout(HUMAN_INTERACTION_TIMEOUT_MS),
      }),
    [],
  );
  return useMemo(() => ({ open }), [open]);
}

/**
 * Fire-and-forget analytics.
 *
 * 🔴 STILL `TRACK_EVENT` ON THE WIRE, NOT A NO-OP SHIM, AND THE DIFFERENCE MATTERS
 * EVEN THOUGH TODAY'S HOST DROPS IT. `@civitai/sdk`'s `BREAKING.md` files
 * `TRACK_EVENT` as "not carried", and notes it "has no host handler today either —
 * `hostHandlerParity.ts` marks both hosts N/A". A shim would therefore be
 * observationally identical *right now* and would silently delete the capability
 * the day a sink is wired. Sending the same message the bridge hook sent keeps the
 * port a port: `notify` goes through the adapter to the bridge's `sendMessage`, so
 * the bytes on the wire are unchanged.
 */
export function useBlockAnalytics(): {
  track: (eventName: string, properties?: Record<string, unknown>) => void;
} {
  const track = useCallback((eventName: string, properties?: Record<string, unknown>) => {
    transport().notify({ type: 'TRACK_EVENT', payload: { eventName, properties } });
  }, []);
  return useMemo(() => ({ track }), [track]);
}

// ---------------------------------------------------------------------------
// Group 3 — REST
// ---------------------------------------------------------------------------

/** One row of a key listing. `updatedAt` is revived to a `Date` by the SDK client. */
export interface AppStorageKeyEntry {
  key: string;
  updatedAt: Date;
}

export interface AppStorageListResult {
  keys: AppStorageKeyEntry[];
  nextCursor?: string;
}

export interface AppStorageQuota {
  usedBytes: number;
  rowCount: number;
  limitBytes: number;
  limitRows: number;
}

/**
 * The per-(block instance, viewer) KV surface this app consumes.
 *
 * 🔴 DECLARED HERE RATHER THAN ALIASED TO THE SDK's `StorageClient`, and the
 * reason is `set`. The SDK's client promises `{ ok: true; sizeBytes: number }`
 * where the bridge promised `sizeBytes?: number`, and this repo's fakes
 * (`test-helpers.tsx`'s two, plus the per-file ones) return `{ ok: true }` with no
 * size. Aliasing would make every one of them a type error and turn a transport
 * port into a rewrite of the test fakes — for a field no consumer reads. So the
 * app keeps the contract it was written against; the façade below simply satisfies
 * it, and the SDK's stricter promise is compatible with the looser declaration.
 */
export interface AppStorage {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<{ ok: true; sizeBytes?: number }>;
  delete(key: string): Promise<{ ok: true; deleted: boolean }>;
  list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<AppStorageListResult>;
  getQuota(): Promise<AppStorageQuota>;
}

/**
 * Per-(block instance, viewer) KV, over `POST /api/v1/blocks/app-storage/*`.
 *
 * Returns a STABLE façade whose methods await the AppClient internally, rather
 * than `AppStorage | null`. Two reasons, both load-bearing:
 *   - the object goes into `useMemo` dependency arrays (`App.tsx`'s `deps`) and
 *     the bridge hook documented itself as stable;
 *   - a `null` would make every call site grow a branch for a state that lasts
 *     milliseconds and that the app already gates on `ready`.
 *
 * ⚠ ONE MIGRATION DELTA THE PORT INHERITS, from `@civitai/sdk`'s `BREAKING.md`:
 * an ANONYMOUS viewer gets 403 where the bridge resolved an anonymous read to
 * `null`. This app already gates its whole storage surface on a signed-in viewer
 * (`App.tsx` renders the sign-in prompt instead of the chat when `viewer` is
 * null, and `loadSessions` runs off that branch), so nothing here reads an empty
 * result as "nothing stored" — but a new call site must not start doing so.
 */
export function useAppStorage(): AppStorage {
  return useMemo<AppStorage>(
    () => ({
      get: async (key) => (await app()).storage.get(key),
      set: async (key, value) => (await app()).storage.set(key, value),
      delete: async (key) => (await app()).storage.delete(key),
      list: async (opts) => (await app()).storage.list(opts),
      getQuota: async () => (await app()).storage.getQuota(),
    }),
    [],
  );
}

/**
 * Where the four workflow operations live, relative to the site base URL.
 *
 * 🔴 THESE ROUTES, NOT `app.orchestration`, AND THE WRONG ONE COMPILES.
 * `@civitai/sdk`'s `BREAKING.md` calls this "the sharpest trap in the migration":
 * substituting `app.orchestration` for these routes type-checks and passes tests
 * while dropping server-side policy no local check can miss — the per-call
 * `buzzBudget`, the per-viewer and per-app daily spend caps, the maturity clamp
 * and the `app-block:<appId>` attribution tag every later read and cancel is
 * scoped by. The SDK additionally refuses `app.orchestration` outright for a
 * block-scoped token, which is what this app holds (no `auth: "oauth"` in the
 * manifest, deliberately).
 *
 * Verified against the route files rather than guessed (civitai `origin/main`,
 * `src/pages/api/v1/blocks/workflows/*.ts`, added 2026-09-23 by #5068): all four
 * are POST under scope `ai:write:budgeted`, all four answer `{ snapshot }`, and
 * each is "a thin adapter over the SAME procedure the page host calls".
 */
const WORKFLOW_ROUTES = Object.freeze({
  estimate: 'blocks/workflows/estimate',
  submit: 'blocks/workflows/submit',
  poll: 'blocks/workflows/poll',
  cancel: 'blocks/workflows/cancel',
});

/**
 * The bridge's `WORKFLOW_REQUEST_TIMEOUT_MS`, carried over.
 *
 * The SDK sets no deadline of its own, so without this a hung request would wait
 * forever where the bridge rejected at two minutes. Two minutes is the bridge's
 * own figure: "a generous ceiling so a busy-but-healthy orchestrator doesn't
 * surface as a spurious timeout".
 */
const WORKFLOW_REQUEST_TIMEOUT_MS = 120_000;

/** The `{ snapshot }` envelope all four routes answer with. */
interface WorkflowReply {
  snapshot?: BlockWorkflowSnapshot;
}

/**
 * A fresh idempotency key per submit.
 *
 * 🔴 REQUIRED BY THE ROUTE — `submit.ts`'s schema has no `?` on it, and its
 * docblock says why: on a public HTTP surface retry-on-timeout is the default
 * behaviour of most clients, and without a client key a retry mints a second
 * `externalId`, a second workflow and a second debit of the viewer's Buzz.
 *
 * 🔴 FRESH PER CALL, matching the bridge's `generateIdempotencyKey()` default.
 * Each call is a new logical submit; reusing one across calls would collapse two
 * deliberate generations into one. `orchestrator-bridge.ts` relies on this — its
 * "no retry is attempted" note says an automatic retry would be a SECOND
 * reservation rather than a second attempt at the first.
 *
 * Charset is the route's `BLOCK_IDEMPOTENCY_KEY_REGEX` (`/^[A-Za-z0-9_-]{1,64}$/`),
 * so no separator can leak into the orchestrator `externalId` derived from it.
 * `crypto.randomUUID()` is hex-and-hyphens, which that regex admits.
 */
function mintIdempotencyKey(): string {
  return `bls-${globalThis.crypto.randomUUID()}`;
}

export interface BuzzWorkflow {
  estimate: (body: WorkflowBody) => Promise<BlockWorkflowSnapshot>;
  submit: (body: WorkflowBody) => Promise<BlockWorkflowSnapshot>;
  poll: (workflowId: string) => Promise<BlockWorkflowSnapshot>;
  cancel: (workflowId: string) => Promise<BlockWorkflowSnapshot>;
}

async function workflowCall(route: string, body: unknown): Promise<BlockWorkflowSnapshot> {
  const client = await app();
  const reply = await client.site.post<WorkflowReply>(route, body, {
    signal: AbortSignal.timeout(WORKFLOW_REQUEST_TIMEOUT_MS),
  });
  const snapshot = reply?.snapshot;
  // A reply without a usable snapshot is a failure, not a result. Returning
  // `undefined` would make `poll` resolve with a non-snapshot and make the
  // adapter's watch loop — whose stop condition reads `snapshot.status` — spin
  // against a server answering with nothing.
  if (!snapshot || typeof snapshot.status !== 'string') {
    throw new Error(`${route}: malformed response (no snapshot)`);
  }
  return snapshot;
}

/**
 * The four workflow operations, re-expressed on the block REST routes with the
 * bridge hook's resolve/reject contract preserved exactly.
 *
 * 🔴 THE RESOLVE-VS-REJECT BOUNDARY IS THE CONTRACT, AND IT IS THE MONEY HALF.
 * `lib/orchestrator-bridge.ts` branches on `instanceof WorkflowEstimateError` /
 * `WorkflowSubmitError` and reads their `code`, and the routes were written to
 * keep that boundary intact: each answers 200 with the procedure's body
 * byte-for-byte when the procedure RESOLVED — INCLUDING a budget-refusal snapshot
 * that quotes the price it declined to charge — and a non-2xx only when the
 * procedure THREW. So the two clauses below are the bridge hook's, verbatim in
 * effect:
 *   - `estimate` rejects on `status === 'failed'` OR on a missing numeric
 *     `cost.total`. Both arms are load-bearing: keying on status alone leaves the
 *     cost-less-but-not-failed reply resolving into a dead "Cost unavailable"
 *     control, and keying on cost alone would call a priced failure "no cost".
 *   - `submit` rejects ONLY when `status === 'failed'` AND there is no numeric
 *     `cost.total`. Dropping the status test would reject every ordinary
 *     in-flight `{status:'pending'}` reply; dropping the cost test would reject
 *     the budget refusal the app recovers from. And the test is `typeof … !==
 *     'number'`, never `!cost?.total`: `0` is a real price and falsy.
 *
 * ⚠ ONE BEHAVIOUR DIFFERENCE THE PORT INTRODUCES, AND IT IS NOT SMUGGLED. Over the
 * bridge, a procedure that THREW came back as a host-synthesised failure snapshot
 * (workflow id `'failed'`), which `useBuzzWorkflow` reported as
 * `WorkflowSubmitError(code: 'exception')`. Over REST a throw is a non-2xx, so it
 * arrives as the SDK's `ApiError` instead and `'exception'` becomes unreachable
 * from here. `orchestrator-bridge.ts` handles that: its `catch` re-throws anything
 * that is not a `WorkflowSubmitError` with the server's own message, and its
 * `'exception'` arm — the one that stays silent about money — is now dead code
 * rather than wrong code. The `'workflow-failed'` arm is the one this path can
 * produce, and it is the CAUTIOUS one ("this turn may already have been charged"),
 * which is the right default for an unknown id.
 */
export function useBuzzWorkflow(): BuzzWorkflow {
  return useMemo<BuzzWorkflow>(
    () => ({
      estimate: async (body) => {
        const snapshot = await workflowCall(WORKFLOW_ROUTES.estimate, { body });
        if (snapshot.status === 'failed') throw new WorkflowEstimateError(snapshot, 'failed');
        if (typeof snapshot.cost?.total !== 'number') {
          throw new WorkflowEstimateError(snapshot, 'no-cost');
        }
        return snapshot;
      },
      submit: async (body) => {
        const snapshot = await workflowCall(WORKFLOW_ROUTES.submit, {
          body,
          idempotencyKey: mintIdempotencyKey(),
        });
        if (snapshot.status === 'failed' && typeof snapshot.cost?.total !== 'number') {
          throw new WorkflowSubmitError(snapshot, 'workflow-failed');
        }
        return snapshot;
      },
      // `waitSeconds` is deliberately OMITTED rather than sent as 0: the route
      // treats its absence as a plain read, which is what the bridge's `poll`
      // (as opposed to its `watch`) sent. `orchestrator-bridge.ts` owns the loop
      // and its cadence, so a long-poll hint here would change two things at once.
      poll: (workflowId) => workflowCall(WORKFLOW_ROUTES.poll, { workflowId }),
      cancel: (workflowId) => workflowCall(WORKFLOW_ROUTES.cancel, { workflowId }),
    }),
    [],
  );
}
