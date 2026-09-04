import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage } from './test-helpers.js';
import { clearCache } from './lib/research.js';

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 DELETING A CHAT MUST TAKE ITS TRANSCRIPT OFF THE SCREEN WITH IT.
//
// `deleteSession` moved `sessions` and `activeSessionId` and nothing else. The
// transcript on screen is `messages`, paired with `messagesSessionId`, and the
// citation gate renders that transcript against `groundedBySession[
// messagesSessionId]` — so a delete that touches neither leaves the DELETED
// conversation on screen, with its citations still resolving to live links.
//
// The ids in it genuinely were grounded by that conversation, so the gate is not
// lying. The conversation is the thing that no longer exists.
//
// 🔴 WHY THE FAILING-READ ARM IS THE ONE THAT MATTERS. In the happy case the
// `[activeSessionId]` effect loads the successor and `applyLoadedMessages`
// overwrites the pair a tick later, so the stale transcript is a transient
// nobody sees. When that read REJECTS there is nothing to end it: the catch
// shows an error and leaves `messages`/`messagesSessionId` exactly where they
// were. The deleted chat then stays on screen indefinitely, next to an error
// about a DIFFERENT chat. Same shape as the failed-SWITCH case pinned in
// `citation-grounding.e2e.test.tsx`, on the route that fix did not cover.
//
// 🔴 BOTH ROUTES INTO THAT STATE ARE PINNED, AND THEY DISAGREE ABOUT THE
// PREDICATE — which is the whole reason the second case exists. Case 1 deletes
// the chat that is both SELECTED and ON SCREEN; case 2 deletes one that is only
// ON SCREEN (a failed switch already moved the selection away). A clear keyed on
// `activeSessionId === id` satisfies case 1 and leaves case 2 broken. The cell
// that describes the transcript is `messagesSessionId`, so that is the one the
// clear is keyed on, and case 2 is what says so.
//
// ⚠️ WHAT THIS FILE DOES NOT COVER, stated rather than implied: the
// `groundedBySession[id]` purge that ships in the same change. Once the pair is
// cleared, `groundedModelIds` can never read the deleted id again — the entry is
// unreachable, not merely unused — so its removal has no consequence any DOM
// assertion can see. It is a memory-leak fix, and the mutation report for this
// change records it as an unkilled mutant rather than claiming coverage here.
//
// IDS: the same measured ones as `citation-grounding.e2e.test.tsx` — 4384 is
// DreamShaper, a real model the catalog really returns.
// ─────────────────────────────────────────────────────────────────────────────

const DREAMSHAPER = 4384;

const h = vi.hoisted(() => ({
  storage: null as ReturnType<typeof fakeAppStorage> | null,
}));

const estimateFn = vi
  .fn()
  .mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } });
const submitFn = vi.fn(async () => ({ workflowId: 'wf', status: 'pending' }));

let pollQueue: Array<Record<string, unknown>> = [];
const pollFn = vi.fn(async () => {
  const next = pollQueue.shift();
  return (
    next ?? { workflowId: 'wf-x', status: 'succeeded', cost: { total: 1 }, textOutputs: ['done'] }
  );
});

vi.mock('@civitai/blocks-react', () => ({
  // One instance, resolved at call time — a factory call here would hand every
  // render a fresh empty store and the switch/delete cases would be measuring
  // the fake rather than the app.
  useAppStorage: () => h.storage!.appStorage,
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

/** What the next POST /tools returns — i.e. what grounds the conversation. */
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
        function: { name: 'search_models', arguments: JSON.stringify({ query: 'realistic' }) },
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

/** The rendered anchor for a model id, or null when the gate refused it. */
function anchorFor(id: number): HTMLAnchorElement | null {
  return document.querySelector<HTMLAnchorElement>(`a[href*="/models/${id}"]`);
}

const rows = () => document.querySelectorAll<HTMLElement>('[data-testid^="session-item-"]');

/** The session id a switcher row stands for. */
function idOf(row: HTMLElement): string {
  return (row.dataset.testid ?? row.getAttribute('data-testid') ?? '').replace('session-item-', '');
}

async function startChat() {
  render(<App />);
  await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
  fireEvent.click(screen.getByTestId('new-session-button'));
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
}

/**
 * Type and send; resolves once the reply is on screen AND the turn has settled.
 * Waiting for the text alone lets the next `send` return having done nothing,
 * because `handleSend` refuses while `isStreaming` is still true.
 */
async function send(question: string, expectInReply: string) {
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: question } });
  fireEvent.click(screen.getByTestId('send-button'));
  await waitFor(() => expect(screen.getByText(new RegExp(expectInReply))).toBeTruthy(), {
    timeout: 8000,
  });
  await waitFor(() => expect(screen.queryByTestId('streaming-indicator')).toBeNull(), {
    timeout: 8000,
  });
}

/**
 * Build the two-chat fixture and leave the GROUNDED one on screen and selected.
 *
 * Returns the two ids. The grounded chat is the older of the two, so it is the
 * LAST row — boot and `next[0]` both prefer the newer one, which is what makes
 * the successor in each case below a chat that is not this one.
 */
async function twoChatsGroundedFirst(): Promise<{ grounded: string; other: string }> {
  toolItems = [{ id: DREAMSHAPER, name: 'DreamShaper', type: 'Checkpoint' }];
  pollQueue = [
    toolCallSnapshot(),
    textSnapshot(`[DreamShaper](https://civitai.com/models/${DREAMSHAPER}) is great.`),
  ];
  await startChat();
  await send('what is DreamShaper?', 'is great');

  fireEvent.click(screen.getByTestId('new-session-button'));
  await waitFor(() => expect(screen.queryByText(/is great/)).toBeNull());
  pollQueue = [textSnapshot('Nothing looked up here.')];
  await send('hello', 'Nothing looked up here');

  const all = rows();
  expect(all, 'expected both conversations in the switcher').toHaveLength(2);
  const grounded = idOf(all[all.length - 1]);
  const other = idOf(all[0]);

  // Back to the grounded conversation, so IT is the transcript on screen.
  fireEvent.click(all[all.length - 1]);
  await waitFor(() => expect(screen.getByText(/is great/)).toBeTruthy());
  // 🔴 POSITIVE CONTROL. Every assertion below is "no anchor"; without watching
  // one render first, an app that renders no anchors at all passes them all.
  await waitFor(() => expect(anchorFor(DREAMSHAPER)).toBeTruthy());

  return { grounded, other };
}

/** Make every later message read reject, the way the durable failure arm does. */
function breakMessageReads() {
  const storage = h.storage!.appStorage;
  const realGet = storage.get.bind(storage);
  storage.get = (async (key: string) => {
    if (key.startsWith('sensei:messages:')) throw new Error('storage is unavailable');
    return realGet(key);
  }) as typeof storage.get;
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 A DELETE MID-TURN NOW HANDS THE UPDATERS AN EMPTY TRANSCRIPT.
//
// The clear above is what makes `messages === []` REACHABLE while a turn is
// still settling. All three `setMessages` updaters in `handleSend` open with
// `const last = prev[prev.length - 1]; if (last.id === …)`, which on `[]` reads
// `undefined.id` — a TypeError raised INSIDE the reducer, so it is not a lost
// chunk, it is the whole App tree coming down (`RootBoundary` in prod) taking
// the in-flight, already-billed reply with it.
//
// 🔴 THE DEFAULT FAKE CANNOT SEE THIS, WHICH IS WHY THE 548-TEST SUITE DID NOT.
// `fakeAppStorage.get` resolves inside a microtask, so the successor's
// transcript replaces `[]` before the next chunk lands and `prev` is never
// empty when an updater runs. The window only opens once the read costs real
// time — i.e. on the deployed host, where it is a postMessage hop. The three
// cases below buy that window with `delayMessageReads`, and the delay is the
// ONLY variable: nothing is broken, both chats have stored transcripts, and the
// successor read succeeds.
//
// Measured at `cf4a4ba` (this branch's head before the fix) — see the per-case
// notes for what each one pins and which updater it reaches.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Put `ms` of latency on every messages READ, and record what went through it.
 *
 * 🔴 THE RETURNED LOG IS THE KNOB'S OWN POSITIVE CONTROL. A fixture that
 * silently resolved instantly is exactly the blindness these cases exist to
 * close, so each case asserts that the successor's key really was delayed —
 * the elapsed time, not just that `get` was patched.
 *
 * 🔴 AND THE LATENCY IS LOAD-BEARING, MEASURED RATHER THAN ASSUMED. Take this
 * wrapper away and run the three cases against `cf4a4ba` — the whole fix
 * reverted — and all three PASS: 6 consecutive runs, rc=0. `fakeAppStorage`
 * resolves the successor read inside a microtask, so `[]` is replaced before
 * any updater can meet it. That is why 548 green tests could not see this, and
 * why a case written on the default fixture would prove nothing. A
 * `setTimeout(…, 0)` knob does not reproduce it either (3 runs).
 *
 * ⚠️ SCOPE: that is a claim about an unloaded box, not an impossibility. One
 * heavily-loaded run DID reproduce with no delay at all — 8398 ms wall for a
 * case that otherwise takes ~500 ms, i.e. the stall bought the same window the
 * delay buys.
 */
function delayMessageReads(ms: number) {
  const storage = h.storage!.appStorage;
  const realGet = storage.get.bind(storage);
  const delayed: Array<{ key: string; elapsedMs: number }> = [];
  storage.get = (async (key: string) => {
    if (key.startsWith('sensei:messages:')) {
      const started = Date.now();
      await new Promise((r) => setTimeout(r, ms));
      delayed.push({ key, elapsedMs: Date.now() - started });
    }
    return realGet(key);
  }) as typeof storage.get;
  return delayed;
}

/** A reply of `words` words. `simulateStreaming` emits one every 20 ms. */
function longReply(words: number): string {
  return Array.from({ length: words }, (_, i) => `word${i}`).join(' ');
}

/**
 * Every uncaught error raised while this is installed.
 *
 * React 19 reports an error thrown during render through `reportError`, which
 * jsdom dispatches as a window `error` event; the same throw arriving on the
 * async settle path surfaces as an unhandled rejection. Both are collected, so
 * the assertion names the TypeError rather than timing out on a dead tree.
 */
function captureUncaught() {
  const seen: string[] = [];
  const onError = (e: ErrorEvent) => {
    seen.push(e.error instanceof Error ? e.error.message : String(e.message));
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    seen.push(e.reason instanceof Error ? e.reason.message : String(e.reason));
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return {
    seen,
    restore: () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    },
  };
}

/** Send without waiting for the turn to finish; resolves once it is streaming. */
async function startTurn(question: string) {
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: question } });
  fireEvent.click(screen.getByTestId('send-button'));
  await waitFor(() => expect(screen.getByTestId('streaming-indicator')).toBeTruthy());
}

/**
 * Wait out a delete: no uncaught error, the row is gone, and the successor's
 * transcript is on screen — i.e. the tree survived AND the delayed read landed.
 *
 * 🔴 THE UNCAUGHT-ERROR ASSERTION IS FIRST INSIDE THE WAIT, deliberately. A run
 * that brings the tree down can never render the successor, so a wait ordered
 * the other way fails as an anonymous 8 s timeout that attributes to nothing.
 * Ordered this way `waitFor` rethrows THIS assertion, and the failure names the
 * TypeError and the `App.tsx` line that raised it.
 */
async function settled(uncaught: { seen: string[] }, what: string) {
  await waitFor(
    () => {
      expect(uncaught.seen.join(' | '), `${what} and threw out of the reducer`).toBe('');
      expect(rows()).toHaveLength(1);
      expect(screen.getByText(/Nothing looked up here/)).toBeTruthy();
    },
    { timeout: 8000 },
  );
}

describe('deleting a chat takes its transcript with it', () => {
  beforeEach(() => {
    h.storage = fakeAppStorage();
    pollQueue = [];
    toolItems = [];
    submitFn.mockClear();
    pollFn.mockClear();
    clearCache();
    installFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('🔴 DELETING THE SELECTED CHAT CLEARS IT even when the successor will not load', () => {
    return (async () => {
      const { grounded } = await twoChatsGroundedFirst();

      // The successor's load is what would otherwise overwrite the pair. Break
      // it, so what survives the delete is what the viewer is left looking at.
      breakMessageReads();

      fireEvent.click(screen.getByTestId(`delete-session-${grounded}`));

      await waitFor(() => expect(rows()).toHaveLength(1));
      await waitFor(() => expect(screen.getByText(/Couldn't open that chat/)).toBeTruthy());

      expect(
        screen.queryByText(/is great/),
        'the deleted chat’s transcript is still on screen',
      ).toBeNull();
      expect(
        anchorFor(DREAMSHAPER),
        'the deleted chat’s citation is still a live link',
      ).toBeNull();
    })();
  });

  it('🔴 DELETING THE CHAT ON SCREEN CLEARS IT even when the SELECTION already moved', () => {
    return (async () => {
      // 🔴 THE PREDICATE DISCRIMINATOR. Here the deleted chat is NOT the selected
      // one — a failed switch left the selection on the other chat while this
      // transcript stayed on screen. A clear keyed on `activeSessionId` does
      // nothing at all in this case and the deleted conversation stays visible,
      // links and all, with no route left that can ever replace it.
      const { grounded, other } = await twoChatsGroundedFirst();

      breakMessageReads();

      // Switch away. The read rejects, so the selection moves and the transcript
      // does not — the durable disagreement.
      fireEvent.click(screen.getByTestId(`session-item-${other}`));
      await waitFor(() => expect(screen.getByText(/Couldn't open that chat/)).toBeTruthy());
      expect(screen.getByText(/is great/), 'the outgoing transcript should still be up').toBeTruthy();
      expect(anchorFor(DREAMSHAPER), 'and still linked — that is the #45 fix').toBeTruthy();

      // Now delete the chat that is on screen but no longer selected.
      fireEvent.click(screen.getByTestId(`delete-session-${grounded}`));
      await waitFor(() => expect(rows()).toHaveLength(1));

      await waitFor(() =>
        expect(
          screen.queryByText(/is great/),
          'the deleted chat’s transcript is still on screen',
        ).toBeNull(),
      );
      expect(
        anchorFor(DREAMSHAPER),
        'the deleted chat’s citation is still a live link',
      ).toBeNull();
    })();
  });

  it('a send is REFUSED between the delete and the successor loading', () => {
    return (async () => {
      // ⚠️ THIS IS RED AT `be24d6c` ON ITS PRECONDITION, NOT ON ITS SUBJECT, and
      // the distinction is the whole reason this note exists. At base the
      // deleted transcript is still up, so `turns()` is 2 and the run stops
      // there; the REFUSAL below is never reached. Base would in fact refuse the
      // send — it leaves `messagesSessionId` on the deleted id, which fails the
      // same guard for a different reason — so do not read this case as
      // regression coverage of the refusal. Its job is mutant M4.
      //
      // 🔴 IT IS HERE FOR THE `null` IN THE FIX, WHICH IS THE ONE CHOICE THAT
      // COULD LOSE DATA. Pairing the cleared transcript with the SUCCESSOR's id
      // — the shape `createSession` uses, and the obvious-looking edit here —
      // makes `messagesSessionId === activeSessionId` true while `messages` is
      // `[]` and the successor's stored transcript is unread. `handleSend` then
      // accepts, appends to the empty array, and `saveMessages` writes that
      // array over the successor's key. Measured as mutant M4: this case is the
      // only one in the file that goes red for it.
      const { grounded, other } = await twoChatsGroundedFirst();
      const key = `sensei:messages:${other}`;
      const storedBefore = h.storage!.store.get(key);
      expect(
        (storedBefore as unknown[] | undefined)?.length,
        'the successor needs a stored transcript worth losing',
      ).toBeGreaterThan(0);

      breakMessageReads();
      fireEvent.click(screen.getByTestId(`delete-session-${grounded}`));
      await waitFor(() => expect(rows()).toHaveLength(1));
      await waitFor(() => expect(screen.getByText(/Couldn't open that chat/)).toBeTruthy());

      const turns = () =>
        document.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]')
          .length;
      expect(turns(), 'the screen should be empty after the delete').toBe(0);
      const submitsBefore = submitFn.mock.calls.length;

      fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'recommend something' } });
      fireEvent.click(screen.getByTestId('send-button'));
      await waitFor(() => expect(screen.getByText(/Couldn't open that chat/)).toBeTruthy());

      expect(
        turns(),
        'a turn was accepted against a transcript that has not been loaded yet',
      ).toBe(0);
      expect(submitFn.mock.calls.length, 'the turn reached the orchestrator').toBe(submitsBefore);
      expect(
        h.storage!.store.get(key),
        'the successor’s stored transcript was overwritten by a turn sent into an empty array',
      ).toEqual(storedBefore);
    })();
  });

  it('a delete that does NOT touch the transcript on screen leaves it alone', () => {
    return (async () => {
      // INVARIANT GUARD, not regression coverage: the base commit passes this
      // too. It is here so the two cases above cannot be satisfied by a
      // `deleteSession` that clears the transcript unconditionally — which would
      // blank the screen every time a viewer tidied up an unrelated old chat.
      const { other } = await twoChatsGroundedFirst();

      breakMessageReads();
      fireEvent.click(screen.getByTestId(`delete-session-${other}`));
      await waitFor(() => expect(rows()).toHaveLength(1));

      expect(screen.getByText(/is great/)).toBeTruthy();
      expect(anchorFor(DREAMSHAPER)).toBeTruthy();
    })();
  });

  it('🔴 DELETING MID-REPLAY SURVIVES A SUCCESSOR READ THAT TAKES 150ms', () => {
    return (async () => {
      // 🔴 THE ORDINARY HAPPY PATH. Nothing is broken, the successor has a
      // stored transcript and its read SUCCEEDS; the only variable is that it
      // takes 150 ms. Chunks keep arriving through that window, and the first
      // one to land after the delete is the one that used to bring the tree
      // down. Reaches the `onChunk` updater.
      const { grounded, other } = await twoChatsGroundedFirst();
      const uncaught = captureUncaught();
      try {
        const delayed = delayMessageReads(150);

        // 60 words ≈ 1.2 s of streaming, so the whole 150 ms read window sits
        // inside the replay with room either side.
        pollQueue = [textSnapshot(longReply(60))];
        await startTurn('tell me more');
        await waitFor(() => expect(document.body.textContent).toContain('word0'));

        fireEvent.click(screen.getByTestId(`delete-session-${grounded}`));
        await settled(uncaught, 'a chunk landed on the cleared transcript');

        // 🔴 THE KNOB'S POSITIVE CONTROL. Without this the case passes on a
        // fixture that resolved instantly — which is the exact shape that hid
        // this defect from 548 green tests.
        const successorRead = delayed.find((d) => d.key === `sensei:messages:${other}`);
        expect(successorRead, 'the successor read never went through the delay').toBeTruthy();
        expect(successorRead!.elapsedMs).toBeGreaterThanOrEqual(140);

        // Let the orphaned turn finish before the test ends. Without this the
        // stream is still replaying at teardown and its `finally` dispatches a
        // `setIsStreaming` into a torn-down jsdom — an unhandled rejection that
        // fails the RUN while every test passes.
        await waitFor(() => expect(screen.queryByTestId('streaming-indicator')).toBeNull(), {
          timeout: 8000,
        });
      } finally {
        uncaught.restore();
      }
    })();
  }, 20000);

  it('🔴 A REPLY THAT COMPLETES INSIDE THE READ WINDOW LANDS ON THE CLEARED TRANSCRIPT', () => {
    return (async () => {
      // Same shape, different updater: the reply finishes streaming (~600 ms)
      // while the successor read is still out (1.5 s), so it is the FINAL
      // commit — not a chunk — that meets `[]`. Reaches the `replyText`
      // updater, which no amount of chunk-guarding covers.
      const { grounded, other } = await twoChatsGroundedFirst();
      const uncaught = captureUncaught();
      try {
        const delayed = delayMessageReads(1500);

        pollQueue = [textSnapshot(longReply(30))];
        await startTurn('tell me more');
        await waitFor(() => expect(document.body.textContent).toContain('word0'));

        fireEvent.click(screen.getByTestId(`delete-session-${grounded}`));
        await settled(uncaught, 'the completed reply was committed onto the cleared transcript');

        const successorRead = delayed.find((d) => d.key === `sensei:messages:${other}`);
        expect(successorRead, 'the successor read never went through the delay').toBeTruthy();
        expect(successorRead!.elapsedMs).toBeGreaterThanOrEqual(1400);

        // Let the orphaned turn finish before the test ends. Without this the
        // stream is still replaying at teardown and its `finally` dispatches a
        // `setIsStreaming` into a torn-down jsdom — an unhandled rejection that
        // fails the RUN while every test passes.
        await waitFor(() => expect(screen.queryByTestId('streaming-indicator')).toBeNull(), {
          timeout: 8000,
        });
      } finally {
        uncaught.restore();
      }
    })();
  }, 20000);

  it('🔴 A TURN THAT FAILS INSIDE THE READ WINDOW LANDS ON THE CLEARED TRANSCRIPT', () => {
    return (async () => {
      // The error exit is a third updater with the same shape. A `running`
      // snapshot buys the bridge's 1 s poll gap to delete inside; the failure
      // then arrives while the successor read (1.5 s) is still out, so the
      // "Error: …" write meets `[]`. Reaches the `catch` updater.
      const { grounded, other } = await twoChatsGroundedFirst();
      const uncaught = captureUncaught();
      try {
        const delayed = delayMessageReads(1500);

        pollQueue = [
          { workflowId: 'wf-run', status: 'running' },
          { workflowId: 'wf-run', status: 'failed', error: 'the workflow failed' },
        ];
        await startTurn('tell me more');

        fireEvent.click(screen.getByTestId(`delete-session-${grounded}`));
        await settled(uncaught, "the failed turn's error was committed onto the cleared transcript");

        const successorRead = delayed.find((d) => d.key === `sensei:messages:${other}`);
        expect(successorRead, 'the successor read never went through the delay').toBeTruthy();
        expect(successorRead!.elapsedMs).toBeGreaterThanOrEqual(1400);

        // Let the orphaned turn finish before the test ends. Without this the
        // stream is still replaying at teardown and its `finally` dispatches a
        // `setIsStreaming` into a torn-down jsdom — an unhandled rejection that
        // fails the RUN while every test passes.
        await waitFor(() => expect(screen.queryByTestId('streaming-indicator')).toBeNull(), {
          timeout: 8000,
        });
      } finally {
        uncaught.restore();
      }
    })();
  }, 20000);
});
