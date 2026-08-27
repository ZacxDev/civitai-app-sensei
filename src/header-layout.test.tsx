import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage, fakeBlockCatalogApi } from './test-helpers.js';
import { clearCache } from './lib/research.js';

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE SETTINGS-UNREACHABLE DEFECT (#387/1), AND THE LIMIT OF THIS FILE.
//
// The real acceptance test is a HIT-TEST — `document.elementFromPoint` at the
// centre of `[data-testid="settings-button"]` must return the settings button —
// and jsdom cannot run it: `getBoundingClientRect` returns all zeros and
// `elementFromPoint` is not implemented, so a hit-test here would pass with the
// bug fully present. That assertion is made against the LIVE app at two iframe
// widths; see the release notes on clawgate #387.
//
// What this file CAN pin is the mechanism, structurally rather than by spelling:
// the toggle was `position: absolute; right: 8; top: 8`, laid out over the
// right-anchored ⚙️ button. Two claims deny that:
//
//   1. Both controls are inside the header, as siblings of one flex row.
//   2. NEITHER is taken out of normal flow.
//
// A control in normal flow inside a flex row cannot be laid on top of its
// sibling at any width, which is why (2) is the load-bearing half. It also
// cannot be satisfied by renaming anything — it reads the layout property that
// actually caused the overlap.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('@civitai/blocks-react', () => ({
  useAppStorage: () => fakeAppStorage().appStorage,
  useBlockAnalytics: () => ({ track: vi.fn() }),
  useBlockContext: () => ({ ready: true, viewer: { id: 1 }, theme: 'dark' }),
  useBlockResize: () => {},
  useRequestConsent: () => ({ requestConsent: vi.fn() }),
  useRequestSignIn: () => ({ requestSignIn: vi.fn() }),
  useBlockToken: () => ({ raw: 'block-jwt-test', scopes: ['ai:write:budgeted', 'buzz:read:self'] }),
  useBuzzBalance: () => ({ balance: { blue: 100, green: 0, yellow: 200 } }),
  useBuzzWorkflow: () => ({
    estimate: vi.fn().mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 4 } }),
    submit: vi.fn().mockResolvedValue({ workflowId: 'w', status: 'pending' }),
    poll: vi.fn().mockResolvedValue({ status: 'succeeded', textOutputs: ['hi'] }),
    cancel: vi.fn().mockResolvedValue(undefined),
    status: 'idle',
    result: null,
    error: null,
  }),
}));

/** Walk up to the header, collecting every inline `position` on the way. */
function positionsUpToHeader(el: HTMLElement): string[] {
  const out: string[] = [];
  let node: HTMLElement | null = el;
  while (node && node.dataset.testid !== 'app-header') {
    out.push(node.style.position);
    node = node.parentElement;
  }
  return out;
}

describe('header layout — Settings must be reachable', () => {
  let api: ReturnType<typeof fakeBlockCatalogApi>;
  beforeEach(() => {
    clearCache();
    api = fakeBlockCatalogApi();
  });
  afterEach(() => {
    api.restore();
    cleanup();
  });

  it('both controls live inside the header', async () => {
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());

    const header = screen.getByTestId('app-header');
    expect(header.contains(screen.getByTestId('settings-button'))).toBe(true);
    expect(header.contains(screen.getByTestId('open-research'))).toBe(true);
  });

  it('neither control is taken out of normal flow', async () => {
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());

    // 🔴 THIS IS THE ASSERTION THAT WOULD HAVE CAUGHT THE BUG. Pre-fix,
    // `open-research` carried an inline `position: absolute`, and that is the
    // whole mechanism by which it landed on top of ⚙️.
    for (const id of ['open-research', 'settings-button']) {
      for (const position of positionsUpToHeader(screen.getByTestId(id))) {
        expect(position).not.toBe('absolute');
        expect(position).not.toBe('fixed');
      }
    }
  });

  it('the toggle stays in the header whether the panel is open or closed', async () => {
    // The overlap only existed in the CLOSED state, because that is the branch
    // that rendered the absolutely-positioned button. Assert both states so a
    // future "just move it back when closed" cannot pass.
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());

    const header = screen.getByTestId('app-header');
    expect(screen.queryByTestId('research-panel')).toBeNull();
    expect(header.contains(screen.getByTestId('open-research'))).toBe(true);

    fireEvent.click(screen.getByTestId('open-research'));
    await waitFor(() => expect(screen.getByTestId('research-panel')).toBeTruthy());
    expect(header.contains(screen.getByTestId('open-research'))).toBe(true);
    expect(header.contains(screen.getByTestId('research-panel'))).toBe(false);
  });

  it('a click on Settings opens the Settings modal', async () => {
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    fireEvent.click(screen.getByTestId('settings-button'));
    await waitFor(() => expect(screen.getByText('Settings')).toBeTruthy());
  });

  it('the in-app Buzz badge is gone', async () => {
    // #387/2. The on-site header already shows the balance; `buzz:read:self`
    // stays in the manifest so the granted scope set is unchanged and nobody is
    // re-prompted for consent.
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
    expect(screen.queryByTestId('buzz-balance')).toBeNull();
  });
});
