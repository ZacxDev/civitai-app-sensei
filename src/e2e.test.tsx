import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage } from './test-helpers.js';

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
  useBlockToken: () => ({ scopes: ['ai:write:budgeted', 'buzz:read:self'] }),
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

    expect(screen.getByText('Start a new conversation with Sensei')).toBeTruthy();

    fireEvent.click(screen.getByTestId('new-session-button'));

    await waitFor(() => {
      expect(screen.getByTestId('chat-input')).toBeTruthy();
    });

    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'Hello Sensei' } });

    fireEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(screen.getByText('Hello Sensei')).toBeTruthy();
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

  it('research panel toggle', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });
    expect(screen.getByTestId('open-research')).toBeTruthy();
    fireEvent.click(screen.getByTestId('open-research'));
    await waitFor(() => {
      expect(screen.getByTestId('research-panel')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('close-research'));
    await waitFor(() => {
      expect(screen.queryByTestId('research-panel')).toBeNull();
    });
  });
});
