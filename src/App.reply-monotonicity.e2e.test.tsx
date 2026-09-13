import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App, assistantReply, withSettledReply } from './App.js';
import { fakeAppStorage } from './test-helpers.js';

/**
 * 🔴 A DURABLE, PAID-FOR REPLY MUST NEVER GET SHORTER.
 *
 * The defect this pins (F5), measured in production on
 * `session-1787879266275-h93jqp`: a viewer asked a question, the 953-character
 * reply arrived and was durably written, they pressed Stop while the cosmetic
 * typewriter was still running, and then asked a second question in the same
 * chat. What survived was 210 characters — byte-exactly
 * `words.slice(0, 33).join(' ') + ' '`, the `simulateStreaming` accumulator
 * frozen by Stop at word 33. The viewer paid for 953 and kept 22% of them.
 *
 * The mechanism is a state/storage split. `simulateStreaming` emits one word per
 * `setTimeout` and `onChunk` bails on `!streamingRef.current`, so Stop freezes
 * the bubble in React `messages`. `08ea7cd` made the reply durable at arrival
 * and made `replyPersisted` block Stop's OWN downgrade write — but nothing
 * repaired `messages`, and `handleSend` builds its write as
 * `[...messages, userMsg]`. The next send re-serialised the abandoned bubble
 * over the complete stored reply.
 *
 * ── WHY THIS IS A LEDGER AND NOT A "STOP THEN SEND" CASE. ────────────────────
 *
 * A test that drives the exact production sequence and checks the final row
 * closes that sequence and leaves the CLASS open: the harm is not "Stop is
 * mishandled", it is "a committed transcript write can hold a SHORTER `content`
 * for an assistant message than a committed write already held". Any future
 * write path derived from `messages` — a retry, an edit, a session merge, a
 * rename that re-serialises — reintroduces it through a door no case-specific
 * test is watching.
 *
 * ✅ THE LEDGER NOW MEASURES TWO THINGS: `content.length` AND `grounded`. The
 * previous revision measured `content.length` alone and said so, and named the
 * gap it therefore could not see: an ordinary second send re-serialises React's
 * copy of turn 1's reply, whose `grounded` array is `undefined`, so a turn's
 * citation evidence is silently dropped from storage while `content.length` is
 * unchanged. That prediction was correct — widening the comparison DOES go red
 * on `9f2a220` behaviour, verbatim:
 * `write 2 dropped grounded ids from assistant msg-…: [4384] -> []`, where
 * write 2 is the SECOND SEND'S USER-MESSAGE WRITE. `App.tsx`'s `assistantReply`
 * is what closes it (rank 34).
 *
 * ⚠️ AND THE HARM IS A WINDOW, NOT A PERMANENT DELETION — MEASURED AT
 * `9f2a220`, BECAUSE THE OBVIOUS FINAL-STATE READ IS BLIND TO IT. Turn 2's own
 * `turnGrounded` is seeded from the session's accumulated set, so when turn 2
 * COMPLETES it writes the same id back under its OWN message id and the
 * conversation's grounded union is whole again. The four committed writes at
 * base were `[u1]`, `[u1, a1(g=[4384])]`, `[u1, a1(g=absent), u2]`,
 * `[u1, a1(g=absent), u2, a2(g=[4384])]`. So a test that reads the LAST row
 * passes over this defect; only the write LOG sees it. What makes the loss
 * durable is turn 2 never writing a row that carries the union — a closed tab,
 * a reload, or (at `9f2a220`) a turn 2 that fails or is stopped, since those
 * rows carried no `grounded` at all. `App.grounded-evidence.e2e.test.tsx`
 * drives those.
 *
 * 🔴 STILL READ IT NARROWLY: THE LEDGER COMPARES `content.length` AND
 * `grounded`, AND NOTHING ELSE. `mentions` and `correction` are field-level loss
 * of exactly the same kind and are NOT compared here; they are protected only by
 * the structural fact that every assistant row is now built by one function
 * (`assistantReply`) and every state replace takes that same object. That is a
 * weaker claim than a ledger, and it is deliberately stated rather than implied.
 *
 * 🔴 AND THE GROUNDED HALF IS A SET COMPARISON, NOT A COUNT. A write that swaps
 * one id for another keeps the size and loses the evidence, so what is asserted
 * is SUPERSET-of-every-earlier-write, and the failure names the dropped ids.
 *
 * So the assertion below runs over the WHOLE committed write log, per assistant
 * message id, and fails on any strictly-shortening write regardless of which
 * code path issued it. That is the same cross-write shape
 * `App.unmount-turn.e2e.test.tsx:154` and `stop-stream.e2e.test.tsx:428`
 * already apply to USER messages ("once a write contains a user message, no
 * later write may drop it"); the assistant side had no equivalent, which is why
 * a 743-character deletion could ship through a green suite.
 *
 * 🔴 FINAL STATE IS NOT ENOUGH, and that is why this is monotonicity rather
 * than a read-back. In several orderings a later turn restores the full array,
 * so the last row looks correct while a viewer who reloaded in between saw the
 * truncated one. What is lost is a write that an earlier write already had.
 */

const storage = fakeAppStorage();

const estimateFn = vi
  .fn()
  .mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } });
const submitFn = vi.fn(async () => ({ workflowId: 'wf-1', status: 'pending' }));

/**
 * 🔴 LONG ENOUGH THAT THE REPLAY CANNOT FINISH INSIDE THE STOP WINDOW. At
 * ~20 ms/word a 120-word reply replays for ~2.4 s, so the Stop below lands with
 * margin while the accumulator is still mid-reply. A short fixture is the
 * version that makes this test pass for the same reason the bug does — the
 * trap `stop-stream.e2e.test.tsx` already documents at its own 60-word fixture.
 */
const WORDS = Array.from({ length: 120 }, (_, i) => `word${i}`);
const REPLY = WORDS.join(' ');
const LAST_WORD = WORDS[WORDS.length - 1];
const REPLAY_MS = WORDS.length * 20;

/**
 * Which reply text a turn gets, by how many submits have happened.
 *
 * 🔴 OPT-IN, DEFAULTING TO ONE TEXT FOR EVERY TURN. One case below needs two
 * DISTINGUISHABLE replies — asserting that chat A's last bubble was not
 * replaced by chat B's is meaningless when both bubbles hold the same string,
 * and the fixture would pass whether or not the guard ran. Every other case
 * asserts on `LAST_WORD` in turn 1's reply, so the default must stay uniform;
 * `beforeEach` restores it.
 */
let replyTextFor: (submitCount: number) => string = () => REPLY;

/**
 * Snapshots to serve, in order, before falling back to `replyTextFor`.
 *
 * 🔴 OPT-IN AND EMPTY BY DEFAULT, so every case that predates the tool fixture
 * gets byte-identical behaviour. Only the grounded case queues anything.
 */
let pollQueue: Array<Record<string, unknown>> = [];

const pollFn = vi.fn(async () => {
  const queued = pollQueue.shift();
  if (queued) return queued;
  return {
    workflowId: 'wf-1',
    status: 'succeeded',
    cost: { total: 1 },
    textOutputs: [replyTextFor(submitFn.mock.calls.length)],
  };
});
const cancelFn = vi.fn(async () => undefined);

/**
 * The one catalog id this file's tool round returns. Real, and the same id
 * `citation-grounding.e2e.test.tsx` uses, so the two files agree about what a
 * grounded id looks like.
 */
const DREAMSHAPER = '4384';

/** The declarations `GET /api/v1/blocks/tools` serves. Empty = tool-less turn. */
let toolDeclarations: unknown[] = [];
/** What `POST /api/v1/blocks/tools` returns — i.e. what actually grounds. */
let toolItems: Array<Record<string, unknown>> = [];

/**
 * A snapshot in which the model asks for a `search_models` round instead of
 * answering. The reply text arrives on the NEXT submit.
 */
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

/**
 * The host's `/api/v1/blocks/tools` route, both verbs.
 *
 * 🔴 THE FALL-THROUGH BODY IS `{ tools: [] }`, WHICH IS WHAT THIS FILE SERVED
 * FOR EVERY URL BEFORE THE TOOL FIXTURE EXISTED. Keeping it means the cases that
 * do not opt in are running against the same bytes they always were, so a change
 * in one of them is attributable to the code and not to this fixture.
 */
function installFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/v1/blocks/tools')) {
      const payload =
        method === 'GET' ? { tools: toolDeclarations } : { items: toolItems, truncated: 0 };
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    return new Response(JSON.stringify({ tools: [] }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

const SEARCH_MODELS_DECLARATION = {
  type: 'function',
  function: {
    name: 'search_models',
    description: 'Search the Civitai model catalog',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
};

vi.mock('@civitai/blocks-react', () => ({
  useAppStorage: () => storage.appStorage,
  useBlockAnalytics: () => ({ track: vi.fn() }),
  useBlockContext: () => ({ ready: true, viewer: { id: 1 }, theme: 'dark' }),
  useBlockResize: () => {},
  // 🔴 FAIL-CLOSED SFW, WHICH IS WHAT A GREEN/BLUE-DOMAIN VIEWER REALLY GETS —
  // and also what the hook returns before BLOCK_INIT lands. So every case in this
  // file runs with NSFW mode hidden and the SFW arm on the wire, which is the
  // production default. The real policy math is tested against the SDK's own
  // `isLevelAllowed`/`effectiveBrowsingCeiling` in `lib/maturity.test.ts`, and the
  // component gate (including the red-domain-but-viewer-opted-out case) in
  // `components/SettingsBar.test.tsx`. Do not read this literal as the contract.
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

type StoredMessage = { id?: string; role: string; content: string; grounded?: string[] };

/** Every COMMITTED transcript write, in issue order. `sets` excludes rejects. */
function transcriptWrites(): StoredMessage[][] {
  return storage.sets
    .filter((s) => s.key.startsWith('sensei:messages:') && Array.isArray(s.value))
    .map((s) => s.value as StoredMessage[]);
}

/** What the ledger learned, per assistant message id. */
interface ReplyHighWater {
  /** id → the longest `content` any committed write held for it. */
  content: Map<string, number>;
  /** id → the union of every `grounded` id any committed write held for it. */
  grounded: Map<string, Set<string>>;
}

/**
 * THE LEDGER. For every assistant message id, no committed write may hold LESS
 * of that reply than an earlier committed write held — measured on two axes:
 *
 *   `content` — never strictly shorter (the F5 defect: a frozen partial
 *               re-serialised over a complete stored reply);
 *   `grounded` — never a strict subset (rank 34: the citation evidence dropped
 *               by re-serialising React's copy, which never carried the field).
 *
 * 🔴 THE TWO AXES ARE INDEPENDENT AND BOTH ARE REQUIRED. A `content`-only ledger
 * is exactly what was green while an ordinary second send deleted a turn's
 * grounded array — the string was byte-identical. A `grounded`-only ledger would
 * be blind to F5. Neither implies the other.
 *
 * 🔴 `grounded` IS COMPARED AS A SET, NOT AS A LENGTH. Swapping one id for
 * another preserves the count and destroys the evidence, so the test is
 * superset-of-every-earlier-write and the message names what went missing.
 *
 * Returns the per-id high-water marks so the caller can run its own positive
 * control on them — a ledger over a log that never saw the same id twice is
 * vacuously true, and reporting that as coverage is worse than no test.
 */
function assertAssistantReplyNeverShrinks(writes: StoredMessage[][]): ReplyHighWater {
  /** id → the longest content any earlier committed write held for it. */
  const highWater = new Map<string, number>();
  /** id → every grounded id any earlier committed write held for it. */
  const groundedSeen = new Map<string, Set<string>>();
  /** id → how many committed writes mentioned it, for the vacuity control. */
  const appearances = new Map<string, number>();

  for (const [i, arr] of writes.entries()) {
    for (const m of arr) {
      // 🔴 KEYED ON THE MESSAGE ID, NOT ON POSITION. An index-keyed ledger
      // reports a false shrink the moment a turn is inserted or removed, and
      // misses a real one whenever the array is reordered.
      if (m.role !== 'assistant' || !m.id) continue;
      appearances.set(m.id, (appearances.get(m.id) ?? 0) + 1);
      const was = highWater.get(m.id);
      if (was !== undefined) {
        expect(
          m.content.length,
          `write ${i} shortened assistant ${m.id}: ${was} chars -> ${m.content.length} ` +
            `(${JSON.stringify(m.content.slice(0, 60))}…)`,
        ).toBeGreaterThanOrEqual(was);
      }
      highWater.set(m.id, Math.max(was ?? 0, m.content.length));

      // 🔴 A MISSING KEY IS AN EMPTY SET, NOT A SKIP. "The field is absent" is
      // precisely how the evidence disappears — `serializeMessages` omits
      // `grounded` when the array is empty, so the losing write looks like an
      // ordinary row. Treating absence as "nothing to compare" would make this
      // ledger blind to the only shape the defect takes.
      const here = new Set(m.grounded ?? []);
      const before = groundedSeen.get(m.id);
      if (before !== undefined) {
        const dropped = [...before].filter((id) => !here.has(id));
        expect(
          dropped,
          `write ${i} dropped grounded ids from assistant ${m.id}: ` +
            `[${[...before].join(', ')}] -> [${[...here].join(', ')}]`,
        ).toEqual([]);
      }
      groundedSeen.set(m.id, new Set([...(before ?? []), ...here]));
    }
  }

  // 🔴 POSITIVE CONTROL ON THE LEDGER ITSELF: at least one assistant id has to
  // have been committed TWICE, or the loop above never compared anything and
  // every case in this file passes while asserting nothing.
  expect(
    [...appearances.values()].some((n) => n >= 2),
    'vacuous ledger: no assistant message id was committed more than once, ' +
      'so no cross-write comparison ever ran',
  ).toBe(true);

  return { content: highWater, grounded: groundedSeen };
}

async function openChat() {
  render(<App />);
  await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
  fireEvent.click(screen.getByTestId('new-session-button'));
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
}

async function send(question: string, fromCall: number) {
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: question } });
  await waitFor(
    () => {
      if (submitFn.mock.calls.length === fromCall)
        fireEvent.click(screen.getByTestId('send-button'));
      expect(submitFn.mock.calls.length).toBeGreaterThan(fromCall);
    },
    { timeout: 10_000 },
  );
}

/** The writes that targeted one specific session's key. */
function writesFor(sessionId: string) {
  // 🔴 THE PREFIX IS `sensei:messages:`, NOT `messages:` — a wrong prefix makes
  // this return [] forever and the assertions below pass for a reason that has
  // nothing to do with the code under test.
  return storage.sets.filter((s) => s.key === `sensei:messages:${sessionId}`);
}

/** The session list as last persisted — the app's own record of the ids. */
function sessionIds(): string[] {
  const last = storage.sets.filter((s) => s.key === 'sensei:sessions').at(-1);
  const value = last?.value as { sessions?: Array<{ id: string }> } | undefined;
  return (value?.sessions ?? []).map((s) => s.id);
}

/** A committed write that holds the whole reply — i.e. the durable one landed. */
function fullReplyWrites() {
  return transcriptWrites().filter((arr) =>
    arr.some((m) => m.role === 'assistant' && m.content.includes(LAST_WORD)),
  );
}

describe('a durable assistant reply never shrinks across committed writes', () => {
  beforeEach(() => {
    storage.store.clear();
    storage.sets.length = 0;
    storage.attempts.length = 0;
    storage.setFailSet(() => false);
    replyTextFor = () => REPLY;
    pollQueue = [];
    toolDeclarations = [];
    toolItems = [];
    submitFn.mockClear();
    pollFn.mockClear();
    cancelFn.mockClear();
    installFetch();
  });

  it('🔴 Stop mid-replay then a second send — the reply must not shrink (F5)', async () => {
    await openChat();
    await send('what is CFG scale?', 0);

    // The durable write of the COMPLETE reply lands first — the half `08ea7cd`
    // already fixed, and the precondition for anything below to mean anything.
    await waitFor(() => expect(fullReplyWrites().length).toBeGreaterThan(0), { timeout: 15_000 });

    // 🔴 POSITIVE CONTROL: the replay is genuinely still mid-flight. Read BEFORE
    // the click — Stop now settles the bubble synchronously, so a sample taken
    // afterwards reports the settled text in both arms and cannot discriminate.
    const stop = await screen.findByTestId('stop-button');
    expect(
      document.body.textContent ?? '',
      'the replay had already finished, so this never exercised a Stop mid-replay',
    ).not.toContain(LAST_WORD);
    fireEvent.click(stop);

    // The viewer asks a second question in the same chat, without reloading —
    // production's "Say OK.", 6m07s later. Pre-fix this is the write that
    // re-serialised the frozen bubble over the stored reply.
    await send('Say OK.', 1);
    await new Promise((r) => setTimeout(r, REPLAY_MS));

    const writes = transcriptWrites();
    const highWater = assertAssistantReplyNeverShrinks(writes).content;

    // 🔴 SECOND POSITIVE CONTROL, ON THE FIXTURE RATHER THAN THE LOOP: the
    // ledger is only interesting if the full reply was ever committed at all.
    // Without this, a run in which the reply was never written passes — the
    // reassuring-zero shape, where "nothing ever shrank" and "nothing was ever
    // there" are indistinguishable.
    expect(
      [...highWater.values()].some((n) => n >= REPLY.length),
      `no committed write ever held the whole ${REPLY.length}-char reply`,
    ).toBe(true);

    // And what a reload would load still has it.
    const last = writes.at(-1)!;
    expect(
      last.find((m) => m.role === 'assistant')?.content,
      'the final committed transcript lost the first reply',
    ).toContain(LAST_WORD);
  }, 60_000);

  it('CONTROL: no Stop — the same sequence, same ledger', async () => {
    // 🔴 THE ARM THAT PROVES THE LEDGER IS NOT UNCONDITIONALLY FALSE. It is the
    // identical sequence minus the Stop, so a ledger that fails here is failing
    // on something other than the defect.
    await openChat();
    await send('what is CFG scale?', 0);
    await waitFor(() => expect(fullReplyWrites().length).toBeGreaterThan(0), { timeout: 15_000 });
    await waitFor(() => expect(document.body.textContent ?? '').toContain(LAST_WORD), {
      timeout: 15_000,
    });
    await send('Say OK.', 1);
    await new Promise((r) => setTimeout(r, REPLAY_MS));

    const highWater = assertAssistantReplyNeverShrinks(transcriptWrites()).content;
    expect([...highWater.values()].some((n) => n >= REPLY.length)).toBe(true);
  }, 60_000);

  it("🔴 an ORDINARY second send must not drop turn 1's citation evidence (rank 34)", async () => {
    // ── THE FIELD HALF OF THE SAME RE-SERIALISATION. ──────────────────────────
    //
    // No Stop, no switch, no unmount, no failed write — the plainest sequence in
    // the app: ask, get an answer that involved a catalog lookup, ask again.
    // `handleSend` writes `[...messages, userMsg]`, and React's copy of turn 1's
    // reply used to be rebuilt from the empty placeholder, so it carried
    // `content` and nothing else. The committed write therefore held turn 1's
    // reply with `grounded` GONE while `content.length` was byte-identical —
    // which is precisely why the content-only ledger stayed green over it.
    //
    // 🔴 WHY IT IS NOT COSMETIC: `role:'tool'` is never persisted, so `grounded`
    // is the only surviving evidence that the catalog returned this id in this
    // conversation. A reload after this write rebuilds a grounded set without it
    // and the citation gate refuses a link it had itself approved.
    //
    // 🔴 AND WHY THE LEDGER RATHER THAN A FINAL-STATE READ: turn 2's own reply
    // write re-adds the id (its `turnGrounded` is seeded from the session's
    // accumulated set), so the LAST row looks correct while the row a viewer who
    // reloaded in between would have loaded does not. The loss is real and
    // durable exactly when the second turn never completes — it fails, it is
    // withheld, or the viewer closes the tab — and it is invisible to anything
    // that only reads the end state.
    toolDeclarations = [SEARCH_MODELS_DECLARATION];
    toolItems = [{ id: Number(DREAMSHAPER), name: 'DreamShaper', type: 'Checkpoint' }];
    // Turn 1 spends two submits: the model asks for a round, then answers.
    pollQueue = [toolCallSnapshot(), textSnapshot(REPLY)];

    await openChat();
    await send('what is DreamShaper?', 0);
    await waitFor(() => expect(fullReplyWrites().length).toBeGreaterThan(0), { timeout: 15_000 });

    // 🔴 POSITIVE CONTROL ON THE FIXTURE, BEFORE THE LEDGER RUNS. Without it a
    // green verdict is indistinguishable from a conversation that grounded
    // nothing at all — the reassuring zero, where "no evidence was dropped" and
    // "there was no evidence" look the same.
    const groundedSoFar = transcriptWrites().flatMap((arr) =>
      arr.filter((m) => m.role === 'assistant').flatMap((m) => m.grounded ?? []),
    );
    expect(
      groundedSoFar,
      'the tool round never grounded anything, so this case measures nothing',
    ).toContain(DREAMSHAPER);

    // The ordinary next thing a viewer does.
    await send('anything else?', submitFn.mock.calls.length);
    await new Promise((r) => setTimeout(r, REPLAY_MS));

    const marks = assertAssistantReplyNeverShrinks(transcriptWrites());
    expect(
      [...marks.content.values()].some((n) => n >= REPLY.length),
      `no committed write ever held the whole ${REPLY.length}-char reply`,
    ).toBe(true);
    expect(
      [...marks.grounded.values()].some((s) => s.has(DREAMSHAPER)),
      'no committed write ever held the grounded id, so the ledger compared nothing',
    ).toBe(true);
  }, 60_000);

  it('🔴 Stop landing while the reply write is STILL IN FLIGHT — the reply must not shrink', async () => {
    // ── THE WINDOW `StreamingTurn.replyPersisted` DOCUMENTS AS OPEN. ──────────
    //
    // A Stop that lands after the reply write is ISSUED but before it RESOLVES
    // reads `replyPersisted === false`, so it takes the rescue branch, writes
    // the partial and returns — and it is gone by the time the flag is set.
    // Nothing in `handleStopStream` can repair `messages` for that ordering,
    // which is why the settle also runs at the persist site under `aborted()`.
    //
    // 🔴 THIS CASE EXISTS BECAUSE THE PERSIST-SITE SETTLE SURVIVED A MUTATION
    // SWEEP WITHOUT IT. Deleting that line left all 610 tests green: the
    // ordinary Stop cases all land AFTER the write resolves, so they exercise
    // the `handleStopStream` half only. A guard no test can reach is a guard
    // nobody has tested, however obviously correct it reads.
    //
    // 🔴 THE COMMIT ORDER WAS THE WHOLE FIXTURE, AND IT HAS CHANGED — READ THIS
    // BEFORE "RESTORING" IT. This case used to wait for Stop's partial to commit
    // FIRST and the full reply SECOND, because unordered writes made that the
    // order the artificial hold produced. It is not the order production
    // produced: the reply write is ISSUED first, so it also tended to LAND
    // first, and Stop's partial then overwrote it — the ⚠️ window
    // `StreamingTurn.replyPersisted` documents as open.
    //
    // Since rank 33 a session's message writes land in ISSUE order
    // (`lib/write-ownership.ts` → `serializeMessageWrite`), which turned that
    // race into a certainty — so `handleStopStream` now WAITS for an in-flight
    // reply write and rescues only if it failed. Stop therefore commits nothing
    // here at all, and the assertion below pins that: no second transcript write
    // may commit while the reply write is parked. The ledger is unchanged and
    // still the point — what shortens a reply is the second send re-serialising
    // React state, and the persist-site settle is what stops it.
    let releaseReplyWrite: () => void = () => {};
    const realSet = storage.appStorage.set.bind(storage.appStorage);
    const gate = new Promise<void>((r) => {
      releaseReplyWrite = r;
    });
    storage.appStorage.set = (async (key: string, value: unknown) => {
      const holdsFullReply =
        key.startsWith('sensei:messages:') &&
        Array.isArray(value) &&
        (value as StoredMessage[]).some(
          (m) => m.role === 'assistant' && m.content.includes(LAST_WORD),
        );
      if (holdsFullReply) await gate;
      return realSet(key, value);
    }) as typeof storage.appStorage.set;

    try {
      await openChat();
      await send('what is CFG scale?', 0);

      // Wait until the replay is under way — the reply has arrived, so its write
      // has been issued and is now parked on the gate above.
      await waitFor(() => expect(document.body.textContent ?? '').toContain('word0'), {
        timeout: 15_000,
      });
      // 🔴 POSITIVE CONTROL ON THE GATE: the full reply must NOT have committed.
      // Without this the test passes when the gate never engaged, which is the
      // ordinary Stop case wearing this case's name.
      expect(fullReplyWrites().length, 'the gate never held the reply write').toBe(0);

      const writesBeforeStop = transcriptWrites().length;
      fireEvent.click(await screen.findByTestId('stop-button'));
      // Stop has been handled — the control is gone and the turn is no longer
      // streaming — so anything it was going to write has been decided.
      await waitFor(() => expect(screen.queryByTestId('stop-button')).toBeNull(), {
        timeout: 5_000,
      });
      await new Promise((r) => setTimeout(r, 50));
      // 🔴 AND IT WROTE NOTHING WHILE THE REPLY WRITE WAS PARKED. A partial
      // committed here would land AFTER the full reply once the gate opens —
      // deterministically, now that writes are ordered — which is the downgrade
      // this whole case exists to catch.
      expect(
        transcriptWrites().length,
        'Stop wrote a shorter transcript while the reply write was still in flight',
      ).toBe(writesBeforeStop);
      expect(fullReplyWrites().length, 'the gate stopped holding the reply write').toBe(0);

      releaseReplyWrite();
      await waitFor(() => expect(fullReplyWrites().length).toBeGreaterThan(0), { timeout: 15_000 });

      await send('Say OK.', 1);
      await new Promise((r) => setTimeout(r, REPLAY_MS));

      const highWater = assertAssistantReplyNeverShrinks(transcriptWrites()).content;
      expect(
        [...highWater.values()].some((n) => n >= REPLY.length),
        `no committed write ever held the whole ${REPLY.length}-char reply`,
      ).toBe(true);
    } finally {
      storage.appStorage.set = realSet;
      releaseReplyWrite();
    }
  }, 60_000);

  it('🔴 the settle must not leak the reply into a session the viewer switched to', async () => {
    // ── THE SEAM THE SETTLE OPENS, AND THE ONLY THING THAT CLOSES IT. ─────────
    //
    // `handleStopStream` deliberately cannot see `activeSessionId` (clawgate
    // #427) — it asks the TURN, not the screen. That makes it safe for the
    // WRITE, and the settle is a different kind of act: it puts text on the
    // screen, and the screen may belong to a different conversation by then.
    // `withSettledReply`'s last-element identity test is what refuses that.
    //
    // 🔴 THIS CASE EXISTS BECAUSE DELETING THAT GUARD SURVIVED 611 TESTS. The
    // existing switch-then-Stop case (`App.stop-session-key.e2e.test.tsx`)
    // stops BEFORE the reply arrives, so `replyPersisted` is false and the
    // settle branch is never entered — the guard was structurally unreachable
    // from the whole suite. Here the reply lands FIRST, which is the ordering
    // that reaches it.
    //
    // Without the guard S2's transcript is `[]`, so `prev[prev.length - 1]` is
    // `undefined`, the slice yields `[]`, and S1's reply is appended into the
    // empty chat the viewer is looking at — after which S2's own next send
    // serialises it into S2's storage. A brand-new chat silently acquires
    // another conversation's paid-for answer.
    await openChat();
    const s1 = sessionIds()[0];
    expect(s1, 'S1 was never persisted, so this test has no key to assert on').toBeTruthy();

    await send('what is CFG scale?', 0);
    // The reply must be DURABLE before the switch — that is what arms the
    // settle branch. Stopping earlier exercises the rescue path instead.
    await waitFor(() => expect(fullReplyWrites().length).toBeGreaterThan(0), { timeout: 15_000 });

    // The switch, mid-replay.
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(sessionIds().length).toBe(2));
    const s2 = sessionIds().find((id) => id !== s1)!;

    // 🔴 POSITIVE CONTROL ON THE SWITCH: the viewer is genuinely looking at the
    // empty S2. Scoped to `messages-container` because S1's auto-title keeps the
    // question on screen in the SIDEBAR after a perfectly correct switch.
    await waitFor(() =>
      expect(
        screen.getByTestId('messages-container').textContent ?? '',
        'the view never left S1, so this is not exercising the seam',
      ).not.toContain('word0'),
    );

    // 🔴 AND THE STOP BUTTON MUST HAVE SURVIVED THE SWITCH. `isStreaming` is
    // instance-wide; if that changes, this test stops reaching the path and must
    // be reconsidered rather than silently passing.
    fireEvent.click(await screen.findByTestId('stop-button'));
    await new Promise((r) => setTimeout(r, 200));

    // 🔴 THE ASSERTION IS THE SCREEN, AND THE SCOPE IS DELIBERATE — see the
    // note below about what this case does NOT pin.
    expect(
      screen.getByTestId('messages-container').textContent ?? '',
      "the settle put S1's reply on screen inside S2",
    ).not.toContain(LAST_WORD);

    // And S1 still has its reply — the guard refuses the repair, it does not
    // damage the turn that owns it.
    const s1Last = writesFor(s1).at(-1)!.value as StoredMessage[];
    expect(s1Last.some((m) => m.role === 'assistant' && m.content.includes(LAST_WORD))).toBe(true);
    // The switch itself must not have written under S2 at all.
    expect(writesFor(s2).map((s) => s.value)).toHaveLength(0);
  }, 60_000);

  it('🔴 the settle must not overwrite the last message of a NON-EMPTY chat', async () => {
    // ── REACHING THE ID COMPARISON, WHICH THE EMPTY-CHAT CASE CANNOT. ─────────
    //
    // 🔴 THIS CASE EXISTS BECAUSE THE PREVIOUS ONE PROVED ONLY HALF THE GUARD.
    // `withSettledReply` refuses on `!last || last.id !== reply.id`. Switching
    // to a brand-new chat leaves `messages` EMPTY, so `!last` always fires
    // first and the id comparison never executes: weakening it to `if (!last)`
    // survived the whole suite — a mutant that lived because an earlier check
    // always won, not because anything tested it.
    //
    // Here the viewer switches to a chat that already HAS an exchange, so
    // `last` exists and only the id comparison stands between chat B's reply
    // and chat A's last bubble. Without it, A's own answer is silently
    // replaced on screen by another conversation's.
    const OTHER = 'alpha bravo charlie delta echo foxtrot';
    replyTextFor = (n) => (n <= 1 ? OTHER : REPLY);

    // Chat A, with a COMPLETED exchange of its own.
    await openChat();
    const chatA = sessionIds()[0];
    await send('first question', 0);
    await waitFor(() => expect(document.body.textContent ?? '').toContain('foxtrot'), {
      timeout: 15_000,
    });

    // Chat B, with a turn whose reply has landed and is mid-replay.
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(sessionIds().length).toBe(2));
    await send('second question', 1);
    await waitFor(() => expect(fullReplyWrites().length).toBeGreaterThan(0), { timeout: 15_000 });

    // Back to A — which is NOT empty. That is the whole point of this case.
    fireEvent.click(screen.getByTestId(`session-item-${chatA}`));
    await waitFor(
      () => expect(screen.getByTestId('messages-container').textContent ?? '').toContain('foxtrot'),
      { timeout: 10_000 },
    );
    // 🔴 POSITIVE CONTROL ON THE NON-EMPTINESS, which is this case's entire
    // reason to exist: if A rendered empty, `!last` would catch the settle and
    // the id comparison would go untested exactly as before.
    expect(
      screen.getByTestId('messages-container').textContent ?? '',
      'chat A rendered empty, so this case does not reach the id comparison',
    ).toContain('alpha');

    fireEvent.click(await screen.findByTestId('stop-button'));
    await new Promise((r) => setTimeout(r, 200));

    const shown = screen.getByTestId('messages-container').textContent ?? '';
    expect(shown, "chat B's reply replaced chat A's last message on screen").not.toContain(
      LAST_WORD,
    );
    expect(shown, "chat A's own reply was destroyed by the settle").toContain('foxtrot');
    // A's stored transcript is untouched too.
    const aLast = writesFor(chatA).at(-1)!.value as StoredMessage[];
    expect(aLast.some((m) => m.role === 'assistant' && m.content.includes('foxtrot'))).toBe(true);
    expect(aLast.some((m) => m.content.includes(LAST_WORD))).toBe(false);
  }, 60_000);

  /**
   * ⚠️ WHAT THIS FILE DOES NOT PIN, STATED RATHER THAN LEFT AS A GAP.
   *
   * The case above asserts the SCREEN and stops there. It does NOT assert that a
   * switched-to session's committed writes are free of the previous session's
   * reply.
   *
   * 🔴 AN EARLIER REVISION OF THIS COMMENT CLAIMED A MEASURED RED HERE, AND THAT
   * CLAIM IS WITHDRAWN. It said a draft of that second half "goes RED, and goes
   * red on `origin/trunk` too — identical failure, identical message", and
   * recorded it as a confirmed pre-existing leak. A round-1 audit rebuilt that
   * draft and could NOT reproduce it: four runs — this head and a
   * behaviourally-trunk tree, each with an immediate send and with a 200 ms
   * settle window — all reported `S2 acquired S1 reply: false`, with S1's writes
   * intact at full length. `createSession` calls `setMessages([])` synchronously,
   * so S2 starts empty and has nothing to inherit.
   *
   * ⚠ **That is a failure to reproduce, NOT proof the leak does not exist** — an
   * empty result cannot separate "no such defect" from "the draft used a
   * discriminating step this comment omits" (a sidebar switch rather than
   * `+ New`, or a read that had not resolved). What IS established: the sequence
   * as described here is not a route to it, so nobody should spend time on this
   * paragraph as written. If you can build a case that reproduces, that case is
   * the finding — this comment is not evidence for one.
   */
});

/**
 * 🔴 VALIDATE THE INSTRUMENT BEFORE READING ITS VERDICT. The two cases above
 * take their verdict from `assertAssistantReplyNeverShrinks`; until it has
 * been watched to go red on a log that MUST fail and to refuse a log it cannot
 * learn anything from, a green there is a claim about the ledger, not about the
 * app. These run on synthetic logs, so they cannot be quieted by a timing
 * change in the driven cases.
 */
/**
 * 🔴 BOTH REFUSALS, PINNED WITHOUT A CLOCK. The driven cases above reach these
 * branches through a session switch and a replay window, which makes them
 * timing-dependent; these do not. They are also the only place the `!last` and
 * `last.id !== reply.id` halves are separated — an e2e that switches to an EMPTY
 * chat can only ever exercise the first, which is how weakening the second to
 * `if (!last)` once survived the entire suite.
 */
/**
 * 🔴 THE BUILDER'S FOUR CLAUSES, PINNED WHERE A MUTATION CAN REACH THEM.
 *
 * `assistantReply` is now the single site that decides which optional fields an
 * assistant row carries, for the write AND for React. Three of its clauses have
 * behavioural coverage — `grounded` through the cases above and
 * `App.grounded-evidence.e2e.test.tsx`, `correction` through
 * `correction-round.e2e.test.tsx` (measured: deleting that clause reddens 5
 * cases there). The fourth does not, and this describe exists because that was
 * MEASURED rather than assumed.
 *
 * ⚠️ `withheld` HAS NO BEHAVIOURAL COVERAGE ANYWHERE IN THIS REPO, AND THAT IS
 * PRE-EXISTING, NOT SOMETHING THIS CHANGE INTRODUCED. Deleting the flag from
 * BOTH of its `9f2a220` sites — the state replace and the write — leaves all 634
 * pre-existing tests green: `turn-records.e2e.test.tsx` asserts the withhold
 * REASON renders, which is `content`, and `MessageBubble` only styles on the
 * flag, so no assertion in the suite can see it. These unit cases stop it being
 * deleted silently; they are NOT a claim that the rendered withhold notice is
 * pinned end to end. It is not.
 */
describe('assistantReply', () => {
  const base = { id: 'a1', timestamp: 7 } as const;

  it('carries the required fields and NOTHING optional when there is nothing to carry', () => {
    // Byte-identical to what a turn stored before any of these fields existed —
    // the reason each clause is conditional rather than always-present.
    expect(assistantReply(base, { content: 'hi', grounded: [] })).toEqual({
      id: 'a1',
      role: 'assistant',
      content: 'hi',
      timestamp: 7,
    });
  });

  it('🔴 carries `grounded` when the turn grounded something, from a Set or an array', () => {
    expect(assistantReply(base, { content: 'hi', grounded: new Set(['4384']) }).grounded).toEqual([
      '4384',
    ]);
    expect(assistantReply(base, { content: 'hi', grounded: ['4384', '22220'] }).grounded).toEqual([
      '4384',
      '22220',
    ]);
  });

  it('🔴 carries `withheld` only when it is TRUE', () => {
    expect(assistantReply(base, { content: 'x', withheld: true, grounded: [] }).withheld).toBe(true);
    expect('withheld' in assistantReply(base, { content: 'x', withheld: false, grounded: [] })).toBe(
      false,
    );
  });

  it('🔴 carries `correction` only when a round fired', () => {
    const correction = { rounds: 1, resolved: true };
    expect(assistantReply(base, { content: 'x', correction, grounded: [] }).correction).toEqual(
      correction,
    );
    expect('correction' in assistantReply(base, { content: 'x', grounded: [] })).toBe(false);
  });

  it('🔴 stores a plain ARRAY snapshot, never the live Set the turn keeps mutating', () => {
    // 🔴 TWO SEPARATE HAZARDS, ONE ASSERTION EACH, AND THE FIRST IS SILENT
    // DATA LOSS RATHER THAN A TYPE COMPLAINT. `turnGrounded` is a `Set`, and
    // `JSON.stringify(new Set(['4384']))` is `{}` — a row carrying the Set
    // itself would go through `appStorage.set` as an EMPTY OBJECT, i.e. every
    // id lost with nothing thrown. Second: the Set keeps accumulating after the
    // row is built (a correction round can still ground more), so a shared
    // reference would let a later id appear inside a value already handed to
    // `saveMessages`.
    const live = new Set(['4384']);
    const row = assistantReply(base, { content: 'x', grounded: live });
    expect(Array.isArray(row.grounded), 'the row carries the Set itself').toBe(true);
    live.add('22220');
    expect(row.grounded).toEqual(['4384']);
  });
});

describe('withSettledReply', () => {
  const reply = { id: 'a1', role: 'assistant' as const, content: 'the whole reply', timestamp: 1 };

  it('replaces the last message when it IS the assistant message of this turn', () => {
    const prev = [
      { id: 'u1', role: 'user' as const, content: 'q', timestamp: 0 },
      { id: 'a1', role: 'assistant' as const, content: 'the wh', timestamp: 1 },
    ];
    expect(withSettledReply(prev, reply)).toEqual([prev[0], reply]);
  });

  it('🔴 REFUSES an empty transcript — the chat was switched away, or cleared', () => {
    expect(withSettledReply([], reply)).toEqual([]);
  });

  it('🔴 REFUSES when the last message belongs to another turn or another chat', () => {
    const other = [
      { id: 'u9', role: 'user' as const, content: 'somebody else', timestamp: 0 },
      { id: 'a9', role: 'assistant' as const, content: "another chat's answer", timestamp: 1 },
    ];
    expect(withSettledReply(other, reply)).toEqual(other);
  });

  it('🔴 REFUSES when this turn is no longer LAST, even though its message is present', () => {
    // The viewer sent again; the settle must not reach back past the newer turn.
    const moved = [
      { id: 'a1', role: 'assistant' as const, content: 'the wh', timestamp: 1 },
      { id: 'u2', role: 'user' as const, content: 'a newer question', timestamp: 2 },
    ];
    expect(withSettledReply(moved, reply)).toEqual(moved);
  });
});

describe('the ledger itself', () => {
  const full = { id: 'a1', role: 'assistant', content: 'one two three four five' };
  const user = { id: 'u1', role: 'user', content: 'q' };

  it('NEGATIVE CONTROL: goes red on a log that shortens an assistant message', () => {
    const truncated = { id: 'a1', role: 'assistant', content: 'one two' };
    expect(() =>
      assertAssistantReplyNeverShrinks([
        [user, full],
        [user, truncated],
      ]),
    ).toThrow(/shortened assistant a1: 23 chars -> 7/);
  });

  it('accepts growth, and re-writing the identical content', () => {
    const partial = { id: 'a1', role: 'assistant', content: 'one two' };
    expect(() =>
      assertAssistantReplyNeverShrinks([
        [user, partial],
        [user, full],
        [user, full],
      ]),
    ).not.toThrow();
  });

  it('VACUITY CONTROL: refuses a log in which no id was committed twice', () => {
    expect(() => assertAssistantReplyNeverShrinks([[user, full]])).toThrow(/vacuous ledger/);
  });

  it('🔴 keys on the message id, so a shrink is caught after a turn is inserted', () => {
    // An index-keyed ledger compares `full` against the INSERTED message and
    // sees growth, passing straight over the truncation of `a1`.
    const inserted = { id: 'a0', role: 'assistant', content: 'x'.repeat(99) };
    const truncated = { id: 'a1', role: 'assistant', content: 'one' };
    expect(() =>
      assertAssistantReplyNeverShrinks([
        [user, full],
        [user, inserted, truncated],
      ]),
    ).toThrow(/shortened assistant a1/);
  });

  // ── THE GROUNDED AXIS, CONTROLLED SEPARATELY FROM THE CONTENT ONE. ──────────
  //
  // 🔴 EVERY CASE HERE HOLDS `content` CONSTANT. That is the whole point: the
  // defect this axis exists for kept the string byte-identical, so a fixture
  // whose content also moved would let the content assertion do the killing and
  // prove nothing about the grounded comparison.

  const groundedFull = { ...full, grounded: ['4384', '22220'] };

  it('NEGATIVE CONTROL: goes red when a later write DROPS a grounded id', () => {
    // The measured shape: the field is simply absent, because
    // `serializeMessages` omits an empty array.
    const stripped = { ...full };
    expect(() =>
      assertAssistantReplyNeverShrinks([
        [user, groundedFull],
        [user, stripped],
      ]),
    ).toThrow(/dropped grounded ids from assistant a1: \[4384, 22220\] -> \[\]/);
  });

  it('🔴 goes red on a SWAP that preserves the count — a length test would not', () => {
    const swapped = { ...full, grounded: ['4384', '999'] };
    expect(() =>
      assertAssistantReplyNeverShrinks([
        [user, groundedFull],
        [user, swapped],
      ]),
    ).toThrow(/dropped grounded ids from assistant a1: .* -> \[4384, 999\]/);
  });

  it('accepts a grounded set that GROWS, and one re-written identically', () => {
    expect(() =>
      assertAssistantReplyNeverShrinks([
        [user, groundedFull],
        [user, groundedFull],
        [user, { ...full, grounded: ['4384', '22220', '58390'] }],
      ]),
    ).not.toThrow();
  });

  it('accepts a log with no grounded ids anywhere — the ordinary tool-less chat', () => {
    // Absence must not be a failure, or every case in this file that never calls
    // a tool would go red for a reason unrelated to what it tests.
    expect(() =>
      assertAssistantReplyNeverShrinks([
        [user, full],
        [user, full],
      ]),
    ).not.toThrow();
  });

  it('🔴 the grounded high-water is the UNION, so a later write cannot narrow it', () => {
    const { grounded } = assertAssistantReplyNeverShrinks([
      [user, { ...full, grounded: ['4384'] }],
      [user, { ...full, grounded: ['4384', '22220'] }],
    ]);
    expect([...(grounded.get('a1') ?? [])].sort()).toEqual(['22220', '4384']);
  });
});
