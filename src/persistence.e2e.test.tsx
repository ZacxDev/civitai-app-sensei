import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { App } from './App.js';
import { staleReadAppStorage, fakeBlockCatalogApi } from './test-helpers.js';
import { clearCache } from './lib/research.js';

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE REGRESSION SUITE FOR THE LOST-USER-MESSAGE DEFECT (#387/3, #387/5).
//
// It is red at the pre-fix commit and green after, and it is red for the RIGHT
// reason: it runs the app against a KV fake that models the DEPLOYED host —
// `staleTime: Infinity`, no invalidation on write, so a block cannot see its own
// write (see `staleReadAppStorage`). Under the pre-fix read-modify-write
// persistence layer, each write is computed from a pre-write snapshot and
// replaces what came before; the stored array ends up holding the last write
// only.
//
// 🔴 WHY THE EXISTING SUITE COULD NOT SEE ANY OF THIS, and why that is a defect
// in its own right: `e2e.test.tsx` mocks `useAppStorage: () => fakeAppStorage()
// .appStorage` — a factory call, so EVERY invocation of the hook returns a
// BRAND-NEW EMPTY STORE. Nothing those tests write is ever read back by
// anything, so 198 green tests said precisely nothing about persistence. A fake
// that shares no state across calls cannot fail a persistence test; a fake with
// read-your-writes semantics the host does not have cannot fail this one.
//
// Both halves are fixed here: ONE storage instance for the whole test, and the
// host's real read-after-write behaviour.
// ─────────────────────────────────────────────────────────────────────────────

const REPLY_1 = 'DreamShaper is a Stable Diffusion checkpoint.';
const REPLY_2 = 'OK.';

const h = vi.hoisted(() => ({
  storage: null as ReturnType<typeof staleReadAppStorage> | null,
  poll: null as (() => unknown) | null,
}));

vi.mock('@civitai/blocks-react', () => ({
  // 🔴 ONE instance, resolved at call time — not a fresh store per render.
  useAppStorage: () => h.storage!.appStorage,
  useBlockAnalytics: () => ({ track: vi.fn() }),
  useBlockContext: () => ({ ready: true, viewer: { id: 1 }, theme: 'dark' }),
  useBlockResize: () => {},
  useRequestConsent: () => ({ requestConsent: vi.fn() }),
  useRequestSignIn: () => ({ requestSignIn: vi.fn() }),
  // The host's native resource picker. A no-op stub (the viewer dismisses without
  // picking) for every suite that is not ABOUT mentions — see
  // `mention-grounding.e2e.test.tsx` for the driven one.
  useResourcePicker: () => ({ open: vi.fn().mockResolvedValue(null) }),
  useBlockToken: () => ({ raw: 'block-jwt-test', scopes: ['ai:write:budgeted', 'buzz:read:self'] }),
  useBuzzBalance: () => ({ balance: { blue: 100, green: 0, yellow: 200 } }),
  useBuzzWorkflow: () => ({
    estimate: vi
      .fn()
      .mockResolvedValue({ workflowId: 'est-1', status: 'succeeded', cost: { total: 4 } }),
    submit: vi.fn().mockResolvedValue({ workflowId: 'buzz-1', status: 'pending' }),
    poll: vi.fn().mockImplementation(async () => h.poll!()),
    cancel: vi.fn().mockResolvedValue(undefined),
    status: 'idle',
    result: null,
    error: null,
  }),
}));

const MESSAGES_KEY_PREFIX = 'sensei:messages:';

function committedMessages(storage: ReturnType<typeof staleReadAppStorage>) {
  for (const key of storage.store.keys()) {
    if (key.startsWith(MESSAGES_KEY_PREFIX)) {
      return (storage.committed(key) ?? []) as Array<{ role: string; content: string }>;
    }
  }
  return [];
}

async function sendMessage(text: string, reply: string) {
  h.poll = () => ({
    workflowId: 'buzz-1',
    status: 'succeeded',
    cost: { total: 4 },
    textOutputs: [reply],
  });
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('send-button'));
  await waitFor(
    () => {
      expect(screen.getByText(new RegExp(reply.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy();
    },
    { timeout: 5000 },
  );
  await waitFor(() => {
    expect(screen.queryByTestId('streaming-indicator')).toBeNull();
  });
}

describe('persistence against a host that cannot serve a block its own write', () => {
  let api: ReturnType<typeof fakeBlockCatalogApi>;

  beforeEach(() => {
    clearCache();
    h.storage = staleReadAppStorage();
    api = fakeBlockCatalogApi();
  });

  afterEach(() => {
    api.restore();
    cleanup();
  });

  it('two exchanges survive a reload, in order, with the auto-title', async () => {
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());

    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());

    await sendMessage('What is DreamShaper?', REPLY_1);
    await sendMessage('Say OK.', REPLY_2);

    // What a reload would actually load — the backing store, not the cache.
    const stored = committedMessages(h.storage!);
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(stored.map((m) => m.content)).toEqual([
      'What is DreamShaper?',
      REPLY_1,
      'Say OK.',
      REPLY_2,
    ]);

    // ── THE RELOAD. A fresh mount over the same backing store, with the read
    // cache dropped exactly as a page load would drop it.
    cleanup();
    h.storage!.expireReads();
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());

    await waitFor(() => {
      expect(screen.getAllByTestId('message-user')).toHaveLength(2);
    });
    expect(screen.getAllByTestId('message-assistant')).toHaveLength(2);

    const container = screen.getByTestId('messages-container');
    const rendered = within(container)
      .getAllByTestId('message-content')
      .map((n) => n.textContent);
    expect(rendered).toEqual(['What is DreamShaper?', REPLY_1, 'Say OK.', REPLY_2]);

    // …and the session is no longer called "New Chat".
    const items = screen.getAllByTestId(/^session-item-/);
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('What is DreamShaper?');
    expect(items[0].textContent).not.toContain('New Chat');
  });

  // 🔴 INVARIANT GUARD, NOT REGRESSION COVERAGE — labelled because it PASSES at
  // the pre-fix commit (verified: red 2 / green 1 at `e37d717`). The reported
  // "+ New is dead" symptom is a rejected storage call, not a wrong write, and
  // this does not reproduce it — the one that does is the rejection test below.
  // Kept because it pins that the button commits at all, which nothing did.
  it('[invariant] "+ New" creates a session that is actually committed', async () => {
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());

    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
    await waitFor(() => {
      expect(screen.getAllByTestId(/^session-item-/)).toHaveLength(1);
    });

    const committed = h.storage!.committed('sensei:sessions') as { sessions: unknown[] } | null;
    expect(committed?.sessions).toHaveLength(1);

    // And it survives the reload — the assertion the in-memory list cannot make.
    cleanup();
    h.storage!.expireReads();
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    await waitFor(() => {
      expect(screen.getAllByTestId(/^session-item-/)).toHaveLength(1);
    });
  });

  it('a rejected storage write is REPORTED, never silent', async () => {
    // 🔴 THE ACTUAL "+ New IS DEAD" SIGNATURE. Pre-fix, `createSession` had no
    // try/catch anywhere, so a rejected write became an unhandled rejection and
    // the viewer saw nothing at all — indistinguishable from a no-op click.
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());

    const failing = vi
      .spyOn(h.storage!.appStorage, 'set')
      .mockRejectedValue(new Error('PAYLOAD_TOO_LARGE'));

    fireEvent.click(screen.getByTestId('new-session-button'));

    await waitFor(() => {
      expect(screen.getByTestId('storage-error')).toBeTruthy();
    });
    expect(screen.getByTestId('storage-error').textContent).toContain('PAYLOAD_TOO_LARGE');
    // The UI does NOT claim a session that was never saved.
    expect(screen.queryAllByTestId(/^session-item-/)).toHaveLength(0);

    failing.mockRestore();
  });
});
