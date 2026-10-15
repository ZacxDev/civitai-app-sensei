// 🔴 THE CUTOVER MAPPING, END TO END THROUGH THE APP.
//
// `src/lib/kv-store.test.ts` pins the adapter. This pins that the APP reads and
// writes through it: a viewer whose data the cutover script copied — raw
// documents `{ value: <legacy value> }` at the legacy keys in the private `kv`
// collection — opens Sensei and sees their transcript, and the app's next write
// lands as exactly one document at the same key, wrapped the same way.
//
// Seeded RAW, through the SDK fake's own client and never through the adapter,
// because that is what the copy script does: an adapter-seeded fixture would
// agree with the adapter whatever shape it used.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

import { App } from './App.js';
import { KV_COLLECTION } from './lib/kv-store.js';
import { clearCache } from './lib/research.js';
import { fakeAppStorage, fakeBlockCatalogApi } from './test-helpers.js';

const h = vi.hoisted(() => ({ storage: null as ReturnType<typeof fakeAppStorage> | null }));

const REPLY = 'A fresh answer.';

vi.mock('./lib/sdk-runtime.js', () => ({
  // ONE instance, resolved at call time — not a fresh store per render.
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
    poll: vi.fn().mockResolvedValue({
      workflowId: 'buzz-1',
      status: 'succeeded',
      cost: { total: 4 },
      textOutputs: [REPLY],
    }),
    cancel: vi.fn().mockResolvedValue(undefined),
  }),
}));

/** What the copy script writes for one legacy viewer — literal values. */
const SESSION = {
  id: 'abc',
  title: 'Copied chat',
  model: 'deepseek/deepseek-chat',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
};
const LEGACY_MESSAGES = [
  { id: 'msg-1', role: 'user', content: 'Which checkpoint is DreamShaper?', timestamp: 1_700_000_000_000 },
  { id: 'msg-2', role: 'assistant', content: 'DreamShaper is a general-purpose checkpoint.', timestamp: 1_700_000_050_000 },
];

describe('the app over documents the cutover script copied', () => {
  let api: ReturnType<typeof fakeBlockCatalogApi>;

  beforeEach(async () => {
    clearCache();
    api = fakeBlockCatalogApi();
    h.storage = fakeAppStorage();
    const raw = h.storage.docStore.storage.collection(KV_COLLECTION);
    await raw.put('sensei:sessions', { value: { sessions: [SESSION] } });
    await raw.put('sensei:messages:abc', { value: LEGACY_MESSAGES });
  });

  afterEach(() => {
    api.restore();
    cleanup();
  });

  it('renders the transcript stored at sensei:messages:abc as { value: [...] }', async () => {
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());

    expect(await screen.findByText('Which checkpoint is DreamShaper?')).toBeInTheDocument();
    expect(screen.getByText('DreamShaper is a general-purpose checkpoint.')).toBeInTheDocument();
    expect(screen.queryByTestId('storage-error')).toBeNull();
  });

  it('a send writes exactly one document at the SAME key, data = { value: [...] }', async () => {
    render(<App />);
    expect(await screen.findByText('Which checkpoint is DreamShaper?')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'And SDXL?' } });
    fireEvent.click(screen.getByTestId('send-button'));
    expect(await screen.findByText(REPLY, undefined, { timeout: 5000 })).toBeInTheDocument();

    await waitFor(async () => {
      const doc = (await h.storage!.rawDocs()).find((d) => d.key === 'sensei:messages:abc');
      const value = (doc?.data as { value?: unknown[] } | undefined)?.value;
      expect(value).toHaveLength(4);
    });

    const docs = await h.storage!.rawDocs();
    // No second transcript key, no unwrapped twin: the messages live at the one
    // legacy key the copy script wrote.
    expect(docs.filter((d) => d.key.startsWith('sensei:messages:')).map((d) => d.key)).toEqual([
      'sensei:messages:abc',
    ]);
    const messagesDoc = docs.find((d) => d.key === 'sensei:messages:abc')!;
    // Exactly `{ value }` — the wrapper and nothing beside it.
    expect(Object.keys(messagesDoc.data as object)).toEqual(['value']);
    const stored = (messagesDoc.data as { value: Array<{ id: string; role: string; content: string }> })
      .value;
    expect(stored.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Which checkpoint is DreamShaper?'],
      ['assistant', 'DreamShaper is a general-purpose checkpoint.'],
      ['user', 'And SDXL?'],
      ['assistant', REPLY],
    ]);
    // The copied messages kept their ids — the app appended, it did not rewrite.
    expect(stored.slice(0, 2).map((m) => m.id)).toEqual(['msg-1', 'msg-2']);

    // The session list is still the one document at `sensei:sessions`, wrapped.
    const sessionsDoc = docs.find((d) => d.key === 'sensei:sessions')!;
    expect(Object.keys(sessionsDoc.data as object)).toEqual(['value']);
    const sessions = (sessionsDoc.data as { value: { sessions: Array<{ id: string }> } }).value.sessions;
    expect(sessions.map((s) => s.id)).toEqual(['abc']);
  });
});
