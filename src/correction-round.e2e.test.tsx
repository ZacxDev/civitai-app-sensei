import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage } from './test-helpers.js';
import { clearCache } from './lib/research.js';
import { claimMessageWrite } from './lib/write-ownership.js';
import { POLL_INTERVAL_MS } from './lib/orchestrator-bridge.js';
import { MAX_CORRECTION_ROUNDS } from './lib/grounding.js';

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 LAYER 2 — THE CORRECTION ROUND, END TO END, THROUGH THE REAL APP.
//
// `lib/grounding.test.ts` proves what `planCorrectionRound` DECIDES. It cannot
// see any of the four things that actually make or break this feature, all of
// which live in the wire between that decision and the send path:
//
//   1. the grounded set the decision is handed. It is accumulated by
//      `recordGrounded`, which is a `setState` — read from React state it would
//      be one render behind, and a turn that correctly looked a model up would
//      be scored ungrounded and CHARGED for being right;
//   2. the cap surviving a real loop. A bound proved in a pure function is a
//      bound the caller is free to ignore;
//   3. the two no-fire cases costing NOTHING. Every firing is a real submit —
//      4 Buzz measured at `maxTokens: 2048` — so a guard that fires always
//      doubles the price of the app and nothing on screen says so;
//   4. abort and supersede. A correction round is an extra `await` inside a turn
//      that can be stopped or overtaken, i.e. a new window in exactly the code
//      four consecutive rounds of abort fixes were spent on.
//
// So every assertion below reads either the SUBMIT COUNT (what was spent), the
// PERSISTED TRANSCRIPT (what the viewer keeps), or the RENDERED DOM (what they
// see) — never an internal.
//
// 🔴 IDS ARE THE REAL MEASURED ONES from the 18-turn seam probe
// (`eval/results/seam-baseline-2026-08-31.json`), pairwise distinct and distinct
// from every constant an assertion below names:
//   4201  Realistic Vision — real, correctly named
//   4384  DreamShaper      — real, correctly named
//   4823                   — 404, NO SUCH MODEL
//   7878  "Detail Tweaker LoRA" — actually Emilia (Re:Zero); the real one is 58390
//   18619                  — 404, NO SUCH MODEL
//   22220 "Face Slider"    — actually CarDos Animated
// ─────────────────────────────────────────────────────────────────────────────

const REALISTIC_VISION = 4201;
const DREAMSHAPER = 4384;
const DEAD_A = 4823;
const EMILIA = 7878;
const DEAD_B = 18619;
const CARDOS = 22220;

/**
 * The measured S6 answer, verbatim — a BARE parenthesised URL inside a list.
 *
 * 🔴 THIS SHAPE IS WHY LAYER 2 EXISTS. It was never a markdown anchor, so Layer
 * 1 had no href to refuse: the false name reached the viewer intact, attached to
 * a real model id that resolves 200 and goes somewhere unrelated.
 */
const S6_VERBATIM =
  `- **Detail Tweaker LoRA** (https://civitai.com/models/${EMILIA}) improves facial features.`;

const h = vi.hoisted(() => ({
  storage: null as ReturnType<typeof fakeAppStorage> | null,
}));

/**
 * 🔴 HOISTED AND STABLE, not a fresh `vi.fn()` per render. `useBlockAnalytics`
 * runs on every render; an inline factory hands every render a new spy, so the
 * events this feature emits would be recorded into an object nobody can read —
 * and the observability assertions would pass vacuously against zero calls.
 */
const trackFn = vi.fn();

const estimateFn = vi
  .fn()
  .mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } });

/** Bodies as submitted, in order. A submit is the BILLED event — count these. */
let submittedBodies: Array<{ params: { messages: Array<Record<string, unknown>> } }> = [];
const submitFn = vi.fn(async (body: unknown) => {
  submittedBodies.push(body as { params: { messages: Array<Record<string, unknown>> } });
  return { workflowId: `wf-${submittedBodies.length}`, status: 'pending' };
});

/**
 * One snapshot per poll, in order — the same driver `citation-grounding.e2e`
 * uses, so round N's reply is chosen by the test rather than by timing.
 *
 * `holdFromSubmit` freezes the workflow: once that many submits have been made,
 * every poll answers `pending` forever. That is what makes "abort DURING the
 * correction round" a structural state rather than a race — the turn is parked
 * inside the extra `await` this feature adds, and stays there until the test
 * releases it.
 */
let pollQueue: Array<Record<string, unknown>> = [];
let holdFromSubmit: number | null = null;
const pollFn = vi.fn(async () => {
  if (holdFromSubmit !== null && submitFn.mock.calls.length >= holdFromSubmit) {
    return { workflowId: 'wf-held', status: 'pending' };
  }
  const next = pollQueue.shift();
  return (
    next ?? { workflowId: 'wf-x', status: 'succeeded', cost: { total: 1 }, textOutputs: ['done'] }
  );
});

vi.mock('@civitai/blocks-react', () => ({
  useAppStorage: () => h.storage!.appStorage,
  useBlockAnalytics: () => ({ track: trackFn }),
  useBlockContext: () => ({ ready: true, viewer: { id: 1 }, theme: 'dark' }),
  useBlockResize: () => {},
  useRequestConsent: () => ({ requestConsent: vi.fn() }),
  useRequestSignIn: () => ({ requestSignIn: vi.fn() }),
  useResourcePicker: () => ({ open: vi.fn().mockResolvedValue(null) }),
  useBlockToken: () => ({ raw: 'block-jwt-test', scopes: ['ai:write:budgeted', 'buzz:read:self'] }),
  useBuzzBalance: () => ({ balance: { blue: 100, green: 0, yellow: 200 } }),
  useBuzzWorkflow: () => ({
    estimate: estimateFn,
    submit: submitFn,
    poll: pollFn,
    cancel: vi.fn().mockResolvedValue(undefined),
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

/** What the next POST /tools returns — i.e. what the catalog actually grounds. */
let toolItems: Array<Record<string, unknown>> = [];

function toolCallSnapshot() {
  return {
    workflowId: 'wf-tc',
    status: 'succeeded',
    cost: { total: 1 },
    toolCalls: [
      {
        id: 'call_abc',
        type: 'function',
        function: { name: 'search_models', arguments: JSON.stringify({ query: 'faces' }) },
      },
    ],
  };
}

function textSnapshot(text: string) {
  return { workflowId: 'wf-t', status: 'succeeded', cost: { total: 1 }, textOutputs: [text] };
}

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

/** The rendered anchor for a model id, or null when Layer 1 refused it. */
function anchorFor(id: number): HTMLAnchorElement | null {
  return document.querySelector<HTMLAnchorElement>(`a[href*="/models/${id}"]`);
}

interface StoredRow {
  role: string;
  content: string;
  correction?: { rounds: number; resolved: boolean };
}

/** Every write to a session's message key, oldest first. */
function messageWrites(): StoredRow[][] {
  return h
    .storage!.sets.filter((s) => s.key.startsWith('sensei:messages:'))
    .map((s) => s.value as StoredRow[]);
}

/** The session id the app is writing under — read off the key it actually used. */
function writtenSessionId(): string {
  const key = h.storage!.sets.map((s) => s.key).find((k) => k.startsWith('sensei:messages:'));
  expect(key, 'the app must have written a message key by now').toBeTruthy();
  return key!.slice('sensei:messages:'.length);
}

/** The last persisted transcript, or `[]` if nothing was ever written. */
function lastTranscript(): StoredRow[] {
  const writes = messageWrites();
  return writes.length > 0 ? writes[writes.length - 1] : [];
}

/** The correction record on the stored assistant turn, if any. */
function storedCorrection(): { rounds: number; resolved: boolean } | undefined {
  const assistant = [...lastTranscript()].reverse().find((m) => m.role === 'assistant');
  return assistant?.correction;
}

function trackedNames(): string[] {
  return trackFn.mock.calls.map((c) => c[0] as string);
}

async function startChat() {
  render(<App />);
  await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
  fireEvent.click(screen.getByTestId('new-session-button'));
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
}

/**
 * Type and send; resolves once the reply is on screen AND the turn has settled.
 *
 * 🔴 `expectInReply` MUST MATCH ONE CONTIGUOUS TEXT NODE. `MarkdownText` renders
 * a link as its own element, so `Try [X](url) for portraits.` reaches the DOM as
 * three siblings and a regex spanning the anchor matches NOTHING — which
 * presents as a 5-second timeout that reads exactly like the feature hanging.
 * Every fixture below therefore ends in a plain-text clause and this matches
 * that clause.
 */
async function send(question: string, expectInReply: RegExp) {
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: question } });
  fireEvent.click(screen.getByTestId('send-button'));
  await waitFor(() => expect(screen.getByText(expectInReply)).toBeTruthy(), { timeout: 8000 });
  await waitFor(() => expect(screen.queryByTestId('streaming-indicator')).toBeNull(), {
    timeout: 8000,
  });
}

/** Wait out enough poll ticks for a released workflow to be observed. */
async function letPollsTick(multiple = 3) {
  const bound = POLL_INTERVAL_MS * multiple;
  for (let waited = 0; waited < bound; waited += 50) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Layer 2 — the correction round', () => {
  beforeEach(() => {
    h.storage = fakeAppStorage();
    pollQueue = [];
    toolItems = [];
    holdFromSubmit = null;
    submittedBodies = [];
    submitFn.mockClear();
    pollFn.mockClear();
    trackFn.mockClear();
    clearCache();
    installFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── THE NO-FIRE CASES. These are the COST assertions. ─────────────────────

  it('🔴 does NOT fire when the reply cites nothing — one submit, no extra Buzz', async () => {
    pollQueue = [textSnapshot('Lower the CFG to about 4 and raise your step count.')];
    await startChat();
    await send('how do I get sharper output?', /raise your step count/);

    // 🔴 ONE submit. Not "at most a few" — the exact billed count, because the
    // whole risk of this feature is a guard that quietly fires on every turn.
    expect(submitFn).toHaveBeenCalledTimes(1);
    expect(trackedNames()).not.toContain('grounding_correction_round');
    expect(storedCorrection()).toBeUndefined();
  });

  it('🔴 does NOT fire when EVERY citation is grounded — the lookup already worked', async () => {
    toolItems = [{ id: DREAMSHAPER, name: 'DreamShaper', type: 'Checkpoint' }];
    pollQueue = [
      toolCallSnapshot(),
      textSnapshot(
        `Try [DreamShaper](https://civitai.com/models/${DREAMSHAPER}) for portrait work.`,
      ),
    ];
    await startChat();
    await send('what should I use?', /for portrait work/);

    // Two submits: the tool round and the answer. A THIRD would mean Layer 2
    // charged the viewer for correcting a citation the catalog itself returned —
    // and this is the case only an accumulated, same-tick grounded set can get
    // right, because `recordGrounded` has not committed to React state yet.
    expect(submitFn).toHaveBeenCalledTimes(2);
    expect(trackedNames()).not.toContain('grounding_correction_round');
    expect(storedCorrection()).toBeUndefined();
    // Positive control on the fixture: the id really was grounded, so this whole
    // case is not satisfied by an app that renders nothing.
    expect(anchorFor(DREAMSHAPER)).toBeTruthy();
  });

  // ── THE FIRING CASES. ──────────────────────────────────────────────────────

  it('🔴 fires on the measured S6 answer and the corrected reply GETS a live link', async () => {
    // No tool round on the first submit — the exact measured posture: the model
    // names a model from memory and cites a real id under the wrong name.
    pollQueue = [
      textSnapshot(S6_VERBATIM),
      // The correction told it to look the model up, so it does.
      toolCallSnapshot(),
      textSnapshot(
        `Use [CarDos Animated](https://civitai.com/models/${CARDOS}) — that one I verified.`,
      ),
    ];
    toolItems = [{ id: CARDOS, name: 'CarDos Animated', type: 'Checkpoint' }];

    await startChat();
    await send('how do I improve faces?', /that one I verified/);

    // Three submits: the original, the correction, and the answer after the tool
    // round the correction asked for.
    expect(submitFn).toHaveBeenCalledTimes(3);
    // 🔴 THE POINT OF THE WHOLE FEATURE, on screen: an answer that had a false
    // name and a dead-end link now has a real, grounded, clickable one.
    expect(anchorFor(CARDOS)).toBeTruthy();
    // And the invented name is gone from the settled bubble.
    expect(screen.queryByText(/Detail Tweaker LoRA/)).toBeNull();
    expect(storedCorrection()).toEqual({ rounds: 1, resolved: true });
    expect(trackedNames()).toContain('grounding_correction_round');
  });

  it('a corrected reply that DROPS the model reference also counts as resolved', async () => {
    // The other permitted out. Nothing was looked up, so nothing can be linked —
    // saying so is a correct answer, and must not be recorded as a failure.
    pollQueue = [
      textSnapshot(`See [Deliberate](https://civitai.com/models/${DEAD_A}).`),
      textSnapshot('I could not verify that model, so I will not name an id for it.'),
    ];
    await startChat();
    await send('what about Deliberate?', /could not verify that model/);

    expect(submitFn).toHaveBeenCalledTimes(2);
    expect(storedCorrection()).toEqual({ rounds: 1, resolved: true });
  });

  // ── THE CAP. ───────────────────────────────────────────────────────────────

  it('🔴 CAPS AT ONE RETRY when the model returns ungrounded text every single time', async () => {
    // 🔴 THE QUEUE IS DELIBERATELY LONGER THAN THE CAP AND THE FALLBACK IS
    // UNGROUNDED TOO. `pollFn`'s default when the queue empties is the string
    // "done", which cites nothing — so a runaway loop would silently CONVERGE
    // and this test would pass over an unbounded feature. Six ungrounded replies
    // are queued so that an off-by-one, an `=== cap` comparison, or a caller
    // that ignores the plan all keep spending and are seen doing it.
    const ungrounded = [DEAD_A, DEAD_B, EMILIA, CARDOS, REALISTIC_VISION, DREAMSHAPER];
    pollQueue = ungrounded.map((id) =>
      textSnapshot(`Definitely [some model](https://civitai.com/models/${id}) for that job.`),
    );
    await startChat();
    await send('recommend something', /for that job/);

    // ONE original + ONE correction. Never a third.
    expect(submitFn).toHaveBeenCalledTimes(1 + MAX_CORRECTION_ROUNDS);
    // 🔴 AND IT IS RECORDED AS A FAILURE, not quietly swallowed. `resolved:false`
    // is what says "we spent the viewer's Buzz and it did not work" — the number
    // that decides whether this feature keeps earning its cost.
    expect(storedCorrection()).toEqual({ rounds: 1, resolved: false });
    // Layer 1 is the backstop, exactly as designed: the second id is still
    // ungrounded, so it renders as text with no href.
    expect(anchorFor(DEAD_B)).toBeNull();
    // The reply is still shown. A capped correction must not delete prose the
    // viewer was charged for.
    expect(screen.getByText(/for that job/)).toBeTruthy();
  });

  // ── THE WIRE SHAPE. ────────────────────────────────────────────────────────

  it('🔴 the corrective turn is a `user` message after an `assistant` echo, and costs NO tool slot', async () => {
    pollQueue = [textSnapshot(S6_VERBATIM), textSnapshot('Understood — no id for that one.')];
    await startChat();
    await send('how do I improve faces?', /no id for that one/);

    expect(submittedBodies.length).toBe(2);
    const corrective = submittedBodies[1].params.messages;
    const [echo, instruction] = corrective.slice(-2);

    // 🔴 THE ECHO. Without it the corrective user turn follows the previous USER
    // turn with nothing between, so "your previous answer said X" refers to a
    // message the model was never shown.
    expect(echo.role).toBe('assistant');
    expect(echo.content).toContain('Detail Tweaker LoRA');

    // 🔴 `user`, NOT `tool`. A `role:'tool'` message requires a `tool_call_id`
    // correlated to an id a PRECEDING assistant turn declared — and in this
    // posture the model made no tool call at all, so no such id exists.
    expect(instruction.role).toBe('user');
    expect(instruction.tool_call_id).toBeUndefined();
    expect(String(instruction.content)).toContain(String(EMILIA));

    // 🔴 AND IT SPENDS NOTHING FROM `MAX_TOOL_RESULT_MESSAGES`. The host counts
    // `role:'tool'` messages in a `.superRefine` and BAD_REQUESTs the payload
    // past 3; a corrective round that consumed one would silently take a lookup
    // away from the answer it is asking for.
    const toolMessagesBefore = submittedBodies[0].params.messages.filter(
      (m) => m.role === 'tool',
    ).length;
    const toolMessagesAfter = corrective.filter((m) => m.role === 'tool').length;
    expect(toolMessagesAfter).toBe(toolMessagesBefore);
  });

  // ── ABORT AND SUPERSEDE. ───────────────────────────────────────────────────

  it('🔴 Stop DURING the correction round does not resurrect the turn', async () => {
    // The turn parks inside the extra `await` this feature adds: submit #2 is
    // the correction, and its workflow never settles.
    pollQueue = [textSnapshot(S6_VERBATIM)];
    holdFromSubmit = 2;

    await startChat();
    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'how do I improve faces?' },
    });
    fireEvent.click(screen.getByTestId('send-button'));

    // Wait until the correction has actually been submitted — otherwise Stop
    // lands before the window exists and the test proves nothing about it.
    await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(2), { timeout: 8000 });

    fireEvent.click(await screen.findByTestId('stop-button'));
    // Let the bridge observe the abort on its next tick and unwind the turn.
    await letPollsTick();

    // 🔴 NO THIRD SUBMIT. A stopped turn must not spend again, and the correction
    // loop is a new place that could.
    expect(submitFn).toHaveBeenCalledTimes(2);
    // 🔴 NO HALF STATE PERSISTED. Stop writes the prose the viewer was CHARGED
    // for — the ungrounded reply — and the correction record is absent, because
    // the correction never completed. Recording it would claim an outcome that
    // was never observed.
    expect(storedCorrection()).toBeUndefined();
    // 🔴 BUT THE FIRING IS STILL COUNTED. The correction submit was billed the
    // moment it was made; a stopped turn that hid the spend would make the
    // fire-rate systematically under-report exactly the turns that cost most.
    expect(trackedNames()).toContain('grounding_correction_round');
    expect(trackedNames()).not.toContain('grounding_correction_result');
  });

  it('🔴 a turn SUPERSEDED during the correction round discards its reply', async () => {
    // Superseded WITHOUT ever being aborted — the case no abort predicate can
    // see. `claimMessageWrite` is the module-scoped ticket a remounted instance
    // takes; calling it here is exactly what that instance would do, without
    // needing to stage an unmount.
    pollQueue = [textSnapshot(S6_VERBATIM)];
    holdFromSubmit = 2;

    await startChat();
    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'how do I improve faces?' },
    });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(2), { timeout: 8000 });

    // Somebody newer owns this session's transcript now.
    claimMessageWrite(writtenSessionId());
    const writesBefore = messageWrites().length;

    // Release the correction: the turn finishes normally and tries to write.
    pollQueue = [textSnapshot('Corrected: no id for that one.')];
    holdFromSubmit = null;
    await letPollsTick(4);

    await waitFor(() => expect(trackedNames()).toContain('reply_discarded_superseded'), {
      timeout: 8000,
    });
    // 🔴 THE WRITE IS THE THING. A superseded turn's corrected reply must not
    // reach storage over a newer writer's array — the loss measured on the live
    // store, arriving through the new `await` instead of the old one.
    expect(messageWrites().length).toBe(writesBefore);
    expect(
      lastTranscript().some((m) => m.content.includes('Corrected: no id for that one')),
      'the superseded turn must not have persisted its corrected reply',
    ).toBe(false);
  });
});
