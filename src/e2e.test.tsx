import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage, fakeBlockCatalogApi } from './test-helpers.js';
import { clearCache } from './lib/research.js';

// 🔴 THE POLL FIXTURE MIRRORS THE REAL HOST REPLY. It used to return
// `steps: [{ output: { text } }]` and the assertion looked for "stub response" —
// a shape the host never sends, asserted against a stub that no longer exists.
// Released text arrives ONLY on `textOutputs`; a withhold ONLY on
// `textOutputWithheld`.
//
// This is still a FIXTURE and proves only that the app reads the shape it will
// be handed. It is not a substitute for driving the deployed step.
const RELEASED_REPLY = 'Paris is the capital of France.';
const WITHHELD_REASON =
  'This response was withheld because it did not pass Civitai’s content policy.';

const pollResult = vi.fn();

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
    estimate: vi
      .fn()
      .mockResolvedValue({ workflowId: 'est-1', status: 'succeeded', cost: { total: 1 } }),
    submit: vi.fn().mockResolvedValue({ workflowId: 'buzz-1', status: 'pending' }),
    poll: vi.fn().mockImplementation(async () => pollResult()),
    cancel: vi.fn().mockResolvedValue(undefined),
    status: 'idle',
    result: null,
    error: null,
  }),
}));

describe('E2E: Sensei App', () => {
  // Every send fetches tool declarations first. Stub the whole blocks surface —
  // `/tools` included — so the suite makes no network call AND runs the normal
  // tool-enabled path. 🔴 The fake had no `/tools` branch for one revision, so
  // `fetchToolDeclarations` threw, `App.tsx` swallowed it, and these tests
  // silently exercised the DEGRADED no-tools path while this comment claimed
  // the opposite.
  let api: ReturnType<typeof fakeBlockCatalogApi>;
  beforeEach(() => {
    clearCache();
    api = fakeBlockCatalogApi();
  });
  afterEach(() => {
    api.restore();
  });

  it('full flow: create session → send message → see response', async () => {
    pollResult.mockReturnValue({
      workflowId: 'buzz-1',
      status: 'succeeded',
      cost: { total: 1 },
      textOutputs: [RELEASED_REPLY],
    });
    render(<App />);

    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });

    // Copy changed in the 2026-09-02 taste pass — the sentence above the New
    // Chat button used to repeat the button's own label. The anchor here is the
    // affordance, which is what this flow actually depends on.
    expect(screen.getByTestId('start-chat-button')).toBeTruthy();

    fireEvent.click(screen.getByTestId('new-session-button'));

    await waitFor(() => {
      expect(screen.getByTestId('chat-input')).toBeTruthy();
    });

    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'Hello Sensei' } });

    fireEvent.click(screen.getByTestId('send-button'));

    // 🔴 SCOPED TO THE MESSAGE LIST, and the reason is a real behaviour change:
    // since 0.1.5 the auto-title actually LANDS, so "Hello Sensei" now appears
    // in the sidebar as well as in the bubble and a bare `getByText` matches
    // two nodes. Before, the title write was silently overwritten by a later
    // read-modify-write and the sidebar stayed "New Chat" — this assertion was
    // passing BECAUSE of the defect.
    await waitFor(() => {
      expect(
        within(screen.getByTestId('messages-container')).getByText('Hello Sensei'),
      ).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.getByTestId('streaming-indicator')).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.queryByTestId('streaming-indicator')).toBeNull();
    }, { timeout: 5000 });

    await waitFor(() => {
      expect(screen.getByText(new RegExp(RELEASED_REPLY))).toBeTruthy();
    });
  });

  it('a withheld reply renders the policy reason, not an error', async () => {
    // The flagged branch, end to end through the app. `textOutputWithheld` with
    // NO `textOutputs` is exactly what the host sends when the output scan
    // refuses the reply.
    pollResult.mockReturnValue({
      workflowId: 'buzz-2',
      status: 'succeeded',
      cost: { total: 1 },
      textOutputWithheld: { reason: WITHHELD_REASON },
    });
    render(<App />);

    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });

    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => {
      expect(screen.getByTestId('chat-input')).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'flagged content' } });
    fireEvent.click(screen.getByTestId('send-button'));

    await waitFor(
      () => {
        expect(screen.getByText(new RegExp(WITHHELD_REASON))).toBeTruthy();
      },
      { timeout: 5000 },
    );

    // 🔴 THE POINT OF THIS ASSERTION. A withhold means the capability worked;
    // labelling it "Error:" would report a bug where the policy did its job.
    expect(screen.queryByText(/^Error:/)).toBeNull();
  });

  it('session switching', async () => {
    pollResult.mockReturnValue({ status: 'succeeded', textOutputs: [RELEASED_REPLY] });
    render(<App />);

    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });

    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => {
      expect(screen.getByTestId('chat-input')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => {
      expect(screen.getByTestId('chat-input')).toBeTruthy();
    });

    await waitFor(() => {
      const items = screen.getAllByTestId(/^session-item-/);
      expect(items.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('settings button opens modal', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });
    fireEvent.click(screen.getByTestId('settings-button'));
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeTruthy();
    });
  });

  // 🔴 THE RESEARCH-PANEL TOGGLE CASE THAT USED TO SIT HERE IS REPLACED, NOT
  // DROPPED (clawgate #434). Its subject — an in-iframe catalog search — was
  // removed on purpose; the affordance that took its place is the mention
  // picker, and the end-to-end for it lives in `mention-grounding.e2e.test.tsx`
  // because it needs a driven host picker. What belongs HERE is the shape of
  // the composer the toggle's removal left behind.
  it('the composer offers the mention picker where the Research toggle used to be', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });
    fireEvent.click(screen.getByTestId('start-chat-button'));
    await waitFor(() => {
      expect(screen.getByTestId('chat-input')).toBeTruthy();
    });

    expect(screen.queryByTestId('open-research')).toBeNull();
    expect(screen.getByTestId('add-mention-button')).toBeTruthy();
  });
});
