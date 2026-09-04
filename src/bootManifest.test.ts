// 🔴 THIS GUARD EXISTS BECAUSE ITS ABSENCE SHIPPED AN INERT CHANGE IN THE PILOT
// APP. That PR added the whole boot-skeleton mechanism — the pre-paint resolution,
// the dark-base inline stylesheet, the skeleton markup, `paintTheme()` — plus 23
// tests covering all of it, then merged WITHOUT this key. Every test passed, because
// they each verify the mechanism WORKS; none asserted the one line that turns it on.
//
// `bootSkeleton: true` is what makes the full-page run host stand down its opaque
// veil. Without it the host keeps covering the iframe and the entire mechanism is
// dead code nobody can see working or failing. Its counterpart — the skeleton inside
// #root — is asserted by src/bootSkeleton.test.tsx; the two must ship together,
// because the key over an EMPTY #root is strictly worse than not opting in at all.
import { describe, expect, it } from 'vitest';

import manifest from '../block.manifest.json';

describe('boot skeleton opt-in', () => {
  it('the manifest declares bootSkeleton', () => {
    expect((manifest as { bootSkeleton?: unknown }).bootSkeleton).toBe(true);
  });
});
