import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
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
  useBlockAnalytics: () => ({ track: vi.fn() }),
  useBlockContext: () => ({ ready: true, viewer: { id: 1 }, theme: 'dark' }),
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
  useRequestConsent: () => ({ requestConsent: vi.fn() }),
  useRequestSignIn: () => ({ requestSignIn: vi.fn() }),
  useResourcePicker: () => ({ open: vi.fn().mockResolvedValue(null) }),
  useBlockToken: () => ({ raw: 'block-jwt-test', scopes: ['ai:write:budgeted', 'buzz:read:self'] }),
  useBuzzBalance: () => ({ balance: { blue: 100, green: 0, yellow: 200 } }),
  useBuzzWorkflow: () => ({
    estimate: estimateFn,
    submit: submitFn,
    poll: pollFn,
    cancel: vi.fn().mockResolvedValue(undefined),
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

async function boot() {
  render(<App />);
  await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
  fireEvent.click(screen.getByTestId('new-session-button'));
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
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
