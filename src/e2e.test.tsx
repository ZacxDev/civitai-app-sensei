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
}));

describe('E2E: Sensei App', () => {
  it('full flow: create session → send message → see response', async () => {
    render(<App />);

    // Wait for loading to finish
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });

    // Start with no active session
    expect(screen.getByText('Start a new conversation with Sensei')).toBeTruthy();

    // Create a new session
    fireEvent.click(screen.getByTestId('new-session-button'));

    // Should now show chat area
    await waitFor(() => {
      expect(screen.getByTestId('chat-input')).toBeTruthy();
    });

    // Type a message
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'Hello Sensei' } });

    // Send it
    fireEvent.click(screen.getByTestId('send-button'));

    // Should see the user message
    await waitFor(() => {
      expect(screen.getByText('Hello Sensei')).toBeTruthy();
    });

    // Should see streaming indicator
    await waitFor(() => {
      expect(screen.getByTestId('streaming-indicator')).toBeTruthy();
    });

    // Wait for response to complete
    await waitFor(() => {
      expect(screen.queryByTestId('streaming-indicator')).toBeNull();
    }, { timeout: 5000 });

    // Should see the assistant response
    await waitFor(() => {
      expect(screen.getByText(/stub response/)).toBeTruthy();
    });
  });

  it('session switching', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });

    // Create first session
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => {
      expect(screen.getByTestId('chat-input')).toBeTruthy();
    });

    // Create second session
    fireEvent.click(screen.getByTestId('new-session-button'));
    await waitFor(() => {
      expect(screen.getByTestId('chat-input')).toBeTruthy();
    });

    // Should have 2 session items
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
    // Initially closed - should have open button
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
