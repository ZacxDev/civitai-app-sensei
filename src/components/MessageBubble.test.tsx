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
