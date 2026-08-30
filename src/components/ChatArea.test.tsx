import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatArea, type ChatAreaProps } from './ChatArea.js';
import type { Message } from '../types.js';
import type { ResolvedResource } from '../lib/mentions.js';
import { BLOCK_GENERATION_RESOURCE, BLOCK_GENERATION_RESOURCE_LOCON } from '../test-helpers.js';

function makeMessage(role: Message['role'], content: string): Message {
  return {
    id: `msg-${Math.random()}`,
    role,
    content,
    timestamp: Date.now(),
  };
}

/**
 * 🔴 THE MENTION PROPS ARE REQUIRED, LIKE `sendGate`, AND FOR THE SAME REASON —
 * a safe default would have to be "no attachments, picking does nothing", which
 * is precisely the silently-inert composer a caller who forgot the prop would
 * ship. This helper supplies them so the pre-existing cases stay readable; it is
 * NOT a default on the component.
 */
function renderChat(props: Partial<ChatAreaProps> = {}) {
  return render(
    <ChatArea
      sendGate={null}
      onGatedSend={vi.fn()}
      messages={[]}
      isStreaming={false}
      onSend={vi.fn()}
      pendingMentions={[]}
      onPickMention={vi.fn()}
      onRemoveMention={vi.fn()}
      {...props}
    />,
  );
}

const A = BLOCK_GENERATION_RESOURCE as ResolvedResource;
const B = BLOCK_GENERATION_RESOURCE_LOCON as ResolvedResource;

describe('ChatArea', () => {
  it('renders empty state', () => {
    renderChat();
    expect(screen.getByText(/Ask me about AI models/)).toBeTruthy();
  });

  it('renders messages', () => {
    renderChat({ messages: [makeMessage('user', 'Hello'), makeMessage('assistant', 'Hi there!')] });
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.getByText('Hi there!')).toBeTruthy();
  });

  it('calls onSend when clicking send button', () => {
    const onSend = vi.fn();
    renderChat({ onSend });
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'test message' } });
    fireEvent.click(screen.getByTestId('send-button'));
    expect(onSend).toHaveBeenCalledWith('test message');
  });

  it('calls onSend on Enter key', () => {
    const onSend = vi.fn();
    renderChat({ onSend });
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('test');
  });

  it('does not send on Shift+Enter', () => {
    const onSend = vi.fn();
    renderChat({ onSend });
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows streaming indicator', () => {
    renderChat({ isStreaming: true });
    expect(screen.getByTestId('streaming-indicator')).toBeTruthy();
  });

  it('shows stop button when streaming', () => {
    renderChat({ isStreaming: true, onStopStream: vi.fn() });
    expect(screen.getByTestId('stop-button')).toBeTruthy();
  });

  it('shows send button when not streaming', () => {
    renderChat();
    expect(screen.getByTestId('send-button')).toBeTruthy();
  });

  it('disables send when input is empty', () => {
    renderChat();
    expect(screen.getByTestId('send-button')).toBeDisabled();
  });

  it("renders nothing for a LEGACY stored 'tool' message", () => {
    // Sessions written by the removed tool loop still hold raw JSON tool
    // payloads. They must not surface as chat bubbles.
    renderChat({
      messages: [
        makeMessage('user', 'Hello'),
        makeMessage('tool', '{"items":[{"id":1,"name":"Leaked Tool Payload"}]}'),
      ],
    });
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.queryByText(/Leaked Tool Payload/)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the mention affordance in the composer (clawgate #434, criterion 3)', () => {
  it('🔴 the picker button is to the LEFT of the input, read off DOM order', () => {
    // jsdom computes no geometry — `getBoundingClientRect` is all zeros — so a
    // coordinate assertion here would pass with the button on the right. The
    // input row is a plain `display:flex` with the default `row` direction, so
    // DOM order IS visual order, and that is what this reads. The companion
    // guard below denies the two ways that equivalence could be broken without
    // moving the node.
    const { container } = renderChat();
    const button = screen.getByTestId('add-mention-button');
    const input = screen.getByTestId('chat-input');
    const row = button.closest('div')!.parentElement!;

    expect(row.contains(input)).toBe(true);
    expect(
      button.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container).toBeTruthy();
  });

  it('🔴 nothing in the input row reverses or re-orders that layout', () => {
    // `row-reverse` or an `order` property would put the button on the right
    // while leaving it first in the DOM — passing the guard above with the
    // requirement broken.
    renderChat();
    const button = screen.getByTestId('add-mention-button');
    const row = button.closest('div')!.parentElement! as HTMLElement;
    expect(row.style.flexDirection).not.toBe('row-reverse');
    expect((button.closest('div') as HTMLElement).style.order).toBe('');
    expect(row.style.flexDirection === '' || row.style.flexDirection === 'row').toBe(true);
  });

  it('offers exactly the four types the host picker accepts', () => {
    renderChat();
    fireEvent.click(screen.getByTestId('add-mention-button'));
    const menu = screen.getByTestId('mention-type-menu');
    const offered = [...menu.querySelectorAll('[data-testid^="mention-type-"]')].map(
      (el) => (el as HTMLElement).dataset.testid,
    );
    // Widened to the LoRA family by civitai#4494. A fifth entry here would be a
    // control whose modal never opens — `resolveResourcePickerRequest` returns
    // null for a type outside the host allowlist.
    expect(offered).toEqual([
      'mention-type-Checkpoint',
      'mention-type-LORA',
      'mention-type-LoCon',
      'mention-type-DoRA',
    ]);
  });

  it('asks the parent to open the HOST picker for the chosen type', () => {
    const onPickMention = vi.fn();
    renderChat({ onPickMention });
    fireEvent.click(screen.getByTestId('add-mention-button'));
    fireEvent.click(screen.getByTestId('mention-type-LoCon'));
    expect(onPickMention).toHaveBeenCalledWith('LoCon');
    // The menu closes on pick rather than lingering over the composer.
    expect(screen.queryByTestId('mention-type-menu')).toBeNull();
  });

  it('renders a chip per pending mention, each removable', () => {
    const onRemoveMention = vi.fn();
    renderChat({ pendingMentions: [A, B], onRemoveMention });
    expect(screen.getByTestId(`mention-${A.versionId}`)).toBeTruthy();
    expect(screen.getByTestId(`mention-${B.versionId}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId(`remove-mention-${B.versionId}`));
    expect(onRemoveMention).toHaveBeenCalledWith(B.versionId);
  });

  it('renders no chip row when nothing is attached', () => {
    renderChat();
    expect(screen.queryByTestId('pending-mentions')).toBeNull();
  });

  it("shows the MODEL's own lookup query while a tool round is in flight", () => {
    // The transparency half of the removed Research panel. Only while streaming
    // — a stale query line after the answer lands would label the wrong turn.
    renderChat({ isStreaming: true, lookupQuery: 'painterly sketch lora' });
    expect(screen.getByTestId('lookup-query').textContent).toContain('painterly sketch lora');
    renderChat({ isStreaming: false, lookupQuery: 'painterly sketch lora' });
    expect(screen.queryAllByTestId('lookup-query')).toHaveLength(1);
  });
});
