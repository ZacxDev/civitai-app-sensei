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
