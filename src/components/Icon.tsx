import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { token, radius } from '../theme.js';

/**
 * THE APP'S OWN ICON SET, INLINE, PLUS THE ONE BUTTON THAT WEARS IT.
 *
 * 🔴 WHY AN APP-OWNED SET RATHER THAN A DEPENDENCY. No `@civitai/*` package
 * exports an icon primitive — checked against the installed dist of all four
 * direct deps at the versions this repo builds against, not against memory —
 * and a block renders inside a sandboxed cross-origin iframe with a strict CSP,
 * so an icon FONT or a sprite URL is a network request that may simply not
 * resolve. Inline SVG is the only shape with no request and no dependency.
 * If `@civitai/blocks-react` ever ships icons, delete this file rather than
 * keeping two sets.
 *
 * 🔴 AND WHY IT REPLACED EMOJI. Five controls rendered an emoji as their ONLY
 * affordance (`🔄`, `📋`, `✕`, `✏️`, `🗑️`). Three problems, in order of weight:
 * an emoji is a CHARACTER, so it is announced by a screen reader as whatever
 * the platform's CLDR name happens to be ("counterclockwise arrows button") —
 * which is why {@link IconButton} carries a real `aria-label` and every glyph
 * here is `aria-hidden`; it renders in the platform's own emoji font, so it
 * ignores `currentColor` and cannot be tinted to match a theme it is sitting
 * in; and its metrics are font-dependent, so five buttons sized in `px` came
 * out five different sizes.
 *
 * 🔴 A TEST MUST ASSERT THE ACCESSIBLE NAME, NEVER THE GLYPH. A guard reading
 * `getByText('🗑️')` is walked around by any edit that swaps one glyph for
 * another — a SPELLED guard, the exact shape `toolchain-lockstep.test.ts`'s
 * header is about. The name is the contract; the path data is decoration.
 */

/** Every icon this app draws. A name with no arm below is a compile error. */
export type IconName =
  | 'regenerate'
  | 'copy'
  | 'check'
  | 'close'
  | 'pencil'
  | 'trash'
  | 'more';

/**
 * The path geometry, keyed by name.
 *
 * All drawn on a 16×16 grid with `stroke: currentColor` and no fill, so one
 * `color` on the parent tints every icon and `IconButton`'s hover/disabled
 * states need no per-icon work. `more` is the one exception — three dots read
 * better as filled circles than as a stroked path.
 */
const PATHS: Record<IconName, ReactNode> = {
  // A circular arrow: regenerate / try again.
  regenerate: (
    <>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89" />
      <path d="M13.5 2.5v3.2h-3.2" />
    </>
  ),
  // Two offset sheets: copy.
  copy: (
    <>
      <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.5" />
      <path d="M10.25 3.75a1.5 1.5 0 0 0-1.5-1.5h-4.5a1.5 1.5 0 0 0-1.5 1.5v4.5a1.5 1.5 0 0 0 1.5 1.5" />
    </>
  ),
  // A tick: the copy succeeded.
  check: <path d="M2.75 8.5l3.5 3.5 7-7.5" />,
  // An X: remove this attachment.
  close: (
    <>
      <path d="M4 4l8 8" />
      <path d="M12 4l-8 8" />
    </>
  ),
  // A pencil: rename.
  pencil: (
    <>
      <path d="M11.2 2.3a1.8 1.8 0 0 1 2.5 2.5l-8 8-3.2.9.9-3.2z" />
      <path d="M10.1 3.4l2.5 2.5" />
    </>
  ),
  // A bin: delete.
  trash: (
    <>
      <path d="M2.75 4.75h10.5" />
      <path d="M6.25 4.75V3.25h3.5v1.5" />
      <path d="M4.25 4.75l.6 8.1a1 1 0 0 0 1 .9h4.3a1 1 0 0 0 1-.9l.6-8.1" />
    </>
  ),
  // A vertical ellipsis: "more actions on this row".
  more: (
    <>
      <circle cx="8" cy="3.4" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="8" cy="12.6" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
};

export interface IconProps {
  name: IconName;
  /** Edge length in px. The grid is square, so one number covers both axes. */
  size?: number;
}

/**
 * One icon, drawn in `currentColor`.
 *
 * 🔴 `aria-hidden` AND `focusable="false"` ARE BOTH REQUIRED, and neither is
 * optional-with-a-default here. `aria-hidden` stops the shape being announced
 * beside the button's own label (which would read the control twice);
 * `focusable="false"` stops legacy engines putting the `<svg>` itself in the tab
 * order, which turns one control into two tab stops. There is deliberately no
 * prop to switch either off: an icon that must be announced is a label, and
 * labels are text.
 */
export function Icon({ name, size = 15 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      // A block element, so the button's line-height cannot add a descender gap
      // under the glyph — the thing that made the emoji row sit off-centre.
      style={{ display: 'block', flexShrink: 0 }}
      data-icon={name}
    >
      {PATHS[name]}
    </svg>
  );
}

export interface IconButtonProps {
  /**
   * The ACCESSIBLE NAME, and also the tooltip. One prop for both on purpose:
   * they were separate (`title` / `aria-label`) at the one site that had them
   * and identical in value, and a site that set only one is how a control ends
   * up announced as "button".
   */
  label: string;
  icon: IconName;
  onClick: (e: MouseEvent) => void;
  /** Forwarded verbatim. Every caller has one; there is no derived default. */
  testId: string;
  disabled?: boolean;
  /** Set on a control that opens a menu, together with `aria-haspopup`. */
  expanded?: boolean;
  /** `'error'` tints the glyph with the host's error token — used by Delete. */
  tone?: 'default' | 'error';
  size?: number;
  style?: CSSProperties;
}

/**
 * THE ONE ICON-ONLY BUTTON, promoted out of `SessionList`'s local `RowAction`.
 *
 * 🔴 PROMOTED RATHER THAN RE-WRITTEN. `RowAction` already carried the three
 * things the other four sites were missing — `title`, `aria-label` and
 * `data-testid` — so the two `MessageBubble` buttons and the mention Remove
 * were the versions with the defect, not the version to copy. Writing a third
 * variant is what the five-site spread was.
 *
 * 🔴 `type="button"` IS LOAD-BEARING. The default is `submit`, and this app
 * ships inside `sandbox="allow-scripts allow-forms"` — a form CAN submit here,
 * so a bare `<button>` that happens to land inside one navigates the iframe
 * away. None of these controls submits anything.
 */
export function IconButton({
  label,
  icon,
  onClick,
  testId,
  disabled,
  expanded,
  tone = 'default',
  size,
  style,
}: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      {...(expanded === undefined ? {} : { 'aria-expanded': expanded, 'aria-haspopup': 'menu' })}
      data-testid={testId}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'none',
        border: 'none',
        cursor: disabled ? 'default' : 'pointer',
        color: tone === 'error' ? token.error : token.dimmed,
        padding: 3,
        borderRadius: radius.sm,
        lineHeight: 1,
        opacity: disabled ? 0.5 : 1,
        ...style,
      }}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}
