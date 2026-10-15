// 🔴 A BOOT PRUNE MUST NOT SPEND THE WRITE RATE A PAID REPLY NEEDS.
//
// The document store allows a viewer 120 private writes per minute per app, and a
// DELETE counts. The turn-record prune runs at every mount; with a per-mount
// budget of 100 it left ~20 writes for the rest of that minute, so a viewer with a
// backlog of turn records who asked four questions had the fourth CHARGED and then
// its saves refused `rate_limited` — the reply lost. Found by audit, reproduced
// against the SDK fake with rate limits on.
//
// This drives exactly that: the SDK's contract fake with `enforceRateLimits`, a
// 330-record backlog (130 over the cap), a boot that prunes, then four sends in
// the same minute. Every reply must be in the stored transcript, and the store
// must have refused nothing. Red with the old budget (100), green with the paced
// 20 — see the PR for the pair.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

import { App } from './App.js';
import { clearCache } from './lib/research.js';
import { MAX_TURN_RECORDS, PRUNE_DELETE_BUDGET, turnRecordKey } from './lib/turn-records.js';
import { fakeAppStorage, fakeBlockCatalogApi } from './test-helpers.js';

const h = vi.hoisted(() => ({
  storage: null as ReturnType<typeof fakeAppStorage> | null,
  reply: 'answer',
}));

vi.mock('./lib/sdk-runtime.js', () => ({
  useKvStore: () => h.storage!.appStorage,
  useBlockAnalytics: () => ({ track: vi.fn() }),
  useBlockContext: () => ({ ready: true, viewer: { id: 1 }, theme: 'dark' }),
  useBlockResize: () => {},
  useDomainMaturity: () => ({ isSfw: true, isLevelAllowed: () => false }),
  useRequestConsent: () => ({ requestConsent: vi.fn() }),
  useRequestSignIn: () => ({ requestSignIn: vi.fn() }),
  useResourcePicker: () => ({ open: vi.fn().mockResolvedValue(null) }),
  useBlockToken: () => ({ raw: 'block-jwt-test', scopes: ['ai:write:budgeted', 'buzz:read:self'] }),
  useBuzzWorkflow: () => ({
    estimate: vi
      .fn()
      .mockResolvedValue({ workflowId: 'est-1', status: 'succeeded', cost: { total: 4 } }),
    submit: vi.fn().mockResolvedValue({ workflowId: 'buzz-1', status: 'pending' }),
    poll: vi.fn().mockImplementation(async () => ({
      workflowId: 'buzz-1',
      status: 'succeeded',
      cost: { total: 4 },
      textOutputs: [h.reply],
    })),
    cancel: vi.fn().mockResolvedValue(undefined),
  }),
}));

const T0 = 1_800_000_000_000;
const BACKLOG = MAX_TURN_RECORDS + 130;
const SESSION = { id: 'abc', title: 'Busy chat', model: 'm', createdAt: 1, updatedAt: 2 };

describe('the boot prune leaves the viewer room to save their own turns', () => {
  let api: ReturnType<typeof fakeBlockCatalogApi>;
  let clock = T0;

  beforeEach(async () => {
    clearCache();
    api = fakeBlockCatalogApi();
    clock = T0;
    const seed: Record<string, unknown> = {
      'sensei:sessions': { sessions: [SESSION] },
      'sensei:messages:abc': [],
    };
    for (let i = 0; i < BACKLOG; i += 1) {
      const s = { sessionId: 'abc', messageId: `msg-${i}`, submittedAt: 1_700_000_000_000 + i };
      seed[turnRecordKey(s)] = { ...s, workflowIds: [], outcome: 'saved' };
    }
    // Seeding is fixture, not traffic: while it lands, every call reads a clock a
    // minute later than the last, so no seed write shares a window. Then the
    // clock stops, and the app's whole run is ONE minute.
    let seeding = true;
    h.storage = fakeAppStorage(seed, {
      enforceRateLimits: true,
      now: () => (seeding ? (clock += 61_000) : clock),
    });
    await h.storage.settled();
    seeding = false;
    clock += 61_000;
  });

  afterEach(() => {
    api.restore();
    cleanup();
  });

  it('🔴 four questions after a boot prune of a large backlog all save', async () => {
    const calls = h.storage!.docStore.calls;
    const deletesOk = () => calls.filter((c) => c.method === 'DELETE' && c.status === 200).length;

    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    // The prune really ran — without this the case is green on an app that never
    // sweeps. It spends its full budget: the backlog is larger.
    await waitFor(() => expect(deletesOk()).toBe(PRUNE_DELETE_BUDGET), { timeout: 5000 });

    for (let q = 1; q <= 4; q += 1) {
      h.reply = `answer number ${q}`;
      fireEvent.change(screen.getByTestId('chat-input'), { target: { value: `question ${q}` } });
      fireEvent.click(screen.getByTestId('send-button'));
      expect(await screen.findByText(h.reply, undefined, { timeout: 5000 })).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByTestId('streaming-indicator')).toBeNull());
    }

    await waitFor(async () => {
      const doc = (await h.storage!.rawDocs()).find((d) => d.key === 'sensei:messages:abc');
      const value = (doc?.data as { value?: Array<{ content: string }> } | undefined)?.value ?? [];
      expect(value.map((m) => m.content)).toEqual([
        'question 1', 'answer number 1',
        'question 2', 'answer number 2',
        'question 3', 'answer number 3',
        'question 4', 'answer number 4',
      ]);
    });
    // Nothing was refused — the instrument that names the failure directly.
    expect(calls.filter((c) => c.status === 429).map((c) => `${c.method} ${c.path}`)).toEqual([]);
    expect(screen.queryByTestId('storage-error')).toBeNull();
  });
});
