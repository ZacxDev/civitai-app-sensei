/**
 * COPY TO THE CLIPBOARD, AND REPORT WHETHER IT ACTUALLY HAPPENED.
 *
 * 🔴 THE BUTTON USED TO CLAIM SUCCESS HAVING COPIED NOTHING. `ChatArea` called
 * `navigator.clipboard.writeText(msg.content)` with no `await`, no `.catch()`
 * and no return value, while `MessageBubble` flipped its glyph to `✓`
 * unconditionally. This block renders in a `sandbox="allow-scripts allow-forms"`
 * iframe on a different origin from its parent, which is exactly where that
 * promise rejects: the Async Clipboard API needs `clipboard-write` to survive
 * the embedding document's permissions policy AND needs transient activation,
 * and `navigator.clipboard` is `undefined` outright on an insecure context. So
 * the failure is not exotic — it is the embedded case — and it arrived as an
 * unhandled rejection behind a tick that said "Copied".
 *
 * 🔴 ONE HELPER, TWO CALL SITES, BECAUSE THE PREDICATE IS THE SAME ONE. The
 * message-copy button and the session-id copy in the row menu both need "did
 * this land?", and a second copy of this logic is how the two drift — one of
 * them keeping the optimistic tick. One rule, one place.
 *
 * Returns `true` only when a write RESOLVED — via the Async Clipboard API or,
 * since the measured viewer report below, via the legacy fallback. It never
 * throws: a caller's job is to render the outcome, not to handle an exception,
 * and a helper that threw would put a `try` at every call site (which is where
 * the missing `.catch()` came from in the first place).
 *
 * 🔴 THE ASYNC API ALONE IS NOT ENOUGH, MEASURED LIVE. In the embedded run page
 * the host's permissions policy blocks the Clipboard API outright — the viewer's
 * console shows `[Violation] Permissions policy violation: The Clipboard API has
 * been blocked because of a permissions policy applied to the current
 * document.` — and `writeText` exists but its promise REJECTS. Before the
 * fallback that rejection rendered as "Copy failed" on every press: truthful,
 * and useless, because the copy is the thing being asked for. The legacy path
 * below is not governed by that policy; it needs only transient activation,
 * which a click-driven call still carries.
 */
export async function copyText(text: string): Promise<boolean> {
  // 🔴 NOT `navigator.clipboard?.writeText` ALONE. The optional chain covers a
  // missing `clipboard` object but not a missing `writeText`, and an insecure
  // or policy-blocked context can present either shape. Tested as a function so
  // both are one branch.
  const write = globalThis.navigator?.clipboard?.writeText;
  if (typeof write === 'function') {
    try {
      // Called off `navigator.clipboard` rather than through the unbound
      // reference: `writeText` is a method and an unbound call is an
      // `Illegal invocation` in a real browser (jsdom is more forgiving, which
      // is precisely why this cannot be left to the test to notice).
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    } catch {
      // A rejection here is the whole reason this function exists — but since
      // the policy-blocked iframe was measured it is no longer the END of the
      // function. Fall through to the legacy path rather than reporting
      // failure while a working mechanism is one call away.
    }
  }
  return copyViaExecCommand(text);
}

/**
 * THE LEGACY FALLBACK: a selected off-screen `<textarea>` +
 * `document.execCommand('copy')`.
 *
 * 🔴 WHY THIS STILL EXISTS IN 2026: `execCommand` is deprecated, but the thing
 * that replaced it — the Async Clipboard API — is exactly the mechanism the
 * embedding page's permissions policy can (and, measured, does) refuse. The
 * fallback is reached only when the modern path is absent or has already
 * rejected, so it costs nothing when the modern path works.
 *
 * The scratch element is `position: fixed` off-screen rather than
 * `display: none` — a non-rendered element cannot be selected on some engines,
 * which would make the fallback always fail. `readonly` stops mobile browsers
 * from opening a keyboard on focus. The element is removed on every path, so a
 * failed copy leaves no orphan node in the sidebar's DOM.
 */
function copyViaExecCommand(text: string): boolean {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc || typeof doc.execCommand !== 'function' || !doc.body) return false;
  const scratch = doc.createElement('textarea');
  scratch.value = text;
  scratch.setAttribute('readonly', '');
  scratch.style.position = 'fixed';
  scratch.style.top = '-9999px';
  scratch.style.left = '-9999px';
  scratch.style.opacity = '0';
  doc.body.appendChild(scratch);
  scratch.select();
  let copied = false;
  try {
    copied = doc.execCommand('copy') === true;
  } catch {
    // Some engines throw instead of returning false. Same outcome either way.
    copied = false;
  }
  scratch.remove();
  return copied;
}
