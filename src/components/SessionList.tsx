import { useMemo } from 'react';
import { Button, Group } from '@civitai/blocks-react/ui';
import type { Session } from '../types.js';
import { token, mutedText } from '../theme.js';

export interface SessionListProps {
  sessions: Session[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string) => void;
}

export function SessionList({
  sessions,
  activeSessionId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
}: SessionListProps) {
  const sorted = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );

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
          padding: '12px',
          borderBottom: `1px solid ${token.border}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <strong style={{ fontSize: 14 }}>Sessions</strong>
        <Button size="sm" variant="light" onClick={onCreate} data-testid="new-session-button">
          + New
        </Button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {sorted.length === 0 && (
          <div style={{ padding: '16px 12px', ...mutedText }}>
            No sessions yet. Start a new conversation.
          </div>
        )}
        {sorted.map((session) => (
          <div
            key={session.id}
            onClick={() => onSelect(session.id)}
            style={{
              padding: '10px 12px',
              cursor: 'pointer',
              background: session.id === activeSessionId ? token.primaryLight : 'transparent',
              borderBottom: `1px solid ${token.border}`,
              borderRadius: 0,
            }}
            data-testid={`session-item-${session.id}`}
          >
            <Group justify="space-between" align="center">
              <span
                style={{
                  flex: 1,
                  fontWeight: session.id === activeSessionId ? 600 : 400,
                  fontSize: 14,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {session.title}
              </span>
              <Group gap={4}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRename(session.id);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: token.dimmed,
                    fontSize: 12,
                    padding: 2,
                  }}
                  title="Rename"
                  data-testid={`rename-session-${session.id}`}
                >
                  ✏️
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(session.id);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: token.dimmed,
                    fontSize: 12,
                    padding: 2,
                  }}
                  title="Delete"
                  data-testid={`delete-session-${session.id}`}
                >
                  🗑️
                </button>
              </Group>
            </Group>
            <div style={{ ...mutedText, marginTop: 4, fontSize: 11 }}>
              {session.model.split('/').pop()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
