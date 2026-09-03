import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * THE BRAND'S DUAL-THEME CLAIM, MEASURED RATHER THAN RESTATED.
 *
 * 🔴 `brandDepth` IS `accent`, SO WHAT THIS FILE OWNS IS EXACTLY TWO VALUES —
 * and it owns them in BOTH themes, which is the debt the rubric warns about.
 * The host still owns every surface, border and text colour, so those flip on
 * their own; `--sensei-accent` does not, because the app defines it.
 *
 * 🔴 THE RATIOS ARE COMPUTED HERE, NOT COPIED FROM THE COMMENT IN `index.css`.
 * A test that asserted "the file says 5.16:1" would pass over a retint that
 * changed the hex and not the comment — the comment is a claim, and this is the
 * measurement. Change a token to something illegible and this goes red with the
 * number it actually computed.
 */

const CSS = readFileSync(
  fileURLToPath(new URL('../index.css', import.meta.url)),
  'utf8',
);

/** `CSS` with comments removed — see {@link tokenIn}. */
const STRIPPED = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * 🔴 THE DOUBLED-ATTRIBUTE SELECTORS, SPELLED OUT SO A REVERT IS VISIBLE HERE.
 * `@civitai/theme` defines the same variables at the SAME specificity and is
 * injected LATER, so the single-attribute form loses the tie and the whole
 * palette goes inert. See the comment in `index.css`. These constants are what
 * makes a well-meaning "simplify the selector" edit fail a test rather than
 * ship a blue app.
 */
const LIGHT_SEL = '[data-theme][data-theme]';
const DARK_SEL = "[data-theme='dark'][data-theme]";

/** The store's own reference backgrounds, from `brand/README.md`'s gate list. */
const LIGHT_BG = '#F7F9FC';
const DARK_BG = '#0B0E14';

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (
    0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The value of `name` inside the FIRST CSS rule whose selector list contains
 * `selector`. Deliberately not a global search: the whole question here is
 * which theme block a value lives in, so a reader that ignored the block would
 * be measuring nothing.
 */
function tokenIn(selector: string, name: string): string | null {
  // 🔴 COMMENTS STRIPPED FIRST. `[^{}]+` swallows whatever precedes a rule, so
  // a selector sitting under a comment block arrives as `*/ [data-theme]…` and
  // matches nothing — a reader that silently finds NOTHING, which is the exact
  // shape of a test that passes for the wrong reason. The `reader finds a
  // DIFFERENT accent` case above is the positive control that catches it.
  const rules = [...STRIPPED.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const [, selectors, body] of rules) {
    if (!selectors.split(',').some((s) => s.trim() === selector)) continue;
    const hit = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(body);
    if (hit) return hit[1].trim();
  }
  return null;
}

describe('🔴 the brand accent is legible in BOTH themes', () => {
  // Positive control on the reader itself: if `tokenIn` silently returned null
  // for everything, every `expect(...).toBeGreaterThan` below would throw on a
  // null rather than passing — but a reader that found the WRONG block would
  // pass quietly. This pins that the two blocks are genuinely different.
  it('the reader finds a DIFFERENT accent in each theme block', () => {
    const light = tokenIn(LIGHT_SEL, '--sensei-accent');
    const dark = tokenIn(DARK_SEL, '--sensei-accent');
    expect(light).toMatch(/^#[0-9a-f]{6}$/i);
    expect(dark).toMatch(/^#[0-9a-f]{6}$/i);
    expect(dark).not.toBe(light);
  });

  it('light-theme accent clears WCAG AA on the store’s light background', () => {
    const light = tokenIn(LIGHT_SEL, '--sensei-accent')!;
    expect(contrast(light, LIGHT_BG)).toBeGreaterThanOrEqual(4.5);
  });

  it('dark-theme accent clears WCAG AA on the store’s dark background', () => {
    const dark = tokenIn(DARK_SEL, '--sensei-accent')!;
    expect(contrast(dark, DARK_BG)).toBeGreaterThanOrEqual(4.5);
  });

  it('🔴 the PLATE is a fill and would FAIL as light-theme text — the split is real', () => {
    // 🔴 THE NEGATIVE CONTROL, and the reason the plate/accent split exists at
    // all rather than one brand colour. `#67A63A` is the brand hue from
    // `brand/README.md`; on the light background it is ~2.8:1, i.e. unusable
    // for text. If a later edit collapses the two tokens into one, this is what
    // says so — and without it, "the accent passes AA" could be satisfied by
    // simply pointing everything at whichever value happens to pass.
    const plate = tokenIn(LIGHT_SEL, '--sensei-plate')!;
    expect(plate.toLowerCase()).toBe('#67a63a');
    expect(contrast(plate, LIGHT_BG)).toBeLessThan(4.5);
  });

  it('🔴 the white glyph on the plate measures 2.96:1 — recorded, with what would beat it', () => {
    // ─────────────────────────────────────────────────────────────────────────
    // 🔴 REPORTED RATHER THAN ASSERTED AWAY. White on `#67A63A` measures
    // **2.96:1**, which is BELOW the 3:1 WCAG threshold for a meaningful
    // non-text graphic. Three facts decide what to do about it, and all three
    // are pinned below so nobody has to re-derive them:
    //
    //  1. The plate hue is NOT ours to change — `brand/README.md` is the source
    //     of truth for `#67A63A` and every store asset is gated on landing
    //     within dE 3.0 of it. Darkening the plate to buy contrast would put
    //     the in-app mark off-brand from the store icon beside it.
    //  2. White is NOT the ceiling, and claiming it was is a mistake this test
    //     originally made and was caught by its own measurement. A near-black
    //     glyph scores ~6.5:1 on the same plate — better than double. White is
    //     chosen for the store icon's own idiom, not because nothing beats it,
    //     and the alternative is pinned below so the trade stays visible.
    //  3. The 3:1 threshold governs graphics that CARRY MEANING. Both marks in
    //     this app are `aria-hidden` decoration rendered directly beside the
    //     app's name in text, so nothing is conveyed by the glyph alone.
    //
    // If (3) stops being true — if a mark ever becomes the only carrier of a
    // meaning — 2.96 is no longer acceptable and (2) is the fix: darken the
    // glyph, never the plate.
    // ─────────────────────────────────────────────────────────────────────────
    const plate = tokenIn(LIGHT_SEL, '--sensei-plate')!;
    const onPlate = tokenIn(LIGHT_SEL, '--sensei-on-plate')!;
    const accent = tokenIn(LIGHT_SEL, '--sensei-accent')!;

    expect(contrast(plate, onPlate)).toBeCloseTo(2.96, 2);
    // White beats the only other palette value anyone would reach for.
    expect(contrast(plate, onPlate)).toBeGreaterThan(contrast(plate, accent));
    // 🔴 AND THE ESCAPE HATCH, MEASURED: a near-black glyph on the same plate
    // clears 3:1 comfortably. Recorded so the fix in (2) is a number rather
    // than a suggestion.
    expect(contrast(plate, DARK_BG)).toBeGreaterThanOrEqual(3);
  });

  it('🔴 the LEDGER: exactly four host tokens are repointed, and they are the accent channel', () => {
    // ─────────────────────────────────────────────────────────────────────────
    // 🔴 A LEDGER, NOT A BAN, AND THE DIFFERENCE MATTERS. This assertion began
    // as `expect(CSS).not.toMatch(/--civitai-[a-z0-9-]+\s*:/)` — "no host token
    // is redefined" — and that rule was WRONG about what this app needed: with
    // it obeyed, the app shipped a green mark beside a host-blue primary
    // button, which reads as a mistake rather than as restraint. A guard that
    // forbids the thing you have to do gets deleted, not updated.
    //
    // So the set is enumerated instead, and this FAILS IF IT GROWS **OR
    // SHRINKS**. Growing means a structural or semantic token has quietly been
    // taken over and the app is at `skin` depth with none of the dual-theme
    // coverage that implies. Shrinking means half the accent channel is left
    // host-blue — which is the mixed state above, and it is the failure that is
    // easy to reach by deleting one line.
    // ─────────────────────────────────────────────────────────────────────────
    const REPOINTED = [
      '--civitai-color-primary',
      '--civitai-color-primary-hover',
      '--civitai-color-primary-fg',
      '--civitai-color-primary-light',
    ].sort();

    const assigned = [
      ...new Set(
        [...STRIPPED.matchAll(/(--civitai-[a-z0-9-]+)\s*:/gi)].map((m) => m[1].toLowerCase()),
      ),
    ].sort();
    expect(assigned).toEqual(REPOINTED);

    // 🔴 AND BOTH THEMES CARRY THE WHOLE SET. Repointing the fill in dark
    // without its foreground leaves the host's WHITE text on a light-green
    // button at ~2:1 — unreadable, in the theme most viewers use.
    for (const name of REPOINTED) {
      expect(tokenIn(LIGHT_SEL, name), `${name} missing from the light block`).not.toBeNull();
      expect(tokenIn(DARK_SEL, name), `${name} missing from the dark block`).not.toBeNull();
    }
  });

  it('🔴 the filled button’s own text clears AA in BOTH themes', () => {
    // The pair that the ledger above only proves is PRESENT. `@civitai/
    // components` paints the filled button `background: primary; color:
    // primary-fg`, so this is the literal on-screen contrast of every primary
    // button in the app.
    for (const sel of [LIGHT_SEL, DARK_SEL]) {
      const bg = tokenIn(sel, '--civitai-color-primary')!;
      const fg = tokenIn(sel, '--civitai-color-primary-fg')!;
      expect(contrast(bg, fg), `primary button text in ${sel}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('🔴 NO structural or semantic host token is touched — the other half of `accent`', () => {
    // The platform still owns light/dark for the frame, and a status colour
    // still means status. This is the half of the old ban worth keeping.
    for (const name of [
      'body', 'surface', 'surface-2', 'text', 'text-dimmed', 'border',
      'error', 'success', 'warning', 'info',
    ]) {
      expect(STRIPPED, `--civitai-color-${name} must stay the platform's`)
        .not.toMatch(new RegExp(`--civitai-color-${name}\\s*:`, 'i'));
    }
  });
});

describe('🔴 index.css carries keyframes, never a motion DURATION', () => {
  // 🔴 INVARIANT GUARD — also green at `13f32df` (that file had 11 lines and no
  // motion). It exists to stop the second copy of the reduced-motion rule from
  // ever appearing here, which is a live hazard only now that keyframes do.
  it('declares no transition or animation duration', () => {
    // The reduced-motion rule lives in `lib/motion.ts` and is applied by
    // components NOT setting an animation. A duration in this file would be a
    // second, untestable copy of that decision which could disagree with it —
    // see the header comment there. Keyframes and the instant (duration-free)
    // hover reveal are the only motion-adjacent things allowed here.
    const declarations = STRIPPED;
    expect(declarations).not.toMatch(/\btransition\s*:/);
    expect(declarations).not.toMatch(/\banimation\s*:/);
    expect(declarations).not.toMatch(/prefers-reduced-motion/);
  });

  it('positive control: the keyframes the components name DO exist', () => {
    // Otherwise "no durations" is satisfied by a file with no motion at all,
    // and every animation in the app would silently render nothing.
    expect(CSS).toMatch(/@keyframes\s+senseiRise\b/);
    expect(CSS).toMatch(/@keyframes\s+senseiPulse\b/);
  });
});
