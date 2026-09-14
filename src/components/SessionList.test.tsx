import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionList } from './SessionList.js';
import { NSFW_MODEL_ID, SFW_MODEL_ID } from '../lib/models.js';
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
      // The production default, and the fail-closed one: every mock of
      // `useDomainMaturity()` in this repo answers SFW-only. See `lib/maturity.ts`.
      nsfwAllowed={false}
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

  it('🔴 the actions are in the DOM at rest, and the keyboard REALLY reaches them', async () => {
    // ─────────────────────────────────────────────────────────────────────────
    // 🔴 THE TITLE USED TO CLAIM MORE THAN THE BODY DID. It read "the keyboard
    // path is not regressed" over two `toBeInTheDocument()`/`toBeNull()` lines,
    // and this whole FILE contained no `keyDown`, no `userEvent` and no
    // `.focus()` — so nothing here had ever pressed a key. That is the shape
    // RULES.md calls worse than no test: it reads as coverage and stops anyone
    // looking. The presence assertions are kept (they are the half that catches
    // conditional rendering replacing `.sensei-row-actions`) and the promised
    // half is now actually driven: tab to the trigger, open it with the
    // keyboard, and walk into the panel.
    //
    // ⚠️ AND IT IS AN INVARIANT GUARD, NOT A REGRESSION ONE — measured GREEN at
    // `a0977a7`, because the keyboard path genuinely was not broken. It is here
    // because the title had been claiming this for two releases with nothing
    // behind it. The regression guards for what WAS broken are in the
    // "can be DISMISSED" describe below, and all seven of those were watched
    // red at `a0977a7`.
    // ─────────────────────────────────────────────────────────────────────────
    const user = userEvent.setup();
    renderList({ sessions: [makeSession(ID, 'Chat 1')] });
    const trigger = screen.getByTestId(`session-menu-${ID}`);
    expect(trigger).toBeInTheDocument();
    expect(screen.queryByTestId(`session-menu-panel-${ID}`)).toBeNull();

    // "+ New" is the first tab stop in the column; the row's ⋮ is the second.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId('new-session-button'));
    await user.tab();
    expect(document.activeElement).toBe(trigger);

    await user.keyboard('{Enter}');
    expect(screen.getByTestId(`session-menu-panel-${ID}`)).toBeInTheDocument();

    // …and the items are the next tab stops, in panel order.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId(`copy-session-id-${ID}`));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId(`rename-session-${ID}`));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId(`delete-session-${ID}`));
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
// 🔴 DISMISSAL — THE PANEL HOLDS AN UNCONFIRMED DELETE, SO "STAYS OPEN" IS A
// DATA-LOSS BUG, NOT A POLISH ONE.
//
// The scenario every case below exists for: open row A's ⋮, change your mind,
// click the transcript. Before this change the panel stayed open — `position:
// absolute; zIndex: 5`, forced `opacity: 1`, extending down across the rows
// BELOW A — so the next click at what looks like row B landed on A's panel, at
// the coordinates Delete occupies, and deleted conversation A with no
// confirmation anywhere in the flow.
//
// 🔴 THE THREE CLOSERS ARE ISOLATED FROM EACH OTHER ON PURPOSE. `fireEvent`
// moves no focus and `user-event` does, so a case driven with `user.click`
// cannot tell the `pointerdown` closer from the `focusout` one — both fire, and
// the mutant that removes either still dies. Each case below therefore drives
// exactly one mechanism:
//   • `fireEvent.click(trigger)` + `fireEvent.pointerDown(elsewhere)` — pointer
//     only, focus never moves, so ONLY the document `pointerdown` listener can
//     close it.
//   • `fireEvent.click(trigger)` + `fireEvent.keyDown(document.body, …)` — ONLY
//     the document-level Escape listener can see a key pressed on `<body>`.
//   • `user.tab()` past the last item — ONLY the container's `onBlur` sees that.
// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 SessionList — the ⋮ panel can be DISMISSED, and gives focus back', () => {
  const ID = 'session-1757000000000-a1b2c3';

  /** A stand-in for the transcript: the thing a viewer clicks when they change their mind. */
  function renderBeside(over: Partial<Parameters<typeof SessionList>[0]> = {}) {
    return render(
      <>
        <SessionList
          sessions={[makeSession(ID, 'Chat 1')]}
          activeSessionId={ID}
          onSelect={vi.fn()}
          onCreate={vi.fn()}
          onDelete={vi.fn()}
          onRename={vi.fn()}
          currentModel={MODEL}
          nsfwAllowed={false}
          now={NOW}
          {...over}
        />
        <div data-testid="transcript">a reply the viewer clicks instead</div>
      </>,
    );
  }

  it('🔴 A POINTERDOWN OUTSIDE THE ROW CLOSES IT — and the next press cannot reach Delete', () => {
    const onDelete = vi.fn();
    renderBeside({ onDelete });
    fireEvent.click(screen.getByTestId(`session-menu-${ID}`));
    expect(screen.getByTestId(`session-menu-panel-${ID}`)).toBeInTheDocument();

    // Focus never moves here (`fireEvent` does not implement focus), so this is
    // the document `pointerdown` listener and nothing else.
    fireEvent.pointerDown(screen.getByTestId('transcript'));
    expect(screen.queryByTestId(`session-menu-panel-${ID}`)).toBeNull();

    // THE WHOLE POINT, asserted rather than implied: with the panel gone, the
    // coordinates Delete used to occupy belong to whatever is really there.
    expect(screen.queryByTestId(`delete-session-${ID}`)).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('🔴 a pointerdown INSIDE the actions does NOT close it', () => {
    // POSITIVE CONTROL for the case above: a closer that fires on every
    // pointerdown would satisfy it while making the menu unusable — the press
    // that opens the panel would close it again.
    renderBeside();
    const trigger = screen.getByTestId(`session-menu-${ID}`);
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByTestId(`copy-session-id-${ID}`));
    expect(screen.getByTestId(`session-menu-panel-${ID}`)).toBeInTheDocument();
  });

  it('🔴 ESCAPE CLOSES IT FROM OUTSIDE THE ROW — measured still-open before this', () => {
    // The old handler was React `onKeyDown` on the actions container, so it only
    // ever saw a key pressed inside it: it worked from the trigger and the items
    // and was INERT once focus left the row. Measured at `a0977a7`: Escape
    // dispatched on `document.body` left the panel mounted. Opening with
    // `fireEvent.click` reproduces exactly that state — the panel open with focus
    // still on `<body>`.
    renderBeside();
    fireEvent.click(screen.getByTestId(`session-menu-${ID}`));
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByTestId(`session-menu-panel-${ID}`)).toBeNull();
  });

  it('🔴 escape still works from INSIDE, and hands focus back to the ⋮ trigger', async () => {
    // The route the old container handler covered, kept — plus the focus half it
    // never had. Focus is walked INTO the panel first, so the button holding it
    // is one the close unmounts: without the return, `activeElement` is `<body>`.
    const user = userEvent.setup();
    renderBeside();
    const trigger = screen.getByTestId(`session-menu-${ID}`);
    await user.click(trigger);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId(`copy-session-id-${ID}`));

    await user.keyboard('{Escape}');
    expect(screen.queryByTestId(`session-menu-panel-${ID}`)).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('🔴 TABBING PAST THE LAST ITEM CLOSES IT — the keyboard half of the outside click', async () => {
    // Measured at `a0977a7`: tabbing past Delete landed on `<body>` with the panel
    // still open and fully clickable. No pointer event happens here, so this is
    // the container's `onBlur` and nothing else.
    const user = userEvent.setup();
    renderBeside();
    await user.click(screen.getByTestId(`session-menu-${ID}`));
    await user.tab(); // Copy id
    await user.tab(); // Rename
    await user.tab(); // Delete
    expect(document.activeElement).toBe(screen.getByTestId(`delete-session-${ID}`));
    await user.tab(); // out of the panel
    expect(screen.queryByTestId(`session-menu-panel-${ID}`)).toBeNull();
  });

  it('🔴 RENAME BY KEYBOARD leaves focus on the trigger, not on <body>', async () => {
    // The Rename button unmounts as it is activated, and React does not move the
    // focus it was holding — so `activeElement` fell to `<body>`, dumping a viewer
    // who had tabbed deep into the sidebar back to the top of the tab order.
    const user = userEvent.setup();
    const onRename = vi.fn();
    renderBeside({ onRename });
    const trigger = screen.getByTestId(`session-menu-${ID}`);
    await user.click(trigger);
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId(`rename-session-${ID}`));

    await user.keyboard('{Enter}');
    expect(onRename).toHaveBeenCalledWith(ID);
    expect(document.activeElement).toBe(trigger);
  });

  it('🔴 DELETE BY KEYBOARD leaves focus on "+ New" — the trigger is gone with the row', async () => {
    // 🔴 THE ONE ROUTE THE TRIGGER CANNOT SERVE. Delete unmounts the row, so
    // "return focus to the trigger" is not available and `SessionList` sends it to
    // the only control in the column guaranteed to survive. The list is NOT
    // re-rendered without the row here (`onDelete` is a spy, and this component is
    // controlled), so the assertion is about where the focus was PUT, which is the
    // decision under test.
    const user = userEvent.setup();
    const onDelete = vi.fn();
    renderBeside({ onDelete });
    await user.click(screen.getByTestId(`session-menu-${ID}`));
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId(`delete-session-${ID}`));

    await user.keyboard('{Enter}');
    expect(onDelete).toHaveBeenCalledWith(ID);
    expect(document.activeElement).toBe(screen.getByTestId('new-session-button'));
  });

  it('the document listeners are removed when the panel closes', () => {
    // A listener left behind would close a REOPENED panel on the first outside
    // pointerdown of a row that is no longer the open one — and, 15 rows deep,
    // would be 15 live listeners for a sidebar with nothing open.
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    renderBeside();
    const before = add.mock.calls.filter(([t]) => t === 'pointerdown' || t === 'keydown').length;
    fireEvent.click(screen.getByTestId(`session-menu-${ID}`));
    expect(
      add.mock.calls.filter(([t]) => t === 'pointerdown' || t === 'keydown').length,
    ).toBeGreaterThan(before);
    fireEvent.click(screen.getByTestId(`session-menu-${ID}`)); // close from the trigger
    expect(remove.mock.calls.filter(([t]) => t === 'pointerdown')).toHaveLength(1);
    expect(remove.mock.calls.filter(([t]) => t === 'keydown')).toHaveLength(1);
    add.mockRestore();
    remove.mockRestore();
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

  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 …AND NEVER NAMES A MODEL THIS VIEWER MAY NOT BE OFFERED.
  //
  // The two halves of one PR were applying opposite rules to the same fact.
  // `SettingsBar.tsx:91-94`: the NSFW toggle is ABSENT rather than disabled,
  // because a control labelled "NSFW mode" on a green domain is "an
  // advertisement for something the platform has decided they will not be shown,
  // on a surface that cannot explain why". The sidebar then printed the model's
  // NAME on exactly that surface: a session created under a red ceiling stores
  // `NSFW_MODEL_ID`, the viewer narrows their level, `currentModel` clamps to the
  // SFW arm — so `session.model !== currentModel` and the row rendered
  // `· Dolphin Mistral 24B (uncensored)`.
  // ───────────────────────────────────────────────────────────────────────────
  it('🔴 does NOT name the uncensored model to a viewer who may not be offered it', () => {
    renderList({
      sessions: [makeSession('s1', 'Chat 1', { model: NSFW_MODEL_ID })],
      // The viewer's ceiling narrowed, so the app clamped — this is what `App.tsx`
      // really passes in that state, not a contrived pair.
      currentModel: SFW_MODEL_ID,
      nsfwAllowed: false,
    });
    const row = screen.getByTestId('session-item-s1');
    // The whole label, and the id it is derived from, and the one word that is
    // the actual harm — a mutant that trims the parenthetical still dies.
    expect(row).not.toHaveTextContent('Dolphin');
    expect(row).not.toHaveTextContent('uncensored');
    expect(row).not.toHaveTextContent(NSFW_MODEL_ID);
    expect(row).not.toHaveTextContent('dolphin-mistral-24b-venice-edition');
    // The row itself is still there and still readable — suppressed label, not a
    // suppressed session.
    expect(row).toHaveTextContent('Chat 1');
  });

  it('🔴 POSITIVE CONTROL: it DOES name it when the viewer may be offered it', () => {
    // Without this, the case above is satisfied by deleting the label outright —
    // and by an implementation that suppresses every model name, which is the
    // 15-identical-rows defect this feature exists to fix, reached from the other
    // side. Same session, same stored id, opposite ceiling.
    renderList({
      sessions: [makeSession('s1', 'Chat 1', { model: NSFW_MODEL_ID })],
      currentModel: SFW_MODEL_ID,
      nsfwAllowed: true,
    });
    expect(screen.getByTestId('session-item-s1')).toHaveTextContent('uncensored');
  });

  it('🔴 the gate is on OFFERABILITY, not on "is it the NSFW id" — an ordinary model still shows', () => {
    // Discriminating case. An implementation that suppressed the label whenever
    // `nsfwAllowed` is false — rather than whenever THIS model is unofferable —
    // passes the first case and silently blanks every legitimate label for every
    // viewer on a green domain, which is the majority of them.
    renderList({
      sessions: [makeSession('s1', 'Chat 1', { model: 'openai/gpt-4o-mini' })],
      currentModel: MODEL,
      nsfwAllowed: false,
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
