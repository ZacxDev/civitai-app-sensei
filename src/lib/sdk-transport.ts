/**
 * Adapts the `@civitai/blocks-react` transport singleton to the `BlockTransport`
 * interface `@civitai/sdk`'s `initialize({ transport })` accepts.
 *
 * WHY THIS EXISTS — and why it is not just `initialize()` with no argument:
 * `@civitai/blocks-react/ui` stays on the bridge until
 * `civitai/civitai-app-starters#328`, and this app's `/ui` consumers reach the
 * bridge transport SINGLETON. `BlockGate` wraps the PRODUCTION root in
 * `src/main.tsx`, and it resolves to `useDirectLoad` → `useTransportSnapshot` →
 * `getTransport()`, so the bridge transport is constructed on every production
 * boot whatever else the app does.
 *
 * A bare `initialize()` would stand up a SECOND transport beside it: two
 * `message` listeners, two `BLOCK_HELLO` senders, two `BLOCK_READY` auto-senders,
 * two token copies and two `TOKEN_REFRESH` handlers. Whether the host tolerates
 * two `BLOCK_READY`s is a platform question nobody here has measured, so this app
 * does not ship an unverified protocol change. One transport, adapted.
 *
 * Delete this file and switch to a plain `initialize()` once `/ui` no longer
 * imports from `@civitai/blocks-react` (starters#328).
 */
import { getTransport, sendTypedRequest } from '@civitai/blocks-react';
import type { BlockTransport as BridgeTransport } from '@civitai/blocks-react';

/**
 * 🔴 THE BRIDGE REQUIRES THE CALLER TO NAME BOTH THE REPLY TYPE AND THE DEADLINE,
 * AND THE SDK NAMES NEITHER — so both have to live here, per request type.
 *
 * The SDK's `request(type, params, { signal })` carries no response type: it
 * assumes the transport knows. The bridge's `sendRequest` REQUIRES one
 * (`sendTypedRequest(t, req, responseType, { timeoutMs })`) and applies
 * `DEFAULT_REQUEST_TIMEOUT_MS` (30s) when no `timeoutMs` is passed.
 *
 * 🔴 `timeoutMs` IS NOT OPTIONAL POLISH FOR A HUMAN-GATED REQUEST — OMITTING IT IS
 * A REGRESSION WITH A KNOWN INCIDENT BEHIND IT. `@civitai/blocks-react`'s
 * `transport/requestTimeouts.ts` buckets every block→parent message: it files
 * `OPEN_RESOURCE_PICKER` as `'human'` and quotes civitai/civitai#4158, where
 * `PUBLISH_GENERATION_OUTPUTS` shipped on the 30s default and rejected WHILE THE
 * VIEWER'S DIALOG WAS STILL OPEN. `useResourcePicker` therefore passed
 * `HUMAN_INTERACTION_TIMEOUT_MS` (10 minutes), and routing the same message
 * through this adapter without it would silently drop a viewer's model pick 30
 * seconds after the modal opened. `REQUEST_TOKEN` is `'protocol'` in that same
 * ledger, so it takes the default and says so rather than leaving the reader to
 * wonder whether it was forgotten.
 *
 * Pairings are taken from the hooks that already send these messages, not
 * guessed: `hooks/useBlockToken.ts` for `REQUEST_TOKEN` →
 * `TOKEN_REFRESH_RESPONSE`, `hooks/useResourcePicker.ts` for
 * `OPEN_RESOURCE_PICKER` → `RESOURCE_PICKER_RESULT`.
 *
 * An unmapped type THROWS rather than guessing: picking a plausible reply type
 * would hang the request until its timeout and surface as a dead host.
 */
interface BridgeRequestBinding {
  readonly responseType: string;
  /**
   * `undefined` means "the bridge's own default" — recorded explicitly so a
   * `'protocol'` bucketing reads as a decision rather than an omission.
   */
  readonly timeoutMs?: number;
}

/** `HUMAN_INTERACTION_TIMEOUT_MS` from `@civitai/blocks-react`, which does not export it. */
export const HUMAN_INTERACTION_TIMEOUT_MS = 10 * 60_000;

const BRIDGE_REQUESTS: Readonly<Record<string, BridgeRequestBinding>> = Object.freeze({
  REQUEST_TOKEN: { responseType: 'TOKEN_REFRESH_RESPONSE' },
  OPEN_RESOURCE_PICKER: {
    responseType: 'RESOURCE_PICKER_RESULT',
    timeoutMs: HUMAN_INTERACTION_TIMEOUT_MS,
  },
});

/**
 * The SDK's snapshot is the bridge's plus `hostOrigin`, which the bridge exposes
 * as a separate accessor. Everything else is field-for-field identical (the only
 * field in the SDK's `BlockSnapshot` absent from the bridge's is `hostOrigin`;
 * the bridge's extra `appId`/`blockId` are simply ignored).
 *
 * 🔴 IDENTITY IS LOAD-BEARING, NOT AN OPTIMISATION. `snapshot.get()` feeds
 * `useSyncExternalStore`, which bails out on `Object.is`. Composing `{...snap,
 * hostOrigin}` fresh on every call returns a new object every time, so the store
 * never compares equal and React re-renders forever. So: cache, and recompute
 * only when an input actually changed.
 *
 * 🔴 AND `hostOrigin` MUST COME FROM `getHostOrigin()` WITH NO FALLBACK. The
 * bridge documents it as a security invariant: the value it returns is the base
 * URL a money-scoped block bearer token is sent to, and it must only ever be an
 * origin that passed the same allowlist gate every inbound message passes.
 * `null` means "not yet established" and must stay `null` — substituting
 * `window.location.origin`, `document.referrer` or a parent's origin here would
 * turn a not-ready state into a token-exfiltration vector.
 */
function composeSnapshot(bridge: BridgeTransport) {
  let lastBase: unknown;
  let lastHostOrigin: string | null | undefined;
  let lastComposed: unknown;

  return function get() {
    const base = bridge.getSnapshot();
    const hostOrigin = bridge.getHostOrigin();
    if (base === lastBase && hostOrigin === lastHostOrigin) {
      return lastComposed;
    }
    lastBase = base;
    lastHostOrigin = hostOrigin;
    lastComposed = { ...base, hostOrigin };
    return lastComposed;
  };
}

/**
 * Wrap the bridge's transport singleton for `initialize({ transport })`.
 *
 * Takes the transport as an argument (defaulting to the singleton) so tests can
 * drive it with a fake rather than standing up a real iframe transport.
 */
export function createSdkTransportAdapter(bridge: BridgeTransport = getTransport()) {
  const get = composeSnapshot(bridge);

  return {
    snapshot: {
      get,
      subscribe: (listener: () => void) => bridge.subscribe(listener),
    },

    notify: (message: { type: string; payload?: unknown }) => {
      // The bridge's outbound union is narrower than `string`; the SDK only ever
      // sends types the bridge knows, and an unknown one is rejected by the host
      // rather than silently accepted here.
      bridge.sendMessage(message as Parameters<BridgeTransport['sendMessage']>[0]);
    },

    request: (type: string, params: unknown, opts?: { signal?: AbortSignal }) => {
      const binding = BRIDGE_REQUESTS[type];
      if (!binding) {
        throw new Error(
          `sdk-transport: no response type mapped for request '${type}'. ` +
            'Add it to BRIDGE_REQUESTS with a source for the reply pairing AND its ' +
            'bucket from @civitai/blocks-react transport/requestTimeouts.ts, rather ' +
            'than guessing: a wrong reply type hangs until timeout and reads as a ' +
            'dead host, and a human-gated request on the 30s default rejects while ' +
            "the viewer's dialog is still open.",
        );
      }
      const inflight = sendTypedRequest(
        bridge,
        { type, payload: params } as Parameters<typeof sendTypedRequest>[1],
        binding.responseType as Parameters<typeof sendTypedRequest>[2],
        // 🔴 The SDK's opts and the bridge's have NO common property — the SDK's
        // is `{ signal?: AbortSignal }`, the bridge's `{ timeoutMs?: number }` —
        // so the caller's signal cannot be smuggled through here by a cast. It is
        // honoured below instead, and the deadline comes from the table.
        binding.timeoutMs === undefined ? undefined : { timeoutMs: binding.timeoutMs },
      ) as Promise<unknown>;

      const signal = opts?.signal;
      if (!signal) return inflight;
      if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));

      // ⚠ HONEST LIMITATION: this rejects the CALLER's promise on abort, but the
      // bridge exposes no cancellation, so the in-flight postMessage is NOT
      // recalled and a late reply is simply dropped. That is strictly better than
      // ignoring the signal (the caller unblocks) and strictly worse than real
      // cancellation (the host still does the work) — stated rather than implied,
      // because a reader would otherwise assume `signal` cancels the host call.
      return Promise.race([
        inflight,
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
            once: true,
          });
        }),
      ]);
    },

    on: (type: string, handler: (payload: unknown) => void) =>
      bridge.onMessage(type as Parameters<BridgeTransport['onMessage']>[0], handler),
  };
}
