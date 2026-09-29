import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Button } from '@civitai/blocks-react/ui';
import type { Session } from '../types.js';
import { groupSessionsByRecency, formatRelativeTime } from '../lib/sessions.js';
import { getModelById } from '../lib/models.js';
import { isModelOfferable } from '../lib/maturity.js';
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
  /**
   * Commit a rename. The EDITING UI lives in this component — an inline input
   * on the row, replacing the `window.prompt()` that used to sit in
   * `App.renameSession` — and only a committed, non-empty title reaches here.
   * See `RenameEditor` for why `prompt` had to go.
   */
  onRename: (id: string, title: string) => void;
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
  /**
   * Whether this viewer may be offered the uncensored arm — the SAME read that
   * clamps `activeModel` in `App.tsx`, passed down rather than re-derived.
   *
   * 🔴 IT GATES THE LABEL, AND THAT IS NOT COSMETIC. A session created under a red
   * ceiling stores `NSFW_MODEL_ID`. Narrow the ceiling and `currentModel` clamps to
   * the SFW arm, so `session.model !== currentModel` and the row happily rendered
   * `· Dolphin Mistral 24B (uncensored)` — naming an uncensored model to a viewer
   * the platform has decided will not be shown one, in a 240px column with no room
   * to explain why. `SettingsBar.tsx:91-94` forbids exactly that for the toggle
   * ("ABSENT, NOT DISABLED … an advertisement for something the platform has
   * decided they will not be shown"); this surface was applying the opposite rule
   * to the same fact.
   *
   * 🔴 SUPPRESSED, NOT RELABELLED. The honest alternative would be to name the
   * clamp's target instead, and that is worse: the row records what a past
   * conversation actually ran on, so substituting would state something false
   * about it. No label beats a wrong one. See `isModelOfferable`.
   *
   * 🔴 A REQUIRED PROP, deliberately. A default of `true` would fail OPEN — the one
   * direction this must never fail — and a default of `false` would silently
   * suppress a legitimate label at any site that forgot to pass it.
   */
  nsfwAllowed: boolean;
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
  nsfwAllowed,
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
  /**
   * The row currently being renamed, and the text in its editor.
   *
   * 🔴 WHY THIS STATE LIVES HERE AND NOT IN `App.renameSession`: the old flow
   * called `window.prompt()` — which a sandboxed iframe SILENTLY IGNORES (no
   * `allow-modals`), so prompt returned nothing, the `if (!title) return` fired,
   * and clicking Rename did nothing at all. The console even said so: `Ignored
   * call to 'prompt()'. The document is sandboxed, and the 'allow-modals'
   * keyword is not set.` The fix is the editing UI the web uses for a list item:
   * the row itself becomes an input (see `RenameEditor`). The list owns
   * `renamingId` so two rows cannot edit at once; the draft text is the
   * editor's own state, so a cancelled edit cannot leave text behind.
   */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  /**
   * The "+ New" button, as the FOCUS TARGET AFTER A DELETE.
   *
   * 🔴 THE ⋮ TRIGGER CANNOT BE THAT TARGET, because Delete unmounts the row it
   * lives on. Every other close route puts focus back on the trigger (see
   * `SessionRowMenu`); this is the one route where the trigger is gone by the
   * time focus needs somewhere to be, and without a target
   * `document.activeElement` falls to `<body>` — the top of the tab order, from
   * a control the viewer reached by tabbing deep into the sidebar.
   *
   * "+ New" is chosen because it is the only control in this column guaranteed
   * to exist: the deleted row is gone, the row that took its place is not the
   * one the viewer was on, and the list can be emptied entirely by this very
   * press. `Button` from `@civitai/blocks-react/ui` is ref-forwarded to its
   * native `<button>` (checked against the installed `dist/ui/Button.d.ts`).
   *
   * 🔴 AND IT FIRES ON THE KEYBOARD ROUTE ONLY. `SessionRowMenu` decides which
   * route this was and says so in `fromKeyboard`; see the Delete handler. The
   * panel's own policy is that "the outside-pointer and tab-out routes pass
   * `false`, because the viewer is deliberately somewhere else and pulling them
   * back would be a focus trap" — an unconditional refocus here applied the
   * opposite rule to the pointer route. Measured: mouse-click ⋮ → mouse-click
   * Delete left `document.activeElement` on "+ New", so the next Space press
   * fired `onCreate` instead of scrolling the sidebar.
   */
  const newButtonRef = useRef<HTMLButtonElement | null>(null);
  const deleteAndRefocus = useCallback(
    (id: string, fromKeyboard: boolean) => {
      if (fromKeyboard) newButtonRef.current?.focus();
      onDelete(id);
    },
    [onDelete],
  );
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
        <Button
          ref={newButtonRef}
          size="sm"
          variant="light"
          onClick={onCreate}
          data-testid="new-session-button"
        >
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
              // Named only when it is not the current one (see `currentModel`) AND
              // when this viewer may be offered it at all (see `nsfwAllowed`).
              const otherModel =
                session.model === currentModel || !isModelOfferable(session.model, nsfwAllowed)
                  ? null
                  : (getModelById(session.model)?.name ?? session.model.split('/').pop());
              return (
                <div
                  key={session.id}
                  onClick={() => {
                    // 🔴 A PRESS INSIDE THE EDITOR IS NOT A SELECTION. While the
                    // row is being renamed its input sits inside this row, so
                    // every click on it bubbles here; treating that as
                    // `onSelect` is harmless for the same row but would
                    // re-select on a stray press mid-edit. Rename commits live
                    // in the editor's Enter/blur, never here.
                    if (renamingId === session.id) return;
                    onSelect(session.id);
                  }}
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
                  {/*
                    🔴 WHILE THE ROW IS BEING RENAMED, THE EDITOR REPLACES THE
                    TITLE BLOCK AND THE ⋮ IS GONE — not hidden by CSS but not
                    rendered. The menu's own click path starts the rename and
                    closes itself first (`close(true)` in `SessionRowMenu`), so
                    a menu cannot be open on an editing row; rendering the
                    trigger during a rename would just be a second way to click
                    out of the edit (its blur-commit fires first) for no
                    affordance the edit itself does not provide.
                  */}
                  {renamingId === session.id ? (
                    <RenameEditor
                      initial={session.title}
                      testId={`rename-input-${session.id}`}
                      onCommit={(title) => {
                        setRenamingId(null);
                        onRename(session.id, title);
                      }}
                      onCancel={() => setRenamingId(null)}
                    />
                  ) : (
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
                  )}
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
                  {renamingId !== session.id && (
                    <SessionRowMenu
                      session={session}
                      open={openMenuId === session.id}
                      onOpenChange={(next) => setOpenMenuId(next ? session.id : null)}
                      // Starting an edit is THIS component's state change, not a
                      // call out to App. The old flow called `window.prompt()`
                      // inside `App.renameSession`, which the sandboxed iframe
                      // ignores silently — see the `renamingId` note above.
                      onRename={(id) => setRenamingId(id)}
                      onDelete={deleteAndRefocus}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * THE INLINE RENAME INPUT THAT REPLACED `window.prompt()`.
 *
 * 🔴 WHY THE PROMPT DIED, AND WHY THIS IS A COMPONENT AT ALL. The rename flow
 * used to be one line in `App.renameSession`: `prompt('Rename session:')`. In
 * the embedded run page that call is silently IGNORED — the document is
 * sandboxed without `allow-modals`, so the browser skips it and resolves to
 * `null` (the viewer's console: `Ignored call to 'prompt()'. The document is
 * sandboxed, and the 'allow-modals' keyword is not set.`) — and `if (!title)
 * return` turned that into a silent no-op. Rename read as broken because it
 * WAS broken, on the exact surface this app ships on. The replacement is the
 * pattern list UIs use everywhere: the row's title becomes a focused input.
 *
 * Commit rules: Enter or blur COMMITS the trimmed text, Escape CANCELS, an
 * empty (whitespace-only) title commits nothing — the old `if (!title) return`
 * survives as "clearing the box and walking away cancels", not "ship an empty
 * name".
 */
function RenameEditor({
  initial,
  testId,
  onCommit,
  onCancel,
}: {
  initial: string;
  testId: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /**
   * 🔴 THE COMMIT LATCH. Enter commits, the parent unmounts this editor, and
   * browsers deliver a `blur` on a node being torn down inconsistently —
   * `onBlur={commit}` must not fire a SECOND commit after the first, with the
   * same or a cleared draft. Whichever of commit/cancel runs first latches;
   * every later call is a no-op.
   */
  const settledRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // The whole title selected, so typing replaces it — the prompt() flow
    // pre-filled the same way.
    input.select();
  }, []);

  const commit = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    const trimmed = value.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    onCommit(trimmed);
  };

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  };

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={commit}
      aria-label="Rename this chat"
      data-testid={testId}
      style={{
        flex: 1,
        minWidth: 0,
        font: 'inherit',
        fontSize: 13,
        color: token.text,
        background: token.surface2,
        border: `1px solid ${token.border}`,
        borderRadius: radius.sm,
        padding: '3px 6px',
      }}
    />
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
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * 🔴 DISMISSAL IS NOT POLISH HERE — THE PANEL HOLDS AN UNCONFIRMED DELETE.
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * Until this change the ONLY way to close the panel was pressing the ⋮ again, or
 * Escape *while focus was still inside the actions container*. Neither covers the
 * ordinary case: open row A's ⋮, change your mind, click the transcript. The
 * panel is `position: absolute; zIndex: 5` and forced `opacity: 1` while open, so
 * it stays fully visible and clickable over the rows BELOW A — and the next click
 * at what looks like row B lands on A's panel, at the coordinates Delete
 * occupies. There is no confirmation step on that path. Measured before the fix:
 * Escape dispatched on `document.body` left the panel mounted.
 *
 * Three closers now, and they are three because each covers a state the others
 * structurally cannot see:
 *
 *   • a document `pointerdown` OUTSIDE the container — the pointer half. On
 *     `pointerdown` rather than `click` so the panel is gone before the click
 *     lands, which is what stops the dismissing press from also activating what
 *     was underneath.
 *   • a document `keydown` for Escape — CAPTURE phase on `document`, so it fires
 *     wherever focus is, including `<body>`. The old handler was on the container
 *     and could only ever see a key pressed inside it. It does NOT consume the
 *     press; the handler says why, and names the two pack handlers that were
 *     being swallowed while it did.
 *   • `onBlur` on the container (React's name for `focusout`, which bubbles) —
 *     the keyboard half of the outside click: tabbing past Delete leaves the
 *     container, and a panel the viewer has tabbed out of is one they are done
 *     with.
 *
 * 🔴 AND FOCUS GOES BACK TO THE TRIGGER, on every close route where the trigger
 * still exists. `close(true)` is Escape and Rename — though on the Rename route
 * the trigger's focus is momentary by design: the parent starts an inline edit
 * in the same tick, and `RenameEditor` focuses its input on mount, which is
 * where a renaming viewer needs to be. The outside-pointer and tab-out routes
 * pass `false`, because the viewer is deliberately somewhere else and pulling
 * them back would be a focus trap. Delete is the one route the
 * trigger cannot serve — it unmounts with the row — and is handled a level up in
 * `SessionList`'s `deleteAndRefocus`, which applies that same rule: it refocuses
 * on the keyboard route and leaves focus alone on the pointer one.
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
  /** `fromKeyboard` decides the refocus; see `deleteAndRefocus` and the handler. */
  onDelete: (id: string, fromKeyboard: boolean) => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const copy = async () => {
    // Same contract as the message-copy button: the OUTCOME is rendered, never
    // assumed. `copyText` resolves false rather than throwing.
    setCopyState((await copyText(session.id)) ? 'done' : 'failed');
  };

  /**
   * Close, and say whether the ⋮ trigger should get focus back.
   *
   * 🔴 ONE CLOSER, SO THE FOCUS DECISION IS MADE IN ONE PLACE. `.focus()` is
   * called BEFORE React has re-rendered, which is safe precisely because the
   * trigger is never the node being unmounted — React keeps the same DOM node
   * across the re-render that removes the panel.
   */
  const close = useCallback(
    (returnFocus: boolean) => {
      onOpenChange(false);
      if (returnFocus) triggerRef.current?.focus();
    },
    [onOpenChange],
  );

  /** Is this event happening somewhere other than inside this row's actions? */
  const isOutside = useCallback(
    (target: EventTarget | null) =>
      !(target instanceof Node) || !containerRef.current?.contains(target),
    [],
  );

  useEffect(() => {
    // 🔴 LISTENERS ONLY WHILE OPEN. A closed panel's row must not pay for a
    // document listener, and a sidebar of 15 rows would otherwise install 30.
    if (!open) return;

    const onPointerDown = (e: Event) => {
      if (isOutside(e.target)) close(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // ─────────────────────────────────────────────────────────────────────
      // 🔴 THE PRESS IS **NOT** CONSUMED — NO `stopPropagation()` — AND THAT IS
      // A CORRECTION OF THE CLAIM THAT USED TO STAND HERE.
      //
      // The old container handler consumed the press, and that was carried over
      // to this listener on the ground that it "was the only Escape handler in
      // `src/`". That survey was true of `src/` and FALSE OF THE PAGE, which is
      // the scope that decides the behaviour: this listener is on `document` in
      // the CAPTURE phase, so it is the first thing to see the event, and
      // consuming it means nothing below `document` ever gets it. The installed
      // pack ships two Escape handlers that live exactly there:
      //
      //   • `@civitai/blocks-react@0.49.0/dist/ui/Modal.js:48-61` — a
      //     bubble-phase `document` keydown, which is what closes the modal
      //     `SettingsModal.tsx:45` renders.
      //   • `@civitai/blocks-react@0.49.0/dist/internal/pickerOverlay.js:556-560`
      //     — the resource picker's Escape-dismiss, bound on the overlay root,
      //     which is below `document` too.
      //
      // Measured with a bubble-phase `document` keydown handler as the probe:
      // called 1× with this panel shut, 0× with it open, 1× again once it
      // closed. `Modal.js:53` states the rule this now follows, in the pack's
      // own words: "Don't stopPropagation — that swallows Escape unpredictably
      // when two modals (or an author's own document Escape handler) are
      // present."
      //
      // 🔴 AND IT IS REACHABLE, BROWSER-SPECIFICALLY. In Chrome the three
      // closers prevent the overlap: clicking the ⋮ focuses it, so a later
      // tab-out fires the container's `onBlur`. In Safari/macOS and
      // Firefox/macOS a `<button>` is NOT focused by a click, so mouse-opening
      // the ⋮ leaves focus in the composer — the container's `onBlur` can never
      // fire because focus was never inside it, and no outside `pointerdown` has
      // landed either. Tab to the settings gear or "+ Model", press Enter, and
      // the panel is still open beneath the modal or picker; one Escape closed
      // only this panel and the thing on top needed a second press.
      //
      // Nothing in `src/` relies on the event being consumed — the two
      // handlers above are the whole population, and both want it.
      // ─────────────────────────────────────────────────────────────────────
      close(true);
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, close, isOutside]);

  return (
    <div
      ref={containerRef}
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
      // 🔴 `onBlur` IS `focusout`, WHICH BUBBLES — so this one handler on the
      // container sees focus leaving ANY descendant, including the last item in
      // the panel. `relatedTarget` is where focus is GOING; `null` means it left
      // the document or landed on `<body>`, which is still out of the panel.
      // No focus is returned: the viewer moved it themselves.
      onBlur={(e) => {
        if (!open) return;
        if (!isOutside(e.relatedTarget)) return;
        close(false);
      }}
    >
      <IconButton
        buttonRef={triggerRef}
        label={`Options for ${session.title}`}
        icon="more"
        expanded={open}
        testId={`session-menu-${session.id}`}
        onClick={() => {
          // Reset the copy feedback on every open, so a stale "Copied" from a
          // previous visit cannot read as this visit's outcome.
          if (!open) setCopyState('idle');
          // Closing from the trigger needs no focus return — the press that
          // closes it is already on the trigger.
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
              // The row survives a rename, so the trigger is still there to take
              // the focus the unmounting Rename button is about to lose.
              close(true);
              onRename(session.id);
            }}
          />
          <MenuItem
            label="Delete"
            testId={`delete-session-${session.id}`}
            icon="trash"
            tone="error"
            onClick={(e) => {
              // 🔴 NO FOCUS RETURN TO THE TRIGGER HERE, AND THAT IS NOT AN
              // OVERSIGHT. This row — trigger included — is about to unmount.
              // `SessionList` sends focus to "+ New" instead, on the keyboard
              // route only; see `deleteAndRefocus`.
              close(false);
              // ─────────────────────────────────────────────────────────────
              // 🔴 `detail === 0` IS "THE KEYBOARD ACTIVATED THIS", AND IT IS
              // THE ONLY PREDICATE THAT SEPARATES THE TWO ROUTES.
              //
              // A click synthesised by Enter or Space on a `<button>` carries
              // `detail: 0` (the click count); a real pointer press carries
              // `detail: 1`. That split is what the panel's stated policy needs:
              // the refocus exists for the viewer who tabbed deep into the
              // sidebar, and must NOT fire for the one who used the mouse and is
              // deliberately somewhere else.
              //
              // 🔴 "WAS FOCUS INSIDE THE CONTAINER?" DOES NOT WORK HERE, and the
              // reason is measured, not argued: Chrome focuses a `<button>` on
              // click, so by the time this handler runs on the pointer route
              // `document.activeElement` IS the Delete button — inside the
              // container. A focus-scoped gate therefore reads "keyboard" for a
              // mouse press in the majority browser and changes nothing.
              // (Measured with `user.click`, which reproduces that focus move:
              // `activeElement` is `delete-session-<id>` at handler time.)
              //
              // ⚠️ AND THAT IS WHY THE POINTER GUARD MUST USE `user.click`.
              // `fireEvent.click` also yields `detail: 0`, so a fireEvent-driven
              // "pointer" case is indistinguishable from the keyboard one and
              // would pass with this gate deleted.
              // ─────────────────────────────────────────────────────────────
              onDelete(session.id, e.detail === 0);
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
  /**
   * The event is forwarded because Delete reads `detail` off it to tell a
   * keyboard activation from a pointer one; see that handler. A handler that
   * does not care simply declares no parameter.
   */
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
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
