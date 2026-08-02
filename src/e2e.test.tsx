import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage } from './test-helpers.js';

vi.mock('@civitai/blocks-react', () => ({
  useAppStorage: () => fakeAppStorage().appStorage,
  useBlockAnalytics: () => ({ track: vi.fn() }),
  useBlockContext: () => ({ ready: true, viewer: { id: 1 }, theme: 'dark' }),
  useBlockResize: () => {},
  useBlockToken: () => ({ scopes: ['ai:write:budgeted', 'buzz:read:self'] }),
  useBuzzBalance: () => ({ balance: { blue: 100, green: 0, yellow: 200 } }),
  useBuzzWorkflow: () => ({
    estimate: vi.fn().mockResolvedValue({ workflowId: 'est-1', status: 'succeeded', cost: { total: 10 } }),
    submit: vi.fn().mockResolvedValue({ workflowId: 'buzz-1', status: 'pending' }),
    poll: vi.fn().mockResolvedValue({
      workflowId: 'buzz-1',
      status: 'succeeded',
      cost: { total: 10 },
      steps: [{ output: { text: 'This is a stub response — the real orchestrator will provide actual AI-generated content.' } }],
    }),
    cancel: vi.fn().mockResolvedValue(undefined),
    status: 'idle',
    result: null,
    error: null,
  }),
}));

describe('E2E: Sensei App', () => {
  it('full flow: create session → send message → see response', async () => {
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
      expect(screen.getByText(/stub response/)).toBeTruthy();
    });
  });

  it('session switching', async () => {
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
