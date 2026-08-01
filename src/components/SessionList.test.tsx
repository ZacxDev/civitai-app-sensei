import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionList } from './SessionList.js';
import type { Session } from '../types.js';

function makeSession(id: string, title: string): Session {
  return {
    id,
    title,
    model: 'deepseek/deepseek-chat',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('SessionList', () => {
  it('renders empty state', () => {
    render(
      <SessionList
        sessions={[]}
        activeSessionId={null}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
      />,
    );
    expect(screen.getByText(/No sessions yet/)).toBeTruthy();
  });

  it('renders sessions', () => {
    const sessions = [makeSession('s1', 'Chat 1'), makeSession('s2', 'Chat 2')];
    render(
      <SessionList
        sessions={sessions}
        activeSessionId={null}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
      />,
    );
    expect(screen.getByText('Chat 1')).toBeTruthy();
    expect(screen.getByText('Chat 2')).toBeTruthy();
  });

  it('calls onSelect when clicking a session', () => {
    const onSelect = vi.fn();
    const sessions = [makeSession('s1', 'Chat 1')];
    render(
      <SessionList
        sessions={sessions}
        activeSessionId={null}
        onSelect={onSelect}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('session-item-s1'));
    expect(onSelect).toHaveBeenCalledWith('s1');
  });

  it('calls onCreate when clicking new button', () => {
    const onCreate = vi.fn();
    render(
      <SessionList
        sessions={[]}
        activeSessionId={null}
        onSelect={vi.fn()}
        onCreate={onCreate}
        onDelete={vi.fn()}
        onRename={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('new-session-button'));
    expect(onCreate).toHaveBeenCalled();
  });

  it('calls onDelete when clicking delete button', () => {
    const onDelete = vi.fn();
    const sessions = [makeSession('s1', 'Chat 1')];
    render(
      <SessionList
        sessions={sessions}
        activeSessionId={null}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onDelete={onDelete}
        onRename={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('delete-session-s1'));
    expect(onDelete).toHaveBeenCalledWith('s1');
  });

  it('highlights active session', () => {
    const sessions = [makeSession('s1', 'Chat 1')];
    render(
      <SessionList
        sessions={sessions}
        activeSessionId="s1"
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
      />,
    );
    const item = screen.getByTestId('session-item-s1');
    expect(item.style.cursor).toBe('pointer');
  });
});
