import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { BrowsingLevel, effectiveBrowsingCeiling, isLevelAllowed } from '@civitai/app-sdk/blocks';
import { App } from './App.js';
import { fakeAppStorage } from './test-helpers.js';
import { clearCache } from './lib/research.js';
import { NSFW_MODEL_ID, SFW_MODEL_ID } from './lib/models.js';
import { NO_TOOLS_NOTICE } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE SEAM NOBODY OWNS: THE MATURITY GATE AND WHAT GOES ON THE WIRE.
//
// `lib/maturity.test.ts` proves the policy math against the SDK's own pure
// functions. `components/SettingsBar.test.tsx` proves the control appears and
// disappears. NEITHER builds the combined state, and the combined state is where
// the money is: which model id is SUBMITTED, and whether that submit carries tool
// declarations the model cannot use.
//
// 🔴 A FIELD THAT EXISTS IS NOT A GUARD — ONLY A BRANCH ON IT IS. Two of the
// things this file pins were, until this change, exactly that shape:
//   - `ModelConfig.supportsTools` was `false` on every entry with NOTHING in
//     `src/` reading it. Correcting the value changed nothing on screen.
//   - `settings.model` is PERSISTED, so hiding the toggle does not stop a stored
//     NSFW selection from being sent. The clamp is the guard; the control is not.
// Both are asserted here against the SUBMITTED BODY, because that is the only
// artefact that can distinguish a real gate from a well-commented one.
//
// ⚠️ WHAT THIS STILL DOES NOT PROVE: that a reply charged correctly, or that
// `deepseek/deepseek-v4-flash-0731` executes at all. The spend loop is Turnstile +
// auth gated and that model has never been driven to `succeeded` live (disclosed
// upstream). This file proves what the app SENDS.
// ─────────────────────────────────────────────────────────────────────────────

interface SubmittedParams {
  model: string;
  messages: Array<{ role: string; content?: string }>;
  tools?: Array<{ type: string; function: { name: string } }>;
  toolChoice?: string;
}

const submitted: SubmittedParams[] = [];

/**
 * The viewer's ceiling for the next render, as bitmasks.
 *
 * 🔴 RESOLVED THROUGH THE SDK'S OWN `effectiveBrowsingCeiling` /
 * `isLevelAllowed`, never through a hand-written boolean. A stub returning
 * `isLevelAllowed: () => true` would make every case here an assertion about the
 * stub — and the whole defect class being guarded is a block reading the DOMAIN
 * ceiling where it should read the viewer's. Driving real masks through the real
 * resolver is what keeps that distinction alive in this file.
 */
let domainCeiling: number | undefined;
let viewerLevel: number | undefined;

const RED_CEILING =
  BrowsingLevel.PG | BrowsingLevel.PG13 | BrowsingLevel.R | BrowsingLevel.X | BrowsingLevel.XXX;
const SFW_CEILING = BrowsingLevel.PG | BrowsingLevel.PG13;

let storage = fakeAppStorage();

// 🔴 HOISTED, SO THE HOOKS RETURN A STABLE IDENTITY ACROSS RENDERS, AND THAT IS A
// CORRECTNESS REQUIREMENT OF THIS FIXTURE RATHER THAN TIDINESS. Same hazard
// `mention-grounding.e2e.test.tsx`'s header records, and this file is the one
// that needs it most: returning a fresh `vi.fn()` from
// `useRequestConsent`/`useRequestSignIn`, or a fresh `{ id: 1 }` from
// `useBlockContext`, makes `raiseGate` a new function on every render, which makes
// `handleSend` a new function on every render — which SILENTLY REPAIRS any
// missing entry in `handleSend`'s dependency array. `activeModel` was missing from
// it, and with fresh identities the mid-session-flip case below passes whether or
// not the dep is there: the whole point of that case is that the closure is NOT
// rebuilt. The real SDK's callbacks are stable, so production had the stale one.
const VIEWER = { id: 1 };
const requestConsentFn = vi.fn();
const requestSignInFn = vi.fn();
const trackFn = vi.fn();
const openPickerFn = vi.fn().mockResolvedValue(null);
const cancelFn = vi.fn().mockResolvedValue(undefined);

const estimateFn = vi
  .fn()
  .mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } });
const submitFn = vi.fn(async (body: { params?: Record<string, unknown> }) => {
  if (body?.params) submitted.push(body.params as unknown as SubmittedParams);
  return { workflowId: `wf-${submitted.length}`, status: 'pending' };
});
const pollFn = vi.fn(async () => ({
  workflowId: 'wf-x',
  status: 'succeeded',
  cost: { total: 1 },
  textOutputs: ['A reply.'],
}));

vi.mock('@civitai/blocks-react', () => ({
  useAppStorage: () => storage.appStorage,
  useBlockAnalytics: () => ({ track: trackFn }),
  useBlockContext: () => ({ ready: true, viewer: VIEWER, theme: 'dark' }),
  useBlockResize: () => {},
  // The ONE hook under test here, resolved exactly as the real one does.
  useDomainMaturity: () => {
    const effective = effectiveBrowsingCeiling(domainCeiling, viewerLevel);
    return {
      domain: undefined,
      maxBrowsingLevel: domainCeiling,
      effectiveBrowsingLevel: viewerLevel,
      isSfw: !isLevelAllowed(BrowsingLevel.R, effective),
      isLevelAllowed: (level: number) => isLevelAllowed(level, effective),
    };
  },
  useRequestConsent: () => ({ requestConsent: requestConsentFn }),
  useRequestSignIn: () => ({ requestSignIn: requestSignInFn }),
  useResourcePicker: () => ({ open: openPickerFn }),
  useBlockToken: () => ({ raw: 'block-jwt-test', scopes: ['ai:write:budgeted', 'buzz:read:self'] }),
  useBuzzBalance: () => ({ balance: { blue: 100, green: 0, yellow: 200 } }),
  useBuzzWorkflow: () => ({
    estimate: estimateFn,
    submit: submitFn,
    poll: pollFn,
    cancel: cancelFn,
    status: 'idle',
    result: null,
    error: null,
  }),
}));

const DECLARATIONS = [
  {
    type: 'function',
    function: {
      name: 'search_models',
      description: 'Search the Civitai model catalog',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  },
];

let originalFetch: typeof globalThis.fetch;

function installFetch() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.includes('/api/v1/blocks/tools')) {
      // 🔴 DECLARATIONS ARE ALWAYS SERVED, so `declarations.length > 0` is true on
      // EVERY case below. That isolates the mutation: a submit without `tools` can
      // then only be the model's `supportsTools` doing it, never a failed fetch.
      return new Response(JSON.stringify({ tools: DECLARATIONS }), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [], metadata: {} }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

/** Returns the RTL handle, because one case below needs its `rerender`. */
async function boot() {
  const view = render(<App />);
  await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
  fireEvent.click(screen.getByTestId('new-session-button'));
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
  return view;
}

async function send(text: string) {
  await waitFor(() => expect(screen.getByTestId('send-button')).toBeTruthy(), { timeout: 8000 });
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('send-button'));
  await waitFor(() => expect(submitted.length).toBeGreaterThanOrEqual(1), { timeout: 8000 });
}

/** Flip the toggle on, which is the only route a viewer has to the NSFW arm. */
function flipNsfwOn() {
  fireEvent.click(screen.getByTestId('nsfw-toggle'));
}

function systemPromptOf(params: SubmittedParams): string {
  return params.messages.find((m) => m.role === 'system')?.content ?? '';
}

beforeEach(() => {
  submitted.length = 0;
  domainCeiling = undefined;
  viewerLevel = undefined;
  storage = fakeAppStorage();
  submitFn.mockClear();
  pollFn.mockClear();
  requestConsentFn.mockClear();
  requestSignInFn.mockClear();
  trackFn.mockClear();
  openPickerFn.mockClear();
  cancelFn.mockClear();
  clearCache();
  installFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

describe('🔴 the SFW arm — grounded, and the default', () => {
  it('sends the SFW model id, WITH tool declarations', async () => {
    await boot();
    await send('what is a lora?');

    expect(submitted[0].model).toBe(SFW_MODEL_ID);
    // The grounding half of the trade: this arm can look things up.
    expect(submitted[0].tools).toBeTruthy();
    expect(submitted[0].tools).toHaveLength(1);
    expect(submitted[0].toolChoice).toBe('auto');
    // …and the prompt does not tell it otherwise.
    expect(systemPromptOf(submitted[0])).not.toContain(NO_TOOLS_NOTICE.trim());
  });

  it('a fail-closed viewer never even sees the toggle, and still sends the SFW arm', async () => {
    // No ceiling projected at all — an older host, or pre-`BLOCK_INIT`.
    await boot();
    expect(screen.queryByTestId('nsfw-toggle')).toBeNull();
    await send('hello');
    expect(submitted[0].model).toBe(SFW_MODEL_ID);
  });
});

describe('🔴 the NSFW arm — uncensored AND ungrounded', () => {
  beforeEach(() => {
    domainCeiling = RED_CEILING;
    viewerLevel = RED_CEILING;
  });

  it('sends the uncensored model id once the viewer flips the toggle', async () => {
    await boot();
    flipNsfwOn();
    await send('write me something');
    expect(submitted[0].model).toBe(NSFW_MODEL_ID);
  });

  it('🔴 SENDS NO TOOL DECLARATIONS, even though the fetch returned some', async () => {
    // THE POINT. Dolphin's only OpenRouter endpoint does not expose tools, and
    // OpenRouter treats `tools` as a SOFT preference — so sending them means they
    // are silently DROPPED and the viewer is charged anyway. The declarations fetch
    // succeeds in this fixture, so the absence here can only be `supportsTools`.
    await boot();
    flipNsfwOn();
    await send('write me something');

    expect(submitted[0].tools).toBeUndefined();
    expect(submitted[0].toolChoice).toBeUndefined();
  });

  it('🔴 AND THE PROMPT SAYS SO — it must not claim a capability the request lacks', async () => {
    // A model told it can search, then unable to, fabricates results. That is the
    // defect `types.ts`'s prompt header is about, and this is it reached through
    // the MODEL rather than through a failed declarations fetch. One value
    // (`toolsAvailable`) decides both the wire and the prompt, so they cannot
    // disagree on either route.
    await boot();
    flipNsfwOn();
    await send('write me something');

    expect(systemPromptOf(submitted[0])).toContain(NO_TOOLS_NOTICE.trim());
  });
});

describe('🔴 the clamp — a STORED NSFW selection is not honoured for a viewer who may not have it', () => {
  it('sends the SFW arm when the stored model is NSFW and the gate is shut', async () => {
    // 🔴 THE STATE NO COMPONENT TEST CAN REACH. The viewer chose the uncensored arm
    // on a red domain; their settings are persisted; they then narrow their own
    // browsing level or open the app on a green domain. The toggle is nowhere on
    // screen, and WITHOUT the clamp the app goes on submitting the uncensored model
    // — spending Buzz on output the host will withhold on the same ceiling.
    storage = fakeAppStorage({
      'sensei:settings': { model: NSFW_MODEL_ID, temperature: 0.7, maxTokens: 2048, systemPrompt: 'x' },
    });
    domainCeiling = SFW_CEILING;
    viewerLevel = SFW_CEILING;

    await boot();
    expect(screen.queryByTestId('nsfw-toggle')).toBeNull();
    await send('hello');

    expect(submitted[0].model).toBe(SFW_MODEL_ID);
    // And the clamped model is tool-capable, so the grounding comes back too.
    expect(submitted[0].tools).toBeTruthy();
  });

  it('🔴 POSITIVE CONTROL: the same stored selection IS honoured when the gate is open', async () => {
    // Without this, the clamp is satisfied by one that always sends the SFW arm —
    // i.e. by a feature that can never be switched on at all. Same stored settings,
    // same code path, opposite ceiling.
    storage = fakeAppStorage({
      'sensei:settings': { model: NSFW_MODEL_ID, temperature: 0.7, maxTokens: 2048, systemPrompt: 'x' },
    });
    domainCeiling = RED_CEILING;
    viewerLevel = RED_CEILING;

    await boot();
    expect(screen.getByTestId('nsfw-toggle')).toHaveAttribute('aria-checked', 'true');
    await send('hello');

    expect(submitted[0].model).toBe(NSFW_MODEL_ID);
  });

  it('🔴 THE CEILING NARROWS MID-SESSION: the SCREEN and the WIRE must move together', async () => {
    // ─────────────────────────────────────────────────────────────────────────
    // 🔴 THE HALF THE TWO CASES ABOVE CANNOT SEE. Both resolve the ceiling ONCE,
    // before boot, so they prove the clamp is applied — never that it is
    // RE-applied. `handleSend` is a `useCallback`, and its dependency array
    // carries `settings` (the clamp's FIRST argument) but carried nothing for its
    // second. So a ceiling that narrowed after the sender's closure was built
    // updated only the VISIBLE half: the toggle left the DOM while the closure
    // went on submitting the uncensored id. Measured at a0977a7 — the toggle
    // vanished and the submit still carried
    // `cognitivecomputations/dolphin-mistral-24b-venice-edition`.
    //
    // ⚠️ NOT REACHABLE ON `@civitai/blocks-react@0.49.0`, and that is context, not
    // an excuse. `internal/iframeTransport.js:291-317` documents `BLOCK_INIT` as
    // DEDUPED — only the first is honoured — `applyTokenRefresh` (`:388`) replaces
    // `token` only, `THEME_CHANGE` (`:335`) `theme` only, and
    // `internal/inlineTransport.js:47`'s `subscribe` is a no-op. So no host push
    // can move the ceiling today; this case drives the flip directly instead of
    // waiting for one that can. The SDK already pushes `THEME_CHANGE` mid-session
    // for exactly the reason a ceiling push would exist, and on the day it lands
    // nothing else in this repo goes red.
    //
    // 🔴 WHY `rerender` AND NOT A UI ACTION: the mutant is "the closure was not
    // rebuilt", so the re-render must change NO entry in that dependency array.
    // Typing, sending, switching session and opening the menu all move one. A
    // bare `rerender(<App />)` moves none — and the fixture's hooks are module
    // constants (see the hoist at the top of this file) precisely so that a fresh
    // `vi.fn()` identity cannot rebuild the closure behind the assertion's back.
    // ─────────────────────────────────────────────────────────────────────────
    storage = fakeAppStorage({
      'sensei:settings': { model: NSFW_MODEL_ID, temperature: 0.7, maxTokens: 2048, systemPrompt: 'x' },
    });
    domainCeiling = RED_CEILING;
    viewerLevel = RED_CEILING;

    const { rerender } = await boot();
    // The viewer is legitimately on the uncensored arm at this point.
    expect(screen.getByTestId('nsfw-toggle')).toHaveAttribute('aria-checked', 'true');

    // 🔴 LET EVERY BOOT-PATH WRITE SETTLE *BEFORE* THE FLIP, OR THE CASE MEASURES
    // LUCK. A session save resolving AFTER the re-render moves `sessions` — which
    // IS in the dependency array — and rebuilds the closure with the new ceiling
    // already in it, repairing the missing dep by accident. Measured: without this
    // line the widening control below PASSED with `activeModel` removed from the
    // array, and failed with it. Nothing about the flip should depend on which
    // microtask wins.
    await act(async () => {});

    // The host narrows the ceiling under them.
    viewerLevel = SFW_CEILING;
    rerender(<App />);

    // The VISIBLE half updates on its own — it is read straight off the render.
    expect(screen.queryByTestId('nsfw-toggle')).toBeNull();

    // 🔴 AND SO MUST THE WIRE. This is the assertion the missing dep failed, and
    // it names the submitted model rather than asserting a re-render happened.
    await send('write me something');
    expect(submitted[0].model).toBe(SFW_MODEL_ID);
    expect(submitted[0].model).not.toBe(NSFW_MODEL_ID);
    // The clamped arm is tool-capable, so the grounding comes back with it — the
    // same both-halves check the stored-selection case makes.
    expect(submitted[0].tools).toBeTruthy();
  });

  it('🔴 POSITIVE CONTROL: a ceiling that WIDENS mid-session is honoured too', async () => {
    // Without this, the case above is satisfied by a sender that always clamps —
    // i.e. by an app on which the uncensored arm can never be reached after boot.
    // Same mechanism, same `rerender`, opposite direction.
    storage = fakeAppStorage({
      'sensei:settings': { model: NSFW_MODEL_ID, temperature: 0.7, maxTokens: 2048, systemPrompt: 'x' },
    });
    domainCeiling = RED_CEILING;
    viewerLevel = SFW_CEILING;

    const { rerender } = await boot();
    expect(screen.queryByTestId('nsfw-toggle')).toBeNull();
    // Same settle, same reason — see the case above.
    await act(async () => {});

    viewerLevel = RED_CEILING;
    rerender(<App />);
    expect(screen.getByTestId('nsfw-toggle')).toHaveAttribute('aria-checked', 'true');

    await send('write me something');
    expect(submitted[0].model).toBe(NSFW_MODEL_ID);
  });

  it('🔴 A RED DOMAIN WITH A VIEWER WHO OPTED OUT is clamped — the `domain === "red"` case', async () => {
    // The discriminating case for the whole design, driven end to end rather than
    // only through the pure predicate. `maxBrowsingLevel` says "mature"; the
    // viewer's own level says PG13. An implementation reading the domain — or
    // reading `maxBrowsingLevel` instead of the effective ceiling — submits the
    // uncensored model here and is green in every test that only drives a domain.
    storage = fakeAppStorage({
      'sensei:settings': { model: NSFW_MODEL_ID, temperature: 0.7, maxTokens: 2048, systemPrompt: 'x' },
    });
    domainCeiling = RED_CEILING;
    viewerLevel = SFW_CEILING;

    await boot();
    expect(screen.queryByTestId('nsfw-toggle')).toBeNull();
    await send('hello');

    expect(submitted[0].model).toBe(SFW_MODEL_ID);
  });
});
