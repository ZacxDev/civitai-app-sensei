import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage } from './test-helpers.js';

vi.mock('@civitai/blocks-react', () => ({
  useAppStorage: () => fakeAppStorage().appStorage,
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
    estimate: vi.fn().mockResolvedValue({ cost: { total: 10 } }),
    submit: vi.fn().mockResolvedValue({ workflowId: 'buzz-1', status: 'pending' }),
    poll: vi.fn().mockResolvedValue({ status: 'succeeded', steps: [{ output: { text: 'test response' } }] }),
    cancel: vi.fn().mockResolvedValue(undefined),
    status: 'idle',
    result: null,
    error: null,
  }),
}));

describe('App', () => {
  it('renders the app header after loading', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });
    expect(screen.getByText('Civitai Sensei')).toBeTruthy();
  });

  it('🔴 the header does NOT restate the app’s own category back at the viewer', async () => {
    // 🔴 REPOINTED 2026-09-02. This test was `expect(getByText('AI Research
    // Assistant'))` — it pinned a subtitle that sat directly under the app's
    // name, inside the app, on a page the viewer reached by opening the app.
    // A label restating the thing it labels; the store listing is where a
    // category belongs. Pinning the absence alone would pass on an empty
    // header, so the identity it replaced is asserted alongside it: the app's
    // own mark, and its name.
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });
    expect(screen.queryByText('AI Research Assistant')).toBeNull();
    expect(screen.getByText('Civitai Sensei')).toBeInTheDocument();
    // 🔴 THE MARK IS DECORATION, and that is what licenses shipping a glyph
    // measured at 2.96:1 on the brand plate — below the 3:1 threshold for a
    // graphic that carries meaning. See `lib/brand.test.ts`. If this ever stops
    // being `aria-hidden`, that measurement stops being acceptable.
    expect(screen.getByTestId('app-mark')).toHaveAttribute('aria-hidden', 'true');
  });

  it('does not render stub badge in bridge mode', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });
    expect(screen.queryByTestId('stub-badge')).toBeNull();
  });

  it('renders the settings button', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });
    expect(screen.getByTestId('settings-button')).toBeTruthy();
  });

  it('renders the session list', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });
    expect(screen.getByTestId('session-list')).toBeTruthy();
  });

  it('shows no active session state', async () => {
    // 🔴 THE STRING CHANGED, THE CONTRACT DID NOT. "Start a new conversation
    // with Sensei" sat above a button labelled "New Chat" — the sentence and
    // the control said the same thing, and the sentence was the one carrying no
    // extra information. It is replaced by the app's actual promise (the
    // manifest tagline), which is a claim about what Sensei DOES. The
    // start-chat affordance is asserted alongside so this cannot be satisfied
    // by copy alone.
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });
    expect(screen.getByText('Ask a question. Sensei looks it up.')).toBeTruthy();
    expect(screen.getByTestId('start-chat-button')).toBeInTheDocument();
  });

  it('renders the settings bar', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });
    expect(screen.getByTestId('settings-bar')).toBeTruthy();
  });
});
