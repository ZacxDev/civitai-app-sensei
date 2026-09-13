import { useMemo, useState } from 'react';
import { Button } from '@civitai/blocks-react/ui';
import type { Session } from '../types.js';
import { groupSessionsByRecency, formatRelativeTime } from '../lib/sessions.js';
import { getModelById } from '../lib/models.js';
import { copyText } from '../lib/clipboard.js';
import { Icon, IconButton, type IconName } from './Icon.js';
import { useMotion } from '../lib/motion.js';
import { token, brand, radius, metaText } from '../theme.js';

export interface SessionListProps {
  sessions: Session[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string) => void;
  /**
   * The model the app is set to right now.
   *
   * 🔴 IT EXISTS TO SUPPRESS A LABEL, NOT TO SHOW ONE. Every row used to carry
   * `deepseek-chat` under its title — `session.model.split('/').pop()` — which
   * is the same string on every row, because every session is created with the
   * app's one current model. A column whose every cell is identical is noise
   * with a line of height. A row now names its model ONLY when that model
   * differs from this one, i.e. only when the fact separates it from its
   * neighbours.
   */
  currentModel: string;
  /** Injected so grouping and relative times are not clock-dependent in tests. */
  now?: number;
}

export function SessionList({
  sessions,
  activeSessionId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  currentModel,
  now,
}: SessionListProps) {
  /**
   * Which row's ⋮ menu is open, or `null`.
   *
   * 🔴 ONE CELL FOR THE WHOLE LIST, NOT ONE PER ROW, so opening a second menu
   * closes the first by construction. Per-row state would let two menus stand
   * open at once — two panels overlapping in a 240px column, each with its own
   * Delete.
   */
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const motion = useMotion();
  const at = now ?? Date.now();
  const groups = useMemo(() => groupSessionsByRecency(sessions, at), [sessions, at]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        borderRight: `1px solid ${token.border}`,
        background: token.surface,
        width: 240,
        minWidth: 200,
      }}
      data-testid="session-list"
    >
      <div
        style={{
          padding: '10px 12px',
          borderBottom: `1px solid ${token.border}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <strong style={{ fontSize: 13, letterSpacing: 0.2 }}>Chats</strong>
        <Button size="sm" variant="light" onClick={onCreate} data-testid="new-session-button">
          + New
        </Button>
      </div>

      {/*
        🔴 THE EMPTY STATE IS DELIBERATELY SILENT. It used to read "No sessions
        yet. Start a new conversation." while the main pane, visible at the same
        moment and on the same screen, said "Start a new conversation with
        Sensei" above a New Chat button. Two sentences telling the viewer the
        same thing, one of them beside the very button that does it. The pane
        keeps the call to action; the sidebar keeps the "+ New" affordance above
        and says nothing.
      */}
      <div style={{ flex: 1, overflowY: 'auto' }} data-testid="session-scroll">
        {groups.map((group) => (
          <div key={group.label}>
            <div
              data-testid={`session-group-${group.label.replace(/\s+/g, '-').toLowerCase()}`}
              style={{
                ...metaText,
                position: 'sticky',
                top: 0,
                zIndex: 1,
                padding: '8px 12px 4px',
                background: token.surface,
                fontSize: 10,
                letterSpacing: 0.8,
                textTransform: 'uppercase',
              }}
            >
              {group.label}
            </div>
            {group.sessions.map((session) => {
              const isActive = session.id === activeSessionId;
              // See `currentModel`: named only when it is not the current one.
              const otherModel =
                session.model === currentModel
                  ? null
                  : (getModelById(session.model)?.name ?? session.model.split('/').pop());
              return (
                <div
                  key={session.id}
                  onClick={() => onSelect(session.id)}
                  // 🔴 `aria-current` IS THE ACTIVE-ROW CONTRACT, not the
                  // background colour. A test that reads a colour pins a
                  // decoration; this is the fact a screen reader gets, and it
                  // survives a retint.
                  aria-current={isActive ? 'true' : undefined}
                  className="sensei-row"
                  style={{
                    padding: '8px 12px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    background: isActive ? brand.wash : 'transparent',
                    // A brand hairline on the active row instead of a divider on
                    // every row: 15 full-width borders is what made a list of 15
                    // read as a wall.
                    boxShadow: isActive ? `inset 2px 0 0 ${brand.plate}` : undefined,
                    transition: motion.transition('background 120ms ease'),
                  }}
                  data-testid={`session-item-${session.id}`}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: isActive ? 600 : 400,
                        fontSize: 13,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {session.title}
                    </div>
                    <div style={{ ...metaText, fontSize: 11, marginTop: 1 }}>
                      {formatRelativeTime(session.updatedAt, at)}
                      {otherModel ? ` · ${otherModel}` : ''}
                    </div>
                  </div>
                  {/*
                    ONE row action now — the ⋮ that opens the menu. Rename and
                    Delete moved INSIDE it; see `SessionRowMenu`.

                    🔴 STILL A BUTTON, STILL IN THE DOM AT ALL TIMES, STILL
                    KEYBOARD-REACHABLE. `.sensei-row-actions` only fades on
                    hover/focus-within, so a keyboard user tabbing in reveals it
                    exactly as a pointer user hovering does. That property is
                    deliberate and pre-existing — do not replace the class with
                    conditional rendering, which would make the actions
                    unreachable by keyboard entirely.
                  */}
                  <SessionRowMenu
                    session={session}
                    open={openMenuId === session.id}
                    onOpenChange={(next) => setOpenMenuId(next ? session.id : null)}
                    onRename={onRename}
                    onDelete={onDelete}
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/*
 * 🔴 `RowAction` LIVED HERE AND IS NOW `IconButton` IN `./Icon.tsx` — PROMOTED,
 * NOT REWRITTEN. It was the only one of the app's five icon-only controls that
 * already carried `title`, `aria-label` AND `data-testid`, so the other four were
 * the versions with the defect and this was the version to lift. Do not
 * reintroduce a local variant: a third spelling of "an icon-only button" is what
 * the five-site spread was.
 */

/**
 * THE PER-ROW ⋮ MENU — copy this chat's id, rename it, delete it.
 *
 * 🔴 WHY THE ID IS HERE AT ALL. A session id is
 * `session-<epoch-ms>-<6 base36>` (`lib/sessions.ts`), and it is the only handle
 * that identifies one conversation in a KV store, a support thread or a bug
 * report. Nothing surfaced it, so a viewer could not name the chat that went
 * wrong.
 *
 * 🔴 AND WHY IT IS SELECTABLE TEXT *AND* A COPY BUTTON, NOT JUST THE BUTTON.
 * This block runs in a sandboxed cross-origin iframe where the Async Clipboard
 * API can be refused outright — see `lib/clipboard.ts`. A copy button is the
 * convenient path; the rendered id is the one that still works when the
 * clipboard is blocked, because a viewer can select it by hand. Offering only the
 * button would make a blocked clipboard mean "this value is unreachable".
 *
 * 🔴 RENAME AND DELETE MOVED IN, AND THE ROW KEEPS ITS KEYBOARD PATH. They were
 * always-visible icon buttons faded by `.sensei-row-actions`; the ⋮ trigger now
 * sits in that same container with that same class, so tabbing still reveals it.
 * Delete behind one press is also a small safety gain on a 240px column where it
 * used to sit ~2px from Rename.
 */
function SessionRowMenu({
  session,
  open,
  onOpenChange,
  onRename,
  onDelete,
}: {
  session: Session;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle');

  const copy = async () => {
    // Same contract as the message-copy button: the OUTCOME is rendered, never
    // assumed. `copyText` resolves false rather than throwing.
    setCopyState((await copyText(session.id)) ? 'done' : 'failed');
  };

  return (
    <div
      className="sensei-row-actions"
      // 🔴 FORCED VISIBLE WHILE THE MENU IS OPEN, AND THIS IS NOT COSMETIC. The
      // class sets `opacity: 0` off hover/focus-within, so a menu opened by
      // pointer would VANISH the moment the pointer left the row while remaining
      // open, laid out and clickable — an invisible Delete target. Inline style
      // beats the stylesheet, so this is the narrowest fix that cannot fight the
      // class.
      style={{ display: 'flex', gap: 2, position: 'relative', opacity: open ? 1 : undefined }}
      // Clicks inside the actions area must not also select the row: the panel is
      // a descendant of the row's own `onClick`.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          onOpenChange(false);
        }
      }}
    >
      <IconButton
        label={`Options for ${session.title}`}
        icon="more"
        expanded={open}
        testId={`session-menu-${session.id}`}
        onClick={() => {
          // Reset the copy feedback on every open, so a stale "Copied" from a
          // previous visit cannot read as this visit's outcome.
          if (!open) setCopyState('idle');
          onOpenChange(!open);
        }}
      />
      {open && (
        <div
          data-testid={`session-menu-panel-${session.id}`}
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            padding: 6,
            borderRadius: radius.sm,
            border: `1px solid ${token.border}`,
            background: token.surface,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: 4,
            zIndex: 5,
            minWidth: 190,
            boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
          }}
        >
          <div style={{ ...metaText, fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase' }}>
            Chat id
          </div>
          {/*
            🔴 SELECTABLE, AND SAID SO EXPLICITLY. `userSelect: 'text'` is set
            rather than relied upon: the id sits inside a row whose whole job is
            to be clicked, and a future `user-select: none` on the row (a very
            ordinary thing to add to a list item to stop drag-selection) would
            silently take away the fallback this element exists to be.
            `wordBreak` because the id is 25-ish characters in a 190px panel and
            an ellipsised id is not a pasteable one.
          */}
          <code
            data-testid={`session-id-${session.id}`}
            style={{
              userSelect: 'text',
              fontSize: 11,
              color: token.text,
              wordBreak: 'break-all',
              lineHeight: 1.4,
            }}
          >
            {session.id}
          </code>
          <MenuItem
            label={
              copyState === 'done' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy id'
            }
            testId={`copy-session-id-${session.id}`}
            icon={copyState === 'done' ? 'check' : 'copy'}
            tone={copyState === 'failed' ? 'error' : 'default'}
            onClick={copy}
          />
          <MenuItem
            label="Rename"
            testId={`rename-session-${session.id}`}
            icon="pencil"
            onClick={() => {
              onOpenChange(false);
              onRename(session.id);
            }}
          />
          <MenuItem
            label="Delete"
            testId={`delete-session-${session.id}`}
            icon="trash"
            tone="error"
            onClick={() => {
              onOpenChange(false);
              onDelete(session.id);
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * One row in the ⋮ panel: icon PLUS text.
 *
 * 🔴 NOT an `IconButton`. That component is for an icon-ONLY control, where the
 * accessible name has to come from `aria-label` because there is no text. Here
 * the text IS the name, so labelling it again would announce the row twice — and
 * the glyph is decoration, which is why it stays `aria-hidden` via `Icon`.
 */
function MenuItem({
  label,
  testId,
  icon,
  tone = 'default',
  onClick,
}: {
  label: string;
  testId: string;
  icon: IconName;
  tone?: 'default' | 'error';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: tone === 'error' ? token.error : token.text,
        font: 'inherit',
        fontSize: 12,
        textAlign: 'left',
        padding: '4px 6px',
        borderRadius: radius.sm,
      }}
    >
      <Icon name={icon} size={13} />
      {label}
    </button>
  );
}
