import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyText } from './clipboard.js';

/**
 * 🔴 THE DEFECT THIS FILE IS ABOUT IS A CONTROL THAT CLAIMED SUCCESS IT COULD
 * NOT OBSERVE. `ChatArea` called `navigator.clipboard.writeText(...)` with no
 * `await` and no `.catch()`, and `MessageBubble` showed a tick unconditionally.
 * So the assertions here are all about the RETURN VALUE — the thing that did not
 * exist — rather than about the write itself.
 *
 * The three refusal shapes are not invented: a block renders in a
 * `sandbox="allow-scripts allow-forms"` cross-origin iframe, where the Async
 * Clipboard API can be missing entirely (insecure context ⇒ no
 * `navigator.clipboard`), present-but-partial, or present and REJECTING
 * (permissions policy / no transient activation).
 */

const realNavigator = globalThis.navigator;

function installClipboard(clipboard: unknown) {
  Object.defineProperty(globalThis, 'navigator', {
    value: clipboard === undefined ? {} : { clipboard },
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

describe('copyText — reports whether the write LANDED', () => {
  it('resolves true and passes the text through when the clipboard accepts', async () => {
    // 🔴 POSITIVE CONTROL. Without it every refusal below is satisfied by a
    // function that returns `false` unconditionally — the "reassuring zero"
    // shape: a guard wired to nothing cannot be told from a guard that works.
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard({ writeText });
    await expect(copyText('session-1757000000000-abc123')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('session-1757000000000-abc123');
  });

  it('🔴 resolves FALSE when the write rejects — the embedded-iframe case', async () => {
    // The real refusal: `NotAllowedError` from the parent document's permissions
    // policy, or from a call without transient activation. The old call site
    // turned this into an unhandled rejection behind a tick reading "Copied".
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    installClipboard({ writeText });
    await expect(copyText('x')).resolves.toBe(false);
    expect(writeText).toHaveBeenCalled();
  });

  it('🔴 resolves FALSE when `navigator.clipboard` is absent (insecure context)', async () => {
    installClipboard(undefined);
    await expect(copyText('x')).resolves.toBe(false);
  });

  it('🔴 resolves FALSE when `clipboard` exists but `writeText` does not', async () => {
    // The half-present shape. `navigator.clipboard?.writeText` alone would be
    // `undefined` here and calling it throws a TypeError OUT of the helper —
    // which is the one thing this function promises never to do, because a throw
    // is what put the missing `try` at the call site in the first place.
    installClipboard({});
    await expect(copyText('x')).resolves.toBe(false);
  });

  it('never throws, whatever the platform does', async () => {
    // A synchronous throw from the getter is a real shape in a locked-down
    // embedding; the caller's job is to render an outcome, not to catch.
    installClipboard({
      get writeText() {
        return () => {
          throw new Error('blocked');
        };
      },
    });
    await expect(copyText('x')).resolves.toBe(false);
  });
});
