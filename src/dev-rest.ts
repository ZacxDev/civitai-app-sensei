// An in-memory stand-in for the two REST families this app reaches after the
// port: per-viewer app storage (the document store's `blocks/storage/*` routes
// since 0.2.0), and the four block workflow operations. Used by
// the dev harness (`main.tsx`) and by the tests that used to seed those
// conversations through a mocked hook.
//
// 🔴 WHY THIS IS A `fetch` FAKE AND NOT A MOCK HOST, which is the whole point.
// Before the port, the bridge's storage hook and `useBuzzWorkflow` were postMessage
// conversations and `@civitai/blocks-react/testing`'s mock host answered them.
// After it, they are HTTP. A transport-level fake would therefore "answer a
// conversation nobody is having" — the suite would pass while exercising none of
// the code that now carries the traffic. The app's real boundary for these two is
// `fetch`, so the fake belongs there.
//
// 🔴 WHAT IT IS NOT. It is not a second implementation of the platform's policy:
// no scope checks, no spend caps, no maturity clamp, no rate limits, no
// moderation, no idempotency ledger. Those are the server's and they are NOT
// re-asserted here, because a fake that reimplemented them would drift and start
// certifying its own behaviour. What it does own is the ROUTE SHAPES — path,
// method, body, reply envelope — and those are taken from the route files, named
// per family below.

import { createFakeStorage, type FakeStorage, type FakeStorageViewer } from '@civitai/sdk/testing';
import { ApiError } from '@civitai/sdk';

import manifest from '../block.manifest.json';
import { createKvStorage } from './lib/kv-store.js';

/** A workflow snapshot as the routes' `{ snapshot }` envelope carries it. */
export interface RestWorkflowSnapshot {
  workflowId: string;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'expired' | 'canceled';
  cost?: { total: number };
  error?: string;
  /**
   * 🔴 THE ONLY CHANNEL A CHAT REPLY ARRIVES ON, so a fake that omitted it would
   * make every successful generation look empty. `lib/orchestrator-bridge.ts`'s
   * `extractReleasedText` reads `textOutputs` and nothing else — not
   * `steps[].output`, not `content` — because the `'textOutput'` posture entry
   * declares no `extractOutput`.
   */
  textOutputs?: string[];
  toolCalls?: unknown[];
  [extra: string]: unknown;
}

export interface RestFakeOptions {
  /**
   * The document store behind `blocks/storage/*`.
   *
   * `seed` is LEGACY-SHAPED (key → the value the app stores) and is written through
   * `createKvStorage`, i.e. through the same `{ value }` mapping the app reads with,
   * so a seed cannot disagree with the adapter about the document shape. `viewer`
   * is the caller (default `{ username: 'viewer' }`; `null` is anonymous).
   */
  storage?: { seed?: Record<string, unknown>; viewer?: FakeStorageViewer | null };
  /**
   * What each workflow route answers with. A function receives the parsed request
   * body, so a test can drive a sequence (first poll `processing`, then
   * `succeeded`) without reaching for timers.
   *
   * Omitted ops fall back to {@link DEFAULT_WORKFLOW_REPLIES}.
   */
  workflows?: {
    estimate?: WorkflowResponder;
    submit?: WorkflowResponder;
    poll?: WorkflowResponder;
    cancel?: WorkflowResponder;
  };
  /**
   * Called for every request this fake answers. The observation seam a test needs
   * now that these two families are HTTP: a guard that used to watch an
   * `APP_STORAGE_SET` postMessage watches the `blocks/app-storage/set` call here.
   */
  onRequest?: (call: { path: string; method: string; body: Record<string, unknown> }) => void;
}

export type WorkflowResponder =
  | RestWorkflowSnapshot
  | ((body: Record<string, unknown>) => RestWorkflowSnapshot | { status: number; body: unknown });

/**
 * What the four routes answer when a caller seeds nothing.
 *
 * Priced, succeeded and non-empty on purpose: the dev harness has to show a
 * working turn, and a zero cost would trip `estimate`'s own `no-cost` rejection
 * for a reason that has nothing to do with the code under test. (`cost.total: 0`
 * is a legal price the app must accept — that is asserted in the runtime tests,
 * not encoded as a default here.)
 */
const DEFAULT_WORKFLOW_REPLIES: Required<NonNullable<RestFakeOptions['workflows']>> = {
  estimate: { workflowId: 'whatif', status: 'pending', cost: { total: 4 } },
  submit: { workflowId: 'dev-workflow-1', status: 'pending', cost: { total: 4 } },
  poll: {
    workflowId: 'dev-workflow-1',
    status: 'succeeded',
    cost: { total: 4 },
    textOutputs: ['A reply from the in-memory dev REST fake.'],
  },
  cancel: { workflowId: 'dev-workflow-1', status: 'canceled' },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build a `fetch` that answers the app's REST surface from memory.
 *
 * Anything it does not recognise gets a 404 carrying the path — LOUD on purpose.
 * A fake that answered `{}` to an unknown route would turn a wrong path into a
 * quietly empty screen, which is the failure this whole port is most able to
 * introduce.
 */
export function createRestFake(options: RestFakeOptions = {}): typeof globalThis.fetch {
  const docStore: FakeStorage = createFakeStorage({
    manifest,
    ...(options.storage?.viewer !== undefined ? { viewer: options.storage.viewer } : {}),
  });
  const seeded = (async () => {
    // Seeded as a signed-in viewer even when the caller is anonymous: a private
    // collection has no anonymous writer, and the seed is fixture, not traffic.
    const seedAs = options.storage?.viewer ?? { username: 'viewer' };
    const kv = createKvStorage(() => docStore.as({ viewer: seedAs }).storage);
    for (const [k, v] of Object.entries(options.storage?.seed ?? {})) await kv.set(k, v);
  })();

  const responders = { ...DEFAULT_WORKFLOW_REPLIES, ...options.workflows };

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://civitai.com');
    const path = url.pathname.replace(/^.*\/api\/v1\//, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body: Record<string, unknown> =
      init?.body == null ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);
    options.onRequest?.({ path, method, body });

    // --- the document store: blocks/storage/* -----------------------------------
    // 🔴 ANSWERED BY THE SDK's OWN CONTRACT FAKE, NOT RE-IMPLEMENTED HERE.
    // `createFakeStorage` is the server half of the document store (scopes, the
    // manifest's declared collections, key rules, limits, the error envelope); this
    // branch only converts between `fetch` and its `Http` seam. So the app's real
    // client — `initialize()`'s `app.storage` — is what talks to it.
    if (path.startsWith('blocks/storage')) {
      await seeded;
      const query: Record<string, string | string[]> = {};
      for (const name of new Set(url.searchParams.keys())) {
        const all = url.searchParams.getAll(name);
        query[name] = all.length === 1 ? all[0]! : all;
      }
      try {
        const reply = await docStore.http<unknown>(method, path, {
          query,
          ...(init?.body == null ? {} : { body }),
        });
        return json(reply ?? {});
      } catch (err) {
        if (err instanceof ApiError) return json(err.body, err.status);
        throw err;
      }
    }

    // --- workflows: POST blocks/workflows/* ------------------------------------
    // Shapes from src/pages/api/v1/blocks/workflows/{estimate,submit,poll,cancel}.ts
    // — all four POST, all four answer `{ snapshot }`.
    if (path.startsWith('blocks/workflows/')) {
      const op = path.slice('blocks/workflows/'.length) as keyof typeof responders;
      if (method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const responder = responders[op];
      if (!responder) return json({ error: `dev-rest: no workflow op '${op}'` }, 404);
      // 🔴 THE ROUTE REQUIRES `idempotencyKey` ON SUBMIT AND THIS FAKE ENFORCES IT,
      // which is the one policy it does re-assert. Its absence is a 400 on the real
      // surface (`submit.ts`: "no `?`… an optional marker here means every submit
      // they write 400s"), and the consequence of getting it wrong is a double
      // charge — so a submit that forgets the key must fail HERE rather than in
      // production.
      if (op === 'submit' && typeof body.idempotencyKey !== 'string') {
        return json({ error: 'Invalid request body', details: 'idempotencyKey required' }, 400);
      }
      const answer = typeof responder === 'function' ? responder(body) : responder;
      if (answer && typeof answer === 'object' && 'status' in answer && 'body' in answer) {
        const failure = answer as { status: number; body: unknown };
        return json(failure.body, failure.status);
      }
      return json({ snapshot: answer });
    }

    return json({ error: `dev-rest: no route for ${method} ${path}` }, 404);
  }) as typeof globalThis.fetch;
}
