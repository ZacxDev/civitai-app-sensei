import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownText } from './MarkdownText.js';

/**
 * 🔴 THESE ASSERT THE RENDERED DOM, NOT THE PARSE TREE, AND THAT IS THE POINT.
 *
 * The three defects fixed on 2026-09-02 were all VISIBLE ones — a citation that
 * read as raw `[Name](https://…)` on screen, and three list rows all numbered
 * "1.". A parse-tree assertion can be satisfied by a tree the renderer then
 * throws away, which is exactly how the previous suite stayed green over an
 * app whose headline output was unreadable. So these pin the elements: an
 * `<a href=…>`, one `<ol>` with N `<li>`, a `start` attribute.
 *
 * The corpus is REAL model output, taken from the strings recorded in
 * `lib/markdown.ts` and `lib/grounding.ts` — not invented shapes.
 */

const POPULAR_MIX = '1510946';
const DREAMSHAPER = '4384';
const REALISTIC_VISION = '4201';

/** Every model id the fixtures cite, so the grounding gate is not the variable. */
const GROUNDED = new Set([POPULAR_MIX, DREAMSHAPER, REALISTIC_VISION, '58390']);

describe('🔴 MarkdownText — a citation renders as a LINK, not as its source', () => {
  it('renders a BOLD link as an anchor inside <strong>', () => {
    // 🔴 THE HEADLINE DEFECT. Bold and link both matched; the winner was picked
    // by offset and bold starts two characters earlier, so `bold` swallowed the
    // link's whole source and this rendered the literal text
    // `[Popular Mix](https://civitai.com/models/1510946)` in bold.
    render(
      <MarkdownText
        text={`**[Popular Mix](https://civitai.com/models/${POPULAR_MIX})**`}
        groundedModelIds={GROUNDED}
      />,
    );

    const link = screen.getByRole('link', { name: 'Popular Mix' });
    expect(link).toHaveAttribute('href', `https://civitai.com/models/${POPULAR_MIX}`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // Still bold — the container survives, it just no longer eats its contents.
    expect(link.closest('strong')).not.toBeNull();
    // And the source is nowhere on screen.
    expect(screen.queryByText(/\]\(https:/)).toBeNull();
  });

  it('🔴 renders a link whose TEXT CONTAINS BRACKETS — the real naming convention', () => {
    // `[^\]]+` could not match a name containing `]`, and bracketed qualifiers
    // are a Civitai naming convention. This citation matched NOWHERE and fell
    // through as literal text.
    const name = 'Popular Mix [NoobAI & Illustrious]';
    render(
      <MarkdownText
        text={`[${name}](https://civitai.com/models/${POPULAR_MIX})`}
        groundedModelIds={GROUNDED}
      />,
    );

    const link = screen.getByRole('link', { name });
    expect(link).toHaveAttribute('href', `https://civitai.com/models/${POPULAR_MIX}`);
  });

  it('renders BOTH at once — the exact string recorded from production', () => {
    render(
      <MarkdownText
        text={`1. **[Popular Mix [NoobAI & Illustrious]](https://civitai.com/models/${POPULAR_MIX})**`}
        groundedModelIds={GROUNDED}
      />,
    );
    expect(
      screen.getByRole('link', { name: 'Popular Mix [NoobAI & Illustrious]' }),
    ).toHaveAttribute('href', `https://civitai.com/models/${POPULAR_MIX}`);
  });

  it('🔴 an UNGROUNDED bold citation still renders no anchor — the gate is not lost', () => {
    // The fix must not open the grounding hole it renders through. `9999999`
    // is in no tool result, so the name survives and the href does not.
    render(
      <MarkdownText
        text="**[Invented Model](https://civitai.com/models/9999999)**"
        groundedModelIds={GROUNDED}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Invented Model')).toBeInTheDocument();
  });

  it('🔴 an off-site bold link is still refused', () => {
    render(<MarkdownText text="**[Free Buzz](https://evil.example/x)**" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Free Buzz')).toBeInTheDocument();
  });
});

describe('🔴 MarkdownText — an ordered list numbers 1, 2, 3', () => {
  /** All `<li>` that are DIRECT children of the outermost list. */
  const topRows = (container: HTMLElement) => {
    const lists = container.querySelectorAll('ol');
    return { lists, rows: lists[0] ? [...lists[0].children].filter((n) => n.tagName === 'LI') : [] };
  };

  it('keeps ONE list when each row carries indented detail bullets', () => {
    // 🔴 THE MEASURED SHAPE. An indented `- Type: …` closed the enclosing `<ol>`,
    // so each numbered row became its own single-item list and the browser
    // restarted every one of them at 1.
    const { container } = render(
      <MarkdownText
        groundedModelIds={GROUNDED}
        text={
          `Here are some popular models:\n` +
          `1. **[Detail Tweaker](https://civitai.com/models/58390)**\n` +
          `   - Type: LORA\n` +
          `2. **[DreamShaper](https://civitai.com/models/${DREAMSHAPER})**\n` +
          `   - Type: Checkpoint\n` +
          `3. **[Realistic Vision](https://civitai.com/models/${REALISTIC_VISION})**\n` +
          `   - Type: Checkpoint\n` +
          `Let me know!`
        }
      />,
    );

    const { lists, rows } = topRows(container);
    expect(lists).toHaveLength(1);
    expect(rows).toHaveLength(3);
    // The detail bullets are nested INSIDE their row, which is what keeps the
    // numbering unbroken — not dropped, which would be a different regression.
    expect(rows[0].querySelector('ul')?.textContent).toBe('Type: LORA');
    // And all three citations are real links.
    expect(container.querySelectorAll('a')).toHaveLength(3);
  });

  it('keeps ONE list when rows are separated by blank lines', () => {
    // Independent mechanism, identical symptom: a blank line flushed the list.
    const { container } = render(<MarkdownText text={'1. First\n\n2. Second\n\n3. Third'} />);
    const { lists, rows } = topRows(container);
    expect(lists).toHaveLength(1);
    expect(rows).toHaveLength(3);
  });

  it('🔴 preserves the number the source STARTED at', () => {
    const { container } = render(<MarkdownText text={'3. Third\n4. Fourth'} />);
    expect(container.querySelector('ol')).toHaveAttribute('start', '3');
  });

  it('🔴 a list starting at 1 reports start=1, not the previous list’s number', () => {
    // Control for the assertion above: `start` is READ FROM THE SOURCE, so a
    // hardcoded `start={3}` — or a `start` leaking from an earlier list — is
    // caught here. Without it, "preserves the number" is satisfied by any
    // constant.
    const { container } = render(<MarkdownText text={'1. a\n2. b'} />);
    expect(container.querySelector('ol')).toHaveAttribute('start', '1');
  });

  it('🔴 prose after a list still ENDS the list', () => {
    // The blank-line fix closes lists lazily. Without this control, "one list"
    // could be satisfied by a parser that never closes one at all.
    const { container } = render(<MarkdownText text={'1. a\n\n2. b\n\nAnything else?'} />);
    const { rows } = topRows(container);
    expect(rows).toHaveLength(2);
    expect(container.querySelectorAll('ol')).toHaveLength(1);
    expect(container.querySelector('p')?.textContent).toBe('Anything else?');
  });

  // 🔴 INVARIANT GUARD, NOT REGRESSION COVERAGE — labelled because it is the
  // one case in this file that was ALREADY GREEN at `13f32df`. The lazy list
  // close could plausibly have merged an unindented `- ` run into the open
  // `<ol>`; it does not, and this pins that. Do not count it as evidence any
  // bug was fixed here.
  it('an unindented unordered list is NOT merged into an ordered one', () => {
    const { container } = render(<MarkdownText text={'1. a\n2. b\n- c\n- d'} />);
    expect(container.querySelectorAll('ol')).toHaveLength(1);
    // The `<ul>` here is a SIBLING (unindented), not a child of the last row.
    const ul = container.querySelector('ul');
    expect(ul).not.toBeNull();
    expect(ul!.closest('li')).toBeNull();
  });
});
