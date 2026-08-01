import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatArea } from './ChatArea.js';
import type { Message } from '../types.js';

function makeMessage(role: Message['role'], content: string): Message {
  return {
    id: `msg-${Math.random()}`,
    role,
    content,
    timestamp: Date.now(),
  };
}

describe('ChatArea', () => {
  it('renders empty state', () => {
    render(<ChatArea messages={[]} isStreaming={false} onSend={vi.fn()} />);
    expect(screen.getByText(/Ask me about AI models/)).toBeTruthy();
  });

  it('renders messages', () => {
    const messages = [
      makeMessage('user', 'Hello'),
      makeMessage('assistant', 'Hi there!'),
    ];
    render(<ChatArea messages={messages} isStreaming={false} onSend={vi.fn()} />);
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.getByText('Hi there!')).toBeTruthy();
  });

  it('calls onSend when clicking send button', () => {
    const onSend = vi.fn();
    render(<ChatArea messages={[]} isStreaming={false} onSend={onSend} />);
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'test message' } });
    fireEvent.click(screen.getByTestId('send-button'));
    expect(onSend).toHaveBeenCalledWith('test message');
  });

  it('calls onSend on Enter key', () => {
    const onSend = vi.fn();
    render(<ChatArea messages={[]} isStreaming={false} onSend={onSend} />);
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('test');
  });

  it('does not send on Shift+Enter', () => {
    const onSend = vi.fn();
    render(<ChatArea messages={[]} isStreaming={false} onSend={onSend} />);
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows streaming indicator', () => {
    render(<ChatArea messages={[]} isStreaming={true} onSend={vi.fn()} />);
    expect(screen.getByTestId('streaming-indicator')).toBeTruthy();
  });

  it('shows stop button when streaming', () => {
    render(<ChatArea messages={[]} isStreaming={true} onSend={vi.fn()} onStopStream={vi.fn()} />);
    expect(screen.getByTestId('stop-button')).toBeTruthy();
  });

  it('shows send button when not streaming', () => {
    render(<ChatArea messages={[]} isStreaming={false} onSend={vi.fn()} />);
    expect(screen.getByTestId('send-button')).toBeTruthy();
  });

  it('disables send when input is empty', () => {
    render(<ChatArea messages={[]} isStreaming={false} onSend={vi.fn()} />);
    expect(screen.getByTestId('send-button')).toBeDisabled();
  });

  it('renders tool call cards', () => {
    const messages = [
      makeMessage('assistant', ''),
    ];
    messages[0].toolCalls = [{
      id: 'tc-1',
      type: 'function',
      function: { name: 'search_models', arguments: '{"query":"test"}' },
    }];
    render(<ChatArea messages={messages} isStreaming={false} onSend={vi.fn()} />);
    expect(screen.getByTestId('tool-call-card')).toBeTruthy();
  });
});
