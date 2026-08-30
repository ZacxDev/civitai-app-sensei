import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { App } from './App.js';
import {
  fakeAppStorage,
  fakeBlockCatalogApi,
  BLOCK_GENERATION_RESOURCE,
} from './test-helpers.js';
import { clearCache } from './lib/research.js';

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THIS FILE PINS THE PRODUCTION TOKEN SHAPE, NOT THE CONVENIENT ONE.
//
// Every other suite mocks `useBlockToken` as
//   `{ raw, scopes: ['ai:write:budgeted', 'buzz:read:self'] }`
// — i.e. it hardcodes the GRANTED value of the exact condition that fails in
// production, so the gated branch was executed by none of the 199 tests. The
// dev Harness passes `consentGranted` for the same reason. Every instrument
// agreed, and every one of them was configured to.
//
// `ai:write:budgeted` is a CONSENT-GATED scope: the platform withholds it from
// the block token until the viewer has granted it, and simply opening the app
// does not grant it. So `scopes: []` — not the granted array — is what a
// first-time viewer's token actually carries. Storage scopes are NOT
// consent-gated, which is why sessions still save and the app looks alive
// while chat is dead.
// ─────────────────────────────────────────────────────────────────────────────
const UNGRANTED_SCOPES: string[] = [];
const GRANTED_SCOPES = ['ai:write:budgeted', 'buzz:read:self'];

const REPLY = 'Paris is the capital of France.';

/** Mutable so a test can simulate the host re-minting after the viewer grants. */
let currentScopes: string[] = UNGRANTED_SCOPES;
const requestConsent = vi.fn();
const requestSignIn = vi.fn();
let currentViewer: { id: number } | null = { id: 1 };

/**
 * 🔴 ONE STABLE STORE, not a fresh one per render. `useAppStorage: () =>
 * fakeAppStorage().appStorage` hands back an EMPTY store on every render, so
 * nothing persists and any assertion resting on storage passes vacuously. It
 * also makes the seeded-session case below impossible to set up.
 */
let storage = fakeAppStorage();

const pollResult = vi.fn();
/** The CHARGING call. Asserting on this is tighter than asserting on poll. */
const submitSpy = vi.fn();

/** What the host's picker hands back. `null` = the viewer dismissed it. */
let pickerResult: { versionId: number } | null = { versionId: 5678 };

vi.mock('@civitai/blocks-react', () => ({
  useAppStorage: () => storage.appStorage,
  useBlockAnalytics: () => ({ track: vi.fn() }),
  useBlockContext: () => ({ ready: true, viewer: currentViewer, theme: 'dark' }),
  useBlockResize: () => {},
  useBlockToken: () => ({ raw: 'block-jwt-test', scopes: currentScopes }),
  useBuzzBalance: () => ({ balance: { blue: 100, green: 0, yellow: 200 } }),
  useRequestConsent: () => ({ requestConsent }),
  useRequestSignIn: () => ({ requestSignIn }),
  // The host's native resource picker. Driven here (rather than stubbed to
  // "dismissed") because one case needs a real attachment on the composer to
  // assert a gated send does not eat it.
  useResourcePicker: () => ({ open: () => Promise.resolve(pickerResult) }),
  useBuzzWorkflow: () => ({
    estimate: vi
      .fn()
      .mockResolvedValue({ workflowId: 'est-1', status: 'succeeded', cost: { total: 1 } }),
    submit: submitSpy,
    poll: vi.fn().mockImplementation(async () => pollResult()),
    cancel: vi.fn().mockResolvedValue(undefined),
    status: 'idle',
    result: null,
    error: null,
  }),
}));

async function startSession() {
  await waitFor(() => {
    expect(screen.queryByTestId('app-loading')).toBeNull();
  });
  fireEvent.click(screen.getByTestId('new-session-button'));
  await waitFor(() => {
    expect(screen.getByTestId('chat-input')).toBeTruthy();
  });
}

describe('consent gate: the block token lacks ai:write:budgeted', () => {
  let api: ReturnType<typeof fakeBlockCatalogApi>;

  beforeEach(() => {
    clearCache();
    api = fakeBlockCatalogApi();
    storage = fakeAppStorage();
    currentScopes = UNGRANTED_SCOPES;
    currentViewer = { id: 1 };
    requestConsent.mockClear();
    requestSignIn.mockClear();
    submitSpy.mockClear();
    submitSpy.mockResolvedValue({ workflowId: 'buzz-1', status: 'pending' });
    pollResult.mockReturnValue({
      workflowId: 'buzz-1',
      status: 'succeeded',
      cost: { total: 1 },
      textOutputs: [REPLY],
    });
  });
  afterEach(() => {
    api.restore();
  });

  it('asks the host for consent instead of silently swallowing the send', async () => {
    // THE REGRESSION. Shipped behaviour: `handleSend` hits `if (!canGenerate)
    // return;` and does nothing at all — no request, no message, no notice.
    // The composer cleared anyway, which is why this read to a user as
    // "Send is dead".
    render(<App />);
    await startSession();

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello Sensei' } });
    fireEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(requestConsent).toHaveBeenCalled();
    });
    // The advisory hint names both consent-gated scopes the manifest declares.
    expect(requestConsent.mock.calls[0][0]).toEqual({
      scopes: ['ai:write:budgeted', 'buzz:read:self'],
    });
  });

  it('tells the user why nothing was sent', async () => {
    // A fire-and-forget request the viewer may dismiss must still leave
    // something on screen. Silence is what made this defect invisible.
    render(<App />);
    await startSession();

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello Sensei' } });
    fireEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(screen.getByTestId('consent-notice')).toBeTruthy();
    });
  });

  it('does not spend Buzz while the scope is missing', async () => {
    // Asserts on `submit` — the CHARGING call — not on poll.
    render(<App />);
    await startSession();

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello Sensei' } });
    fireEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(requestConsent).toHaveBeenCalled();
    });
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('KEEPS the message in the composer instead of stashing or dropping it', async () => {
    // 🔴 The whole reason nothing is held in App state. An earlier draft of this
    // fix stashed the text and auto-sent it on grant; that stash carried no
    // session id, so it could be delivered into a conversation the viewer had
    // switched to — spending their Buzz there — and it vanished silently if the
    // session was deleted meanwhile. Leaving the text in the box has no such
    // failure mode: there is nothing to misroute, duplicate or lose.
    render(<App />);
    await startSession();

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello Sensei' } });
    fireEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(requestConsent).toHaveBeenCalled();
    });
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('Hello Sensei');
  });

  it('nothing is sent anywhere merely because the scope arrived', async () => {
    // Pins the misroute shut. The grant alone must move no message and spend no
    // Buzz — the viewer presses Send, the app never does it for them.
    const { rerender } = render(<App />);
    await startSession();

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello Sensei' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => {
      expect(requestConsent).toHaveBeenCalled();
    });

    // Viewer moves to a different conversation, THEN grants.
    fireEvent.click(screen.getByTestId('new-session-button'));
    currentScopes = GRANTED_SCOPES;
    rerender(<App />);

    await waitFor(() => {
      expect(screen.queryByTestId('gate-retry-button')).toBeNull();
    });
    expect(submitSpy).not.toHaveBeenCalled();
    // Scoped to the message list on purpose: the text is STILL in the composer
    // (that is the fix), so an unscoped text query would match the textarea and
    // pass for the wrong reason. What must not exist is a rendered BUBBLE.
    expect(
      within(screen.getByTestId('messages-container')).queryByText('Hello Sensei'),
    ).toBeNull();
  });

  it('clears the notice by itself and sends on the next press once granted', async () => {
    // End to end through the fix: the banner is DERIVED, so a re-mint clears it
    // with no bookkeeping, the text is still in the box, and one press sends.
    const { rerender } = render(<App />);
    await startSession();

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello Sensei' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => {
      expect(screen.getByTestId('consent-notice')).toBeTruthy();
    });

    // Host grants → re-mints. No effect, no retry logic: the banner just goes.
    currentScopes = GRANTED_SCOPES;
    rerender(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('consent-notice')).toBeNull();
    });
    // 🔴 ASSERT NO BANNER AT ALL, not merely that the CONSENT one went. A
    // mutation that left a stale sign-in banner standing survived the narrower
    // check — the guard has to be as wide as its own name. `gate-retry-button`
    // is the one element both banners share.
    expect(screen.queryByTestId('signin-notice')).toBeNull();
    expect(screen.queryByTestId('gate-retry-button')).toBeNull();

    fireEvent.click(screen.getByTestId('send-button'));

    // Scoped to the message list: since 0.1.5 the auto-title lands, so the same
    // text is also the session's name in the sidebar. See the note in
    // `e2e.test.tsx` — the unscoped form was passing because of a defect.
    await waitFor(() => {
      expect(
        within(screen.getByTestId('messages-container')).getByText('Hello Sensei'),
      ).toBeTruthy();
    });
    await waitFor(
      () => {
        expect(screen.getByText(new RegExp(REPLY))).toBeTruthy();
      },
      { timeout: 5000 },
    );
  });

  it('asks an anonymous viewer to sign in rather than doing nothing', async () => {
    // The sibling silent return. `viewer` IS populated for a signed-in viewer
    // on the run page, so this is not the production defect — but it failed the
    // same silent way.
    currentViewer = null;
    render(<App />);
    await startSession();

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello Sensei' } });
    fireEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(requestSignIn).toHaveBeenCalled();
    });
    expect(screen.getByTestId('signin-notice')).toBeTruthy();
    // An anonymous viewer must NOT also be asked to consent: their token
    // cannot hold the scope, so the prompt would be nonsense. This pins the
    // `return` in `raiseGate` — without it both requests fire, and both
    // analytics events with them.
    expect(requestConsent).not.toHaveBeenCalled();
  });

  it('shows no banner until the viewer actually hits the gate', async () => {
    // Pins the READ of `gateRaised`. Without this, deleting `gateRaised &&`
    // from the banner condition passes the whole suite while showing every
    // ungranted viewer a permission banner on first paint, unprompted.
    render(<App />);
    await startSession();

    expect(screen.queryByTestId('gate-retry-button')).toBeNull();
    expect(screen.queryByTestId('consent-notice')).toBeNull();
    expect(screen.queryByTestId('signin-notice')).toBeNull();
  });

  it('still asks when the same text is re-sent after a gated attempt', async () => {
    // 🔴 THE DEDUP USED TO WIN. Once `messages` ends with a user message —
    // after a gated Regenerate, or any session reloaded from storage after a
    // failed completion — retyping that text hit the duplicate check BEFORE
    // the gate and returned silently: no prompt, no banner, no feedback. That
    // is this bug reappearing behind a different guard, so the gate must be
    // checked first.
    render(<App />);
    await startSession();

    const send = () => fireEvent.click(screen.getByTestId('send-button'));
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello Sensei' } });
    send();
    await waitFor(() => {
      expect(requestConsent).toHaveBeenCalledTimes(1);
    });

    // Same text, pressed again. The viewer must not be met with silence.
    send();
    await waitFor(() => {
      expect(requestConsent).toHaveBeenCalledTimes(2);
    });
  });

  it('gates Regenerate WITHOUT destroying the reply it would replace', async () => {
    // `handleRegenerate` never touches the composer, so App's own gate is the
    // only one protecting it — and it must fire BEFORE the slice that removes
    // the assistant message, or a refused Regenerate deletes the reply and
    // sends nothing.
    const { rerender } = render(<App />);
    await startSession();

    // Land one real exchange while the scope is granted.
    currentScopes = GRANTED_SCOPES;
    rerender(<App />);
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello Sensei' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(
      () => {
        expect(screen.getByText(new RegExp(REPLY))).toBeTruthy();
      },
      { timeout: 5000 },
    );

    // 🔴 WAIT FOR THE STREAM TO SETTLE BEFORE REVOKING. Without this the click
    // below lands while `isStreaming` is still true, so the reply is preserved
    // by the STREAMING guard and this test's reply-preservation assertion can
    // never fail for the GATE's sake — it was vacuous, and a mutant that let a
    // gated Regenerate fall through to the destructive slice passed 217/217.
    await waitFor(() => {
      expect(screen.queryByTestId('streaming-indicator')).toBeNull();
    });

    // The host revokes / the token re-mints without the scope.
    currentScopes = UNGRANTED_SCOPES;
    rerender(<App />);
    submitSpy.mockClear();
    requestConsent.mockClear();

    fireEvent.click(screen.getByTestId('regenerate-button'));

    await waitFor(() => {
      expect(requestConsent).toHaveBeenCalledTimes(1);
    });
    // Nothing charged, and the reply is still on screen.
    expect(submitSpy).not.toHaveBeenCalled();
    expect(screen.getByText(new RegExp(REPLY))).toBeTruthy();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 THE "Research -> Insert" CASE IS GONE, AND ITS COVERAGE IS GENUINELY
  // REDUCED. SAY SO RATHER THAN QUIETLY REPLACING IT (clawgate #434).
  //
  // That case called itself "THE ONLY TEST THAT CAN KILL App's OWN GATE", and it
  // was right: `handleInsertResearch` sent directly, bypassing `ChatArea`
  // entirely, so `handleSend`'s own `if (sendGate) { raiseGate(); return; }` was
  // the sole guard on that path and the test ISOLATED it.
  //
  // `handleInsertResearch` is deleted with the panel. Every surviving caller of
  // `handleSend` — the composer and Regenerate — checks the gate BEFORE calling
  // it, on the SAME condition. So App's own check is now defence in depth with
  // NO reachable path that isolates it, and a mutation deleting it SURVIVES.
  // Measured, not assumed: `if (sendGate) { raiseGate(); return; }` was removed
  // from `handleSend` and the WHOLE suite run — 336 passed, 0 failed.
  //
  // 🔴 THE SAME SHADOWING COVERS THE ORDERING INSIDE `handleSend`, so say so
  // here rather than let the case below imply otherwise. Moving
  // `setPendingMentions([])` ABOVE the gate also SURVIVES this suite, for the
  // identical reason: `ChatArea` returns first, so `handleSend` never runs on
  // the gated path. The case below therefore pins the USER-VISIBLE outcome —
  // a refused send does not eat the attachments — and it is `ChatArea`'s gate,
  // not App's ordering, that currently delivers it.
  //
  // It is kept anyway, because the next non-composer caller reintroduces the
  // hazard, and it is cheaper to keep a redundant guard than to notice its
  // absence later. What is NOT kept is a test claiming to cover it — a guard
  // whose test cannot fail is worse than an untested guard, because it stops
  // anyone looking.
  //
  // The case below is what the mention path actually adds to this gate's
  // surface, and it is a real one: a gated send must not silently EAT the
  // attachments.
  // ───────────────────────────────────────────────────────────────────────────
  it('a gated send keeps the viewer’s attachments — nothing is consumed or spent', async () => {
    // 🔴 THE PRECONDITION IS NOW BUILT THE WAY PRODUCTION BUILDS IT, and the
    // rewrite is the point rather than an accommodation. This test used to
    // attach WHILE gated — which the composer no longer permits, because a
    // viewer who cannot send must not be able to drive the host picker and an
    // authenticated resolve. That route was never the production one anyway:
    // `sendGate` is DERIVED from the live token, so the reachable path to
    // "attached AND gated" is the gate CLOSING under a composer that already
    // holds chips — a re-mint that drops the consent-gated scope, which is the
    // same mechanism the `grants it and retries` case below exercises in the
    // other direction.
    currentScopes = GRANTED_SCOPES;
    const { rerender } = render(<App />);
    await startSession();

    fireEvent.click(screen.getByTestId('add-mention-button'));
    fireEvent.click(screen.getByTestId('mention-type-Checkpoint'));
    await waitFor(() => {
      expect(screen.getByTestId(`mention-${BLOCK_GENERATION_RESOURCE.versionId}`)).toBeTruthy();
    });

    // The host re-mints without the spend scope. `sendGate` escalates on its own
    // — it is derived, never stored.
    currentScopes = UNGRANTED_SCOPES;
    rerender(<App />);

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'What is this?' } });
    fireEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(requestConsent).toHaveBeenCalled();
    });
    expect(submitSpy).not.toHaveBeenCalled();
    // The end-to-end property: a refused send leaves the viewer's attachment
    // exactly where it was.
    expect(screen.getByTestId(`mention-${BLOCK_GENERATION_RESOURCE.versionId}`)).toBeTruthy();
    // ⚠️ WHAT THIS DOES **NOT** COVER, MEASURED RATHER THAN ASSUMED. Its
    // original comment claimed to pin `App.handleSend`'s clear-vs-gate ORDERING
    // — "if that clear ran ABOVE the gate, a refused send would drop the
    // viewer's attachment". It does not, and never did: `ChatArea.handleSend`
    // checks `sendGate` and returns BEFORE calling `onSend`, so `App.handleSend`
    // is never entered on this path at all. Moving `setPendingMentions([])`
    // above `App.handleSend`'s own gate SURVIVES this test — verified at HEAD
    // (`f6920fe`) against the ORIGINAL test as well as this one, so it is a
    // pre-existing gap and not something the rewrite introduced.
    //
    // No UI route reaches `App.handleSend` while gated: `ChatArea` gates before
    // `onSend`, `handleRegenerate` gates before calling it, and
    // `handleInsertResearch` — the third caller its comment names — was deleted
    // with the Research panel. That gate is defence in depth, and defence in
    // depth is not reachable by construction. Killing this mutant would need a
    // COMPOUND one (ChatArea's ordering AND App's), which is a different and
    // weaker claim; it is recorded here rather than dressed up as coverage.
  });

  it('🔴 a gated viewer cannot drive the HOST picker at all', async () => {
    // The other side of the rewrite above, pinned so the composer's gate cannot
    // be quietly dropped: attaching is grounding for a send this viewer cannot
    // make, and it costs a rate-limited, authenticated resolve to find that out.
    // They are ASKED for the missing scope instead — the picker is not
    // `disabled`, because `'consent'` is the DEFAULT state of a first-time
    // viewer and a dead control on first run is the defect this file is about.
    render(<App />);
    await startSession();

    const launcher = screen.getByTestId('add-mention-button');
    expect(launcher.hasAttribute('disabled')).toBe(false);
    fireEvent.click(launcher);

    expect(screen.queryByTestId('mention-type-menu')).toBeNull();
    expect(requestConsent).toHaveBeenCalled();
  });

  it('asks even when the last stored message is the same text (dedup must not win)', async () => {
    // 🔴 THE ORDERING TEST WITH ITS PRECONDITION ACTUALLY BUILT. A gated send
    // never appends a message, so a naive "press Send twice" never reaches the
    // dedup at all and cannot see this. The state that DOES reach it is a
    // session restored from storage whose last message is the viewer's —
    // exactly what a failed completion leaves behind, since the assistant
    // reply is only persisted on success.
    //
    // With the dedup ahead of the gate, this press returns silently: no
    // prompt, no banner, no feedback. That is the original defect, intact,
    // behind a different guard.
    const now = Date.now();
    await storage.appStorage.set('sensei:sessions', {
      sessions: [
        { id: 'sess-restored', title: 'Restored', model: 'x', createdAt: now, updatedAt: now },
      ],
    });
    await storage.appStorage.set('sensei:messages:sess-restored', [
      { id: 'm1', role: 'user', content: 'Hello Sensei', timestamp: now },
    ]);

    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId('chat-input')).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello Sensei' } });
    fireEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(requestConsent).toHaveBeenCalled();
    });
  });

  it("App's own dedup must not win over the gate either", async () => {
    // 🔴 RETARGETED FROM "Research -> Insert" TO REGENERATE (clawgate #434), and
    // it still isolates App's DEDUP even though it no longer isolates App's
    // GATE. `handleRegenerate` re-sends the last user message verbatim, so on a
    // session restored with that text as its last stored message —
    // exactly what a failed completion leaves behind, since the assistant reply
    // is only persisted on success — `handleSend`'s dedup
    // (`lastMsg.content === content`) is live. With the dedup sitting ABOVE the
    // gate, this returns silently: no prompt, no banner, nothing.
    //
    // 🔴 IT MUST GO THROUGH THE STORED-SESSION SETUP, NOT A FRESH SEND. A gated
    // send never appends a message, so pressing Send twice never reaches the
    // dedup at all and cannot see this.
    const now = Date.now();
    await storage.appStorage.set('sensei:sessions', {
      sessions: [
        { id: 'sess-dedup', title: 'Restored', model: 'x', createdAt: now, updatedAt: now },
      ],
    });
    await storage.appStorage.set('sensei:messages:sess-dedup', [
      { id: 'm1', role: 'user', content: 'Tell me more about Test Model', timestamp: now },
      { id: 'm2', role: 'assistant', content: 'A previous reply.', timestamp: now + 1 },
    ]);

    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId('app-loading')).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId('regenerate-button')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('regenerate-button'));

    await waitFor(() => {
      expect(requestConsent).toHaveBeenCalledTimes(1);
    });
    expect(submitSpy).not.toHaveBeenCalled();
    // And the reply it would have replaced is still on screen — the gate is
    // asked BEFORE the destructive slice.
    expect(screen.getByText('A previous reply.')).toBeTruthy();
  });

  it('states the banner copy exactly, on both gates', async () => {
    // 🔴 THE COPY IS THE DELIVERABLE, so pin the WHOLE normalised string. An
    // earlier version promised "your message is still in the box" — true from
    // the composer, FALSE from Regenerate and Research -> Insert, neither of
    // which puts anything there. A partial/substring match would be satisfied
    // by that lie being restored, so this asserts the entire sentence. It will
    // fail on any reword: that is the price of a machine-checkable claim.
    const norm = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

    currentViewer = null;
    const { rerender } = render(<App />);
    await startSession();

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello Sensei' } });
    fireEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(screen.getByTestId('signin-notice')).toBeTruthy();
    });
    expect(norm(screen.getByTestId('signin-notice'))).toBe(
      'Sign in to chat with Sensei, then try again.Sign in',
    );

    currentViewer = { id: 1 };
    rerender(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('consent-notice')).toBeTruthy();
    });
    expect(norm(screen.getByTestId('consent-notice'))).toBe(
      'Sensei needs your permission to spend Buzz on a reply. Grant it, then try again.Grant permission',
    );
  });

  it('the banner button actually re-asks the host', async () => {
    // The banner tells the viewer to press this. If its onClick were inert the
    // banner would be decoration, and nothing else in the suite clicks it.
    render(<App />);
    await startSession();

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello Sensei' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => {
      expect(requestConsent).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByTestId('gate-retry-button'));
    await waitFor(() => {
      expect(requestConsent).toHaveBeenCalledTimes(2);
    });
  });

  it('gates Regenerate for an ANONYMOUS viewer too, without destroying the reply', async () => {
    // The other half of the Regenerate gate. Narrowing it to the consent case
    // would leave an anonymous viewer's reply deleted by a refused Regenerate.
    const { rerender } = render(<App />);
    await startSession();

    currentScopes = GRANTED_SCOPES;
    rerender(<App />);
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello Sensei' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(
      () => {
        expect(screen.getByText(new RegExp(REPLY))).toBeTruthy();
      },
      { timeout: 5000 },
    );

    // 🔴 WAIT FOR THE STREAM TO SETTLE BEFORE REVOKING. Without this the click
    // below lands while `isStreaming` is still true, so the reply is preserved
    // by the STREAMING guard and this test's reply-preservation assertion can
    // never fail for the GATE's sake — it was vacuous, and a mutant that let a
    // gated Regenerate fall through to the destructive slice passed 217/217.
    await waitFor(() => {
      expect(screen.queryByTestId('streaming-indicator')).toBeNull();
    });

    // Session expires: the viewer is anonymous again.
    currentViewer = null;
    rerender(<App />);
    submitSpy.mockClear();
    requestSignIn.mockClear();

    fireEvent.click(screen.getByTestId('regenerate-button'));

    await waitFor(() => {
      expect(requestSignIn).toHaveBeenCalledTimes(1);
    });
    expect(submitSpy).not.toHaveBeenCalled();
    expect(screen.getByText(new RegExp(REPLY))).toBeTruthy();
  });

  it('Regenerate mid-stream does not delete the reply it cannot resend', async () => {
    // 🔴 SAME CLASS AS THE GATE, DIFFERENT REFUSAL. `handleRegenerate` sliced
    // the reply out of view and THEN called `handleSend`, which refuses while
    // `isStreaming`. Nothing was re-sent, the in-flight completion still ran
    // and still persisted — so the viewer paid Buzz for an answer that
    // vanished from screen and only came back on reload. Every refusal has to
    // be asked before anything is destroyed.
    const { rerender } = render(<App />);
    await startSession();

    currentScopes = GRANTED_SCOPES;
    rerender(<App />);

    // One completed exchange.
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'first question' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(
      () => {
        expect(screen.getByText(new RegExp(REPLY))).toBeTruthy();
      },
      { timeout: 5000 },
    );

    // Wait for the first send to fully settle — the reply text can render a
    // tick before `isStreaming` clears, and the composer is a Stop button
    // until it does.
    await waitFor(() => {
      expect(screen.queryByTestId('streaming-indicator')).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId('send-button')).toBeTruthy();
    });

    // A second send that never settles, so the app stays streaming.
    submitSpy.mockImplementation(() => new Promise(() => {}));
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'second question' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => {
      expect(screen.getByTestId('streaming-indicator')).toBeTruthy();
    });

    // Regenerate the FIRST reply while the second is in flight.
    fireEvent.click(screen.getAllByTestId('regenerate-button')[0]);

    // The reply must still be there. Before the fix it was sliced away.
    expect(screen.getByText(new RegExp(REPLY))).toBeTruthy();
  });

  it('escalates sign-in to consent instead of dead-ending', async () => {
    // 🔴 Signing in does NOT grant the spend scope. A stored gate left the
    // viewer staring at a "sign in" banner they had already satisfied, whose
    // button was a no-op. Deriving the gate escalates it on its own.
    currentViewer = null;
    const { rerender } = render(<App />);
    await startSession();

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello Sensei' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => {
      expect(screen.getByTestId('signin-notice')).toBeTruthy();
    });

    // Viewer signs in; the token still lacks the consent-gated scope.
    currentViewer = { id: 1 };
    rerender(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('consent-notice')).toBeTruthy();
    });
    expect(screen.queryByTestId('signin-notice')).toBeNull();
  });
});
