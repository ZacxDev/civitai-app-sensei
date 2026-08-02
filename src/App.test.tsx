import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    estimate: vi.fn().mockResolvedValue({ cost: 10 }),
    submit: vi.fn().mockResolvedValue({ id: 'buzz-1', status: 'pending' }),
    poll: vi.fn().mockResolvedValue({ status: 'completed' }),
    cancel: vi.fn().mockResolvedValue(undefined),
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

  it('renders the AI Research Assistant subtitle', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });
    expect(screen.getByText('AI Research Assistant')).toBeTruthy();
  });

  it('renders the stub badge', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });
    expect(screen.getByTestId('stub-badge')).toBeTruthy();
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
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });
    expect(screen.getByText('Start a new conversation with Sensei')).toBeTruthy();
  });

  it('renders the settings bar', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });
    expect(screen.getByTestId('settings-bar')).toBeTruthy();
  });
});
