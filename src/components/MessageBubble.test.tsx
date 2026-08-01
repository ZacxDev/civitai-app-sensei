import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageBubble } from './MessageBubble.js';
import type { Message } from '../types.js';

function makeMsg(role: Message['role'], content: string): Message {
  return { id: 'msg-1', role, content, timestamp: Date.now() };
}

describe('MessageBubble', () => {
  it('renders user message', () => {
    render(<MessageBubble message={makeMsg('user', 'Hello')} />);
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('Hello')).toBeTruthy();
  });

  it('renders assistant message', () => {
    render(<MessageBubble message={makeMsg('assistant', 'Hi there')} />);
    expect(screen.getByText('Sensei')).toBeTruthy();
    expect(screen.getByText('Hi there')).toBeTruthy();
  });

  it('shows copy button', () => {
    render(<MessageBubble message={makeMsg('user', 'Test')} onCopy={vi.fn()} />);
    expect(screen.getByTestId('copy-button')).toBeTruthy();
  });

  it('calls onCopy when clicking copy', () => {
    const onCopy = vi.fn();
    render(<MessageBubble message={makeMsg('user', 'Test')} onCopy={onCopy} />);
    fireEvent.click(screen.getByTestId('copy-button'));
    expect(onCopy).toHaveBeenCalled();
  });

  it('shows regenerate button for assistant messages', () => {
    const onRegenerate = vi.fn();
    render(<MessageBubble message={makeMsg('assistant', 'Test')} onRegenerate={onRegenerate} />);
    expect(screen.getByTestId('regenerate-button')).toBeTruthy();
  });

  it('calls onRegenerate when clicking regenerate', () => {
    const onRegenerate = vi.fn();
    render(<MessageBubble message={makeMsg('assistant', 'Test')} onRegenerate={onRegenerate} />);
    fireEvent.click(screen.getByTestId('regenerate-button'));
    expect(onRegenerate).toHaveBeenCalled();
  });

  it('shows empty indicator for no content', () => {
    render(<MessageBubble message={makeMsg('assistant', '')} />);
    expect(screen.getByText('…')).toBeTruthy();
  });
});
