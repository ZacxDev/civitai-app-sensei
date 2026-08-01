import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

import { resetHarnessTransport } from './dev-transport.js';

beforeEach(() => {
  resetHarnessTransport();
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
