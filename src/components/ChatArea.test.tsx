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
    render(<ChatArea sendGate={null} onGatedSend={vi.fn()} messages={[]} isStreaming={false} onSend={vi.fn()} />);
    expect(screen.getByText(/Ask me about AI models/)).toBeTruthy();
  });

  it('renders messages', () => {
    const messages = [
      makeMessage('user', 'Hello'),
      makeMessage('assistant', 'Hi there!'),
    ];
    render(<ChatArea sendGate={null} onGatedSend={vi.fn()} messages={messages} isStreaming={false} onSend={vi.fn()} />);
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.getByText('Hi there!')).toBeTruthy();
  });

  it('calls onSend when clicking send button', () => {
    const onSend = vi.fn();
    render(<ChatArea sendGate={null} onGatedSend={vi.fn()} messages={[]} isStreaming={false} onSend={onSend} />);
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'test message' } });
    fireEvent.click(screen.getByTestId('send-button'));
    expect(onSend).toHaveBeenCalledWith('test message');
  });

  it('calls onSend on Enter key', () => {
    const onSend = vi.fn();
    render(<ChatArea sendGate={null} onGatedSend={vi.fn()} messages={[]} isStreaming={false} onSend={onSend} />);
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('test');
  });

  it('does not send on Shift+Enter', () => {
    const onSend = vi.fn();
    render(<ChatArea sendGate={null} onGatedSend={vi.fn()} messages={[]} isStreaming={false} onSend={onSend} />);
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows streaming indicator', () => {
    render(<ChatArea sendGate={null} onGatedSend={vi.fn()} messages={[]} isStreaming={true} onSend={vi.fn()} />);
    expect(screen.getByTestId('streaming-indicator')).toBeTruthy();
  });

  it('shows stop button when streaming', () => {
    render(<ChatArea sendGate={null} onGatedSend={vi.fn()} messages={[]} isStreaming={true} onSend={vi.fn()} onStopStream={vi.fn()} />);
    expect(screen.getByTestId('stop-button')).toBeTruthy();
  });

  it('shows send button when not streaming', () => {
    render(<ChatArea sendGate={null} onGatedSend={vi.fn()} messages={[]} isStreaming={false} onSend={vi.fn()} />);
    expect(screen.getByTestId('send-button')).toBeTruthy();
  });

  it('disables send when input is empty', () => {
    render(<ChatArea sendGate={null} onGatedSend={vi.fn()} messages={[]} isStreaming={false} onSend={vi.fn()} />);
    expect(screen.getByTestId('send-button')).toBeDisabled();
  });

  it("renders nothing for a LEGACY stored 'tool' message", () => {
    // Sessions written by the removed tool loop still hold raw JSON tool
    // payloads. They must not surface as chat bubbles.
    const messages = [
      makeMessage('user', 'Hello'),
      makeMessage('tool', '{"items":[{"id":1,"name":"Leaked Tool Payload"}]}'),
    ];
    render(<ChatArea sendGate={null} onGatedSend={vi.fn()} messages={messages} isStreaming={false} onSend={vi.fn()} />);
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.queryByText(/Leaked Tool Payload/)).toBeNull();
  });
});
