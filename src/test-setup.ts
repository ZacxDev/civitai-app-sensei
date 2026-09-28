import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

import { resetHarnessTransport } from './dev-transport.js';
import { resetSdkRuntime } from './lib/sdk-runtime.js';

beforeEach(() => {
  resetHarnessTransport();
  // The SDK runtime caches one transport adapter and one AppClient, both bound to
  // the bridge transport the line above just replaced, plus any `fetch` a previous
  // test injected. Its own cache is keyed on the transport's identity so it would
  // recover anyway — this makes the per-test reset explicit rather than relying on
  // that, and it is what drops a leaked `fetch`.
  //
  // ⚠ INERT IN THE 23 FILES THAT `vi.mock` THE RUNTIME MODULE — a mocked module has
  // no singleton to reset. It is live for `sdk-runtime.test.tsx` and for
  // `bootSkeleton.test.tsx`, the one file that renders the real `App` against the
  // real bindings.
  resetSdkRuntime();
  if (!window.matchMedia) {
    window.matchMedia = makeMatchMedia(true) as typeof window.matchMedia;
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

export function makeMatchMedia(isMobile: boolean) {
  return (query: string) => {
    const isMaxWidth = /max-width/.test(query);
    const matches = isMaxWidth ? isMobile : !isMobile;
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  };
}

export function setViewport(kind: 'mobile' | 'desktop') {
  window.matchMedia = makeMatchMedia(kind === 'mobile') as typeof window.matchMedia;
}
