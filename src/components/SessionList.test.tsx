import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SessionList } from './SessionList.js';
import type { Session } from '../types.js';

const MODEL = 'deepseek/deepseek-chat';
const NOW = Date.UTC(2026, 8, 2, 12, 0, 0); // a fixed instant; grouping is calendar-based

function makeSession(id: string, title: string, over: Partial<Session> = {}): Session {
  return {
    id,
    title,
    model: MODEL,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function renderList(over: Partial<Parameters<typeof SessionList>[0]> = {}) {
  return render(
    <SessionList
      sessions={[]}
      activeSessionId={null}
      onSelect={vi.fn()}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onRename={vi.fn()}
      currentModel={MODEL}
      now={NOW}
      {...over}
    />,
  );
}

describe('SessionList', () => {
  it('🔴 an empty sidebar says NOTHING — the pane beside it carries the call to action', () => {
    // ─────────────────────────────────────────────────────────────────────────
    // 🔴 REPOINTED 2026-09-02, and this one is a genuine loosening in text and
    // a tightening in contract, so it is called out rather than edited quietly.
    //
    // It used to be `expect(screen.getByText(/No sessions yet/))`, pinning the
    // copy "No sessions yet. Start a new conversation." That string was
    // DELETED: it rendered at the same moment, on the same screen, as the main
    // pane's "Ask a question. Sensei looks it up." above a New Chat button —
    // two pieces of copy telling one viewer the same thing.
    //
    // Pinning the absence alone would be a test that a `return null` satisfies,
    // so the contract is asserted from both ends: no rows, and the create
    // affordance still present.
    // ─────────────────────────────────────────────────────────────────────────
    renderList();
    expect(screen.queryByText(/No sessions yet/)).toBeNull();
    expect(within(screen.getByTestId('session-scroll')).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByTestId('new-session-button')).toBeInTheDocument();
  });

  it('renders sessions', () => {
    renderList({ sessions: [makeSession('s1', 'Chat 1'), makeSession('s2', 'Chat 2')] });
    expect(screen.getByText('Chat 1')).toBeTruthy();
    expect(screen.getByText('Chat 2')).toBeTruthy();
  });

  it('calls onSelect when clicking a session', () => {
    const onSelect = vi.fn();
    renderList({ sessions: [makeSession('s1', 'Chat 1')], onSelect });
    fireEvent.click(screen.getByTestId('session-item-s1'));
    expect(onSelect).toHaveBeenCalledWith('s1');
  });

  it('calls onCreate when clicking new button', () => {
    const onCreate = vi.fn();
    renderList({ onCreate });
    fireEvent.click(screen.getByTestId('new-session-button'));
    expect(onCreate).toHaveBeenCalled();
  });

  it('calls onDelete when clicking delete button', () => {
    const onDelete = vi.fn();
    renderList({ sessions: [makeSession('s1', 'Chat 1')], onDelete });
    fireEvent.click(screen.getByTestId('delete-session-s1'));
    expect(onDelete).toHaveBeenCalledWith('s1');
  });

  it('calls onRename when clicking rename button', () => {
    const onRename = vi.fn();
    renderList({ sessions: [makeSession('s1', 'Chat 1')], onRename });
    fireEvent.click(screen.getByTestId('rename-session-s1'));
    expect(onRename).toHaveBeenCalledWith('s1');
  });

  it('🔴 marks the active session with aria-current, not with a colour', () => {
    // ─────────────────────────────────────────────────────────────────────────
    // 🔴 REPOINTED 2026-09-02. This test was named "highlights active session"
    // and its whole body was `expect(item.style.cursor).toBe('pointer')` —
    // which is true of EVERY row, active or not, and would still pass with the
    // highlight deleted. It pinned an incidental fact under a name claiming a
    // contract, so it read as coverage and provided none.
    //
    // It now asserts the fact a screen reader is given, which is also the one
    // that survives a retint.
    // ─────────────────────────────────────────────────────────────────────────
    renderList({
      sessions: [makeSession('s1', 'Chat 1'), makeSession('s2', 'Chat 2')],
      activeSessionId: 's1',
    });
    expect(screen.getByTestId('session-item-s1')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('session-item-s2')).not.toHaveAttribute('aria-current');
  });

  it('the row actions carry accessible names, not just emoji', () => {
    renderList({ sessions: [makeSession('s1', 'Chat 1')] });
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeInTheDocument();
  });
});

describe('🔴 SessionList — the noise the live sidebar was full of', () => {
  const DAY = 86_400_000;

  it('groups rows by recency instead of running 15 of them together', () => {
    renderList({
      sessions: [
        makeSession('a', 'Today one', { updatedAt: NOW - 60_000 }),
        makeSession('b', 'Yesterday one', { updatedAt: NOW - DAY }),
        makeSession('c', 'Ancient', { updatedAt: NOW - 40 * DAY }),
      ],
    });
    expect(screen.getByTestId('session-group-today')).toHaveTextContent('Today');
    expect(screen.getByTestId('session-group-yesterday')).toHaveTextContent('Yesterday');
    expect(screen.getByTestId('session-group-older')).toHaveTextContent('Older');
    // A heading with nothing under it is worse than no heading.
    expect(screen.queryByTestId('session-group-previous-7-days')).toBeNull();
  });

  it('🔴 does NOT repeat the current model under every row', () => {
    // The old subtitle was `session.model.split('/').pop()` — `deepseek-chat`
    // on all fifteen rows, because every session is created with the app's one
    // current model. A column whose every cell is identical is a line of height
    // carrying no information.
    renderList({
      sessions: [makeSession('s1', 'Chat 1'), makeSession('s2', 'Chat 2')],
      currentModel: MODEL,
    });
    expect(screen.queryByText(/deepseek-chat/)).toBeNull();
  });

  it('🔴 DOES name the model when it differs — the case where it separates rows', () => {
    // Positive control for the assertion above: the label is SUPPRESSED when
    // uninformative, not deleted. Without this, `otherModel = null` would pass.
    renderList({
      sessions: [makeSession('s1', 'Chat 1', { model: 'openai/gpt-4o-mini' })],
      currentModel: MODEL,
    });
    expect(screen.getByTestId('session-item-s1')).toHaveTextContent('GPT-4o mini');
  });

  it('shows a relative time, which is what tells two same-titled rows apart', () => {
    renderList({
      sessions: [
        makeSession('s1', 'most popular models', { updatedAt: NOW - 2 * 60_000 }),
        makeSession('s2', 'most popular models', { updatedAt: NOW - 3 * 3_600_000 }),
      ],
    });
    expect(screen.getByTestId('session-item-s1')).toHaveTextContent('2m');
    expect(screen.getByTestId('session-item-s2')).toHaveTextContent('3h');
  });
});
