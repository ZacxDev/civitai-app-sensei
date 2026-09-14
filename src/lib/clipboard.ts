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
 * Returns `true` only when the write RESOLVED. It never throws: a caller's job
 * is to render the outcome, not to handle an exception, and a helper that threw
 * would put a `try` at every call site (which is where the missing `.catch()`
 * came from in the first place).
 */
export async function copyText(text: string): Promise<boolean> {
  // 🔴 NOT `navigator.clipboard?.writeText` ALONE. The optional chain covers a
  // missing `clipboard` object but not a missing `writeText`, and an insecure
  // or policy-blocked context can present either shape. Tested as a function so
  // both are one branch.
  const write = globalThis.navigator?.clipboard?.writeText;
  if (typeof write !== 'function') return false;
  try {
    // Called off `navigator.clipboard` rather than through the unbound
    // reference: `writeText` is a method and an unbound call is an
    // `Illegal invocation` in a real browser (jsdom is more forgiving, which is
    // precisely why this cannot be left to the test to notice).
    await globalThis.navigator.clipboard.writeText(text);
    return true;
  } catch {
    // A rejection here is the whole reason this function exists. Swallowed
    // rather than rethrown, and reported through the return value.
    return false;
  }
}
