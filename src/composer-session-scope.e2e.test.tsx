import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage, BLOCK_GENERATION_RESOURCE } from './test-helpers.js';
import { clearCache } from './lib/research.js';

// ─────────────────────────────────────────────────────────────────────────────
// THE COMPOSER BELONGS TO ONE CONVERSATION — ALL OF IT, AND AT EVERY INSTANT.
//
// Two properties, both of which a green suite has already been wrong about.
//
// 1. WHAT A SESSION SWITCH CLEARS. `App`'s `[activeSessionId]` effect clears
//    three App-owned cells; `ChatArea`'s `key` clears the two it owns itself.
//    Each of the five gets its OWN test here, because a comment arguing for
//    five clears is not coverage of five clears — the effect's three survived a
//    reduction to one against all 351 tests before this file existed.
//
// 2. WHEN THE ATTACH GATE IS READ. `handlePickMention` spans two awaits, so the
//    gate it was entered with is not necessarily the gate in force when it
//    issues an authenticated, rate-limited resolve.
//
// 🔴 THE HOOK IDENTITIES BELOW ARE HOISTED, AND `useBlockToken` IS BACKED BY
// REAL `useState`. Both are correctness requirements of the fixture, not
// tidiness — the reasoning is spelled out at length in
// `mention-grounding.e2e.test.tsx`: a hook returning a fresh identity every
// render silently repairs any missing dependency-array entry, so a stale-closure
// bug becomes invisible to the whole suite while being live in production. The
// `useState` here is the other half of the same requirement: a re-mint is
// observable to this app ONLY as `useBlockToken()` returning different scopes on
// a LATER RENDER, and a plain mutable module variable changes no render at all.
// ─────────────────────────────────────────────────────────────────────────────

const VIEWER = { id: 1 };
const FULL_SCOPES = ['ai:write:budgeted', 'buzz:read:self'];
/** The `useBlockToken` state setter, captured from the last render. */
let setScopes: ((s: string[]) => void) | null = null;

const requestConsentFn = vi.fn();
const requestSignInFn = vi.fn();
const trackFn = vi.fn();

/** What the HOST's picker resolves with. */
let pickerResult: { versionId: number } | null = null;
let pickerCalls = 0;
/**
 * When true, `open()` parks until the test releases it — this is the host modal
 * standing open, which is the whole window FIX C is about.
 */
let deferPicker = false;
let releasePicker: (() => void) | null = null;

const openPickerFn = async (_opts: Record<string, unknown>) => {
  pickerCalls += 1;
  if (deferPicker) {
    await new Promise<void>((r) => {
      releasePicker = r;
    });
  }
  return pickerResult;
};

let resolveCalls: string[] = [];
let toolPosts: string[] = [];
/** When true, the tool POST parks, so a lookup stays in flight and observable. */
let holdToolPost = false;

let storage = fakeAppStorage();
let pollQueue: Array<Record<string, unknown>> = [];

const estimateFn = vi
  .fn()
  .mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } });
const submitFn = vi.fn(async () => ({ workflowId: 'wf-1', status: 'pending' }));
const pollFn = vi.fn(async () => {
  const next = pollQueue.shift();
  return (
    next ?? { workflowId: 'wf-x', status: 'succeeded', cost: { total: 1 }, textOutputs: ['done'] }
  );
});
const cancelFn = vi.fn().mockResolvedValue(undefined);

vi.mock('@civitai/blocks-react', async () => {
  const { useState } = await import('react');
  return {
    useAppStorage: () => storage.appStorage,
    useBlockAnalytics: () => ({ track: trackFn }),
    useBlockContext: () => ({ ready: true, viewer: VIEWER, theme: 'dark' }),
    useBlockResize: () => {},
    useRequestConsent: () => ({ requestConsent: requestConsentFn }),
    useRequestSignIn: () => ({ requestSignIn: requestSignInFn }),
    // Real state, so a re-mint is a RENDER — see the header.
    useBlockToken: () => {
      const [scopes, set] = useState<string[]>(FULL_SCOPES);
      setScopes = set;
      return { raw: 'block-jwt-test', scopes };
    },
    useBuzzBalance: () => ({ balance: { blue: 100, green: 0, yellow: 200 } }),
    useResourcePicker: () => ({ open: openPickerFn }),
    useBuzzWorkflow: () => ({
      estimate: estimateFn,
      submit: submitFn,
      poll: pollFn,
      cancel: cancelFn,
      status: 'idle',
      result: null,
      error: null,
    }),
  };
});

const A = BLOCK_GENERATION_RESOURCE;

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

/** Ids the resolve endpoint releases. Anything else is DROPPED, as the clamp does. */
let resolvable = [A];

let originalFetch: typeof globalThis.fetch;

function installFetch() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';

    if (url.includes('/api/v1/blocks/generation-resources')) {
      resolveCalls.push(url);
      const asked = new URL(url).searchParams.get('ids')!.split(',').map(Number);
      const items = resolvable.filter((r) => asked.includes(r.versionId));
      return new Response(JSON.stringify({ items, maturity: { browsingLevel: 1, sfwOnly: true } }), {
        status: 200,
      });
    }
    if (url.includes('/api/v1/blocks/tools')) {
      if (method === 'GET') {
        return new Response(JSON.stringify({ tools: DECLARATIONS }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { name: string };
      toolPosts.push(body.name);
      if (holdToolPost) {
        // Parks forever. Nothing aborts a turn on unmount (see
        // `App.unmount-turn.e2e.test.tsx`), so this promise is simply never
        // settled and the parked turn is collected with the test.
        await new Promise<void>(() => {});
      }
      return new Response(JSON.stringify({ items: [], truncated: 0 }), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof globalThis.fetch;
}

function toolCallSnapshot(query: string) {
  return {
    workflowId: 'wf-tool',
    status: 'succeeded',
    cost: { total: 1 },
    toolCalls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'search_models', arguments: JSON.stringify({ query }) },
      },
    ],
  };
}

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

function switchTo(id: string) {
  fireEvent.click(screen.getByTestId(`session-item-${id}`));
}

/** Attach a resource through the real controls: menu → type → host picker → resolve. */
async function attach(versionId: number) {
  pickerResult = { versionId };
  fireEvent.click(screen.getByTestId('add-mention-button'));
  fireEvent.click(screen.getByTestId('mention-type-Checkpoint'));
  await waitFor(() => expect(pickerCalls).toBeGreaterThan(0));
}

function inputValue(): string {
  return (screen.getByTestId('chat-input') as HTMLTextAreaElement).value;
}

/** Let every already-scheduled microtask and timer-0 continuation run. */
async function settle(ms = 20) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

beforeEach(() => {
  pickerCalls = 0;
  pickerResult = null;
  deferPicker = false;
  releasePicker = null;
  resolveCalls = [];
  toolPosts = [];
  holdToolPost = false;
  resolvable = [A];
  pollQueue = [];
  storage = fakeAppStorage();
  setScopes = null;
  requestConsentFn.mockClear();
  requestSignInFn.mockClear();
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
describe('a session switch clears the WHOLE composer, not the half App owns', () => {
  // ── ChatArea-owned state (closed by `key={activeSessionId}`) ───────────────

  it('🔴 clears the TYPED QUESTION when the conversation changes', async () => {
    // THE DEFECT THIS PINS. `pendingMentions` is cleared by the effect, but the
    // sentence the viewer typed lives in `ChatArea`'s own `input`, which no
    // effect can reach. The result was strictly worse than either whole
    // behaviour: the question stayed on screen exactly as written while its
    // grounding was silently removed, and `mentionError` — the one channel that
    // could have said so — was cleared by the same effect. Pressing Send then
    // buys an ungrounded answer, or a second CHARGED `search_models` round,
    // which is the exact cost this feature exists to remove.
    await boot();
    const first = await newSession();
    await newSession();

    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'which is better for anime?' },
    });
    expect(inputValue()).toBe('which is better for anime?');

    switchTo(first);

    await waitFor(() =>
      expect(inputValue(), 'ChatArea input survived the session switch').toBe(''),
    );
  });

  it('🔴 closes an OPEN attach menu when the conversation changes', async () => {
    // The second cell `ChatArea` owns, and the reason the fix is `key=` rather
    // than lifting `input` alone: a menu left standing open belongs to the
    // composer the viewer just left. Lifting one cell and not the other is the
    // per-call-site shape the effect's own comment argues against, one level
    // down.
    await boot();
    const first = await newSession();
    await newSession();

    fireEvent.click(screen.getByTestId('add-mention-button'));
    expect(screen.getByTestId('mention-type-menu')).toBeTruthy();

    switchTo(first);

    await waitFor(() =>
      expect(
        screen.queryByTestId('mention-type-menu'),
        'ChatArea menuOpen survived the session switch',
      ).toBeNull(),
    );
  });

  // ── App-owned state (the `[activeSessionId]` effect's three clears) ────────
  //
  // One test per clear, each written so that removing ONLY its own
  // `setX(...)` line turns it red. The effect's comment argues all three at
  // length; before this block, a mutant reduced to `setPendingMentions([])`
  // alone passed all 351 tests.

  it('🔴 clears ATTACHED RESOURCES when the conversation changes', async () => {
    // Pins `setPendingMentions([])`. These are BILLED grounding — carrying them
    // across attaches another conversation's resources to a question the viewer
    // has not asked yet.
    await boot();
    const first = await newSession();
    await newSession();

    await attach(A.versionId);
    await screen.findByTestId(`mention-${A.versionId}`);

    switchTo(first);

    await waitFor(() =>
      expect(
        screen.queryByTestId(`mention-${A.versionId}`),
        'pendingMentions survived the session switch',
      ).toBeNull(),
    );
    expect(screen.queryByTestId('pending-mentions')).toBeNull();
  });

  it('🔴 clears a FAILED-ATTACH BANNER when the conversation changes', async () => {
    // Pins `setMentionError(null)`. A banner describing an attach that failed on
    // the composer you just left is a statement that is false about the
    // conversation you are now in.
    await boot();
    const first = await newSession();
    await newSession();

    resolvable = []; // the clamp releases nothing
    await attach(A.versionId);
    await screen.findByTestId('mention-error');

    switchTo(first);

    await waitFor(() =>
      expect(
        screen.queryByTestId('mention-error'),
        'mentionError survived the session switch',
      ).toBeNull(),
    );
  });

  it('🔴 clears the IN-FLIGHT LOOKUP LABEL when the conversation changes', async () => {
    // Pins `setLookupQuery(null)`. `ChatArea` renders this label whenever
    // `isStreaming`, and `isStreaming` is INSTANCE-wide — so after a switch an
    // uncleared label reads as the NEW conversation looking something up, using
    // the OLD conversation's query.
    await boot();
    const first = await newSession();
    await newSession();

    holdToolPost = true;
    pollQueue = [toolCallSnapshot('anime checkpoints')];
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'find me something' } });
    fireEvent.click(screen.getByTestId('send-button'));

    // The label is up, and the tool POST is parked so it stays up.
    const label = await screen.findByTestId('lookup-query', undefined, { timeout: 8000 });
    expect(label.textContent).toContain('anime checkpoints');

    switchTo(first);

    await waitFor(() =>
      expect(
        screen.queryByTestId('lookup-query'),
        'lookupQuery survived the session switch',
      ).toBeNull(),
    );
    // 🔴 POSITIVE CONTROL. `isStreaming` is instance-wide and still true, so the
    // null above is a fact about the CLEAR and not about the turn having ended
    // (which would remove the label by removing its whole container).
    expect(screen.getByTestId('streaming-indicator')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the attach gate is re-read after the host modal, not just before it', () => {
  it('🔴 a gate that closes while the picker is open blocks the resolve', async () => {
    // THE WINDOW. `handlePickMention` is entered with the gate OPEN — so
    // `ChatArea`'s own gate lets it through, correctly — and then awaits host
    // chrome. If the host re-mints without `ai:write:budgeted` while its modal
    // stands open (or the viewer signs out in another tab), the pick lands
    // against a gate that has since closed. Without a re-read this issues an
    // authenticated, rate-limited resolve and lands a chip on a composer that
    // cannot send.
    await boot();
    await newSession();

    deferPicker = true;
    await attach(A.versionId);
    await waitFor(() => expect(releasePicker).not.toBeNull());

    // The host re-mints WITHOUT the spend scope, while its modal is open.
    await act(async () => {
      setScopes!(['buzz:read:self']);
    });

    // Now the viewer's pick comes back.
    await act(async () => {
      releasePicker!();
    });
    await settle();

    // 🔴 THE ASSERTION THAT MATTERS: no authenticated request was issued for a
    // resource that can no longer be used.
    expect(
      resolveCalls,
      'a resolve was issued after the gate closed mid-pick',
    ).toHaveLength(0);
    expect(screen.queryByTestId(`mention-${A.versionId}`)).toBeNull();
    // …and the viewer is told what is missing rather than being left with a
    // control that silently did nothing — the same treatment Send gives.
    expect(requestConsentFn).toHaveBeenCalled();
    expect(screen.getByTestId('consent-notice')).toBeTruthy();
  });

  it('POSITIVE CONTROL: the same deferred pick DOES resolve while the gate stays open', async () => {
    // 🔴 Without this, the zero above is indistinguishable from a fixture whose
    // deferred picker never delivers a pick at all. Same path, same defer, gate
    // untouched — the resolve must fire.
    await boot();
    await newSession();

    deferPicker = true;
    await attach(A.versionId);
    await waitFor(() => expect(releasePicker).not.toBeNull());

    await act(async () => {
      releasePicker!();
    });
    await settle();

    expect(resolveCalls).toHaveLength(1);
    expect(screen.getByTestId(`mention-${A.versionId}`)).toBeTruthy();
    expect(requestConsentFn).not.toHaveBeenCalled();
  });
});
