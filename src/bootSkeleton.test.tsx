// The two halves of `bootSkeleton: true` that can each fail silently:
//
//  1. THE SKELETON EXISTS AND IS INSIDE #root. With the manifest key set the host
//     stands down its veil, so an EMPTY `#root` means a blank iframe for the whole
//     load — strictly worse than not opting in. A skeleton painted as a SIBLING of
//     #root is never replaced and stays on screen forever.
//  2. REACT REMOVES IT. `createRoot(container).render(...)` clears the container's
//     children before its first commit, which is why no cleanup code exists. That is
//     a react-dom behaviour, not a law — it does NOT hold for frameworks that append
//     (Svelte's `mount`, and this org's own panorama-360, which does
//     `root.appendChild`). Pinned so a react-dom bump cannot strand it.
//
// …plus the pre-`ready` paint, which is what makes the whole thing worth doing.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
import { bootThemeGuess, paintTheme } from './bootTheme.js';

// 🔴 `process.cwd()`, not `import.meta.url`: under the jsdom project
// `import.meta.url` is an http URL (jsdom's document base), so
// `new URL('../index.html', …)` is not a file URL and readFileSync rejects it.
const INDEX_HTML = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

/** The literal `#root` subtree as index.html ships it. */
function rootInnerHtml(): string {
  const m = /<div id="root">([\s\S]*?)<\/div>\s*<script type="module"/.exec(INDEX_HTML);
  if (!m) throw new Error('could not extract #root from index.html');
  return m[1];
}

// 🔴 THESE TESTS CONTROL THEIR OWN INPUTS, and both stubs are load-bearing.
//
// `matchMedia`: this app's global test setup installs a stub for its own viewport
// and reduced-motion queries, and that stub answers EVERY non-viewport query —
// including `(prefers-color-scheme: light)`. Inheriting it made "unknown resolves to
// dark" depend on an unrelated harness default rather than on the code under test,
// and in one app of this rollout it answered LIGHT and failed the suite. Asking the
// question explicitly is what makes the assertion about `bootThemeGuess()`.
//
// The env var: some pinned `@civitai/blocks-react` versions throw out of
// `IframeTransport` unless an allowed parent origin is configured, so a bare
// `render(<App />)` cannot mount at all. Stubbing it lets the transport construct
// while never receiving BLOCK_INIT — which is exactly the pre-`ready` state under
// test. Harmless where the version does not need it.
beforeEach(() => {
  vi.stubEnv('VITE_BLOCK_ALLOWED_PARENT_ORIGINS', 'https://civitai.com');
  vi.stubGlobal('matchMedia', ((query: string) => ({
    // OS says "not light" — i.e. dark or no-preference, the case the dark default
    // exists for. Individual tests override where they need the other answer.
    matches: /prefers-color-scheme: light/.test(query) ? false : /max-width/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia);
});

afterEach(() => {
  document.documentElement.removeAttribute('data-civitai-boot-theme');
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the shipped index.html', () => {
  it('puts a non-empty boot skeleton INSIDE #root', () => {
    const host = document.createElement('div');
    host.innerHTML = rootInnerHtml();

    // 🔴 Emptiness is what the platform gate keys on, and a container holding only
    // an inert node still reads as "non-empty" to a naive check — a `<script>`'s
    // source IS a text node. Strip inert subtrees before testing.
    host.querySelectorAll('script, style, template').forEach((n) => n.remove());
    expect(host.textContent?.trim() ?? '').toBe(''); // no copy to translate…
    expect(host.children.length).toBeGreaterThan(0); // …but real painted boxes

    const marker = host.querySelector('[data-boot-skeleton]');
    expect(marker).not.toBeNull();
    expect(marker!.getAttribute('aria-hidden')).toBe('true');
  });

  // 🔴 PARSED, not grepped. A substring check for `data-boot-skeleton` outside the
  // #root region is walkable: the inline <style> mentions `[data-boot-skeleton]` as
  // a SELECTOR, which is legitimate and is not an element. The invariant is about
  // element PLACEMENT, so it has to be asserted against a DOM.
  it('has every [data-boot-skeleton] ELEMENT inside #root', () => {
    const doc = new DOMParser().parseFromString(INDEX_HTML, 'text/html');
    const root = doc.querySelector('#root');
    expect(root).not.toBeNull();

    const marked = [...doc.querySelectorAll('[data-boot-skeleton]')];
    expect(marked.length).toBeGreaterThan(0); // positive control: the query CAN match
    for (const el of marked) expect(root!.contains(el)).toBe(true);
  });
});

describe('react-dom removes the boot skeleton', () => {
  // Mounts through the REAL react-dom this app ships, seeded with the REAL markup
  // from index.html. What this pins is react-dom's container-clearing behaviour —
  // the thing that could change under a bump. It does not depend on what <App>
  // renders, which is why a minimal component is mounted rather than the whole App.
  it('clears the seeded children before its first commit', async () => {
    const container = document.createElement('div');
    container.id = 'root';
    container.innerHTML = rootInnerHtml();
    document.body.appendChild(container);

    expect(container.querySelector('[data-boot-skeleton]')).not.toBeNull();

    await act(async () => {
      createRoot(container).render(<p data-testid="mounted">app</p>);
    });

    expect(container.querySelector('[data-boot-skeleton]')).toBeNull();
    expect(container.querySelector('[data-testid="mounted"]')).not.toBeNull();
    document.body.removeChild(container);
  });
});

describe('the pre-ready paint agrees with the skeleton', () => {
  // 🔴 THE POINT OF THE WHOLE CHANGE. Rendered with no host (no BLOCK_INIT), the
  // SDK's snapshot reports `ready: false` and the hardcoded sentinel
  // `theme: 'light'`. Stamping that sentinel would repaint the dark boot skeleton
  // light and then dark again ~100ms later — a flash INTRODUCED by standing the
  // host's veil down.
  it('paints DARK before ready, not the SDK sentinel', () => {
    const { container } = render(<App />);
    const root = container.querySelector('[data-theme]');
    expect(root).not.toBeNull();
    expect(root!.getAttribute('data-theme')).toBe('dark');
  });

  it('honours a light answer recorded on the boot attribute', () => {
    document.documentElement.setAttribute('data-civitai-boot-theme', 'light');
    const { container } = render(<App />);
    expect(container.querySelector('[data-theme]')!.getAttribute('data-theme')).toBe('light');
  });
});

describe('bootTheme helpers', () => {
  it('reads the attribute back rather than re-deriving it', () => {
    document.documentElement.setAttribute('data-civitai-boot-theme', 'light');
    expect(bootThemeGuess()).toBe('light');
    document.documentElement.setAttribute('data-civitai-boot-theme', 'dark');
    expect(bootThemeGuess()).toBe('dark');
  });

  it('resolves an absent or junk attribute to dark', () => {
    expect(bootThemeGuess()).toBe('dark');
    document.documentElement.setAttribute('data-civitai-boot-theme', 'chartreuse');
    expect(bootThemeGuess()).toBe('dark');
  });

  // 🔴 THESE TWO EXIST BECAUSE A MUTANT SURVIVED WITHOUT THEM IN ALL FOUR APPS OF
  // THIS ROLLOUT. Flipping the function's final `return 'dark'` to `'light'` changed
  // nothing and no test failed — correctly, because every other test either sets the
  // attribute or has a working `matchMedia` stub, so the last-resort return was
  // never reached. It IS reachable in production: a UA without `matchMedia`, or a
  // hardened embedder where touching it throws.
  it('resolves DARK when matchMedia is unavailable entirely', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(bootThemeGuess()).toBe('dark');
  });

  it('resolves DARK when matchMedia throws', () => {
    vi.stubGlobal('matchMedia', (() => {
      throw new Error('blocked');
    }) as unknown as typeof window.matchMedia);
    expect(bootThemeGuess()).toBe('dark');
  });

  // After BLOCK_INIT the host is authoritative and wins outright.
  it('hands over to the host theme once ready', () => {
    document.documentElement.setAttribute('data-civitai-boot-theme', 'dark');
    expect(paintTheme(true, 'light')).toBe('light');
    expect(paintTheme(false, 'light')).toBe('dark');
  });
});
