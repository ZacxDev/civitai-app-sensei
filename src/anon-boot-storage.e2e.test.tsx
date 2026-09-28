// 🔴 THE BOOT STORAGE READ IS GATED ON A SIGNED-IN VIEWER, AND THIS FILE IS THE
// ONLY THING THAT SAYS SO.
//
// WHAT WENT WRONG. `POST /api/v1/blocks/app-storage/get` answers an ANONYMOUS
// subject with 403 — deliberately, and civitai's own route says so at
// `src/pages/api/v1/blocks/app-storage/get.ts`: "🔴 AN ANONYMOUS VIEWER GETS 403
// HERE, NOT THE BRIDGE'S CLEAN `{ value: null }`, AND THAT DIVERGENCE IS
// DELIBERATE" (`enforceContextBinding` throws
// `forbidden('apps:storage:read requires authenticated subject')`,
// `src/server/middleware/block-scope.middleware.ts`). The bridge hook this app
// used before the `@civitai/sdk` port resolved an anon read CLEANLY, so the boot
// load effect could run unconditionally. After the port it cannot: the read
// rejects, the effect's `catch` sets `storageError`, and every anonymous viewer
// — probably the majority of impressions of a public block — sees
//
//   Couldn't load your saved chats — apps:storage:read requires authenticated
//   subject. Anything you send now may not be saved.
//
// on first paint, about data they were never going to have.
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
//
// The fake below refuses an anonymous read with the PLATFORM'S OWN message
// rather than a generic one, so (1) fails with the exact string a viewer would
// have seen and (3) cannot pass on a look-alike.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
import type { AppStorage } from './lib/sdk-runtime.js';
import { fakeBlockCatalogApi } from './test-helpers.js';

/** The exact refusal `block-scope.middleware.ts` throws for an anon subject. */
const ANON_REFUSAL = 'apps:storage:read requires authenticated subject';

let currentViewer: { id: number } | null = null;
/** Every façade method call, in order — the observation seam for (2). */
let storageCalls: string[] = [];
/** Set to make a SIGNED-IN read fail, for (3). */
let failSignedInReads: string | null = null;

/**
 * A KV fake that models the DEPLOYED ROUTE rather than a convenient store: a
 * read issued while `currentViewer` is null rejects the way the platform
 * rejects it. A fake that resolved `null` for an anon read would reproduce the
 * pre-port BRIDGE, i.e. the exact thing the port removed, and the case would be
 * green whatever the app does.
 */
const storage: AppStorage = {
  async get<T = unknown>(key: string) {
    storageCalls.push(`get:${key}`);
    if (!currentViewer) throw new Error(ANON_REFUSAL);
    if (failSignedInReads) throw new Error(failSignedInReads);
    return null as T | null;
  },
  async set(key: string) {
    storageCalls.push(`set:${key}`);
    if (!currentViewer) throw new Error('apps:storage:write requires authenticated subject');
    return { ok: true as const };
  },
  async delete(key: string) {
    storageCalls.push(`delete:${key}`);
    if (!currentViewer) throw new Error('apps:storage:write requires authenticated subject');
    return { ok: true as const, deleted: false };
  },
  async list() {
    storageCalls.push('list');
    if (!currentViewer) throw new Error(ANON_REFUSAL);
    if (failSignedInReads) throw new Error(failSignedInReads);
    return { keys: [] };
  },
  async getQuota() {
    storageCalls.push('getQuota');
    if (!currentViewer) throw new Error(ANON_REFUSAL);
    return { usedBytes: 0, rowCount: 0, limitBytes: 50_000_000, limitRows: 1_000_000 };
  },
};

vi.mock('./lib/sdk-runtime.js', () => ({
  useAppStorage: () => storage,
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
    failSignedInReads = null;
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

  it('🔴 …and it issues NO app-storage call at all, rather than rescuing a 403', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });

    // THE DISCRIMINATOR between "gated" and "the error was swallowed". A bare
    // `catch {}` in the load effect satisfies the case above and fails this one;
    // the platform still 403s, still writes an audit row per refused call, and
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

  // 🔴 THE WRITE ON THE SAME FOOTING. `apps:storage:write` refuses an anonymous
  // subject exactly as `apps:storage:read` does, and the Settings control renders
  // for an anonymous viewer — the sign-in prompt is an inline COMPOSER notice, not
  // a replacement screen. This write's rejection is already swallowed, so the
  // defect it left was not a banner: it was a guaranteed-403 request per settings
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
    failSignedInReads = 'PAYLOAD_TOO_LARGE';

    render(<App />);

    const banner = await screen.findByTestId('storage-error');
    expect(banner.textContent).toContain("Couldn't load your saved chats");
    expect(banner.textContent).toContain('PAYLOAD_TOO_LARGE');
  });
});
