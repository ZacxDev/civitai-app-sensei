import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
    // 🔴 REPOINTED: Delete now lives in the row's ⋮ menu. Same testid, same
    // callback, one press earlier — the assertion is unchanged, only the reach is.
    const onDelete = vi.fn();
    renderList({ sessions: [makeSession('s1', 'Chat 1')], onDelete });
    fireEvent.click(screen.getByTestId('session-menu-s1'));
    fireEvent.click(screen.getByTestId('delete-session-s1'));
    expect(onDelete).toHaveBeenCalledWith('s1');
  });

  it('calls onRename when clicking rename button', () => {
    const onRename = vi.fn();
    renderList({ sessions: [makeSession('s1', 'Chat 1')], onRename });
    fireEvent.click(screen.getByTestId('session-menu-s1'));
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
    // 🔴 REPOINTED for the ⋮ move. The contract is unchanged — every action is
    // reachable by NAME rather than by glyph — but two of the three names now live
    // one press in. The trigger's own name is resource-specific because a sidebar
    // of 15 rows would otherwise offer 15 controls all announced "Options".
    renderList({ sessions: [makeSession('s1', 'Chat 1')] });
    expect(screen.getByRole('button', { name: 'Options for Chat 1' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('session-menu-s1'));
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy id' })).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE ⋮ ROW MENU — rename and delete moved IN, and a chat's id came OUT.
// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 SessionList — the per-row ⋮ menu', () => {
  const ID = 'session-1757000000000-a1b2c3';

  it('the menu is CLOSED at rest, and the moved actions are not on the row', () => {
    // The other half of the move: if Rename/Delete were still rendered on the row
    // as well, every "reachable after the move" assertion below would pass with
    // the menu doing nothing.
    renderList({ sessions: [makeSession(ID, 'Chat 1')] });
    expect(screen.queryByTestId(`session-menu-panel-${ID}`)).toBeNull();
    expect(screen.queryByTestId(`rename-session-${ID}`)).toBeNull();
    expect(screen.queryByTestId(`delete-session-${ID}`)).toBeNull();
  });

  it('the trigger reports its state with aria-expanded', () => {
    renderList({ sessions: [makeSession(ID, 'Chat 1')] });
    const trigger = screen.getByTestId(`session-menu-${ID}`);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('🔴 the id is present as SELECTABLE TEXT, not only behind a copy button', () => {
    // The clipboard can be refused outright in this sandboxed cross-origin
    // iframe, so the rendered id is the path that still works when the button
    // cannot. Asserting the exact id, and that the element is not
    // `user-select: none` — an ellipsised or unselectable id is not a pasteable
    // one.
    renderList({ sessions: [makeSession(ID, 'Chat 1')] });
    fireEvent.click(screen.getByTestId(`session-menu-${ID}`));
    const el = screen.getByTestId(`session-id-${ID}`);
    expect(el.textContent).toBe(ID);
    expect((el as HTMLElement).style.userSelect).toBe('text');
  });

  it('🔴 the actions container stays VISIBLE while the menu is open', () => {
    // `.sensei-row-actions` is `opacity: 0` off hover/focus-within, so without the
    // inline override a menu opened by pointer would vanish the instant the
    // pointer left the row — while staying open, laid out and clickable. An
    // invisible Delete target.
    renderList({ sessions: [makeSession(ID, 'Chat 1')] });
    const trigger = screen.getByTestId(`session-menu-${ID}`);
    const actions = trigger.parentElement as HTMLElement;
    expect(actions.className).toContain('sensei-row-actions');
    expect(actions.style.opacity).toBe('');
    fireEvent.click(trigger);
    expect(actions.style.opacity).toBe('1');
  });

  it('🔴 the actions are in the DOM at rest — the keyboard path is not regressed', () => {
    // The fade is CSS-only and deliberate: a keyboard user tabbing into the row
    // reveals the control exactly as a pointer user hovering does. Replacing the
    // class with conditional rendering would make it unreachable by keyboard, so
    // the trigger's presence with the menu shut is pinned.
    renderList({ sessions: [makeSession(ID, 'Chat 1')] });
    expect(screen.getByTestId(`session-menu-${ID}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`session-menu-panel-${ID}`)).toBeNull();
  });

  it('opening one row’s menu closes another’s', () => {
    renderList({ sessions: [makeSession('s1', 'Chat 1'), makeSession('s2', 'Chat 2')] });
    fireEvent.click(screen.getByTestId('session-menu-s1'));
    expect(screen.getByTestId('session-menu-panel-s1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('session-menu-s2'));
    expect(screen.queryByTestId('session-menu-panel-s1')).toBeNull();
    expect(screen.getByTestId('session-menu-panel-s2')).toBeInTheDocument();
  });

  it('a menu action does not also select the row', () => {
    // The panel is a descendant of the row's own `onClick`, so without
    // `stopPropagation` pressing Rename would ALSO switch the viewer's
    // conversation — which for `onDelete` means deleting a chat and navigating
    // into it in one press.
    const onSelect = vi.fn();
    const onRename = vi.fn();
    renderList({ sessions: [makeSession('s1', 'Chat 1')], onSelect, onRename });
    fireEvent.click(screen.getByTestId('session-menu-s1'));
    fireEvent.click(screen.getByTestId('rename-session-s1'));
    expect(onRename).toHaveBeenCalledWith('s1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('the menu closes after rename or delete', () => {
    renderList({ sessions: [makeSession('s1', 'Chat 1')] });
    fireEvent.click(screen.getByTestId('session-menu-s1'));
    fireEvent.click(screen.getByTestId('rename-session-s1'));
    expect(screen.queryByTestId('session-menu-panel-s1')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 COPY ID — the same "never claim success you cannot observe" contract as the
// message-copy button, driven through the SDK-refusal shape.
// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 SessionList — copy id reports the REAL outcome', () => {
  const realNavigator = globalThis.navigator;

  function installClipboard(writeText: unknown) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText } },
      configurable: true,
      writable: true,
    });
  }

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: realNavigator,
      configurable: true,
      writable: true,
    });
  });

  it('says "Copied" and sends the id when the clipboard accepts', async () => {
    // POSITIVE CONTROL. Without it, "does not claim success" below is satisfied by
    // a button that can never succeed.
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    renderList({ sessions: [makeSession('s1', 'Chat 1')] });
    fireEvent.click(screen.getByTestId('session-menu-s1'));
    fireEvent.click(screen.getByTestId('copy-session-id-s1'));
    await waitFor(() => expect(screen.getByText('Copied')).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith('s1');
  });

  it('🔴 CLIPBOARD REJECTS: says "Copy failed" and never "Copied"', async () => {
    installClipboard(vi.fn().mockRejectedValue(new Error('NotAllowedError')));
    renderList({ sessions: [makeSession('s1', 'Chat 1')] });
    fireEvent.click(screen.getByTestId('session-menu-s1'));
    fireEvent.click(screen.getByTestId('copy-session-id-s1'));
    await waitFor(() => expect(screen.getByText('Copy failed')).toBeInTheDocument());
    expect(screen.queryByText('Copied')).toBeNull();
    // 🔴 AND THE FALLBACK IS STILL THERE. A refused clipboard must leave the
    // viewer a way to get the value, which is the whole reason the id is rendered
    // as selectable text beside the button.
    expect(screen.getByTestId('session-id-s1').textContent).toBe('s1');
  });

  it('reopening the menu clears a stale copy verdict', async () => {
    installClipboard(vi.fn().mockRejectedValue(new Error('NotAllowedError')));
    renderList({ sessions: [makeSession('s1', 'Chat 1')] });
    fireEvent.click(screen.getByTestId('session-menu-s1'));
    fireEvent.click(screen.getByTestId('copy-session-id-s1'));
    await waitFor(() => expect(screen.getByText('Copy failed')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('session-menu-s1')); // close
    fireEvent.click(screen.getByTestId('session-menu-s1')); // reopen
    expect(screen.getByText('Copy id')).toBeInTheDocument();
    expect(screen.queryByText('Copy failed')).toBeNull();
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
