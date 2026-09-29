// An in-memory stand-in for the two REST families this app reaches after the
// port: per-viewer app storage, and the four block workflow operations. Used by
// the dev harness (`main.tsx`) and by the tests that used to seed those
// conversations through a mocked hook.
//
// 🔴 WHY THIS IS A `fetch` FAKE AND NOT A MOCK HOST, which is the whole point.
// Before the port, `useAppStorage` and `useBuzzWorkflow` were postMessage
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
  /** Per-viewer KV seed (key → JSON value). */
  storage?: { seed?: Record<string, unknown>; limitBytes?: number; limitRows?: number };
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

/** A fixed instant, so nothing here reads a clock a test cannot control. */
const EPOCH = '2026-01-01T00:00:00.000Z';

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

function bytesOf(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
}

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
  const kv = new Map<string, { value: unknown; updatedAt: string }>(
    Object.entries(options.storage?.seed ?? {}).map(([k, v]) => [k, { value: v, updatedAt: EPOCH }]),
  );
  const limitBytes = options.storage?.limitBytes ?? 50 * 1024 * 1024;
  const limitRows = options.storage?.limitRows ?? 1_000_000;

  const responders = { ...DEFAULT_WORKFLOW_REPLIES, ...options.workflows };

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://civitai.com');
    const path = url.pathname.replace(/^.*\/api\/v1\//, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body: Record<string, unknown> =
      init?.body == null ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);
    options.onRequest?.({ path, method, body });

    // --- per-viewer KV: POST blocks/app-storage/* ------------------------------
    // Shapes from src/pages/api/v1/blocks/app-storage/{get,set,delete,list,quota}.ts
    if (path.startsWith('blocks/app-storage/')) {
      const op = path.slice('blocks/app-storage/'.length);
      const key = String(body.key ?? '');
      if (op === 'get') return json({ value: kv.get(key)?.value ?? null });
      if (op === 'set') {
        const size = bytesOf(body.value);
        kv.set(key, { value: body.value, updatedAt: EPOCH });
        // `{ ok: true, sizeBytes }`, and `sizeBytes` is REQUIRED — the SDK's client
        // throws without it, and the route's docblock says there is "no 2xx path
        // that means not written".
        return json({ ok: true, sizeBytes: size });
      }
      if (op === 'delete') return json({ ok: true, deleted: kv.delete(key) });
      if (op === 'list') {
        const prefix = body.prefix === undefined ? '' : String(body.prefix);
        const keys = [...kv.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => ({ key: k, updatedAt: v.updatedAt }));
        return json({ keys });
      }
      if (op === 'quota') {
        let usedBytes = 0;
        for (const [, v] of kv) usedBytes += bytesOf(v.value);
        return json({ usedBytes, rowCount: kv.size, limitBytes, limitRows });
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
