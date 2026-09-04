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
});
