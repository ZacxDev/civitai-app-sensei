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
      // Empty rather than absent, because the prop is REQUIRED and an empty set
      // is the honest value for a conversation that has grounded nothing. These
      // cases render no model links, so it changes nothing they assert; the
      // grounding behaviour itself is pinned in `MessageBubble.test.tsx`,
      // `lib/markdown.test.ts` and `citation-grounding.e2e.test.tsx`.
      groundedModelIds={new Set<string>()}
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

  // ───────────────────────────────────────────────────────────────────────────
  // The picker declared a `disabled` prop and NOTHING PASSED IT — a control that
  // reads as gated and is not. The gate has to be the send button's, and the
  // send button gives its two conditions DIFFERENT treatments: `isStreaming`
  // disables it, `sendGate` makes it ASK for what is missing.
  it('🔴 an anonymous viewer cannot drive the HOST picker', () => {
    // `sendGate === 'signin'` means the send is refused and the host is asked to
    // sign the viewer in. Leaving the picker live lets that viewer open host
    // chrome and drive an authenticated resolve from a block that cannot send.
    const onPickMention = vi.fn();
    const onGatedSend = vi.fn();
    renderChat({ sendGate: 'signin', onPickMention, onGatedSend });
    fireEvent.click(screen.getByTestId('add-mention-button'));

    expect(screen.queryByTestId('mention-type-menu')).toBeNull();
    expect(onPickMention).not.toHaveBeenCalled();
    // …and they are told how to fix it, exactly as Send does. NOT `disabled`:
    // `'consent'` is the default state of a first-time viewer, so a disabled
    // launcher would be a dead control on first run for everyone.
    expect(onGatedSend).toHaveBeenCalled();
  });

  it('🔴 a viewer without the spend scope cannot drive the HOST picker either', () => {
    const onPickMention = vi.fn();
    const onGatedSend = vi.fn();
    renderChat({ sendGate: 'consent', onPickMention, onGatedSend });
    fireEvent.click(screen.getByTestId('add-mention-button'));

    expect(screen.queryByTestId('mention-type-menu')).toBeNull();
    expect(onPickMention).not.toHaveBeenCalled();
    expect(onGatedSend).toHaveBeenCalled();
  });

  it('🔴 attaching is closed MID-STREAM — those chips belong to the next message', () => {
    // While a turn streams the composer's Send is replaced by Stop, so anything
    // attached now cannot be sent with the message it was attached to. It would
    // silently ground the NEXT question instead. Here `disabled` IS right: the
    // condition clears by itself in seconds and there is nothing for the viewer
    // to grant.
    renderChat({ isStreaming: true });
    expect(screen.getByTestId('add-mention-button').hasAttribute('disabled')).toBe(true);
  });

  it('🔴 the PICK is gated too, not just the launcher', () => {
    // Gating the launcher alone is a SPELLED guard: a menu already open when the
    // gate closes keeps four live buttons that reach `onPickMention` directly,
    // and it is the PICK that opens host chrome. Asserted by opening the menu
    // while ungated and closing the gate underneath it.
    const onPickMention = vi.fn();
    const onGatedSend = vi.fn();
    const props = {
      onGatedSend,
      messages: [] as Message[],
      isStreaming: false,
      onSend: vi.fn(),
      pendingMentions: [] as ResolvedResource[],
      onPickMention,
      onRemoveMention: vi.fn(),
      groundedModelIds: new Set<string>(),
    };
    const { rerender } = render(<ChatArea sendGate={null} {...props} />);
    fireEvent.click(screen.getByTestId('add-mention-button'));
    // POSITIVE CONTROL: the menu really was open before the gate closed, so the
    // refusal below is a fact about the gate and not about a menu that never
    // rendered.
    expect(screen.getByTestId('mention-type-menu')).toBeTruthy();

    rerender(<ChatArea sendGate={'signin'} {...props} />);
    fireEvent.click(screen.getByTestId('mention-type-Checkpoint'));
    expect(onPickMention).not.toHaveBeenCalled();
    expect(onGatedSend).toHaveBeenCalled();
  });

  it('🔴 a menu open when a STREAM starts is closed with it', () => {
    const props = {
      sendGate: null,
      onGatedSend: vi.fn(),
      messages: [] as Message[],
      onSend: vi.fn(),
      pendingMentions: [] as ResolvedResource[],
      onPickMention: vi.fn(),
      onRemoveMention: vi.fn(),
      groundedModelIds: new Set<string>(),
    };
    const { rerender } = render(<ChatArea isStreaming={false} {...props} />);
    fireEvent.click(screen.getByTestId('add-mention-button'));
    expect(screen.getByTestId('mention-type-menu')).toBeTruthy();

    rerender(<ChatArea isStreaming={true} {...props} />);
    expect(screen.queryByTestId('mention-type-menu')).toBeNull();
  });

  it('the picker stays live when the send is live — negative control', () => {
    // Without this, every assertion above is satisfied by a picker that is
    // always closed.
    const onPickMention = vi.fn();
    const onGatedSend = vi.fn();
    renderChat({ sendGate: null, isStreaming: false, onPickMention, onGatedSend });
    expect(screen.getByTestId('add-mention-button').hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByTestId('add-mention-button'));
    expect(screen.getByTestId('mention-type-menu')).toBeTruthy();
    fireEvent.click(screen.getByTestId('mention-type-Checkpoint'));
    expect(onPickMention).toHaveBeenCalledWith('Checkpoint');
    expect(onGatedSend).not.toHaveBeenCalled();
  });

  it('a chip already attached stays REMOVABLE while the picker is gated', () => {
    // Gating what ADDS grounding must not trap what is already attached — the
    // viewer would otherwise be unable to take back a chip they can no longer
    // send.
    const onRemoveMention = vi.fn();
    renderChat({ sendGate: 'consent', pendingMentions: [A], onRemoveMention });
    fireEvent.click(screen.getByTestId(`remove-mention-${A.versionId}`));
    expect(onRemoveMention).toHaveBeenCalledWith(A.versionId);
  });
});
