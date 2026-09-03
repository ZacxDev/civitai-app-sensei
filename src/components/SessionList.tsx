import { useMemo } from 'react';
import { Button } from '@civitai/blocks-react/ui';
import type { Session } from '../types.js';
import { groupSessionsByRecency, formatRelativeTime } from '../lib/sessions.js';
import { getModelById } from '../lib/models.js';
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
                    Row actions. Still buttons, still in the DOM at all times and
                    still keyboard-reachable — `.sensei-row` only fades them in
                    on hover/focus-within, so a keyboard user tabbing in reveals
                    them exactly as a pointer user hovering does.
                  */}
                  <div className="sensei-row-actions" style={{ display: 'flex', gap: 2 }}>
                    <RowAction
                      label="Rename"
                      testId={`rename-session-${session.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRename(session.id);
                      }}
                    >
                      ✏️
                    </RowAction>
                    <RowAction
                      label="Delete"
                      testId={`delete-session-${session.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(session.id);
                      }}
                    >
                      🗑️
                    </RowAction>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function RowAction({
  label,
  testId,
  onClick,
  children,
}: {
  label: string;
  testId: string;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: token.dimmed,
        fontSize: 12,
        lineHeight: 1,
        padding: 3,
        borderRadius: radius.sm,
      }}
      title={label}
      aria-label={label}
      data-testid={testId}
    >
      {children}
    </button>
  );
}
