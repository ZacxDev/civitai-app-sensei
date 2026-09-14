import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage } from './test-helpers.js';

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 A TURN'S CITATION EVIDENCE MUST SURVIVE EVERYTHING THAT WRITES AFTER IT.
//
// `Message.grounded` is the app's anti-fabrication evidence: the catalog ids a
// turn's tool rounds actually RETURNED. The citation gate refuses a
// `civitai.com/models/<id>` link unless `<id>` is in the conversation's grounded
// set, and `role:'tool'` is a transcript role that is NEVER persisted — so this
// field is the ONLY surviving record. Lose it and a reload rebuilds a poorer set
// than the live turn enforced: the gate refuses links it had itself approved,
// and a citation the catalog vouched for degrades to unverifiable text.
//
// 🔴 EVERY CASE HERE ASSERTS THE RENDERED DOM AFTER A RELOAD, OR THE COMMITTED
// BYTES — never React state. The whole defect class is a state/storage split, so
// a test that reads state is asking the copy that was never wrong.
//
// ── WHY THESE ARE SEPARATE FROM `App.reply-monotonicity.e2e.test.tsx`. ────────
//
// That file's widened ledger catches a write that HOLDS LESS than an earlier
// write held for the same message id. Two of the three losses below are NOT that
// shape: an errored turn and a stopped turn write their row for the FIRST time
// with the evidence already missing, so there is no earlier write to compare
// against and no ledger can see them. They need a behavioural case each.
//
// 🔴 MEASURED AT `9f2a220` (rank 33, the tip this was written against): all
// three go red there, each for its own reason. Do not read one as covering
// another — the three write sites are `handleSend`'s success path, its
// catch/withhold path, and `handleStopStream`'s rescue transcript.
// ─────────────────────────────────────────────────────────────────────────────

/** Real id, real model (DreamShaper) — the same one `citation-grounding` uses. */
const DREAMSHAPER = 4384;

const storage = fakeAppStorage();

const estimateFn = vi
  .fn()
  .mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } });
const submitFn = vi.fn(async () => ({ workflowId: 'wf-1', status: 'pending' }));

/** One snapshot per poll, in order. Empty falls through to `pollFallback`. */
let pollQueue: Array<Record<string, unknown>> = [];
/**
 * What a poll returns once the queue is empty.
 *
 * 🔴 IT EXISTS FOR THE STOP CASE, which has to hold a turn OPEN — a queue can
 * only ever run dry, and running dry has to mean something a test chooses. The
 * default answers with text so a case that simply forgets to queue enough
 * snapshots fails on its own assertion rather than hanging.
 */
let pollFallback: () => Record<string, unknown> = () => ({
  workflowId: 'wf-x',
  status: 'succeeded',
  cost: { total: 1 },
  textOutputs: ['done'],
});
const pollFn = vi.fn(async () => pollQueue.shift() ?? pollFallback());
const cancelFn = vi.fn(async () => undefined);

vi.mock('@civitai/blocks-react', () => ({
  useAppStorage: () => storage.appStorage,
  useBlockAnalytics: () => ({ track: vi.fn() }),
  useBlockContext: () => ({ ready: true, viewer: { id: 1 }, theme: 'dark' }),
  useBlockResize: () => {},
  // Fail-closed SFW — the production default. Why, and what actually tests the
  // policy: `lib/maturity.ts`. Not the contract; a literal.
  useDomainMaturity: () => ({ isSfw: true, isLevelAllowed: () => false }),
  useRequestConsent: () => ({ requestConsent: vi.fn() }),
  useRequestSignIn: () => ({ requestSignIn: vi.fn() }),
  useResourcePicker: () => ({ open: vi.fn().mockResolvedValue(null) }),
  useBlockToken: () => ({ raw: 'block-jwt-test', scopes: ['ai:write:budgeted', 'buzz:read:self'] }),
  useBuzzBalance: () => ({ balance: { blue: 100, green: 0, yellow: 200 } }),
  useBuzzWorkflow: () => ({
    estimate: estimateFn,
    submit: submitFn,
    poll: pollFn,
    cancel: cancelFn,
    status: 'idle',
    result: null,
    error: null,
  }),
}));

const DECLARATIONS = [
  {
    type: 'function',
    function: {
      name: 'search_models',
      description: 'Search the Civitai model catalog',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  },
];

/** What `POST /api/v1/blocks/tools` answers with — i.e. what grounds. */
let toolItems: Array<Record<string, unknown>> = [];
let originalFetch: typeof globalThis.fetch;

function installFetch() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/v1/blocks/tools')) {
      const payload =
        method === 'GET' ? { tools: DECLARATIONS } : { items: toolItems, truncated: 0 };
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [], metadata: {} }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

/** The model asks for a `search_models` round instead of answering. */
function toolCallSnapshot() {
  return {
    workflowId: 'wf-tc',
    status: 'succeeded',
    cost: { total: 1 },
    toolCalls: [
      {
        id: 'call_abc',
        type: 'function',
        function: { name: 'search_models', arguments: JSON.stringify({ query: 'realistic' }) },
      },
    ],
  };
}

function textSnapshot(text: string) {
  return { workflowId: 'wf-t', status: 'succeeded', cost: { total: 1 }, textOutputs: [text] };
}

/** A workflow that ended badly — the bridge turns this into `Error: boom`. */
function failedSnapshot() {
  return { workflowId: 'wf-f', status: 'failed', error: 'boom', cost: { total: 1 } };
}

/** A workflow that never finishes, so a turn can be Stopped mid-flight. */
function pendingSnapshot() {
  return { workflowId: 'wf-p', status: 'pending', cost: { total: 1 } };
}

/**
 * The same reply queued twice: an UNGROUNDED citation provokes one corrective
 * re-submit, and the model asked to correct itself says the same thing again.
 * Queuing both means a case reads the same on the arm where the gate refuses the
 * link and on the arm where it does not.
 */
function twice(snap: Record<string, unknown>) {
  return [snap, { ...snap }];
}

/** The rendered anchor for a model id, or null when the gate refused it. */
function anchorFor(id: number): HTMLAnchorElement | null {
  return document.querySelector<HTMLAnchorElement>(`a[href*="/models/${id}"]`);
}

/** Every COMMITTED transcript write, in issue order. */
type StoredRow = { id?: string; role: string; content: string; grounded?: string[] };
function transcriptWrites(): StoredRow[][] {
  return storage.sets
    .filter((s) => s.key.startsWith('sensei:messages:') && Array.isArray(s.value))
    .map((s) => s.value as StoredRow[]);
}

/** Every grounded id in the LAST committed transcript — what a reload loads. */
function committedGroundedIds(): string[] {
  const last = transcriptWrites().at(-1) ?? [];
  return [...new Set(last.flatMap((m) => m.grounded ?? []))];
}

async function startChat() {
  render(<App />);
  await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
  fireEvent.click(screen.getByTestId('new-session-button'));
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
}

/**
 * Type and send; resolves once `expectOnScreen` is visible AND the turn has
 * settled. Waiting for the text alone silently returns while `isStreaming` is
 * still true, and the NEXT send is then refused without doing anything.
 */
async function send(question: string, expectOnScreen: RegExp) {
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: question } });
  fireEvent.click(screen.getByTestId('send-button'));
  await waitFor(() => expect(screen.getByText(expectOnScreen)).toBeTruthy(), { timeout: 10_000 });
  await waitFor(() => expect(screen.queryByTestId('streaming-indicator')).toBeNull(), {
    timeout: 10_000,
  });
}

/** Re-open the app from scratch — the only thing that reads storage back. */
async function reload() {
  cleanup();
  render(<App />);
  await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
}

describe("a turn's grounded evidence survives every later write", () => {
  beforeEach(() => {
    storage.store.clear();
    storage.sets.length = 0;
    storage.attempts.length = 0;
    storage.setFailSet(() => false);
    pollQueue = [];
    pollFallback = () => textSnapshot('done');
    toolItems = [{ id: DREAMSHAPER, name: 'DreamShaper', type: 'Checkpoint' }];
    submitFn.mockClear();
    pollFn.mockClear();
    cancelFn.mockClear();
    installFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('🔴 asking a second question, then reloading before the answer — turn 1 keeps its link', async () => {
    // ── THE SUCCESS-PATH WRITE SITE (rank 34). ────────────────────────────────
    //
    // `handleSend` writes `[...messages, userMsg]`, and React's copy of turn 1's
    // reply was rebuilt from the empty placeholder — `content` and `correction`
    // only. So an ORDINARY second send committed turn 1's reply back with
    // `grounded` gone.
    //
    // 🔴 THE RELOAD HAPPENS WHILE TURN 2 IS STILL IN FLIGHT, AND THAT IS THE
    // WHOLE FIXTURE — MEASURED, NOT CHOSEN FOR CONVENIENCE. Any row turn 2
    // eventually writes carries the SESSION's accumulated grounded set (its
    // `turnGrounded` is seeded from `groundedBySession`), so a completed — or
    // even a failed — turn 2 puts the id back under its OWN message id and the
    // reloaded conversation can vouch for the link again. Letting turn 2 finish
    // therefore tests the catch path, not this one: verified by mutation, a
    // build with only the success-path fix reverted stayed GREEN on that
    // version of this case. Measured at `9f2a220`, the four committed writes of
    // a completed two-turn chat are `[u1]`, `[u1, a1(g=[4384])]`,
    // `[u1, a1(g=absent), u2]`, `[u1, a1(g=absent), u2, a2(g=[4384])]` — the
    // union is whole again by the last row. The durable loss is exactly the
    // window between the second question being written and any later row
    // landing: a viewer who closes the tab, or reloads, inside it. That window
    // is what this drives.
    pollQueue = [
      toolCallSnapshot(),
      textSnapshot(`[DreamShaper](https://civitai.com/models/${DREAMSHAPER}) is great.`),
    ];
    await startChat();
    await send('what is DreamShaper?', /is great/);

    // 🔴 POSITIVE CONTROL: the lookup happened and the gate approved the link
    // LIVE. Without it, a missing anchor after the reload is indistinguishable
    // from a fixture that never grounded anything.
    expect(anchorFor(DREAMSHAPER), 'the tool round never grounded the id').toBeTruthy();

    const writesBefore = transcriptWrites().length;
    // Turn 2 never answers: the viewer asks, and leaves.
    pollFallback = () => pendingSnapshot();
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'anything else?' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(transcriptWrites().length).toBeGreaterThan(writesBefore), {
      timeout: 10_000,
    });

    // 🔴 POSITIVE CONTROL ON THAT WRITE: it really is the second question, and
    // it really does re-serialise turn 1's reply. Otherwise the reload below
    // could be reading a store nothing had rewritten.
    const latest = transcriptWrites().at(-1)!;
    expect(latest.some((m) => m.role === 'user' && m.content === 'anything else?')).toBe(true);
    expect(latest.some((m) => m.role === 'assistant' && m.content.includes('is great'))).toBe(true);

    await reload();
    await waitFor(() => expect(screen.getByText(/is great/)).toBeTruthy());
    expect(
      anchorFor(DREAMSHAPER),
      'the second send cost turn 1 its evidence: the reloaded transcript refuses a link the app approved before the viewer asked again',
    ).toBeTruthy();

    // Let the stranded turn end rather than leaving it polling into the next
    // case. It settles through the catch path, well after every assertion above.
    pollFallback = () => failedSnapshot();
    await new Promise((r) => setTimeout(r, 1200));
  }, 60_000);

  it("🔴 a turn that FAILS after its lookup still records what the catalog returned", async () => {
    // ── THE CATCH / WITHHOLD WRITE SITE. ──────────────────────────────────────
    //
    // The model asked, the catalog answered, and only the final completion
    // failed. `recordGrounded` has already put the id into `groundedBySession`,
    // so the LIVE app honours it for the rest of the session — but the row that
    // gets written carried no `grounded` at all, so storage was strictly weaker
    // than the running app and the next reload lost the lookup entirely.
    //
    // 🔴 NO LEDGER CAN SEE THIS. The errored row is written ONCE, already
    // missing the field, so there is no earlier write to compare it against.
    pollQueue = [toolCallSnapshot(), failedSnapshot()];
    await startChat();
    await send('what is DreamShaper?', /Error: boom/);

    // 🔴 POSITIVE CONTROL ON THE FIXTURE: the tool round genuinely ran, so a
    // missing id below is a lost write and not an absent lookup.
    expect(
      pollFn.mock.calls.length,
      'the turn never reached a second submit, so no tool round happened',
    ).toBeGreaterThanOrEqual(2);

    await reload();

    // A follow-up turn calls NO tool and cites the id turn 1 looked up. After a
    // reload the ONLY thing that can vouch for it is the stored `grounded`.
    pollQueue = twice(
      textSnapshot(`Use [DreamShaper](https://civitai.com/models/${DREAMSHAPER}).`),
    );
    await send('recommend something', /Use/);

    expect(
      anchorFor(DREAMSHAPER),
      'the failed turn dropped the ids its own lookup returned, so the reloaded conversation can no longer vouch for them',
    ).toBeTruthy();
  }, 60_000);

  it('🔴 a turn STOPPED before its reply is durable still records its lookup', async () => {
    // ── `handleStopStream`'s RESCUE TRANSCRIPT. ───────────────────────────────
    //
    // Stop pressed while the turn is still polling leaves `replyPersisted` false
    // and `replyWrite` undefined, so the rescue write is the ONLY write this
    // turn ever makes. It was built from the placeholder plus streamed prose and
    // dropped the catalog ids the turn had already been handed — the Buzz was
    // spent on the lookup and the evidence was thrown away with the answer.
    //
    // 🔴 ALSO INVISIBLE TO THE LEDGER, for the same reason as the case above:
    // one write, already missing the field.
    pollQueue = [toolCallSnapshot()];
    // Everything after the tool round hangs, so the turn is Stoppable with the
    // lookup already banked.
    pollFallback = () => pendingSnapshot();

    await startChat();
    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'what is DreamShaper?' },
    });
    fireEvent.click(screen.getByTestId('send-button'));

    // The tool round has been answered and the SECOND submit is out — i.e.
    // `turnGrounded` holds the id and nothing has written a reply.
    await waitFor(() => expect(submitFn.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 15_000,
    });
    const writesBeforeStop = transcriptWrites().length;

    fireEvent.click(await screen.findByTestId('stop-button'));

    // 🔴 POSITIVE CONTROL ON THE RESCUE: Stop must actually have written. A
    // green assertion over a log Stop never touched would be measuring nothing.
    await waitFor(
      () =>
        expect(
          transcriptWrites().length,
          'Stop wrote nothing, so this case never reached the rescue transcript',
        ).toBeGreaterThan(writesBeforeStop),
      { timeout: 10_000 },
    );

    expect(
      committedGroundedIds(),
      "the stopped turn's rescue write threw away the catalog ids its own lookup had already returned",
    ).toContain(String(DREAMSHAPER));
  }, 60_000);
});
