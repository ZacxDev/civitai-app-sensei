import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { App } from './App.js';
import {
  fakeAppStorage,
  BLOCK_GENERATION_RESOURCE,
  BLOCK_GENERATION_RESOURCE_LOCON,
} from './test-helpers.js';
import { clearCache } from './lib/research.js';
import { MENTION_TOOL_CALL_ID, MENTION_TOOL_NAME } from './lib/mentions.js';
import { MAX_TOOL_RESULT_MESSAGES } from './lib/tools.js';

// ─────────────────────────────────────────────────────────────────────────────
// clawgate #434, criterion 3 — MENTION A RESOURCE, ANSWER IN ONE ROUND.
//
// 🔴 THIS SUITE ASSERTS ON THE CONSTRUCTED REQUEST BODY, NOT ON THE SCREEN,
// inherited from `tool-calling.e2e.test.tsx` for the same reason: "the answer
// mentioned the model" is satisfied by a model that hallucinated it. The only
// thing that distinguishes pre-filled grounding from a confident invention is
// what was actually PUT ON THE WIRE.
//
// 🔴 AND THE WIRE SHAPE IT PINS WAS PROBED AGAINST THE LIVE ORCHESTRATOR before
// any of this was written (2026-08-30), because the host ACCEPTING a payload is
// not the provider EXECUTING it — a gap this arc has already paid for once
// (`tool_choice` vs `toolChoice`, 0.1.6, asserted correct by two tests and a
// fixture type). In this exact shape — `tools` declaring only `search_models`
// while the synthetic call names `attached_resources` — deepseek/deepseek-chat
// and openai/gpt-4o-mini both answered from the pre-filled content in ONE
// round, `finishReason: 'stop'`. The control arm (synthetic pair removed, same
// question) was decisive rather than merely different: deepseek came back
// `finishReason: 'tool_calls'` re-calling `search_models`, which is precisely
// the second charged round this feature exists to remove.
// ─────────────────────────────────────────────────────────────────────────────

interface SubmittedParams {
  model: string;
  messages: Array<{
    role: string;
    content?: string;
    tool_call_id?: string;
    tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  }>;
  tools?: Array<{ type: string; function: { name: string } }>;
  toolChoice?: string;
}

const submitted: SubmittedParams[] = [];
let pollQueue: Array<Record<string, unknown>> = [];
let toolPosts: Array<{ name: string }> = [];

// 🔴 HOISTED, SO THE HOOKS RETURN A STABLE IDENTITY ACROSS RENDERS — and that
// is a CORRECTNESS requirement of the fixture, not tidiness. Returning a fresh
// `vi.fn()` from `useRequestConsent`/`useRequestSignIn` on every render makes
// `raiseGate` a new function every render, which makes `handleSend` a new
// function every render, which SILENTLY REPAIRS any missing entry in
// `handleSend`'s dependency array. A stale-closure bug is then invisible to
// every suite in this repo while being live in production, where the real SDK's
// callbacks are stable. Measured: with fresh identities, omitting
// `pendingMentions` from those deps passed this whole file; with stable ones it
// fails with "expected +0 to be greater than or equal to 1" — the attachment
// never reaches the wire.
// `viewer` too: `useBlockContext` returning a fresh `{ id: 1 }` each render is
// the same hazard one level up — `raiseGate` depends on `viewer` IDENTITY.
const VIEWER = { id: 1 };
const requestConsentFn = vi.fn();
const openPickerFn = async (opts: Record<string, unknown>) => {
  pickerCalls.push(opts);
  return pickerResult;
};
const requestSignInFn = vi.fn();

/** What the HOST's picker resolves with. `null` models a dismissal. */
let pickerResult: { versionId: number } | null = null;
/** Every `open()` argument, so the host-chrome boundary can be read off it. */
let pickerCalls: Array<Record<string, unknown>> = [];
/** Ids the resolve endpoint will return. Anything else is DROPPED, as the clamp does. */
let resolvable = [BLOCK_GENERATION_RESOURCE, BLOCK_GENERATION_RESOURCE_LOCON];
let resolveCalls: string[] = [];

let storage = fakeAppStorage();

const estimateFn = vi
  .fn()
  .mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } });
const submitFn = vi.fn(async (body: { params?: Record<string, unknown> }) => {
  if (body?.params) submitted.push(body.params as unknown as SubmittedParams);
  return { workflowId: `wf-${submitted.length}`, status: 'pending' };
});
const pollFn = vi.fn(async () => {
  const next = pollQueue.shift();
  return next ?? { workflowId: 'wf-x', status: 'succeeded', cost: { total: 1 }, textOutputs: ['done'] };
});

vi.mock('@civitai/blocks-react', () => ({
  useAppStorage: () => storage.appStorage,
  useBlockAnalytics: () => ({ track: vi.fn() }),
  useBlockContext: () => ({ ready: true, viewer: VIEWER, theme: 'dark' }),
  useBlockResize: () => {},
  useRequestConsent: () => ({ requestConsent: requestConsentFn }),
  useRequestSignIn: () => ({ requestSignIn: requestSignInFn }),
  useBlockToken: () => ({ raw: 'block-jwt-test', scopes: ['ai:write:budgeted', 'buzz:read:self'] }),
  useBuzzBalance: () => ({ balance: { blue: 100, green: 0, yellow: 200 } }),
  // Stable for the same reason as the two above.
  useResourcePicker: () => ({ open: openPickerFn }),
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

function textSnapshot(text: string) {
  return { workflowId: 'wf-t', status: 'succeeded', cost: { total: 1 }, textOutputs: [text] };
}

function toolCallSnapshot(id: string, query: string) {
  return {
    workflowId: `wf-${id}`,
    status: 'succeeded',
    cost: { total: 1 },
    toolCalls: [
      { id, type: 'function', function: { name: 'search_models', arguments: JSON.stringify({ query }) } },
    ],
  };
}

let originalFetch: typeof globalThis.fetch;

function installFetch() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';

    if (url.includes('/api/v1/blocks/generation-resources')) {
      resolveCalls.push(url);
      const asked = new URL(url).searchParams.get('ids')!.split(',').map(Number);
      // 🔴 MODELS THE CLAMP: an id this fixture cannot resolve is simply ABSENT
      // from `items`, exactly as the endpoint drops a resource failing
      // `hasAccess` or exceeding the token's browsing ceiling. It does NOT 404.
      const items = resolvable.filter((r) => asked.includes(r.versionId));
      return new Response(JSON.stringify({ items, maturity: { browsingLevel: 1, sfwOnly: true } }), {
        status: 200,
      });
    }
    if (url.includes('/api/v1/blocks/tools')) {
      if (method === 'GET') return new Response(JSON.stringify({ tools: DECLARATIONS }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { name: string };
      toolPosts.push({ name: body.name });
      return new Response(
        JSON.stringify({ items: [{ id: 1, name: 'Searched Thing' }], truncated: 0 }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof globalThis.fetch;
}

async function startSession() {
  render(<App />);
  await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
  fireEvent.click(screen.getByTestId('new-session-button'));
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
}

async function attach(type: string, versionId: number) {
  pickerResult = { versionId };
  fireEvent.click(screen.getByTestId('add-mention-button'));
  fireEvent.click(screen.getByTestId(`mention-type-${type}`));
  await waitFor(() => expect(pickerCalls.length).toBeGreaterThan(0));
}

async function send(text: string, expectSubmits = 1) {
  // 🔴 WAIT FOR THE COMPOSER TO BE IDLE FIRST. While a turn streams, `ChatArea`
  // renders Stop in place of Send — a second `send()` that does not wait fails
  // with "unable to find send-button", which reads as a missing control rather
  // than as a still-running turn.
  await waitFor(() => expect(screen.getByTestId('send-button')).toBeTruthy(), { timeout: 8000 });
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('send-button'));
  await waitFor(() => expect(submitted.length).toBeGreaterThanOrEqual(expectSubmits), {
    timeout: 8000,
  });
}

const A = BLOCK_GENERATION_RESOURCE;
const B = BLOCK_GENERATION_RESOURCE_LOCON;

beforeEach(() => {
  submitted.length = 0;
  pollQueue = [];
  toolPosts = [];
  pickerCalls = [];
  pickerResult = null;
  resolveCalls = [];
  resolvable = [A, B];
  storage = fakeAppStorage();
  submitFn.mockClear();
  pollFn.mockClear();
  clearCache();
  installFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the pick — host chrome, and nothing but a type crosses the boundary', () => {
  it('asks the HOST to open its own picker for the chosen type', async () => {
    await startSession();
    await attach('LoCon', B.versionId);

    expect(pickerCalls).toHaveLength(1);
    // 🔴 THE BOUNDARY, READ OFF THE CALL. The block sends a TYPE and nothing
    // else: no query, no browsing level, no sfw flag, no candidate list. The
    // viewer searches in host chrome and the host posts back ONE resource. An
    // extra key here is the iframe starting to drive the catalog.
    expect(Object.keys(pickerCalls[0])).toEqual(['resourceType']);
    expect(pickerCalls[0].resourceType).toBe('LoCon');
  });

  it('resolves the pick through the maturity-clamped endpoint, by id only', async () => {
    await startSession();
    await attach('Checkpoint', A.versionId);
    await waitFor(() => expect(resolveCalls).toHaveLength(1));

    expect(resolveCalls[0]).toContain('/api/v1/blocks/generation-resources?ids=');
    expect([...new URL(resolveCalls[0]).searchParams.keys()]).toEqual(['ids']);
    // Never the search endpoints — those would put a catalog LIST in the iframe.
    expect(resolveCalls[0]).not.toContain('/blocks/models');
  });

  it('renders the RESOLVED resource as a removable chip on the composer', async () => {
    await startSession();
    await attach('Checkpoint', A.versionId);

    const chip = await screen.findByTestId(`mention-${A.versionId}`);
    // Built from the resolve response, not from the picker's own copy.
    expect(chip.textContent).toContain(A.modelName);
    expect(chip.textContent).toContain(A.versionName);
    expect(chip.textContent).toContain(A.baseModel);

    fireEvent.click(screen.getByTestId(`remove-mention-${A.versionId}`));
    await waitFor(() => expect(screen.queryByTestId(`mention-${A.versionId}`)).toBeNull());
  });

  it('a dismissed picker attaches nothing and reports nothing', async () => {
    await startSession();
    pickerResult = null;
    fireEvent.click(screen.getByTestId('add-mention-button'));
    fireEvent.click(screen.getByTestId('mention-type-Checkpoint'));
    await waitFor(() => expect(pickerCalls).toHaveLength(1));

    expect(resolveCalls).toHaveLength(0);
    expect(screen.queryByTestId('pending-mentions')).toBeNull();
    expect(screen.queryByTestId('mention-error')).toBeNull();
  });

  it('🔴 a resource the CLAMP withheld is refused, never synthesised from the pick', async () => {
    // The endpoint drops what the token may not see. Building a chip from the
    // picker's own name would show the viewer exactly the value the clamp
    // withheld — so the app must say it could not attach it.
    await startSession();
    resolvable = []; // the clamp releases nothing
    await attach('Checkpoint', A.versionId);

    await waitFor(() => expect(screen.getByTestId('mention-error')).toBeTruthy());
    expect(screen.queryByTestId(`mention-${A.versionId}`)).toBeNull();
    expect(screen.queryByTestId('pending-mentions')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the wire — a pre-filled tool result, batched, correlated and ordered', () => {
  it('🔴 puts exactly ONE role:"tool" message on the wire for N mentions', async () => {
    await startSession();
    await attach('Checkpoint', A.versionId);
    await screen.findByTestId(`mention-${A.versionId}`);
    await attach('LoCon', B.versionId);
    await screen.findByTestId(`mention-${B.versionId}`);

    pollQueue = [textSnapshot('Grounded answer.')];
    await send('Compare these two.');

    const msgs = submitted[0].messages;
    const toolMsgs = msgs.filter((m) => m.role === 'tool');
    // The host counts these against MAX_TOOL_ROUNDS (3) with a bare filter and
    // no provenance test. Two mentions must still cost ONE slot.
    expect(toolMsgs).toHaveLength(1);
    // …and both resources are inside that one message.
    const payload = JSON.parse(toolMsgs[0].content!) as { items: Array<{ versionId: number }> };
    expect(payload.items.map((r) => r.versionId)).toEqual([A.versionId, B.versionId]);
  });

  it('🔴 the assistant tool_calls turn PRECEDES the result and declares its id', async () => {
    await startSession();
    await attach('Checkpoint', A.versionId);
    await screen.findByTestId(`mention-${A.versionId}`);

    pollQueue = [textSnapshot('Grounded answer.')];
    await send('What is this?');

    const msgs = submitted[0].messages;
    const toolIdx = msgs.findIndex((m) => m.role === 'tool');
    const askIdx = msgs.findIndex((m) => m.tool_calls?.some((c) => c.id === MENTION_TOOL_CALL_ID));

    expect(askIdx).toBeGreaterThanOrEqual(0);
    // The host builds `declaredCallIds` in ITERATION ORDER, so this is an
    // ordering requirement, not a membership one.
    expect(askIdx).toBeLessThan(toolIdx);
    expect(msgs[askIdx].role).toBe('assistant');
    expect(msgs[toolIdx].tool_call_id).toBe(MENTION_TOOL_CALL_ID);
    expect(msgs[askIdx].tool_calls![0].function.name).toBe(MENTION_TOOL_NAME);
  });

  it('the synthetic pair sits AFTER the user turn it grounds', async () => {
    await startSession();
    await attach('Checkpoint', A.versionId);
    await screen.findByTestId(`mention-${A.versionId}`);

    pollQueue = [textSnapshot('Grounded answer.')];
    await send('What is this?');

    const msgs = submitted[0].messages;
    const userIdx = msgs.findIndex((m) => m.role === 'user' && m.content === 'What is this?');
    const askIdx = msgs.findIndex((m) => m.tool_calls?.some((c) => c.id === MENTION_TOOL_CALL_ID));
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(askIdx).toBeGreaterThan(userIdx);
    // System prompt first, as always.
    expect(msgs[0].role).toBe('system');
  });

  it('🔴 answers in ONE round — one submit, and search_models is never called', async () => {
    // The whole argument for pre-filling. Measured against the live provider in
    // both arms: without the pair, deepseek re-called `search_models` (a second
    // charged round); with it, both models answered `stop` in one.
    await startSession();
    await attach('Checkpoint', A.versionId);
    await screen.findByTestId(`mention-${A.versionId}`);

    pollQueue = [textSnapshot('Grounded answer.')];
    await send('What is this?');
    await waitFor(() => expect(screen.getByText('Grounded answer.')).toBeTruthy());

    expect(submitted).toHaveLength(1);
    expect(toolPosts).toHaveLength(0);
  });

  it('a turn with NO mentions puts no tool message on the wire at all', async () => {
    // NEGATIVE CONTROL for every assertion above: the synthetic pair must not
    // appear when nothing was attached, or it would burn a round slot for no
    // grounding on every ordinary message.
    await startSession();
    pollQueue = [textSnapshot('Plain answer.')];
    await send('Just a question.');

    const msgs = submitted[0].messages;
    expect(msgs.filter((m) => m.role === 'tool')).toHaveLength(0);
    expect(msgs.some((m) => m.tool_calls)).toBe(false);
  });

  it('🔴 an EARLIER turn’s mentions are not replayed on a later turn', async () => {
    // The host's cap is PER PAYLOAD. Replaying history's attachments would
    // spend one slot per mentioned turn — silencing tool calling on the third
    // and BAD_REQUESTing the fourth — for grounding already in the transcript.
    await startSession();
    await attach('Checkpoint', A.versionId);
    await screen.findByTestId(`mention-${A.versionId}`);

    pollQueue = [textSnapshot('First answer.')];
    await send('What is this?');
    await waitFor(() => expect(screen.getByText('First answer.')).toBeTruthy());

    pollQueue = [textSnapshot('Second answer.')];
    await send('And what about training it?', 2);

    const second = submitted[1].messages;
    expect(second.filter((m) => m.role === 'tool')).toHaveLength(0);
    expect(second.some((m) => m.tool_calls)).toBe(false);
    // POSITIVE CONTROL: the first submit really did carry one, so the zero
    // above is a fact about replay rather than about the fixture.
    expect(submitted[0].messages.filter((m) => m.role === 'tool')).toHaveLength(1);
  });

  it('🔴 the pre-filled result COUNTS against the round cap, leaving 2 real rounds', async () => {
    // Seeding the loop's counter from 0 rather than from the payload would let
    // three real rounds stack on top of the synthetic one — FOUR tool messages
    // and a BAD_REQUEST on the last submit, after the viewer had paid for the
    // rounds that got there.
    await startSession();
    await attach('Checkpoint', A.versionId);
    await screen.findByTestId(`mention-${A.versionId}`);

    pollQueue = [
      toolCallSnapshot('call_1', 'first'),
      toolCallSnapshot('call_2', 'second'),
      toolCallSnapshot('call_3', 'third'),
      textSnapshot('never reached'),
    ];
    await send('Dig into this.');

    await waitFor(() => expect(screen.getByText(/could not finish that/i)).toBeTruthy(), {
      timeout: 8000,
    });

    // Every submitted payload stays at or under the host's cap.
    for (const params of submitted) {
      expect(params.messages.filter((m) => m.role === 'tool').length).toBeLessThanOrEqual(
        MAX_TOOL_RESULT_MESSAGES,
      );
    }
    // And the mention really did consume one of the three: only 2 real rounds
    // ran before the cap stopped it.
    expect(toolPosts).toHaveLength(2);
  });

  it('🔴 seeds the round counter from what REACHES THE WIRE, not from the app-side array', async () => {
    // The host counts `role:'tool'` messages in the array it RECEIVES. The app
    // counted them in `apiMessages`, which is the array BEFORE `toStepMessages`
    // — and `toStepMessages` drops any `role:'tool'` message with no
    // `tool_call_id`, which is exactly the shape `handleSend` produces when it
    // maps stored history (`.map(m => ({ role, content }))` discards the id).
    // So the app could count messages the wire never carried and refuse a real
    // tool call that the host would have accepted, telling the viewer they had
    // asked for too many lookups when the payload carried none.
    //
    // ⚠️ SCOPE, STATED PLAINLY: this is a SEED-CONTRACT guard, not a proven
    // production regression. No shipped build of this app has ever PERSISTED a
    // `role:'tool'` message — 0.1.0 put them in React state only, and its
    // `appendMessage` read from storage rather than from state — so the input
    // below is a state the code defends against (`deserializeMessages` casts it
    // through, `ChatArea` renders it as nothing, `toStepMessages` drops it) but
    // that nothing is known to produce. It is written this way because it is
    // the only input that can distinguish the two counts.
    const sessionId = 'sess-with-stored-tool-messages';
    storage = fakeAppStorage({
      'sensei:sessions': {
        sessions: [
          {
            id: sessionId,
            title: 'Legacy chat',
            model: 'deepseek/deepseek-chat',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
      [`sensei:messages:${sessionId}`]: [
        { id: 'm1', role: 'user', content: 'an earlier question', timestamp: 1 },
        // Three of them — enough to exhaust MAX_TOOL_RESULT_MESSAGES (3) on its
        // own. None carries a `tool_call_id`, so none reaches the host.
        { id: 'm2', role: 'tool', content: '{"items":[]}', timestamp: 2 },
        { id: 'm3', role: 'tool', content: '{"items":[]}', timestamp: 3 },
        { id: 'm4', role: 'tool', content: '{"items":[]}', timestamp: 4 },
        { id: 'm5', role: 'assistant', content: 'an earlier answer', timestamp: 5 },
      ],
    });

    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    pollQueue = [toolCallSnapshot('call_1', 'first'), textSnapshot('Answered.')];
    await send('What is this?');
    // The turn settles either way — the pre-fix path refuses immediately with
    // the cap notice — so wait for the composer rather than for an outcome.
    await waitFor(() => expect(screen.getByTestId('send-button')).toBeTruthy(), { timeout: 8000 });

    // POSITIVE CONTROL, and the whole point: the FIRST submit carried ZERO
    // `role:'tool'` messages, because `toStepMessages` dropped all three. A
    // counter seeded from the wire therefore starts at 0 and the round is free.
    expect(submitted[0].messages.filter((m) => m.role === 'tool')).toHaveLength(0);
    // …so the one real round actually ran.
    expect(toolPosts).toHaveLength(1);
    // …and the viewer was never told they had asked for too many lookups.
    expect(screen.queryByText(/needed more lookups at once/i)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('composer state belongs to ONE conversation — every route that moves activeSessionId', () => {
  // The #427 class in the composer axis: state that belongs to the conversation
  // being composed, leaking across a switch. `createSession` already cleared it
  // and said why ("carrying them across would silently ground a question the
  // viewer has not asked yet") — and that reasoning applies verbatim to the two
  // OTHER routes that move `activeSessionId`. Fixed at the ONE place the id
  // moves rather than at each caller, because `deleteSession` is exactly the
  // route a per-call-site fix forgets.

  async function twoSessions() {
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
    // A second, so there is something to switch TO.
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getAllByTestId(/^session-item/).length).toBe(2));
  }

  it('🔴 SELECTING another session drops the attachments', async () => {
    await twoSessions();
    await attach('Checkpoint', A.versionId);
    await screen.findByTestId(`mention-${A.versionId}`);

    // Switch to the OTHER session (the newest is active, so pick the older one).
    const items = screen.getAllByTestId(/^session-item/);
    fireEvent.click(items[1]);

    await waitFor(() => expect(screen.queryByTestId('pending-mentions')).toBeNull());
    expect(screen.queryByTestId(`mention-${A.versionId}`)).toBeNull();
  });

  it('🔴 DELETING the active session drops the attachments', async () => {
    // The route a per-call-site fix forgets: it moves `activeSessionId` to
    // `next[0]` without ever being a switcher click.
    await twoSessions();
    await attach('Checkpoint', A.versionId);
    await screen.findByTestId(`mention-${A.versionId}`);

    const del = screen.getAllByTestId(/^delete-session/)[0];
    fireEvent.click(del);

    await waitFor(() => expect(screen.getAllByTestId(/^session-item/).length).toBe(1));
    await waitFor(() => expect(screen.queryByTestId('pending-mentions')).toBeNull());
  });

  it('the attachments SURVIVE while the conversation does not change — negative control', async () => {
    // Without this, "the chips are gone" is satisfied by a fix that clears them
    // on every render.
    await twoSessions();
    await attach('Checkpoint', A.versionId);
    await screen.findByTestId(`mention-${A.versionId}`);

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'still typing' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId(`mention-${A.versionId}`)).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the message enhancement — what the viewer sees, and what survives a reload', () => {
  it('renders the resolved resource under the user’s own message', async () => {
    await startSession();
    await attach('LoCon', B.versionId);
    await screen.findByTestId(`mention-${B.versionId}`);

    pollQueue = [textSnapshot('Grounded answer.')];
    await send('What is this?');

    const bubble = await screen.findByTestId('message-user');
    // Beside the text, never spliced into it — what the viewer typed stays
    // what they typed.
    expect(bubble.textContent).toContain('What is this?');
    const enhancement = bubble.querySelector('[data-testid="message-mentions"]');
    expect(enhancement).toBeTruthy();
    expect(enhancement!.textContent).toContain(B.modelName);
    expect(enhancement!.textContent).toContain(B.modelType);
  });

  it('the composer is cleared of attachments once they are sent', async () => {
    await startSession();
    await attach('Checkpoint', A.versionId);
    await screen.findByTestId(`mention-${A.versionId}`);

    pollQueue = [textSnapshot('Grounded answer.')];
    await send('What is this?');
    await waitFor(() => expect(screen.queryByTestId('pending-mentions')).toBeNull());
  });

  it('🔴 REGENERATE re-attaches the stored mentions — it does not re-ask ungrounded', async () => {
    // Regenerate re-sends `lastUserMsg.content` only. Without its stored
    // `mentions`, the re-send carries NO tool message, so the model either
    // answers ungrounded or spends a REAL charged round looking up what it had
    // been handed — the exact cost this feature exists to remove, and it makes
    // the manifest's "answers in one round without spending a lookup" false on
    // this path.
    await startSession();
    await attach('Checkpoint', A.versionId);
    await screen.findByTestId(`mention-${A.versionId}`);

    pollQueue = [textSnapshot('First answer.')];
    await send('What is this?');
    await waitFor(() => expect(screen.getByText('First answer.')).toBeTruthy());
    // POSITIVE CONTROL: the first submit really did carry the grounding, so a
    // zero on the second is a fact about regenerate and not about the fixture.
    expect(submitted[0].messages.filter((m) => m.role === 'tool')).toHaveLength(1);

    pollQueue = [textSnapshot('Second answer.')];
    // Composer idle first: `isStreaming` is still true for a beat after the
    // reply text renders, and `handleRegenerate` refuses silently while it is.
    await waitFor(() => expect(screen.getByTestId('send-button')).toBeTruthy(), { timeout: 8000 });
    fireEvent.click(screen.getByTestId('regenerate-button'));
    await waitFor(() => expect(submitted.length).toBeGreaterThanOrEqual(2), { timeout: 8000 });

    const second = submitted[1].messages;
    const toolMsgs = second.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(1);
    const payload = JSON.parse(toolMsgs[0].content!) as { items: Array<{ versionId: number }> };
    expect(payload.items.map((r) => r.versionId)).toEqual([A.versionId]);
    // Correlated the same way as an ordinary attach — the pair, not a lone
    // orphan the host would reject.
    const askIdx = second.findIndex((m) =>
      m.tool_calls?.some((c) => c.id === MENTION_TOOL_CALL_ID),
    );
    expect(askIdx).toBeGreaterThanOrEqual(0);
    expect(askIdx).toBeLessThan(second.findIndex((m) => m.role === 'tool'));
    // And it did NOT spend a real lookup to recover what it already had.
    expect(toolPosts).toHaveLength(0);
  });

  it('🔴 REGENERATE does not consume the chips sitting in the composer', async () => {
    // The mentions it re-attaches come from the STORED message, so the
    // composer's own pending attachments belong to the message the viewer is
    // still writing and must survive untouched — the same reasoning that keeps
    // their TEXT in the box when a send is refused.
    await startSession();
    pollQueue = [textSnapshot('Plain answer.')];
    await send('Just a question.');
    await waitFor(() => expect(screen.getByText('Plain answer.')).toBeTruthy());
    // Composer idle before attaching: the picker is closed MID-STREAM by design,
    // and `isStreaming` is still true for a beat after the reply text renders.
    await waitFor(() => expect(screen.getByTestId('send-button')).toBeTruthy(), { timeout: 8000 });

    await attach('Checkpoint', A.versionId);
    await screen.findByTestId(`mention-${A.versionId}`);

    pollQueue = [textSnapshot('Second answer.')];
    // Composer idle first: `isStreaming` is still true for a beat after the
    // reply text renders, and `handleRegenerate` refuses silently while it is.
    await waitFor(() => expect(screen.getByTestId('send-button')).toBeTruthy(), { timeout: 8000 });
    fireEvent.click(screen.getByTestId('regenerate-button'));
    await waitFor(() => expect(submitted.length).toBeGreaterThanOrEqual(2), { timeout: 8000 });

    // The regenerated turn is ungrounded, because the ORIGINAL message was.
    expect(submitted[1].messages.filter((m) => m.role === 'tool')).toHaveLength(0);
    // …and the composer still holds what the viewer attached.
    expect(screen.getByTestId(`mention-${A.versionId}`)).toBeTruthy();
  });

  it('🔴 the attachment survives a reload', async () => {
    // A transcript that loses the attachment is a partial record of what the
    // viewer paid for — the same reasoning that persists a withheld reply.
    await startSession();
    await attach('Checkpoint', A.versionId);
    await screen.findByTestId(`mention-${A.versionId}`);

    pollQueue = [textSnapshot('Grounded answer.')];
    await send('What is this?');
    await waitFor(() => expect(screen.getByText('Grounded answer.')).toBeTruthy());

    cleanup();
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('message-mentions')).toBeTruthy());
    expect(screen.getByTestId('message-mentions').textContent).toContain(A.modelName);
  });
});
