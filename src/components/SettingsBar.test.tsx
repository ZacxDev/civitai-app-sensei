import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsBar } from './SettingsBar.js';
import { SettingsModal } from './SettingsModal.js';
import { DEFAULT_SETTINGS } from '../types.js';

/**
 * 🔴 FOUR ASSERTIONS IN THIS FILE MOVED TO `SettingsModal`, THEY WERE NOT
 * DROPPED, and the move is the point of the change rather than a casualty of
 * it. `renders temperature slider`, `renders max tokens slider`, `displays
 * current temperature` and `displays current max tokens` all still exist —
 * against the dialog the controls now live in, by the SAME testids and the same
 * displayed values. Nothing about what the app can do got weaker; what changed
 * is which surface owns the control. The bar's own contract — that it renders
 * and that the model select is on it — is unchanged and asserted below.
 */
describe('SettingsBar — the demoted footer strip', () => {
  const renderBar = (over: Partial<Parameters<typeof SettingsBar>[0]> = {}) =>
    render(
      <SettingsBar
        settings={DEFAULT_SETTINGS}
        onChange={vi.fn()}
        onOpenSettings={vi.fn()}
        {...over}
      />,
    );

  it('renders the bar and the model selector', () => {
    renderBar();
    expect(screen.getByTestId('settings-bar')).toBeTruthy();
    expect(screen.getByTestId('model-selector')).toBeTruthy();
  });

  it('🔴 the capture recipe’s testids survive the demotion', () => {
    // `settings-bar` is a documented ready anchor for this app's app-capture
    // recipe and its crop rect is measured to end just under this strip. The
    // coupling is invisible to every gate in both repos, so it is pinned here.
    renderBar();
    expect(screen.getByTestId('settings-bar')).toBeInTheDocument();
  });

  it('🔴 the tuning sliders are NOT on the bar any more', () => {
    // The demotion, asserted as a fact rather than left to a screenshot. If a
    // future edit puts them back, this is what says so.
    renderBar();
    expect(screen.queryByTestId('temperature-slider')).toBeNull();
    expect(screen.queryByTestId('max-tokens-slider')).toBeNull();
  });

  it('offers a route to where they went', () => {
    // Demoting a control without leaving a way to reach it is hiding it.
    const onOpenSettings = vi.fn();
    renderBar({ onOpenSettings });
    fireEvent.click(screen.getByTestId('open-tuning'));
    expect(onOpenSettings).toHaveBeenCalled();
  });
});

describe('SettingsModal — the tuning controls, at their new address', () => {
  const renderModal = (over: Partial<Parameters<typeof SettingsModal>[0]> = {}) =>
    render(
      <SettingsModal
        opened
        onClose={vi.fn()}
        settings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        {...over}
      />,
    );

  it('renders temperature slider', () => {
    renderModal();
    expect(screen.getByTestId('temperature-slider')).toBeTruthy();
  });

  it('renders max tokens slider', () => {
    renderModal();
    expect(screen.getByTestId('max-tokens-slider')).toBeTruthy();
  });

  it('displays current temperature', () => {
    renderModal();
    expect(screen.getByText('0.7')).toBeTruthy();
  });

  it('displays current max tokens', () => {
    renderModal();
    expect(screen.getByText('2048')).toBeTruthy();
  });

  it('🔴 re-seeds from the CURRENT settings each time it opens', () => {
    // `useState(settings)` reads its argument once, and this component is
    // mounted for the app's whole life. With three settings now reachable from
    // two surfaces, a dialog showing mount-time values would write a stale
    // model back over a fresh one on Save.
    const onSave = vi.fn();
    const { rerender } = render(
      <SettingsModal
        opened={false}
        onClose={vi.fn()}
        settings={DEFAULT_SETTINGS}
        onSave={onSave}
      />,
    );
    const changed = { ...DEFAULT_SETTINGS, maxTokens: 1024 };
    rerender(
      <SettingsModal opened onClose={vi.fn()} settings={changed} onSave={onSave} />,
    );
    expect(screen.getByText('1024')).toBeTruthy();
  });

  it('does not explain what the labelled control already says', () => {
    renderModal();
    expect(screen.queryByText(/Defines Sensei's personality/)).toBeNull();
  });
});
