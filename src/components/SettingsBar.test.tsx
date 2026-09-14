import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsBar } from './SettingsBar.js';
import { SettingsModal } from './SettingsModal.js';
import { DEFAULT_SETTINGS } from '../types.js';
import { NSFW_MODEL_ID, SFW_MODEL_ID } from '../lib/models.js';

/**
 * 🔴 FOUR ASSERTIONS IN THIS FILE MOVED TO `SettingsModal`, THEY WERE NOT
 * DROPPED, and the move is the point of the change rather than a casualty of
 * it. `renders temperature slider`, `renders max tokens slider`, `displays
 * current temperature` and `displays current max tokens` all still exist —
 * against the dialog the controls now live in, by the SAME testids and the same
 * displayed values. Nothing about what the app can do got weaker; what changed
 * is which surface owns the control. The bar's own contract — that it renders
 * and that the model select is on it — is unchanged and asserted below.
 */
describe('SettingsBar — the demoted footer strip', () => {
  const renderBar = (over: Partial<Parameters<typeof SettingsBar>[0]> = {}) =>
    render(
      <SettingsBar
        settings={DEFAULT_SETTINGS}
        onChange={vi.fn()}
        onOpenSettings={vi.fn()}
        // Fail-closed by default, which is what a green/blue-domain viewer gets and
        // what the hook returns before `BLOCK_INIT` lands.
        nsfwAllowed={false}
        {...over}
      />,
    );

  it('renders the bar', () => {
    renderBar();
    expect(screen.getByTestId('settings-bar')).toBeTruthy();
  });

  it('🔴 the model SELECT is gone — replaced by the NSFW toggle', () => {
    // ─────────────────────────────────────────────────────────────────────────
    // 🔴 REPOINTED, AND THIS ONE HAS A CONSEQUENCE OUTSIDE THIS REPO.
    //
    // `data-testid="model-selector"` was documented in this component's header as
    // load-bearing: the app-capture recipe in `datapacket-talos` names it, and
    // "renaming either would break a coupling that no gate in either repo can
    // see". Removing the control removes the testid, and there is no honest way
    // to keep it — a `model-selector` on a thing that is not a model selector is
    // worse than its absence. Reported with the PR and recorded in `taste.json`.
    //
    // A three-item dropdown asked the viewer to decide something they have no
    // basis for: two of the three differ only in price and neither name says so.
    // The real choice is grounded-vs-uncensored, which is one switch.
    // ─────────────────────────────────────────────────────────────────────────
    renderBar();
    expect(screen.queryByTestId('model-selector')).toBeNull();
  });

  it('🔴 the capture recipe’s READY ANCHOR survives', () => {
    // `settings-bar` is a documented ready anchor for this app's app-capture
    // recipe and its crop rect is measured to end just under this strip. That half
    // of the coupling is unchanged and is pinned here — it is invisible to every
    // gate in both repos.
    renderBar();
    expect(screen.getByTestId('settings-bar')).toBeInTheDocument();
  });

  it('🔴 the tuning sliders are NOT on the bar any more', () => {
    // The demotion, asserted as a fact rather than left to a screenshot. If a
    // future edit puts them back, this is what says so.
    renderBar();
    expect(screen.queryByTestId('temperature-slider')).toBeNull();
    expect(screen.queryByTestId('max-tokens-slider')).toBeNull();
  });

  it('offers a route to where they went', () => {
    // Demoting a control without leaving a way to reach it is hiding it.
    const onOpenSettings = vi.fn();
    renderBar({ onOpenSettings });
    fireEvent.click(screen.getByTestId('open-tuning'));
    expect(onOpenSettings).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE NSFW TOGGLE.
//
// The gate is `useDomainMaturity().isLevelAllowed`, read ONCE in `App` and passed
// down — see `lib/maturity.ts` for why the `domain` string is the wrong input and
// why the bit is `X`. The policy MATH is tested against the SDK's own pure
// functions in `lib/maturity.test.ts`; what is tested here is the COMPONENT's
// behaviour given each answer.
// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 SettingsBar — the NSFW-mode toggle', () => {
  const renderBar = (over: Partial<Parameters<typeof SettingsBar>[0]> = {}) =>
    render(
      <SettingsBar
        settings={DEFAULT_SETTINGS}
        onChange={vi.fn()}
        onOpenSettings={vi.fn()}
        nsfwAllowed={false}
        {...over}
      />,
    );

  it('🔴 HIDDEN when the viewer may not be shown NSFW output', () => {
    // Covers the two fail-closed causes at once, because they present identically
    // to this component: an absent ceiling (old host / green domain) and
    // pre-`BLOCK_INIT`. `lib/maturity.test.ts` separates the causes.
    renderBar({ nsfwAllowed: false });
    expect(screen.queryByTestId('nsfw-toggle')).toBeNull();
    expect(screen.queryByTestId('nsfw-mode-note')).toBeNull();
  });

  it('🔴 ABSENT, not disabled', () => {
    // A disabled switch labelled "NSFW mode" tells a viewer on a green domain that
    // this app has an uncensored mode they cannot have — an advertisement for
    // something the platform decided they will not be shown, on a surface that
    // cannot explain why.
    renderBar({ nsfwAllowed: false });
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('SHOWN when the viewer may — the positive control', () => {
    // Without this, "hidden" above is satisfied by a toggle that never renders.
    renderBar({ nsfwAllowed: true });
    expect(screen.getByTestId('nsfw-toggle')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'NSFW mode' })).toBeInTheDocument();
  });

  it('reports its state with aria-checked, off by default', () => {
    renderBar({ nsfwAllowed: true });
    // `DEFAULT_SETTINGS.model` is the SFW arm, so the switch reads off.
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('reads ON when the stored model IS the uncensored arm', () => {
    renderBar({ nsfwAllowed: true, settings: { ...DEFAULT_SETTINGS, model: NSFW_MODEL_ID } });
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('🔴 flipping ON sends the NSFW model id', () => {
    const onChange = vi.fn();
    renderBar({ nsfwAllowed: true, onChange });
    fireEvent.click(screen.getByTestId('nsfw-toggle'));
    expect(onChange).toHaveBeenCalledWith({ model: NSFW_MODEL_ID });
  });

  it('🔴 flipping OFF sends the SFW model id', () => {
    const onChange = vi.fn();
    renderBar({
      nsfwAllowed: true,
      onChange,
      settings: { ...DEFAULT_SETTINGS, model: NSFW_MODEL_ID },
    });
    fireEvent.click(screen.getByTestId('nsfw-toggle'));
    expect(onChange).toHaveBeenCalledWith({ model: SFW_MODEL_ID });
  });

  it('🔴 THE COPY DISCLOSES ALL THREE COSTS, BEFORE THE FLIP', () => {
    // 🔴 THE COPY IS THE ONLY MITIGATION THAT EXISTS for this mode, so it is
    // asserted as a DISCLOSURE rather than as decoration. Three facts, each of
    // which the viewer cannot discover any other way:
    //   1. the answers are uncensored (the thing they want)
    //   2. the model CANNOT look anything up, so it answers from its own knowledge
    //      and any model link it writes is STRIPPED by the citation gate
    //   3. they are CHARGED either way — OpenRouter treats `tools` as a soft
    //      preference, so the declarations are silently dropped and the round is
    //      still quoted and billed
    // Rendered while the switch is OFF, because "before they flip it, not after"
    // is the whole point.
    //
    // 🔴 THE WHOLE NORMALISED STRING, NOT FIVE WORDS. This assertion used to be
    // five `toMatch` regexes (`/uncensored/i`, `/stripped/i`, `/cost Buzz/i`, …).
    // When the artifact under test is PROSE, a guard on WORDS is walkable by
    // REWORDING: a rewrite that keeps all five tokens while losing or INVERTING
    // the meaning passed it. "Uncensored answers with no catalog limits: this
    // model can’t look anything up, so nothing is stripped and replies cost Buzz
    // only when grounded." carries every token and discloses the opposite. On a
    // surface whose only mitigation IS the copy, that is not a nit.
    //
    // ⚠️ THE PRICE, ACCEPTED DELIBERATELY: a purely cosmetic reword now fails
    // this test. That is the trade — a machine-readable claim about a spend path
    // is worth a red test on an intentional edit, and the fix is one line (paste
    // the new copy here). Do NOT "fix" a failure by loosening this back to
    // tokens; re-read the three facts above and check the new copy still carries
    // all three, then update the literal.
    //
    // Whitespace is normalised because the source is JSX: the copy is wrapped
    // across three lines in `SettingsBar.tsx`, so `textContent` carries the
    // newlines and indentation of whatever column the formatter chose. Reflowing
    // those lines is not a reword, and must not be a failure.
    const EXPECTED_NSFW_NOTE =
      'Uncensored answers, but no catalog: this model can’t look anything up, ' +
      'so it answers from its own knowledge and any model link it writes is ' +
      'stripped. Replies cost Buzz either way.';

    renderBar({ nsfwAllowed: true });
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    const note = (screen.getByTestId('nsfw-mode-note').textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    expect(note).toBe(EXPECTED_NSFW_NOTE);
  });
});

describe('SettingsModal — the tuning controls, at their new address', () => {
  const renderModal = (over: Partial<Parameters<typeof SettingsModal>[0]> = {}) =>
    render(
      <SettingsModal
        opened
        onClose={vi.fn()}
        settings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        {...over}
      />,
    );

  it('renders temperature slider', () => {
    renderModal();
    expect(screen.getByTestId('temperature-slider')).toBeTruthy();
  });

  it('renders max tokens slider', () => {
    renderModal();
    expect(screen.getByTestId('max-tokens-slider')).toBeTruthy();
  });

  it('displays current temperature', () => {
    renderModal();
    expect(screen.getByText('0.7')).toBeTruthy();
  });

  it('displays current max tokens', () => {
    renderModal();
    expect(screen.getByText('2048')).toBeTruthy();
  });

  it('🔴 re-seeds from the CURRENT settings each time it opens', () => {
    // `useState(settings)` reads its argument once, and this component is
    // mounted for the app's whole life. With three settings now reachable from
    // two surfaces, a dialog showing mount-time values would write a stale
    // model back over a fresh one on Save.
    const onSave = vi.fn();
    const { rerender } = render(
      <SettingsModal
        opened={false}
        onClose={vi.fn()}
        settings={DEFAULT_SETTINGS}
        onSave={onSave}
      />,
    );
    const changed = { ...DEFAULT_SETTINGS, maxTokens: 1024 };
    rerender(
      <SettingsModal opened onClose={vi.fn()} settings={changed} onSave={onSave} />,
    );
    expect(screen.getByText('1024')).toBeTruthy();
  });

  it('does not explain what the labelled control already says', () => {
    renderModal();
    expect(screen.queryByText(/Defines Sensei's personality/)).toBeNull();
  });
});
