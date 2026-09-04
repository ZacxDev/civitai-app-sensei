import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import type { UseAppStorage } from '@civitai/blocks-react';
import { App } from './App.js';
import { fakeAppStorage, fakeBlockCatalogApi } from './test-helpers.js';
import { clearCache } from './lib/research.js';

// ─────────────────────────────────────────────────────────────────────────────
// A SEND THE APP WILL REFUSE MUST NOT BE ACCEPTED BY THE COMPOSER.
//
// `handleSend` refuses while `messagesSessionId !== activeSessionId` — the
// transcript on screen is not the selected conversation's — and that refusal is
// correct: the turn would be appended to one conversation's array and rendered
// against another's grounded set (#46). What it did NOT have was any outward
// sign. The composer stayed live, Send stayed enabled, `ChatArea` cleared the
// box the instant it was pressed, and the parent then returned without sending.
// The viewer's question vanished and nothing at all replaced it.
//
// TWO WINDOWS, and the second is the one that makes this worth a fix:
//  - TRANSIENT: between clicking a session and its messages arriving.
//  - DURABLE: if that read REJECTS. The catch shows "Couldn't open that chat …"
//    and leaves `messagesSessionId` pointing at the OUTGOING conversation
//    INDEFINITELY, so every press from then on is discarded the same way.
//
// 🔴 THE STORAGE FAKE IS ONE INSTANCE WITH A PROGRAMMABLE MESSAGE READ. Every
// other observable here is downstream of `getMessages` resolving, parking or
// rejecting, so the read is the only thing these tests vary. A fake that
// resolved every read could not reach either window at all.
//
// 🔴 WHAT THESE TESTS ASSERT IS STATE, NOT COPY: the Send control's `disabled`
// property and a notice keyed by `data-testid`. A guard spelled as a sentence is
// walkable by rewording it, and the two windows carry DIFFERENT testids so an
// implementation that renders one notice for both fails the arm it is wrong
// about.
// ─────────────────────────────────────────────────────────────────────────────

const MESSAGES_PREFIX = 'sensei:messages:';

/** How the message read for a given session id behaves. */
type ReadMode = 'ok' | 'park' | 'reject';

let storage = fakeAppStorage();
let readMode: Record<string, ReadMode> = {};
/** Resolvers for reads currently parked, so a test can release them. */
let parked: Array<() => void> = [];
/** The ONE storage object the app sees for a whole test. */
let appStorage: UseAppStorage;

function makeControlledStorage(): UseAppStorage {
  const inner = storage.appStorage;
  return {
    ...inner,
    async get<T = unknown>(key: string) {
      if (key.startsWith(MESSAGES_PREFIX)) {
        const id = key.slice(MESSAGES_PREFIX.length);
        const mode = readMode[id] ?? 'ok';
        if (mode === 'park') {
          await new Promise<void>((r) => {
            parked.push(r);
          });
        } else if (mode === 'reject') {
          throw new Error('storage is unavailable');
        }
      }
      return inner.get<T>(key);
    },
  };
}

const trackFn = vi.fn();
const requestConsentFn = vi.fn();
const requestSignInFn = vi.fn();
const submitFn = vi.fn(async () => ({ workflowId: 'wf-1', status: 'pending' }));
const pollFn = vi.fn(async () => ({
  workflowId: 'wf-1',
  status: 'succeeded',
  cost: { total: 1 },
  textOutputs: ['an answer'],
}));

vi.mock('@civitai/blocks-react', () => ({
  // Resolved at CALL time, so the object identity is stable for a whole test —
  // a fake handing back a fresh identity per render silently repairs a missing
  // dependency-array entry (see `mention-grounding.e2e.test.tsx`).
  useAppStorage: () => appStorage,
  useBlockAnalytics: () => ({ track: trackFn }),
  useBlockContext: () => ({ ready: true, viewer: { id: 1 }, theme: 'dark' }),
  useBlockResize: () => {},
  useRequestConsent: () => ({ requestConsent: requestConsentFn }),
  useRequestSignIn: () => ({ requestSignIn: requestSignInFn }),
  useResourcePicker: () => ({ open: vi.fn().mockResolvedValue(null) }),
  // FULL scopes and a signed-in viewer, deliberately: `sendGate` must be `null`
  // throughout, or these tests would be exercising the capability gate instead
  // of the window they are about. Asserted, not assumed — see the reachability
  // block in the second test.
  useBlockToken: () => ({ raw: 'block-jwt-test', scopes: ['ai:write:budgeted', 'buzz:read:self'] }),
  useBuzzBalance: () => ({ balance: { blue: 100, green: 0, yellow: 200 } }),
  useBuzzWorkflow: () => ({
    estimate: vi
      .fn()
      .mockResolvedValue({ workflowId: 'est-1', status: 'succeeded', cost: { total: 1 } }),
    submit: submitFn,
    poll: pollFn,
    cancel: vi.fn().mockResolvedValue(undefined),
    status: 'idle',
    result: null,
    error: null,
  }),
}));

// ---- Driving the app ------------------------------------------------------

function sessionIds(): string[] {
  return Array.from(document.querySelectorAll('[data-testid^="session-item-"]')).map((el) =>
    el.getAttribute('data-testid')!.slice('session-item-'.length),
  );
}

async function boot() {
  render(<App />);
  await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
}

/** Create a session and return its id, read off the DOM rather than assumed from list order. */
async function newSession(): Promise<string> {
  const before = new Set(sessionIds());
  fireEvent.click(screen.getByTestId('new-session-button'));
  let created = '';
  await waitFor(() => {
    const fresh = sessionIds().filter((id) => !before.has(id));
    expect(fresh).toHaveLength(1);
    created = fresh[0];
  });
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
  return created;
}

/**
 * Put sessions in storage BEFORE boot, newest first.
 *
 * 🔴 NOT "+ New" THREE TIMES. `createSession` RECYCLES an unused chat that is
 * not the one on screen, so the third press selects the first row instead of
 * minting a row — correct behaviour, and it makes a three-session fixture
 * unbuildable through that button.
 */
function seedSessions(ids: string[]) {
  const now = Date.now();
  storage.store.set('sensei:sessions', {
    sessions: ids.map((id, i) => ({
      id,
      title: `Chat ${id}`,
      model: 'test-model',
      createdAt: now - i * 1000,
      updatedAt: now - i * 1000,
    })),
  });
}

function switchTo(id: string) {
  fireEvent.click(screen.getByTestId(`session-item-${id}`));
}

function sendButton(): HTMLButtonElement {
  return screen.getByTestId('send-button') as HTMLButtonElement;
}

function input(): HTMLTextAreaElement {
  return screen.getByTestId('chat-input') as HTMLTextAreaElement;
}

function type(text: string) {
  fireEvent.change(input(), { target: { value: text } });
}

/** Every rendered turn, both roles — what the viewer can actually see. */
function turns(): number {
  return document.querySelectorAll(
    '[data-testid="message-user"], [data-testid="message-assistant"]',
  ).length;
}

/** Let every already-scheduled microtask and timer-0 continuation run. */
async function settle(ms = 20) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

let api: ReturnType<typeof fakeBlockCatalogApi>;

beforeEach(() => {
  storage = fakeAppStorage();
  appStorage = makeControlledStorage();
  readMode = {};
  parked = [];
  trackFn.mockClear();
  requestConsentFn.mockClear();
  requestSignInFn.mockClear();
  submitFn.mockClear();
  pollFn.mockClear();
  clearCache();
  api = fakeBlockCatalogApi();
});

afterEach(() => {
  api.restore();
  cleanup();
});

/**
 * Two sessions, then switch to the first with its message read set to `mode`.
 * Returns both ids.
 */
async function switchIntoWindow(mode: ReadMode) {
  await boot();
  const first = await newSession();
  const second = await newSession();
  readMode[first] = mode;
  switchTo(first);
  await settle();
  return { first, second };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('the composer says so while the selected chat is not the one on screen', () => {
  it('🔴 TRANSIENT: Send is disabled and the state is shown while the transcript loads', async () => {
    await switchIntoWindow('park');
    type('which is better for anime?');

    expect(
      sendButton().disabled,
      'Send is live while the transcript on screen belongs to another chat — ' +
        '`handleSend` refuses this press and discards it with no feedback at all',
    ).toBe(true);
    expect(
      screen.queryByTestId('transcript-loading-notice'),
      'nothing on screen tells the viewer why the send is refused',
    ).toBeTruthy();
    // The two windows must read differently — this one is not the failure.
    expect(screen.queryByTestId('transcript-failed-notice')).toBeNull();
  });

  it('🔴 TRANSIENT: neither Send nor Enter is ACCEPTED — the question is not eaten', async () => {
    await switchIntoWindow('park');
    type('which is better for anime?');

    // Both doors. `disabled` is a UI affordance; the keyboard path goes straight
    // to `ChatArea`'s own handler, which used to clear the box before the parent
    // could refuse.
    fireEvent.click(sendButton());
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: false });
    await settle();

    expect(
      input().value,
      'the composer cleared a question it never sent — the 0.1.0–0.1.3 "Send is dead" signature',
    ).toBe('which is better for anime?');
    expect(submitFn, 'a refused send reached the orchestrator').not.toHaveBeenCalled();

    // ── REACHABILITY. ────────────────────────────────────────────────────────
    // 🔴 A GUARD THAT NEVER EXECUTES PASSES ITS MUTATION TEST FOR THE WRONG
    // REASON. `handleSend` refuses in this order: `!activeSessionId`,
    // `isStreaming`, the transcript check, then `sendGate`. These four
    // assertions say none of the others is what stopped this press, so the state
    // under test is genuinely the one reached.
    expect(screen.getByTestId('chat-input'), 'no session is selected').toBeTruthy();
    expect(screen.queryByTestId('streaming-indicator'), 'a turn is in flight').toBeNull();
    expect(screen.queryByTestId('consent-notice'), 'the capability gate is what fired').toBeNull();
    expect(screen.queryByTestId('signin-notice'), 'the capability gate is what fired').toBeNull();
    expect(requestConsentFn).not.toHaveBeenCalled();
    expect(requestSignInFn).not.toHaveBeenCalled();
  });

  it('🔴 DURABLE: a REJECTED read leaves the composer disabled with the failure shown', async () => {
    await switchIntoWindow('reject');

    // The pre-existing app-level banner still reports the failure…
    expect(await screen.findByTestId('storage-error-dismiss')).toBeTruthy();

    type('which is better for anime?');
    expect(
      sendButton().disabled,
      'after a FAILED read the composer still accepts presses that go nowhere, indefinitely',
    ).toBe(true);
    expect(
      screen.queryByTestId('transcript-failed-notice'),
      'the durable window is not reported as a failure',
    ).toBeTruthy();
    // …and it does not claim to still be loading, because it is not.
    expect(
      screen.queryByTestId('transcript-loading-notice'),
      'a read that already REJECTED is reported as still loading',
    ).toBeNull();

    // DURABLE means durable: nothing resolves this on its own.
    await settle(50);
    expect(sendButton().disabled).toBe(true);
    expect(screen.queryByTestId('transcript-failed-notice')).toBeTruthy();
  });

  it("🔴 a PREVIOUS chat's failure is not reported against the NEXT one", async () => {
    // The failure verdict is per-read. Without the reset at the top of the load
    // effect it would persist, so the very next switch — a perfectly healthy
    // read still in flight — would tell the viewer that chat "didn't open".
    //
    // THREE sessions, not two, and that is a fact about the app rather than
    // padding: a failed read leaves `messagesSessionId` on the conversation that
    // was already on screen, so switching back to THAT one makes the pair agree
    // at once and opens no second window to read the stale verdict against. `c`
    // is neither the one on screen nor the one that failed, so it does.
    seedSessions(['s-a', 's-b', 's-c']);
    await boot();
    // `s-a` is newest, so it is what boot opened and what stays on screen.
    expect(screen.getByTestId('chat-input')).toBeTruthy();

    readMode['s-b'] = 'reject';
    switchTo('s-b');
    await settle();
    expect(screen.queryByTestId('transcript-failed-notice')).toBeTruthy();

    // Now open a different one, whose read is merely SLOW.
    readMode['s-c'] = 'park';
    switchTo('s-c');
    await settle();

    expect(
      screen.queryByTestId('transcript-loading-notice'),
      "the previous chat's failure was carried onto a healthy read",
    ).toBeTruthy();
    expect(screen.queryByTestId('transcript-failed-notice')).toBeNull();
  });

  it('POSITIVE CONTROL: the same composer is live once the transcript arrives', async () => {
    // 🔴 Without this, every assertion above is satisfied by a composer that is
    // disabled ALWAYS — which would be a worse defect than the one being fixed,
    // and invisible to the three tests above. Same path, same fixture, read
    // allowed to resolve.
    await switchIntoWindow('ok');
    await waitFor(() => expect(screen.queryByTestId('transcript-loading-notice')).toBeNull());
    expect(screen.queryByTestId('transcript-failed-notice')).toBeNull();

    type('which is better for anime?');
    expect(sendButton().disabled).toBe(false);

    fireEvent.click(sendButton());
    await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(1));
    expect(input().value).toBe('');
  });

  it('POSITIVE CONTROL: releasing a PARKED read re-opens the composer', async () => {
    // The transient window is transient. This also proves the parked read in the
    // tests above is a real in-flight read and not a fixture that never fires.
    const { first } = await switchIntoWindow('park');
    expect(sendButton().disabled).toBe(true);

    readMode[first] = 'ok';
    await act(async () => {
      parked.forEach((r) => r());
      parked = [];
    });
    await settle();

    expect(screen.queryByTestId('transcript-loading-notice')).toBeNull();
    type('which is better for anime?');
    expect(sendButton().disabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REGENERATE IS A SEND, AND IT IS THE ONE THAT NEVER TOUCHES THE COMPOSER.
//
// 🔴 THIS IS WHERE `App.handleSend`'s TRANSCRIPT REFUSAL IS ACTUALLY PINNED.
// Every assertion in the block above is satisfied by the composer alone: Send is
// `disabled` and `ChatArea.handleSend` returns on `sendPaused`, each
// independently, so deleting `handleSend`'s `if (transcriptPending) return;`
// leaves all of them — and `citation-grounding.e2e.test.tsx`'s send case —
// GREEN. Measured, both directions, in #49's round-1 audit and again here.
// `handleRegenerate` calls `handleSend` directly and renders its button in the
// message list, so this is the only route left that reaches that guard.
//
// 🔴 AND THE ROUTE HAD ITS OWN HOLE. Until this round `handleRegenerate` removed
// the reply from view BEFORE calling `handleSend`, and it asked `sendGate` and
// `!activeSessionId || isStreaming` but never the transcript question — so one
// click in the durable window took visible turns 2 → 1 with the submit count
// unmoved. The remedy was to stop DESTROYING rather than to copy the predicate:
// a copy in `handleRegenerate` would have shadowed the App guard exactly as the
// composer does, closing the last route that can see it. See the block at the
// top of `handleRegenerate`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two chats with one real exchange in the FIRST, which is the one left on
 * screen. A caller enters a window by setting `readMode[second]` and switching
 * to it, so the transcript on screen — and the Regenerate button rendered in it
 * — belongs to `first` while `activeSessionId` is `second`.
 */
async function transcriptWithAReply() {
  await boot();
  const first = await newSession();
  const second = await newSession();
  switchTo(first);
  await settle();

  type('what is DreamShaper?');
  fireEvent.click(sendButton());
  await waitFor(() => expect(screen.getByText('an answer')).toBeTruthy(), { timeout: 8000 });
  await waitFor(() => expect(screen.queryByTestId('streaming-indicator')).toBeNull());
  await waitFor(() => expect(screen.getByTestId('send-button')).toBeTruthy());
  expect(turns(), 'the fixture did not produce a transcript to regenerate').toBe(2);
  expect(submitFn, 'the first exchange never reached the orchestrator').toHaveBeenCalledTimes(1);

  return { first, second };
}

/**
 * None of the checks that run BEFORE the transcript refusal is what stopped the
 * press — so the state under test is genuinely the one reached.
 *
 * `handleRegenerate` refuses on `sendGate` and on `!activeSessionId ||
 * isStreaming`; `handleSend` then refuses on `!activeSessionId || isStreaming`,
 * on the transcript, and on `sendGate`, in that order. This asserts every one of
 * those EXCEPT the transcript check is false.
 */
function expectNothingElseRefusedIt() {
  expect(screen.getByTestId('chat-input'), 'no session is selected').toBeTruthy();
  expect(screen.queryByTestId('streaming-indicator'), 'a turn is in flight').toBeNull();
  expect(screen.queryByTestId('consent-notice'), 'the capability gate is what fired').toBeNull();
  expect(screen.queryByTestId('signin-notice'), 'the capability gate is what fired').toBeNull();
  expect(requestConsentFn).not.toHaveBeenCalled();
  expect(requestSignInFn).not.toHaveBeenCalled();
  // The button really is offered — a refusal proved by an absent control would
  // be a fact about the render, not about the guard.
  const btn = screen.getByTestId('regenerate-button') as HTMLButtonElement;
  expect(btn.disabled, 'Regenerate was disabled, so this press never reached the app').toBe(false);
}

describe('Regenerate while the selected chat is not the one on screen', () => {
  it('🔴 DURABLE: Regenerate destroys nothing and sends nothing', async () => {
    const { second } = await transcriptWithAReply();
    readMode[second] = 'reject';
    switchTo(second);
    await settle();
    expect(screen.queryByTestId('transcript-failed-notice')).toBeTruthy();

    expectNothingElseRefusedIt();
    fireEvent.click(screen.getByTestId('regenerate-button'));
    await settle();

    // 🔴 THE LEAK FIRST, THEN THE LOSS. The two directions fail this case for
    // different reasons and each must say which: an accepted turn is the
    // cross-conversation grounding leak `handleSend`'s guard exists to refuse; a
    // missing turn is the reply destroyed ahead of a refusal.
    expect(
      submitFn,
      'Regenerate sent a turn into the selected chat while the transcript on ' +
        'screen — and the grounded set it renders against — belonged to another chat',
    ).toHaveBeenCalledTimes(1);
    expect(
      turns(),
      'the transcript on screen MOVED on a Regenerate the app refuses: fewer turns ' +
        'means the reply was destroyed ahead of the refusal, with nothing on this ' +
        'screen to bring it back; more means the turn was accepted into the wrong chat',
    ).toBe(2);
    expect(
      screen.queryByText('an answer'),
      'the reply Regenerate could not re-send was taken off the screen anyway',
    ).toBeTruthy();
  });

  it('🔴 TRANSIENT: the same, while the read is still in flight', async () => {
    const { second } = await transcriptWithAReply();
    readMode[second] = 'park';
    switchTo(second);
    await settle();
    expect(screen.queryByTestId('transcript-loading-notice')).toBeTruthy();

    expectNothingElseRefusedIt();
    fireEvent.click(screen.getByTestId('regenerate-button'));
    await settle();

    expect(
      submitFn,
      'Regenerate sent a turn while the transcript on screen belonged to another chat',
    ).toHaveBeenCalledTimes(1);
    expect(
      turns(),
      'the transcript on screen MOVED on a Regenerate the app refuses — destroyed ' +
        'ahead of the refusal, or accepted into the wrong chat',
    ).toBe(2);
  });

  it('POSITIVE CONTROL: Regenerate DOES re-send once the two agree', async () => {
    // 🔴 Without this, both cases above are satisfied by a Regenerate that never
    // sends anything under any conditions — and by a fixture whose second submit
    // was never reachable. Same fixture, same button, no window entered.
    await transcriptWithAReply();
    expect(screen.queryByTestId('transcript-failed-notice')).toBeNull();
    expect(screen.queryByTestId('transcript-loading-notice')).toBeNull();

    fireEvent.click(screen.getByTestId('regenerate-button'));
    await waitFor(() => expect(submitFn).toHaveBeenCalledTimes(2), { timeout: 8000 });
  });
});
