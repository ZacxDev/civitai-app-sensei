// 🔴 THE BOOT STORAGE READ IS GATED ON A SIGNED-IN VIEWER, AND THIS FILE IS THE
// ONLY THING THAT SAYS SO.
//
// WHAT WENT WRONG (on the legacy KV, 0.1.x). `POST /api/v1/blocks/app-storage/get`
// answered an ANONYMOUS subject with 403 (`apps:storage:read requires
// authenticated subject`), where the pre-SDK bridge hook had resolved an anon
// read CLEANLY, so the boot load effect could run unconditionally. After that
// port it could not: the read rejected, the effect's `catch` set `storageError`,
// and every anonymous viewer — probably the majority of impressions of a public
// block — saw "Couldn't load your saved chats — …" on first paint, about data
// they were never going to have.
//
// THE SAME FOOTING ON THE DOCUMENT STORE (0.2.0+). Sensei's data lives in a
// PRIVATE collection (`kv`), and a private collection has no anonymous reader:
// every operation answers `sign_in_required` (401). So the gate is as necessary
// as it was, and this file now drives it against the SDK's own contract fake
// (`createFakeStorage`) through the production adapter, as an anonymous caller —
// the refusal below is the platform's, not one typed into this test.
//
// 🔴 WHY THE ABSENCE ALONE WOULD BE A VACUOUS GUARD, and what this file does
// instead. "No banner for an anonymous viewer" is satisfied by a broken render,
// by a swallowed catch, and by deleting the banner outright. So all three of
// these are asserted together, and the third is the one that gives the first two
// their meaning:
//
//   1. anonymous → NO banner, and the chat shell really did render;
//   2. anonymous → the storage façade is not CALLED AT ALL (the gate, not a
//      rescued error — a `catch {}` in the effect would pass (1) and fail this);
//   3. signed-in + a genuinely failing read → the banner IS shown, with the
//      failure's own detail in it.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeStorage } from '@civitai/sdk/testing';

import manifest from '../block.manifest.json';
import { App } from './App.js';
import { createKvStorage } from './lib/kv-store.js';
import type { AppStorage } from './lib/sdk-runtime.js';
import { fakeBlockCatalogApi } from './test-helpers.js';

let currentViewer: { id: number } | null = null;
/** Every façade method call, in order — the observation seam for (2). */
let storageCalls: string[] = [];
/** Set to make a SIGNED-IN read fail, for (3): the store answers `storage_disabled`. */
let failSignedInReads = false;

/**
 * The production adapter over the SDK's document-store fake, AS WHOEVER
 * `currentViewer` SAYS IS CALLING. Anonymous → the fake's anonymous caller, which
 * the platform refuses `sign_in_required` on a private collection. A fake that
 * resolved `null` for an anon read would reproduce the pre-port BRIDGE, i.e. the
 * exact thing that hid this, and the case would be green whatever the app does.
 */
const docStore = createFakeStorage({ manifest });
const disabledStore = createFakeStorage({ manifest, disabled: true });
const kv = createKvStorage(() => {
  if (!currentViewer) return docStore.as({ viewer: null }).storage;
  return (failSignedInReads ? disabledStore : docStore).as({ viewer: { username: 'v7' } }).storage;
});

const storage: AppStorage = {
  get(key) {
    storageCalls.push(`get:${key}`);
    return kv.get(key);
  },
  set(key, value) {
    storageCalls.push(`set:${key}`);
    return kv.set(key, value);
  },
  delete(key) {
    storageCalls.push(`delete:${key}`);
    return kv.delete(key);
  },
  list(opts) {
    storageCalls.push('list');
    return kv.list(opts);
  },
};

vi.mock('./lib/sdk-runtime.js', () => ({
  useKvStore: () => storage,
  useBlockAnalytics: () => ({ track: vi.fn() }),
  useBlockContext: () => ({ ready: true, viewer: currentViewer, theme: 'dark' }),
  useBlockResize: () => {},
  useDomainMaturity: () => ({ isSfw: true, isLevelAllowed: () => false }),
  useBlockToken: () => ({ raw: 'block-jwt-test', scopes: ['ai:write:budgeted', 'buzz:read:self'] }),
  useRequestConsent: () => ({ requestConsent: vi.fn() }),
  useRequestSignIn: () => ({ requestSignIn: vi.fn() }),
  useResourcePicker: () => ({ open: vi.fn().mockResolvedValue(null) }),
  useBuzzWorkflow: () => ({
    estimate: vi.fn().mockResolvedValue({ cost: { total: 1 } }),
    submit: vi.fn().mockResolvedValue({ workflowId: 'wf-1', status: 'pending' }),
    poll: vi.fn().mockResolvedValue({ status: 'succeeded', textOutputs: ['hi'] }),
    cancel: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe('boot: the anonymous viewer is not told their storage failed', () => {
  let api: ReturnType<typeof fakeBlockCatalogApi>;

  beforeEach(() => {
    api = fakeBlockCatalogApi();
    currentViewer = null;
    storageCalls = [];
    failSignedInReads = false;
  });
  afterEach(() => {
    api.restore();
  });

  it('🔴 an anonymous viewer gets the chat shell and NO storage-failure banner', async () => {
    render(<App />);

    // The boot skeleton has to clear. Gating the effect on `viewer` without
    // releasing `loading` would trade the false banner for a permanent
    // "Loading sessions…" — a worse regression, and one a banner assertion
    // alone would not see.
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });

    // The app is actually there — so "no banner" is a statement about the
    // banner, not about a blank render.
    expect(screen.getByText('Civitai Sensei')).toBeInTheDocument();
    expect(screen.getByTestId('session-list')).toBeInTheDocument();

    expect(screen.queryByTestId('storage-error')).toBeNull();
  });

  it('🔴 …and it issues NO app-storage call at all, rather than rescuing a refusal', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });

    // THE DISCRIMINATOR between "gated" and "the error was swallowed". A bare
    // `catch {}` in the load effect satisfies the case above and fails this one;
    // the platform still refuses it, still writes an audit row per refused call, and
    // the next reader to add a `setStorageError` re-opens the defect.
    expect(storageCalls).toEqual([]);
  });

  it('loads once the viewer signs in — the gate is on `viewer`, not a permanent off switch', async () => {
    const { rerender } = render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });
    expect(storageCalls).toEqual([]);

    // The host re-mints and pushes a viewer. Without `viewer` in the effect's
    // dependencies this stays empty forever and a viewer who signs in inside
    // the iframe never sees their own chats until they reload.
    currentViewer = { id: 7 };
    rerender(<App />);

    await waitFor(() => {
      expect(storageCalls.length).toBeGreaterThan(0);
    });
    expect(screen.queryByTestId('storage-error')).toBeNull();
  });

  // 🔴 THE WRITE ON THE SAME FOOTING. A private collection refuses an anonymous
  // write exactly as it refuses the read, and the Settings control renders
  // for an anonymous viewer — the sign-in prompt is an inline COMPOSER notice, not
  // a replacement screen. This write's rejection is already swallowed, so the
  // defect it left was not a banner: it was a guaranteed-refused request per settings
  // change, an audit row for each, and a live trap for whoever decides that
  // `catch` should report. The in-memory value must still apply.
  //
  // ⚠ ANCHORED ON `system-prompt-input`, NOT ON `settings-modal`. That second
  // testid is on `SettingsModal`'s `<Modal>` element and `@civitai/blocks-react/
  // ui`'s `Modal` destructures a closed prop list — it forwards no `data-testid`,
  // so the attribute never reaches the DOM. Waiting on it hangs. The field inside
  // the panel is a real anchor and is also the thing being driven.
  async function openSettings() {
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });
    fireEvent.click(screen.getByTestId('settings-button'));
    await waitFor(() => {
      expect(screen.getByTestId('system-prompt-input')).toBeInTheDocument();
    });
  }

  it('🔴 an anonymous viewer changing a setting issues NO storage write', async () => {
    render(<App />);
    await openSettings();

    fireEvent.change(screen.getByTestId('system-prompt-input'), {
      target: { value: 'be terse' },
    });
    fireEvent.click(screen.getByTestId('save-settings'));

    // The change applied in memory — this is not "the control is dead". Save
    // closes the panel, so reopening it reads back the app's own state.
    await waitFor(() => {
      expect(screen.queryByTestId('system-prompt-input')).toBeNull();
    });
    fireEvent.click(screen.getByTestId('settings-button'));
    expect(await screen.findByTestId('system-prompt-input')).toHaveValue('be terse');

    // …and nothing was sent to a route that is defined to refuse it.
    expect(storageCalls).toEqual([]);
  });

  it('…while a SIGNED-IN viewer changing a setting DOES write it', async () => {
    // The anti-vacuity half: without this, "no write" is satisfied by a settings
    // control that never persists for anybody.
    currentViewer = { id: 7 };
    render(<App />);
    await openSettings();

    fireEvent.change(screen.getByTestId('system-prompt-input'), {
      target: { value: 'be terse' },
    });
    fireEvent.click(screen.getByTestId('save-settings'));

    await waitFor(() => {
      expect(storageCalls).toContain('set:sensei:settings');
    });
  });

  it('🔴 a SIGNED-IN viewer whose read really fails still gets the banner, with the detail', async () => {
    // The other half of the pair. Without this, the three cases above are
    // satisfied by "never show the banner", which a deleted banner also
    // satisfies — so the gate would read as coverage while removing the
    // reporting `storageError` exists for.
    currentViewer = { id: 7 };
    failSignedInReads = true;

    render(<App />);

    const banner = await screen.findByTestId('storage-error');
    expect(banner.textContent).toContain("Couldn't load your saved chats");
    // The document store's own message for `storage_disabled`.
    expect(banner.textContent).toContain('document storage is unavailable');
  });
});
