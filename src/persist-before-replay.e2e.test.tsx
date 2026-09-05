import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage } from './test-helpers.js';

/**
 * 🔴 REGRESSION TEST FOR: a paid-for reply existed only in memory until a purely
 * COSMETIC animation had finished, and in a background tab that is minutes.
 *
 * `submitChatCompletion` fetches the reply complete and already moderated — the
 * step is non-streaming by construction, because a partial reply cannot be
 * scanned. The bridge then replayed that finished text through `onChunk` at one
 * `setTimeout(20 ms)` per word and AWAITED it before returning, so `handleSend`'s
 * continuation — the only place the reply is written to storage — did not run
 * until the typewriter had finished. Chrome throttles `setTimeout` in a hidden
 * tab, and an agent-driven send runs in a hidden tab by construction.
 *
 * Measured live through the deployed build on 2026-09-04:
 *
 *   turn                     sent       persisted   lag
 *   short ("Say OK.")        23:09:09   23:09:54    45 s
 *   long ("What is CFG…")    23:10:44   23:14:14    3 m 30 s
 *
 * For the second turn the finished reply was ON SCREEN while storage held ZERO
 * assistant messages for that session — both true at the same instant. Close the
 * tab in that window and the answer is gone, having been charged. That is
 * failure mode F1: 2 of the 16 questions that ever reached production.
 *
 * 🔴 WHAT THIS FILE ASSERTS IS AN ORDERING, NOT A DURATION. "It got faster" is
 * satisfied by a shorter animation and would go green again the moment someone
 * lowered `delayMs`. The property is that the write does not wait for the replay
 * AT ALL: the assistant message must be in storage while the typewriter still
 * has words left to type. A slow replay is what makes that observable, so the
 * fixture's reply is long on purpose.
 */

const storage = fakeAppStorage();

/**
 * 🔴 HOISTED, NOT INLINE — the same trap `stop-stream.e2e.test.tsx` records.
 * `useBuzzWorkflow` runs on every render, and a fresh `vi.fn()` per call changes
 * the `useMemo` dep in `App`, rebuilding the orchestrator adapter mid-turn.
 */
const estimateFn = vi.fn().mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } });
const submitFn = vi.fn(async () => ({ workflowId: 'wf-1', status: 'pending' }));

/** The released reply, as words, so the test can name its first and last. */
const WORDS = Array.from({ length: 120, }, (_, i) => `word${i}`);
const LAST_WORD = WORDS[WORDS.length - 1];
/** 120 words × 20 ms ≈ 2.4 s of replay — the window the write must land inside. */
const REPLAY_MS = WORDS.length * 20;

const pollFn = vi.fn(async () => ({
  workflowId: 'wf-1',
  status: 'succeeded',
  cost: { total: 1 },
  textOutputs: [WORDS.join(' ')],
}));
const cancelFn = vi.fn(async () => undefined);

vi.mock('@civitai/blocks-react', () => ({
  useAppStorage: () => storage.appStorage,
  useBlockAnalytics: () => ({ track: vi.fn() }),
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
    cancel: cancelFn,
    status: 'idle',
    result: null,
    error: null,
  }),
}));

/**
 * Writes of the transcript key that actually carry the assistant's reply.
 *
 * 🔴 THE PREFIX IS `sensei:messages:`, AND THE FILTER ON CONTENT IS NOT
 * OPTIONAL. `handleSend` writes the USER turn to this same key before it ever
 * submits, so a bare prefix match is satisfied the instant Send is clicked —
 * which would make every ordering assertion below pass on pre-change code for a
 * write that has nothing to do with the reply.
 */
function replyWrites() {
  return storage.sets.filter(
    (s) =>
      s.key.startsWith('sensei:messages:') &&
      Array.isArray(s.value) &&
      (s.value as Array<{ role: string; content: string }>).some(
        (m) => m.role === 'assistant' && m.content.includes(LAST_WORD),
      ),
  );
}

/**
 * The same filter over ATTEMPTED writes — the ones that rejected included.
 *
 * 🔴 `sets` CANNOT SEE A WRITE THAT WAS REFUSED, so against an injected storage
 * failure "the reply write never happened" and "the reply write was issued and
 * rejected" produce an identical `sets`. The failed-write case below has to
 * distinguish exactly those two, and this is the only thing that can.
 */
function replyAttempts() {
  return storage.attempts.filter(
    (s) =>
      s.key.startsWith('sensei:messages:') &&
      Array.isArray(s.value) &&
      (s.value as Array<{ role: string; content: string }>).some(
        (m) => m.role === 'assistant' && m.content.includes(LAST_WORD),
      ),
  );
}

/** Every transcript write that COMMITTED, reply or not. */
function transcriptWrites() {
  return storage.sets.filter((s) => s.key.startsWith('sensei:messages:'));
}

/**
 * Open a fresh chat and get a question sent, deterministically.
 *
 * 🔴 A SEND CAN BE REFUSED SILENTLY, AND UNDER LOAD IT IS. `handleSend` declines
 * while the transcript on screen is not yet the selected chat's — the composer's
 * input renders before that read resolves, so a click fired in the gap does
 * nothing at all and no error is raised. Waiting on the write afterwards then
 * expires against a turn that was never sent, and reports a 15 s timeout for a
 * fixture problem. Measured: this file passed alone and failed inside the full
 * suite, which is the signature of a widening window rather than a defect.
 *
 * So the click is retried until the SUBMIT is observed, which is the only signal
 * that the send was accepted. At most one lands: once it has, `isStreaming`
 * refuses the next, and the loop has already stopped clicking.
 */
async function openChatAndSend(question: string) {
  render(<App />);
  await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
  fireEvent.click(screen.getByTestId('new-session-button'));
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: question } });
  await waitFor(
    () => {
      if (submitFn.mock.calls.length === 0) fireEvent.click(screen.getByTestId('send-button'));
      expect(submitFn, 'the send was refused every time it was clicked').toHaveBeenCalled();
    },
    { timeout: 10_000 },
  );
}

describe('durability must not wait on a cosmetic replay', () => {
  beforeEach(() => {
    // 🔴 THE STORE, NOT JUST THE WRITE LOG. Leaving the previous test's session
    // behind makes the second render load a transcript before it can accept a
    // send, which is the window the helper above exists to close — clearing it
    // removes the coupling rather than relying on the retry alone.
    storage.store.clear();
    storage.sets.length = 0;
    storage.attempts.length = 0;
    // The injected write failure is per-test; the two cases above run against a
    // storage that never rejects, exactly as they did before it existed.
    storage.setFailSet(() => false);
    submitFn.mockClear();
    pollFn.mockClear();
    cancelFn.mockClear();
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ tools: [] }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
  });

  it('🔴 persists the reply while the typewriter still has words left', async () => {
    await openChatAndSend('what is CFG scale?');

    const bubble = () => document.body.textContent ?? '';

    // 🔴 THE TIMEOUT IS EXPLICIT AND GENEROUS ON PURPOSE. On pre-change code
    // this write DOES eventually happen — after the whole ~2.4 s replay — and
    // the point is to catch it and then assert about the screen at that moment.
    // A `waitFor` that expired first would kill the test with a bare timeout
    // naming no guard, which is exactly the failure that teaches nothing.
    await waitFor(() => expect(replyWrites().length).toBeGreaterThan(0), { timeout: 15_000 });
    const screenAtWrite = bubble();
    const wroteAt = Date.now();

    // ── THE WHOLE FIX, AS ONE OBSERVATION. ────────────────────────────────────
    expect(
      screenAtWrite,
      'the reply was not written until the cosmetic replay had finished typing it',
    ).not.toContain(LAST_WORD);

    // 🔴 POSITIVE CONTROL: the replay is real, and it finishes. Without this,
    // "the last word was not on screen yet" is equally satisfied by an animation
    // that never ran — i.e. by deleting the feature this fix must preserve.
    await waitFor(() => expect(bubble()).toContain(LAST_WORD), { timeout: 15_000 });
    const finishedAt = Date.now();

    // 🔴 AND THE GAP IS MEASURED, NOT ASSUMED. A quarter of the replay is a
    // deliberately loose floor — the claim is "the write did not wait", and a
    // write landing within 600 ms of a 2,400 ms animation's end would not
    // support it. Derived from the fixture (120 words × 20 ms), not guessed.
    expect(
      finishedAt - wroteAt,
      `the write landed only ${finishedAt - wroteAt} ms before the replay ended`,
    ).toBeGreaterThan(REPLAY_MS / 4);

    // The animation is presentation and must keep working exactly as it does
    // now: every word, in order, ending on the complete reply.
    expect(bubble()).toContain(WORDS[0]);
    expect(bubble()).toContain(LAST_WORD);
  }, 40_000);

  it('🔴 writes the reply exactly once — Stop mid-animation must not downgrade it', async () => {
    // Once the complete reply is durably stored, Stop's rescue write would put
    // the user turn plus a half-typed reply over it: a second write of the same
    // key with strictly less in it. `handleStopStream` reads the turn's
    // `replyPersisted` flag to refuse that. Its rescue is untouched on every
    // path where the flag is false — see `stop-stream.e2e.test.tsx`, whose Stops
    // all land before any reply exists.
    await openChatAndSend('what is CFG scale?');

    await waitFor(() => expect(replyWrites().length).toBeGreaterThan(0), { timeout: 15_000 });

    // 🔴 POSITIVE CONTROL FOR THE STOP ITSELF: the animation must genuinely
    // still be running, or "Stop wrote nothing" is trivially true of a turn that
    // had already ended and the Stop button would not be there to click.
    const stop = await screen.findByTestId('stop-button');
    expect(document.body.textContent ?? '').not.toContain(LAST_WORD);
    fireEvent.click(stop);

    // Long enough for Stop's write to have been issued and settled if it were
    // going to be — it is a synchronous `void persist(...)` on the click.
    await new Promise((r) => setTimeout(r, REPLAY_MS));

    const transcriptWrites = storage.sets.filter((s) => s.key.startsWith('sensei:messages:'));
    const last = transcriptWrites[transcriptWrites.length - 1].value as Array<{
      role: string;
      content: string;
    }>;
    const assistant = last.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(
      assistant[0].content,
      'Stop overwrote the stored complete reply with a half-typed one',
    ).toContain(LAST_WORD);
  }, 40_000);

  /**
   * 🔴 THE OTHER HALF OF THE FLAG, AND UNTIL THIS CASE NOTHING MEASURED IT.
   * `handleSend` sets `replyPersisted` only `if (saved)` — `saved` being
   * `persist`'s real boolean. Deleting that condition (`turn.replyPersisted =
   * true;` unconditionally) SURVIVED the whole 603-test suite, and it is not a
   * cosmetic loosening: a reply write that REJECTS would then mark the turn
   * persisted, `handleStopStream` would skip its rescue on the strength of it,
   * and the charged reply would be in NO store — failure mode F1 recreated by
   * this fix's own guard, in exactly the `write-failed` arm (mechanism (b)) the
   * rescue exists for.
   *
   * The case above pins the flag's TRUE side (a resolved write suppresses the
   * downgrade); this one pins its FALSE side. They must move together.
   *
   * 🔴 WHAT MAKES THE OBSERVATION ATTRIBUTABLE: Stop's rescue is the only
   * transcript write left on this path. The reply already arrived, so the
   * bridge never throws and `handleSend`'s catch never runs; the success path
   * returns at `if (aborted())` immediately after the replay. So a transcript
   * write appearing AFTER the click is Stop's, and there is nothing else it
   * could be — which is why the count is taken across the click rather than
   * over the whole test.
   */
  it('🔴 a reply write that REJECTS must leave Stop\'s rescue armed', async () => {
    // Fail ONLY the write carrying the complete reply. The user-turn write has
    // no assistant message in it and Stop's rescue carries a half-typed one, so
    // this predicate rejects the reply write alone — the same arm
    // `turn-records.e2e.test.tsx` drives with a predicate of its own.
    storage.setFailSet(
      (key, value) =>
        key.startsWith('sensei:messages:') &&
        Array.isArray(value) &&
        (value as Array<{ role: string; content: string }>).some(
          (m) => m.role === 'assistant' && m.content.includes(LAST_WORD),
        ),
    );

    await openChatAndSend('what is CFG scale?');

    // 🔴 POSITIVE CONTROL ON THE INJECTED FAILURE, BEFORE ANYTHING IS CONCLUDED
    // FROM IT. The reply write must have been ISSUED (`attempts`) and must NOT
    // have COMMITTED (`sets`). Without both halves this case would pass just as
    // well against a fixture where the reply never arrived at all.
    await waitFor(() => expect(replyAttempts().length).toBeGreaterThan(0), { timeout: 15_000 });
    expect(
      replyWrites(),
      'the injected failure did not fire — the complete reply committed, so this case is not testing a failed write',
    ).toHaveLength(0);

    // Mid-replay, with prose already typed: the Stop button is on screen and the
    // animation has not reached the end, so the rescue has something to write
    // and is a strict subset of the reply — the shape the flag arbitrates.
    await waitFor(() => expect(document.body.textContent ?? '').toContain(WORDS[3]), {
      timeout: 15_000,
    });
    const stop = await screen.findByTestId('stop-button');
    expect(document.body.textContent ?? '').not.toContain(LAST_WORD);

    const before = transcriptWrites().length;
    fireEvent.click(stop);

    // 🔴 THE TIMEOUT IS WELL INSIDE THE TEST'S OWN, so a failure arrives as this
    // assertion's message rather than as a bare `Test timed out` naming nothing.
    // Stop's write is a synchronous `void persist(...)` on the click, so 5 s is
    // already generous.
    await waitFor(
      () =>
        expect(
          transcriptWrites().length,
          "the reply write REJECTED and Stop still skipped its rescue — the charged reply is in no store: `replyPersisted` was set on a write that never resolved",
        ).toBeGreaterThan(before),
      { timeout: 5_000 },
    );

    const rescued = transcriptWrites()[transcriptWrites().length - 1].value as Array<{
      role: string;
      content: string;
    }>;
    const assistant = rescued.filter((m) => m.role === 'assistant');
    expect(assistant, 'Stop wrote the user turn without the prose that was paid for').toHaveLength(
      1,
    );
    // What Stop rescued is what had typed out by the click — prose, and not the
    // whole reply. That is what makes this write the rescue and not a late copy
    // of the reply write that was refused above.
    expect(assistant[0].content).toContain(WORDS[0]);
    expect(assistant[0].content).not.toContain(LAST_WORD);
  }, 40_000);
});
