import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsBar } from './SettingsBar.js';
import { DEFAULT_SETTINGS } from '../types.js';

describe('SettingsBar', () => {
  it('renders model selector', () => {
    render(<SettingsBar settings={DEFAULT_SETTINGS} onChange={vi.fn()} />);
    expect(screen.getByTestId('settings-bar')).toBeTruthy();
    expect(screen.getByTestId('model-selector')).toBeTruthy();
  });

  it('renders temperature slider', () => {
    render(<SettingsBar settings={DEFAULT_SETTINGS} onChange={vi.fn()} />);
    expect(screen.getByTestId('temperature-slider')).toBeTruthy();
  });

  it('renders max tokens slider', () => {
    render(<SettingsBar settings={DEFAULT_SETTINGS} onChange={vi.fn()} />);
    expect(screen.getByTestId('max-tokens-slider')).toBeTruthy();
  });

  it('displays current temperature', () => {
    render(<SettingsBar settings={DEFAULT_SETTINGS} onChange={vi.fn()} />);
    expect(screen.getByText('0.7')).toBeTruthy();
  });

  it('displays current max tokens', () => {
    render(<SettingsBar settings={DEFAULT_SETTINGS} onChange={vi.fn()} />);
    expect(screen.getByText('2048')).toBeTruthy();
  });
});
