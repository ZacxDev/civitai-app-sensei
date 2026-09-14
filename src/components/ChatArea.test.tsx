import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatArea, BUBBLE_MAX_WIDTH, type ChatAreaProps } from './ChatArea.js';
import type { Message } from '../types.js';
import type { ResolvedResource } from '../lib/mentions.js';
import { resourceDisplayName } from '@civitai/blocks-react/ui';
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
      // `null` = the transcript on screen IS the selected conversation's, which
      // is the state every case here is about. The paused states are driven
      // through the real app in `composer-pending-transcript.e2e.test.tsx`.
      sendPaused={null}
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
  it('🔴 an empty conversation does not re-explain the composer beside it', () => {
    // 🔴 REPOINTED 2026-09-02. This pinned "Ask me about AI models, checkpoints,
    // or anything related to AI art generation." — rendered directly above a
    // composer whose placeholder already reads "Ask Sensei anything…". The same
    // instruction, twice, one of them inside the box you type into.
    //
    // The absence is asserted together with the affordance that replaced it, so
    // a component that rendered nothing at all would still fail.
    renderChat();
    expect(screen.queryByText(/Ask me about AI models/)).toBeNull();
    expect(screen.getByTestId('empty-conversation')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Ask Sensei anything…')).toBeInTheDocument();
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

  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 THE CHIP IS THE PACK'S `ResourceCard`, NOT A HAND-ROLLED ONE.
  //
  // ⚠️ GREP FOR THE SUFFIX, NEVER FOR THE COMPOSED VALUE. `ResourceCard` DERIVES
  // every inner hook from the root testid, so `mention-8765-name` appears nowhere
  // in source as a literal — a search for it returns zero whether the selector
  // works or has just been deleted. That is the component's own warning, and it
  // is why these assertions build the id from the same parts the component does.
  // ───────────────────────────────────────────────────────────────────────────
  it('🔴 the chip renders through ResourceCard — the derived testids are present', () => {
    renderChat({ pendingMentions: [A] });
    const root = screen.getByTestId(`mention-${A.versionId}`);
    // The name hook, and the name itself — `resourceDisplayName`, whose whole
    // purpose is that an absent `modelName` becomes `#<versionId>` rather than an
    // empty chip indistinguishable from a broken one.
    const name = screen.getByTestId(`mention-${A.versionId}-name`);
    expect(root.contains(name)).toBe(true);
    expect(name.textContent).toBe(resourceDisplayName(A));
    // The actions slot exists ONLY because we passed something into it.
    expect(screen.getByTestId(`mention-${A.versionId}-actions`)).toBeInTheDocument();
  });

  it('🔴 an absent modelName becomes `#<versionId>`, not an empty chip', () => {
    // The reason to adopt the component at all. `modelName` is typed `string`
    // (REQUIRED) and that type is optimistic — a first-party block has already
    // seen it absent at runtime. Whitespace-only counts as absent, which is the
    // case the local card rendered as a bordered box with no text.
    //
    // ⚠️ THE FIXTURE IS WHITESPACE, NOT `''`, AND THE DIFFERENCE MATTERS. A first
    // mutant that re-introduced an app-side placeholder as
    // `modelName || 'Untitled model'` SURVIVED this test, because `'   '` is
    // TRUTHY so the `||` never fired and the fixture could only ever produce the
    // expected value anyway. The same mutant written `.trim() || 'Untitled model'`
    // — the way anyone would actually write it — dies here with
    // `expected 'Untitled model' to be '#5678'`. Whitespace is kept as the fixture
    // because it is the harder case the component explicitly handles; the lesson is
    // that the mutant has to be the realistic one.
    const nameless = { ...A, modelName: '   ' } as ResolvedResource;
    renderChat({ pendingMentions: [nameless] });
    expect(screen.getByTestId(`mention-${A.versionId}-name`).textContent).toBe(
      `#${A.versionId}`,
    );
  });

  it('the remove control is a SIBLING of the hit area, never nested in it', () => {
    // The whole reason `actions` exists. A `<button>` inside a `<button>` is
    // invalid HTML: the parser REPARENTS it, so the inner control becomes
    // keyboard-unreachable and its click is eaten by the outer one. Asserted
    // structurally, because a click test alone passes in jsdom — which does not
    // reparent the way a real parser does.
    //
    // ⚠️ AN INVARIANT GUARD, NOT REGRESSION COVERAGE, AND MEASURED AS SUCH. The
    // hazard is UNREACHABLE from this call site: `actions` renders as a sibling of
    // the hit area by construction, so it holds whether or not the card is
    // interactive. Mutant K — adding `interactive` + `onSelect`, which really does
    // make the card itself a `<button>` — SURVIVED this assertion and the whole
    // 32-test file, because the component's structure is doing the work. What this
    // guard is actually for is the regression where someone hand-rolls the chip
    // again and wraps their own control inside a clickable card, which is the state
    // this commit replaced.
    renderChat({ pendingMentions: [A], onRemoveMention: vi.fn() });
    const remove = screen.getByTestId(`remove-mention-${A.versionId}`);
    expect(remove.tagName).toBe('BUTTON');
    expect(remove.parentElement?.closest('button')).toBeNull();
  });

  it('🔴 remove STILL FIRES after the refactor, with the right versionId', () => {
    // The behavioural half. A structural check type-checks past a wrong argument,
    // so the callback's payload is pinned too.
    const onRemoveMention = vi.fn();
    renderChat({ pendingMentions: [A, B], onRemoveMention });
    fireEvent.click(screen.getByTestId(`remove-mention-${A.versionId}`));
    expect(onRemoveMention).toHaveBeenCalledTimes(1);
    expect(onRemoveMention).toHaveBeenCalledWith(A.versionId);
  });

  // The negative control for `-actions` — a chip with NO remove control — cannot
  // be driven from here: a composer chip is always removable, so `ChatArea` always
  // passes `onRemove`. It lives in `MessageBubble.test.tsx`, against the
  // transcript chip, which deliberately has none.

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
      sendPaused: null,
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
      sendPaused: null,
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

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE TRANSCRIPT'S SHAPE — viewer right, replies left, both bounded.
//
// The bubble `max-width` is the ONLY thing governing line length in this app:
// the host's 1600px page cap was lifted for it upstream (civitai#4804), so the
// container is full-bleed and a 2560px display gives the chat pane ~2320px. An
// unbounded transcript there is a ~280-character line.
// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 ChatArea — bubble alignment and measure', () => {
  const transcript = [makeMessage('user', 'Hello'), makeMessage('assistant', 'Hi there!')];

  function wraps() {
    return screen.getAllByTestId('bubble-wrap') as HTMLElement[];
  }

  it('aligns the viewer RIGHT and the reply LEFT, with align-self', () => {
    renderChat({ messages: transcript });
    const [user, assistant] = wraps();
    expect(user.dataset.bubbleRole).toBe('user');
    expect(user.style.alignSelf).toBe('flex-end');
    expect(assistant.dataset.bubbleRole).toBe('assistant');
    expect(assistant.style.alignSelf).toBe('flex-start');
  });

  it('🔴 every bubble is bounded BELOW 100% of the pane', () => {
    // Derived from the exported constant rather than mirroring a literal, and then
    // the constant's own PROPERTY is checked — so this fails both when the DOM
    // stops using it and when someone widens it to the full pane.
    renderChat({ messages: transcript });
    for (const w of wraps()) expect(w.style.maxWidth).toBe(BUBBLE_MAX_WIDTH);

    // No arm of the expression may reach the pane width. Parsed, not pattern-
    // matched: a `toContain('%')` passes for `100%`.
    const percentages = [...BUBBLE_MAX_WIDTH.matchAll(/([\d.]+)%/g)].map((m) => Number(m[1]));
    expect(percentages.length).toBeGreaterThan(0);
    for (const p of percentages) expect(p).toBeLessThan(100);

    // And there IS a font-relative cap, which is the half that actually bounds the
    // measure on a wide screen — a percentage alone still scales with the pane.
    const chCaps = [...BUBBLE_MAX_WIDTH.matchAll(/([\d.]+)ch/g)].map((m) => Number(m[1]));
    expect(chCaps.length).toBeGreaterThan(0);
    // 45–75 characters is the readable range; `ch` is the advance of "0", which is
    // wider than the average glyph, so the ceiling is expressed generously.
    for (const c of chCaps) expect(c).toBeLessThanOrEqual(80);
  });

  it('🔴 READING ORDER STILL EQUALS DOM ORDER — the row-reverse guard for the transcript', () => {
    // The companion to the input row's two order guards. `align-self` was chosen
    // over `row-reverse` precisely so this stays true: a reversal would put the
    // viewer's message on the right while leaving assistive tech hearing the
    // conversation in an order the screen does not show. jsdom computes no
    // geometry, so DOM order is what a test can actually read.
    renderChat({ messages: transcript });
    const [user, assistant] = wraps();

    // 🔴 THE BINDING IS POSITIONAL, SO THE ROLES MUST BE PINNED — WITHOUT THIS THE
    // NEXT ASSERTION IS A TAUTOLOGY. `getAllByTestId` returns document order, so
    // `user` and `assistant` are element[0] and element[1] WHATEVER their roles
    // are, and element[0] always precedes element[1]: `compareDocumentPosition`
    // cannot fail. Measured — render the transcript with the assistant FIRST and
    // the comparison below still passed; only the separate role→`alignSelf` test
    // above went red, i.e. the test named for this invariant was not the test
    // pinning it. These two lines are what make the comparison a claim about
    // READING ORDER rather than about array indices.
    expect(user.dataset.bubbleRole).toBe('user');
    expect(assistant.dataset.bubbleRole).toBe('assistant');

    expect(
      user.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // …and neither the container nor any wrapper may break that equivalence
    // without moving the node.
    const container = screen.getByTestId('messages-container') as HTMLElement;
    expect(container.style.flexDirection).toBe('column');
    for (const w of wraps()) {
      expect(w.style.order).toBe('');
      expect(w.style.flexDirection).not.toBe('row-reverse');
    }

    // ⚠️ THE RESIDUAL BLIND SPOT, ON THE RECORD. Every assertion here reads INLINE
    // `.style`, so a reversal arriving via a CSS class or the dependency's injected
    // stylesheet is invisible to all of them — and `src/index.css` is imported only
    // by `main.tsx`, so no jsdom test in this repo ever loads it. jsdom computes no
    // geometry either. Closing this needs a real browser, not another assertion;
    // `taste.json` is where that belongs if it is ever wanted.
  });

  it('the wrapper can shrink below its content — a long URL cannot push past the cap', () => {
    // A flex item's default `min-width: auto` refuses to shrink below its content,
    // so a single unbroken token (a model URL) would overflow the max-width it was
    // just given. INVARIANT guard: nothing is known to have hit this, it is pinned
    // because the cap is worthless without it.
    renderChat({ messages: transcript });
    for (const w of wraps()) expect(w.style.minWidth).toBe('0');
  });
});
