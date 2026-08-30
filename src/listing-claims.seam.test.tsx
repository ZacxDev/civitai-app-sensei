import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage, fakeBlockCatalogApi } from './test-helpers.js';
import { manifest } from './manifest.js';
import { clearCache } from './lib/research.js';

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE LISTING DESCRIPTION IS A CLAIM ABOUT THE APP, SO PIN THE RELATIONSHIP —
// NOT THE WORDS ON EITHER SIDE. (clawgate #434, criterion 4.)
//
// `block.manifest.json`'s `description` is what a viewer reads in the store
// before installing. It said "the Research panel shows you the query it used.
// You can search from the panel yourself too." for as long as that was true and
// would have gone on saying it after the panel was deleted, because nothing
// connected the two. A stale listing description is not cosmetic: it is a false
// statement to users about what they are installing.
//
// 🔴 EACH CASE ASSERTS BOTH SIDES, AND THAT IS WHAT MAKES IT A SEAM RATHER THAN
// TWO SPELLING CHECKS. A one-sided "the description does not say 'Research
// panel'" passes if the panel comes BACK while the copy stays silent — the
// listing then under-claims, which is a different defect but still a lie. A
// one-sided "the app renders no `open-research`" says nothing about the copy at
// all. Asserting the pair means the guard fails whenever the two DISAGREE, in
// either direction, which is the property that actually matters.
//
// LIMIT, STATED: this covers the two capabilities this change MOVED. It is not
// a general "every sentence in the description is true" check — no test can be
// — so a new claim added to the copy is not automatically covered. Add a case
// here when you add a capability claim.
// ─────────────────────────────────────────────────────────────────────────────

// 🔴 THE SAME OBJECT THE APP ITSELF SHIPS, not a re-read of the file. `readFileSync`
// with `import.meta.url` is unavailable here — under jsdom that URL is `http:`,
// not `file:`, and the read throws at COLLECT time, which vitest reports as
// `Tests no tests`: a green-looking zero for a suite that never ran. Importing
// through `./manifest.js` uses exactly the path `src/manifest.ts` uses to build
// the submitted manifest, so the bytes under test are the bytes that ship.
const description = (manifest as { description?: unknown }).description;

// POSITIVE CONTROL for the import itself. Every case below tests a REGEX
// against this string, and every one of them would pass vacuously against
// `undefined` or `''` — the "reassuring zero" shape. Assert it is real first.
describe('the description is actually loaded', () => {
  it('is a substantial string', () => {
    expect(typeof description).toBe('string');
    expect((description as string).length).toBeGreaterThan(200);
  });
});

vi.mock('@civitai/blocks-react', () => ({
  useAppStorage: () => storage.appStorage,
  useBlockAnalytics: () => ({ track: vi.fn() }),
  useBlockContext: () => ({ ready: true, viewer: { id: 1 }, theme: 'dark' }),
  useBlockResize: () => {},
  useBlockToken: () => ({ raw: 'block-jwt-test', scopes: ['ai:write:budgeted', 'buzz:read:self'] }),
  useBuzzBalance: () => ({ balance: { blue: 100, green: 0, yellow: 200 } }),
  useRequestConsent: () => ({ requestConsent: vi.fn() }),
  useRequestSignIn: () => ({ requestSignIn: vi.fn() }),
  useResourcePicker: () => ({ open: vi.fn().mockResolvedValue(null) }),
  useBuzzWorkflow: () => ({
    estimate: vi.fn().mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } }),
    submit: vi.fn().mockResolvedValue({ workflowId: 'w', status: 'pending' }),
    poll: vi.fn().mockResolvedValue({ status: 'succeeded', textOutputs: ['hi'] }),
    cancel: vi.fn().mockResolvedValue(undefined),
    status: 'idle',
    result: null,
    error: null,
  }),
}));

let storage = fakeAppStorage();

async function renderComposer() {
  render(<App />);
  await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
  fireEvent.click(screen.getByTestId('start-chat-button'));
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
}

describe('the store listing describes the app that actually ships', () => {
  let api: ReturnType<typeof fakeBlockCatalogApi>;
  beforeEach(() => {
    clearCache();
    storage = fakeAppStorage();
    api = fakeBlockCatalogApi();
  });
  afterEach(() => {
    api.restore();
    cleanup();
  });

  it('🔴 the Research panel is absent from BOTH the app and the description', async () => {
    await renderComposer();
    const rendersPanel =
      screen.queryByTestId('open-research') !== null ||
      screen.queryByTestId('research-panel') !== null;
    const claimsPanel = /research panel/i.test(description as string);

    expect(rendersPanel).toBe(false);
    expect(claimsPanel).toBe(false);
    // The seam itself: the two must agree, whichever way a future change moves.
    expect(claimsPanel).toBe(rendersPanel);
  });

  it('🔴 the description must not promise an in-app catalog search either', async () => {
    // The removed sentence's SECOND half — "You can search from the panel
    // yourself too" — is a claim about a control, not about the panel's name,
    // so deleting only the words "Research panel" would leave it standing.
    await renderComposer();
    expect(screen.queryByTestId('research-search-input')).toBeNull();
    expect(screen.queryByTestId('research-search-button')).toBeNull();
    expect(/search from the panel/i.test(description as string)).toBe(false);
  });

  it('🔴 the mention picker is present in BOTH the app and the description', async () => {
    // The positive direction, and the reason this file is a seam rather than a
    // deny-list: a description that fails to mention a shipped, Buzz-relevant
    // affordance under-claims, and this case goes red if the copy is written
    // before the control or the control is removed after the copy.
    await renderComposer();
    const rendersPicker = screen.queryByTestId('add-mention-button') !== null;
    const claimsPicker = /model picker/i.test(description as string) && /attach/i.test(description as string);

    expect(rendersPicker).toBe(true);
    expect(claimsPicker).toBe(true);
    expect(claimsPicker).toBe(rendersPicker);
  });

  it('🔴 every resource type the description names is a type the picker offers', async () => {
    // The copy names four kinds of resource. Naming a fifth would advertise a
    // control whose modal never opens — the host's
    // `resolveResourcePickerRequest` returns null outside its allowlist.
    await renderComposer();
    fireEvent.click(screen.getByTestId('add-mention-button'));
    const offered = [
      ...screen.getByTestId('mention-type-menu').querySelectorAll('[data-testid^="mention-type-"]'),
    ].map((el) => (el as HTMLElement).dataset.testid!.replace('mention-type-', ''));

    // POSITIVE CONTROL — an empty `offered` would make the loop vacuous.
    expect(offered.length).toBeGreaterThan(0);
    for (const named of ['checkpoint', 'LoRA', 'LoCon', 'DoRA']) {
      expect(description as string).toContain(named);
      expect(offered.map((t) => t.toLowerCase())).toContain(named.toLowerCase());
    }
  });
});
