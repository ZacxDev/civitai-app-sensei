import type { CSSProperties } from 'react';

export const token = {
  text: 'var(--civitai-color-text)',
  dimmed: 'var(--civitai-color-text-dimmed)',
  body: 'var(--civitai-color-body)',
  surface: 'var(--civitai-color-surface)',
  surface2: 'var(--civitai-color-surface-2)',
  border: 'var(--civitai-color-border)',
  primary: 'var(--civitai-color-primary)',
  primaryLight: 'var(--civitai-color-primary-light)',
  error: 'var(--civitai-color-error)',
  success: 'var(--civitai-color-success)',
  radius: 'var(--civitai-radius)',
  font: 'var(--civitai-font)',
} as const;

/**
 * The APP-OWNED brand accent. `brandDepth: accent` — see `index.css` for the
 * measured light/dark contrast figures and for why no host token is redefined.
 *
 * 🔴 `plate` IS A FILL, `accent` IS TEXT. The plate is 2.80:1 on the store's
 * light background, so using it for a label or a link is an accessibility
 * regression that looks fine on the dark theme most of us develop against.
 */
export const brand = {
  /** Solid fill. Put `brand.onPlate` on top of it, never body text beside it. */
  plate: 'var(--sensei-plate)',
  /** Text, icons and strokes. Flips per theme; the plate does not. */
  accent: 'var(--sensei-accent)',
  onPlate: 'var(--sensei-on-plate)',
  /** Translucent washes — safe in both themes because they are alpha. */
  wash: 'var(--sensei-wash)',
  washStrong: 'var(--sensei-wash-strong)',
  hairline: 'var(--sensei-hairline)',
} as const;

export const radius = {
  sm: token.radius,
  md: `calc(${token.radius} * 2)`,
  lg: `calc(${token.radius} * 3)`,
} as const;

export function elevate(pct: number): string {
  return `color-mix(in srgb, var(--civitai-color-text) ${pct}%, var(--civitai-color-surface))`;
}

export interface Palette {
  bg: string;
  fg: string;
  muted: string;
  border: string;
  card: string;
  headerBg: string;
}

export function palette(): Palette {
  return {
    bg: token.body,
    fg: token.text,
    muted: token.dimmed,
    border: token.border,
    card: token.surface,
    headerBg: elevate(4),
  };
}

export function pageStyle(c: Palette): CSSProperties {
  return {
    fontFamily: token.font,
    background: c.bg,
    color: c.fg,
    width: '100%',
    minHeight: '100dvh',
    display: 'flex',
    boxSizing: 'border-box',
  };
}

export const mutedText: CSSProperties = { color: token.dimmed, fontSize: 13, lineHeight: 1.5 };
export const metaText: CSSProperties = { color: token.dimmed, fontSize: 12, lineHeight: 1.45 };
