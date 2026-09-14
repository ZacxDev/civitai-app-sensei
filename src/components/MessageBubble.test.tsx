import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { resourceDisplayName } from '@civitai/blocks-react/ui';
import { MessageBubble } from './MessageBubble.js';
import { failureBody } from '../lib/chat.js';
import { BLOCK_GENERATION_RESOURCE } from '../test-helpers.js';
import type { ResolvedResource } from '../lib/mentions.js';
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

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 ICON BUTTONS — ASSERT THE ACCESSIBLE NAME, NEVER THE GLYPH.
//
// These two controls rendered `🔄` and `📋`/`✓` as their ONLY affordance, with a
// `title` and no `aria-label`. A guard reading `getByText('📋')` would be walked
// around by any edit that swaps one glyph for another — the SPELLED-guard shape
// `toolchain-lockstep.test.ts`'s header is about. The name is the contract.
// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 MessageBubble — the icon controls carry accessible NAMES', () => {
  it('regenerate and copy are reachable by role + name, not by glyph', () => {
    render(
      <MessageBubble
        message={makeMsg('assistant', 'Test')}
        onRegenerate={vi.fn()}
        onCopy={vi.fn().mockResolvedValue(true)}
      />,
    );
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('🔴 the name comes from `aria-label`, not from `title` alone', () => {
    // ⚠️ MEASURED: the role+name query above is NOT sufficient, and finding that
    // out is why this test exists. `title` is itself an accessible-name source, so
    // a mutant deleting `aria-label` and keeping `title` leaves BOTH assertions
    // above green — it survived the whole 33-test sweep of this file plus
    // `SessionList.test.tsx`. A derived name cannot tell you which attribute
    // produced it, so the attribute is pinned directly.
    //
    // It matters because the two are not equivalent in practice: `title` is not
    // announced by every screen reader, is not reachable on touch, and is the
    // shape the four pre-change buttons had — `title` with no `aria-label`. Both
    // are asserted because the tooltip is a real affordance for a sighted pointer
    // user and dropping it would be a silent loss.
    render(<MessageBubble message={makeMsg('assistant', 'Test')} onRegenerate={vi.fn()} />);
    const btn = screen.getByTestId('regenerate-button');
    expect(btn).toHaveAttribute('aria-label', 'Regenerate');
    expect(btn).toHaveAttribute('title', 'Regenerate');
  });

  it('🔴 no emoji is left as a control’s only affordance', () => {
    // The absence half, pinned against the five glyphs the pass removed. Asserted
    // together with the names above so a component rendering NOTHING would fail
    // the pair rather than satisfy this one.
    const { container } = render(
      <MessageBubble
        message={makeMsg('assistant', 'Test')}
        onRegenerate={vi.fn()}
        onCopy={vi.fn().mockResolvedValue(true)}
      />,
    );
    for (const glyph of ['🔄', '📋', '✓', '✕', '✏️', '🗑️']) {
      expect(container.textContent ?? '').not.toContain(glyph);
    }
  });

  it('the glyph is hidden from assistive tech, so the control is announced once', () => {
    render(<MessageBubble message={makeMsg('assistant', 'Test')} onRegenerate={vi.fn()} />);
    const svg = screen.getByRole('button', { name: 'Regenerate' }).querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    // `focusable="false"` keeps legacy engines from making the `<svg>` a second
    // tab stop inside the one button.
    expect(svg).toHaveAttribute('focusable', 'false');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE COPY BUTTON MUST NOT CLAIM SUCCESS IT CANNOT OBSERVE.
//
// It flipped to `✓` unconditionally while the parent fired
// `navigator.clipboard.writeText(...)` un-awaited and un-caught. In a sandboxed
// cross-origin iframe that promise can reject, so the control reported a copy
// that never happened. The outcome is read off the accessible NAME.
// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 MessageBubble — the copy button reports the REAL outcome', () => {
  it('says "Copied" when the clipboard accepted', async () => {
    // POSITIVE CONTROL for the refusal case below: without it, "never claims
    // success" is satisfied by a button that can never succeed.
    render(<MessageBubble message={makeMsg('user', 'Test')} onCopy={async () => true} />);
    fireEvent.click(screen.getByTestId('copy-button'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument(),
    );
  });

  it('🔴 says "Copy failed" — and NEVER "Copied" — when the clipboard refuses', async () => {
    render(<MessageBubble message={makeMsg('user', 'Test')} onCopy={async () => false} />);
    fireEvent.click(screen.getByTestId('copy-button'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copy failed' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  });

  it('🔴 a caller still on the old `void` signature reads as FAILURE, not success', async () => {
    // The fix-direction trap: widening the prop's type does nothing on screen
    // while a caller returns `undefined`. `?? false` makes an unobservable
    // outcome render as unobserved rather than as a tick — the whole defect being
    // removed, so it must not survive a half-migrated call site.
    render(
      <MessageBubble
        message={makeMsg('user', 'Test')}
        onCopy={(() => undefined) as unknown as () => boolean}
      />,
    );
    fireEvent.click(screen.getByTestId('copy-button'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copy failed' })).toBeInTheDocument(),
    );
  });
});

describe('🔴 MessageBubble — the transcript chip has NO remove control', () => {
  // The negative control for `ChatArea`'s `-actions` assertions, and it can only
  // live here: a COMPOSER chip is always removable, so `ChatArea` always passes
  // `onRemove`. A chip already SENT must not be, or the viewer would appear able
  // to un-attach grounding from a turn that has already been charged for.
  const msg: Message = {
    ...makeMsg('user', 'What is this?'),
    mentions: [BLOCK_GENERATION_RESOURCE as ResolvedResource],
  };

  it('renders the chip, with the actions slot ABSENT', () => {
    render(<MessageBubble message={msg} />);
    const id = BLOCK_GENERATION_RESOURCE.versionId;
    // Present: the chip and its derived name hook — so "no actions" is not
    // satisfied by a chip that failed to render at all.
    expect(screen.getByTestId(`mention-${id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`mention-${id}-name`).textContent).toBe(
      resourceDisplayName(BLOCK_GENERATION_RESOURCE as ResolvedResource),
    );
    // Absent: the slot, and the control.
    expect(screen.queryByTestId(`mention-${id}-actions`)).toBeNull();
    expect(screen.queryByTestId(`remove-mention-${id}`)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 AN APP-AUTHORED FAILURE BODY DOES NOT GO THROUGH THE MARKDOWN PARSER.
// Closes `error-text-through-markdown` in `taste.json`, whose closing condition
// names exactly this test: a body containing `_`, `*` and a leading `1. ` must
// render as ONE literal text node.
// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 MessageBubble — error text is NOT rendered as markdown', () => {
  /**
   * A realistic server diagnostic, not a textbook fixture — the constructs are
   * the ones THIS renderer implements.
   *
   * ⚠️ CORRECTED AGAINST THE PARSER. The claim being corrected — "underscores in
   * a Prisma/`pg` constraint name emphasise" — reached TWO durable places, which
   * is why this header is the canonical statement: `taste.json`'s entry (since
   * trimmed, the false text deleted rather than kept beside its correction) and
   * `lib/chat.ts`'s own `isPlainBody` header, which asserted it for another whole
   * round because the first correction only looked at the ledger. They do NOT
   * emphasise. `lib/markdown.ts`
   * implements bold, links, and ordered/unordered lists — there is no `_`
   * emphasis rule and the parser emits no `<em>` at all, so `sessions_pkey`
   * survives either way. What DOES transform a body like this is a `**…**` pair
   * (⇒ `<strong>`) and a list leader.
   *
   * 🔴 AND THE LIST LEADER HAS TO BE ON ITS OWN LINE, WHICH IS A MEASURED
   * CORRECTION TO THIS TEST'S FIRST VERSION. `failureBody` prepends `Error: `, so
   * a `1. ` at the START of the server's message is no longer line-initial and the
   * `<ol>` rule never fires — the first fixture here produced NO markdown at all,
   * i.e. it would have certified the plain branch while proving nothing. A real
   * server diagnostic is frequently multi-line (a reason plus a remediation
   * step), and that is the shape that mangles. Underscores and lone asterisks are
   * carried anyway, because `taste.json`'s closing condition names them and
   * because a parser that later grows an emphasis rule must not silently start
   * mangling this body.
   */
  const MANGLEABLE = failureBody(
    'relation _sessions_pkey_ violated in **blocks.router** at *line 40*\n1. retry the request\n- or pick another chat',
  );

  it('🔴 the fixture really IS mangleable — reachability, not a claim', () => {
    // 🔴 WITHOUT THIS THE GUARD BELOW IS VACUOUS. "No `<ol>` in the output" is
    // satisfied by a fixture the parser would never have transformed anyway, and
    // that is the survivor shape a mutation sweep finds: the plain branch could be
    // deleted and the assertion would still pass. Same string, same component,
    // routed through the MARKDOWN path by giving it a role that cannot carry an
    // app-authored failure body — so the only difference is the branch.
    render(<MessageBubble message={makeMsg('user', MANGLEABLE)} />);
    const content = screen.getByTestId('message-content');
    expect(content.querySelector('ol')).not.toBeNull();
    expect(content.querySelector('ul')).not.toBeNull();
    expect(content.querySelector('strong')).not.toBeNull();
    // And the damage, stated: the reader loses the literal markers off a
    // diagnostic they may need to paste into an issue.
    expect(content.textContent).not.toBe(MANGLEABLE);
  });

  it('renders the whole body as one literal text node', () => {
    render(<MessageBubble message={makeMsg('assistant', MANGLEABLE)} />);
    const content = screen.getByTestId('message-content');
    // The exact normalised string, not a substring: a `toContain` passes while the
    // parser has eaten the markers around it.
    expect(content.textContent).toBe(MANGLEABLE);
    // One text node, which is what `taste.json`'s closing condition asks for.
    expect(content.childNodes).toHaveLength(1);
    expect(content.childNodes[0].nodeType).toBe(Node.TEXT_NODE);
    // …and structurally: none of the elements the parser emits.
    expect(content.querySelector('strong')).toBeNull();
    expect(content.querySelector('ol')).toBeNull();
    expect(content.querySelector('ul')).toBeNull();
    expect(content.querySelector('li')).toBeNull();
    expect(content.querySelector('a')).toBeNull();
  });

  it('🔴 MODEL PROSE STILL GOES THROUGH THE PARSER — the negative control', () => {
    // Without this, the assertion above is satisfied by deleting markdown from the
    // app entirely.
    render(<MessageBubble message={makeMsg('assistant', 'Try **Realistic Vision** next.')} />);
    expect(screen.getByTestId('message-content').querySelector('strong')).not.toBeNull();
  });

  it('a WITHHOLD stays plain — INVARIANT guard, the branch that already worked', () => {
    const msg: Message = {
      ...makeMsg('assistant', '1. withheld **by** policy'),
      withheld: true,
    };
    render(<MessageBubble message={msg} />);
    const content = screen.getByTestId('message-content');
    expect(content.textContent).toBe('1. withheld **by** policy');
    expect(content.querySelector('ol')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE GROUNDED-CITATION GATE, AT THE BUBBLE — the layer that decides WHOSE
// text the rule applies to. Ids are the real measured ones from
// `eval/results/seam-baseline-2026-08-31.json`, pairwise distinct.
// ─────────────────────────────────────────────────────────────────────────────

const RV = '4201'; // Realistic Vision — real id
const DEAD = '4823'; // 404 — no such model
const CARDOS = '22220'; // real: CarDos Animated, cited as "Face Slider"

/** The rendered anchor for a model id, or null when it was refused. */
function anchorFor(id: string): HTMLAnchorElement | null {
  return document.querySelector<HTMLAnchorElement>(`a[href*="/models/${id}"]`);
}

describe('🔴 MessageBubble — grounded citations', () => {
  it('renders an anchor for a grounded id and PLAIN TEXT for an ungrounded one', () => {
    render(
      <MessageBubble
        message={makeMsg(
          'assistant',
          `Try [Realistic Vision](https://civitai.com/models/${RV}) or [Deliberate](https://civitai.com/models/${DEAD}).`,
        )}
        groundedModelIds={new Set([RV])}
      />,
    );
    expect(anchorFor(RV)).toBeTruthy();
    expect(anchorFor(DEAD)).toBeNull();
    // 🔴 THE NAME IS STILL ON SCREEN. Refusing the href must not delete the
    // model's own words — the viewer reads the same sentence, minus a link
    // that would have sent them to an unrelated model.
    expect(screen.getByText(/Deliberate/)).toBeTruthy();
  });

  it('🔴 an ASSISTANT bubble with an EMPTY grounded set links nothing', () => {
    render(
      <MessageBubble
        message={makeMsg('assistant', `**Face Slider** [here](https://civitai.com/models/${CARDOS}).`)}
        groundedModelIds={new Set()}
      />,
    );
    expect(anchorFor(CARDOS)).toBeNull();
  });

  it('🔴 a USER bubble is NOT gated — the rule is about MODEL output', () => {
    // A viewer pasting a model link into their own question is not citing
    // anything; refusing it would be a different product decision wearing this
    // fix's clothes. Same set, same href, opposite outcome to the case above.
    render(
      <MessageBubble
        message={makeMsg('user', `what about [this](https://civitai.com/models/${CARDOS})?`)}
        groundedModelIds={new Set()}
      />,
    );
    expect(anchorFor(CARDOS)).toBeTruthy();
  });

  it('positive control: with no grounded set at all, an assistant link still renders', () => {
    // Without this, every refusal above is satisfied by a bubble that never
    // renders anchors.
    render(
      <MessageBubble message={makeMsg('assistant', `[Deliberate](https://civitai.com/models/${DEAD})`)} />,
    );
    expect(anchorFor(DEAD)).toBeTruthy();
  });
});
