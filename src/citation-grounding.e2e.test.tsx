import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { App } from './App.js';
import { fakeAppStorage } from './test-helpers.js';
import { clearCache } from './lib/research.js';

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE GROUNDED-CITATION GATE, END TO END, THROUGH THE REAL APP.
//
// `lib/grounding.test.ts` proves the predicate and `lib/markdown.test.ts` proves
// the parser honours it. NEITHER can see the defect this file is for: the wire
// between them. The grounded set is accumulated inside `handleSend`'s tool loop
// and has to travel App → ChatArea → MessageBubble → MarkdownText → linkHref.
// Every one of those hops is a place the set can arrive as `undefined`, which
// means "do not apply the rule" — so the guard would be perfectly correct,
// perfectly unit-tested, and completely inert in production. "Verified in
// isolation" is exactly how that ships.
//
// So every assertion here reads the RENDERED DOM: is there an `<a>` for this id
// or is there not.
//
// 🔴 IDS ARE THE REAL MEASURED ONES from the 18-turn seam probe
// (`eval/results/seam-baseline-2026-08-31.json`), pairwise distinct:
//   4384  DreamShaper      — real, correctly named
//   4823  "Deliberate"     — 404, NO SUCH MODEL
//   18619 "Juggernaut"     — 404, NO SUCH MODEL
//   22220 "Face Slider"    — real (CarDos Animated), cited under another name
// ─────────────────────────────────────────────────────────────────────────────

const DREAMSHAPER = 4384;
const DEAD_A = 4823;
const DEAD_B = 18619;
const CARDOS = 22220;

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 LAYER 2 CHANGED WHAT THESE FIXTURES HAVE TO CONTAIN, AND NOT WHAT THEY
// ASSERT. Every case below feeds an UNGROUNDED citation on purpose — which is
// now exactly the posture that makes `handleSend` spend ONE corrective
// re-submit (`lib/grounding.ts`, `planCorrectionRound`). So a queue holding a
// single reply per turn runs dry on the correction and the app renders
// `pollFn`'s fallback instead of the answer under test.
//
// The fix is `twice()`: the model, asked to correct itself, says the same thing
// again. That is the measured worst case AND it is what this file is for — it
// keeps every assertion here about LAYER 1, and pins the designed relationship
// between the two layers: after a correction round fails, the mechanical gate
// is still the thing standing between the viewer and a wrong destination.
//
// 🔴 IT ALSO CLOSES A TEST THAT WAS PASSING FOR THE WRONG REASON. The
// PER-CONVERSATION case below stayed green with a one-entry queue only because
// its `waitFor` caught the text during the streaming transient, before the
// correction replaced it. Green, and blind to its own subject.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The same reply queued twice: once for the turn, once for the correction round
 * that this reply's ungrounded citation provokes.
 */
function twice(snap: Record<string, unknown>) {
  return [snap, { ...snap }];
}

const h = vi.hoisted(() => ({
  storage: null as ReturnType<typeof fakeAppStorage> | null,
}));

const estimateFn = vi
  .fn()
  .mockResolvedValue({ workflowId: 'e', status: 'succeeded', cost: { total: 1 } });
const submitFn = vi.fn(async () => ({ workflowId: 'wf', status: 'pending' }));

/** One snapshot per poll, in order. Lets a test drive round N's reply. */
let pollQueue: Array<Record<string, unknown>> = [];
const pollFn = vi.fn(async () => {
  const next = pollQueue.shift();
  return next ?? { workflowId: 'wf-x', status: 'succeeded', cost: { total: 1 }, textOutputs: ['done'] };
});

vi.mock('@civitai/blocks-react', () => ({
  // 🔴 ONE instance, resolved at call time. A `fakeAppStorage()` factory call
  // here would hand every render a brand-new empty store, and the
  // session-switch and reload cases below would then be measuring the fake.
  useAppStorage: () => h.storage!.appStorage,
  useBlockAnalytics: () => ({ track: vi.fn() }),
  useBlockContext: () => ({ ready: true, viewer: { id: 1 }, theme: 'dark' }),
  useBlockResize: () => {},
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

/** What the next POST /tools returns. The catalog's answer, i.e. what grounds. */
let toolItems: Array<Record<string, unknown>> = [];

function toolCallSnapshot() {
  return {
    workflowId: 'wf-tc',
    status: 'succeeded',
    cost: { total: 1 },
    toolCalls: [
      {
        id: 'call_abc',
        type: 'function',
        function: { name: 'search_models', arguments: JSON.stringify({ query: 'realistic' }) },
      },
    ],
  };
}

function textSnapshot(text: string) {
  return { workflowId: 'wf-t', status: 'succeeded', cost: { total: 1 }, textOutputs: [text] };
}

let originalFetch: typeof globalThis.fetch;

function installFetch() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/v1/blocks/tools')) {
      const payload =
        method === 'GET' ? { tools: DECLARATIONS } : { items: toolItems, truncated: 0 };
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [], metadata: {} }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

/** The rendered anchor for a model id, or null when the gate refused it. */
function anchorFor(id: number): HTMLAnchorElement | null {
  return document.querySelector<HTMLAnchorElement>(`a[href*="/models/${id}"]`);
}

async function startChat() {
  render(<App />);
  await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
  fireEvent.click(screen.getByTestId('new-session-button'));
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
}

/**
 * Type and send; resolves once the reply is on screen AND the turn has settled.
 *
 * 🔴 WAITING FOR THE TEXT ALONE IS NOT ENOUGH, and the failure is silent: the
 * reply renders before `handleSend`'s `finally` clears `isStreaming`, and
 * `handleSend` refuses a send while it is true. A second `send()` therefore
 * returned having done nothing at all, and the test then failed on the PREVIOUS
 * turn's screen — which reads as the grounding gate misbehaving.
 */
async function send(question: string, expectInReply: string) {
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: question } });
  fireEvent.click(screen.getByTestId('send-button'));
  await waitFor(() => expect(screen.getByText(new RegExp(expectInReply))).toBeTruthy(), {
    timeout: 8000,
  });
  await waitFor(() => expect(screen.queryByTestId('streaming-indicator')).toBeNull(), {
    timeout: 8000,
  });
}

describe('grounded citations reach the screen', () => {
  beforeEach(() => {
    h.storage = fakeAppStorage();
    pollQueue = [];
    toolItems = [];
    submitFn.mockClear();
    pollFn.mockClear();
    clearCache();
    installFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('🔴 the id the CATALOG returned is a link; the one beside it that it did not is TEXT', () => {
    return (async () => {
      toolItems = [{ id: DREAMSHAPER, name: 'DreamShaper', type: 'Checkpoint' }];
      pollQueue = [
        toolCallSnapshot(),
        ...twice(
          textSnapshot(
            `1. [DreamShaper](https://civitai.com/models/${DREAMSHAPER})\n` +
              `2. [Deliberate](https://civitai.com/models/${DEAD_A})`,
          ),
        ),
      ];
      await startChat();
      await send('photorealistic portraits?', 'Deliberate');

      expect(anchorFor(DREAMSHAPER)).toBeTruthy();
      // 4823 is a 404. Before this gate it rendered as a live link.
      expect(anchorFor(DEAD_A)).toBeNull();
      // 🔴 THE MODEL'S WORDS SURVIVE. Refusing the href must not delete the
      // sentence; the viewer reads the same answer, minus a dead link.
      expect(screen.getByText(/Deliberate/)).toBeTruthy();
    })();
  });

  it('🔴 grounding ACCUMULATES: turn 1 looked it up, turn 5 may still link it', () => {
    return (async () => {
      toolItems = [{ id: DREAMSHAPER, name: 'DreamShaper', type: 'Checkpoint' }];
      pollQueue = [toolCallSnapshot(), textSnapshot('DreamShaper is a checkpoint.')];
      await startChat();
      await send('what is DreamShaper?', 'DreamShaper is a checkpoint');

      // Turn 2 calls NO tool — the exact posture that produced every measured
      // fabrication — and cites one id from turn 1 plus one from nowhere.
      pollQueue = twice(
        textSnapshot(
          `Use [DreamShaper](https://civitai.com/models/${DREAMSHAPER}), not ` +
            `[Juggernaut](https://civitai.com/models/${DEAD_B}).`,
        ),
      );
      await send('anything else?', 'Juggernaut');

      // Grounded on turn 1, still grounded now. A per-TURN set would refuse
      // this and break every follow-up question in the app.
      expect(anchorFor(DREAMSHAPER)).toBeTruthy();
      expect(anchorFor(DEAD_B)).toBeNull();
    })();
  });

  it('🔴 grounding is PER CONVERSATION: a lookup in one chat does not vouch for another', () => {
    return (async () => {
      toolItems = [{ id: DREAMSHAPER, name: 'DreamShaper', type: 'Checkpoint' }];
      pollQueue = [toolCallSnapshot(), textSnapshot('DreamShaper is a checkpoint.')];
      await startChat();
      await send('what is DreamShaper?', 'DreamShaper is a checkpoint');

      // A second conversation. Nothing has been looked up in it.
      fireEvent.click(screen.getByTestId('new-session-button'));
      await waitFor(() => expect(screen.queryByText(/is a checkpoint/)).toBeNull());

      pollQueue = twice(
        textSnapshot(`Try [DreamShaper](https://civitai.com/models/${DREAMSHAPER}) here too.`),
      );
      await send('recommend something', 'here too');

      // Same id, same app, different conversation — and this one grounded
      // nothing. One flat set would let chat A silently authorise chat B.
      expect(anchorFor(DREAMSHAPER)).toBeNull();
    })();
  });

  it('🔴 a turn that calls NO tool links NOTHING — the measured defect, end to end', () => {
    return (async () => {
      pollQueue = twice(
        textSnapshot(
          `- **Face Slider** [link](https://civitai.com/models/${CARDOS}) tunes expressions.`,
        ),
      );
      await startChat();
      await send('how do I improve faces?', 'Face Slider');

      // 22220 IS a real model — CarDos Animated — so this link resolves 200 and
      // sends the viewer somewhere unrelated. Nothing on screen says so, which
      // is why the fix cannot be "read the answer".
      expect(anchorFor(CARDOS)).toBeNull();
      expect(screen.getByText(/Face Slider/)).toBeTruthy();
    })();
  });

  it('positive control: the SAME answer renders a live link once the tool returns that id', () => {
    return (async () => {
      // Without this the four cases above are all satisfied by an app that
      // renders no anchors at all, for any reason.
      toolItems = [{ id: CARDOS, name: 'CarDos Animated', type: 'Checkpoint' }];
      pollQueue = [
        toolCallSnapshot(),
        textSnapshot(
          `- **Face Slider** [link](https://civitai.com/models/${CARDOS}) tunes expressions.`,
        ),
      ];
      await startChat();
      await send('how do I improve faces?', 'Face Slider');

      const a = anchorFor(CARDOS);
      expect(a).toBeTruthy();
      // The rest of the link contract is unchanged by grounding.
      expect(a?.getAttribute('target')).toBe('_blank');
      expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
    })();
  });

  it('🔴 NO COMMIT EVER SHOWS THE TRANSCRIPT WITHOUT ITS LINKS', () => {
    return (async () => {
      // 🔴 THIS PINS COMMIT ORDERING, WHICH NO OTHER TEST HERE CAN SEE. Every
      // other reload assertion waits for a settled DOM, so it is blind to what
      // was on screen in between — and what was on screen was the whole
      // transcript with its citations as PLAIN TEXT. The boot path read the
      // session, committed `setMessages` alone, cleared `loading` in its own
      // `finally`, and left grounding to the `[activeSessionId]` effect a tick
      // later. A viewer saw the text, then the links appeared.
      //
      // 🔴 WAITING IS EXACTLY WHAT HID IT, so this test must NOT wait to observe.
      // It records the (text, anchor) pair at EVERY DOM mutation batch during
      // boot and asserts the half-state never occurs. `waitFor` is used only to
      // bound the run, after the observer is already recording.
      //
      // ⚠️ WHAT THIS ORACLE CANNOT SEE, so nobody reads it as a general one:
      // `MutationObserver` delivers ONE callback per microtask checkpoint and the
      // callback reads the CURRENT DOM, not a snapshot per mutation. Two commits
      // landing inside a single checkpoint would coalesce into one callback that
      // sees only the final, linked state — a false green. It is sound HERE
      // because the two commits are separated by an awaited storage read (red
      // 5/5 at base, verified independently), and the separation is larger
      // against the real host's postMessage round trip. It is not a general
      // "no half-state ever" assertion.
      toolItems = [{ id: DREAMSHAPER, name: 'DreamShaper', type: 'Checkpoint' }];
      pollQueue = [
        toolCallSnapshot(),
        textSnapshot(`[DreamShaper](https://civitai.com/models/${DREAMSHAPER}) is great.`),
      ];
      await startChat();
      await send('what is DreamShaper?', 'is great');

      cleanup();

      const halfStates: number[] = [];
      let batches = 0;
      const observer = new MutationObserver(() => {
        batches += 1;
        const hasText = (document.body.textContent ?? '').includes('is great');
        if (hasText && anchorFor(DREAMSHAPER) === null) halfStates.push(batches);
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      try {
        render(<App />);
        await waitFor(() => expect(anchorFor(DREAMSHAPER)).toBeTruthy());
      } finally {
        observer.disconnect();
      }

      // 🔴 POSITIVE CONTROL FIRST — without it a zero here is indistinguishable
      // from an observer that was never wired to anything, which is the shape
      // that makes a reassuring zero worthless.
      expect(batches, 'the observer saw no DOM mutations at all — it is not measuring').toBeGreaterThan(0);
      expect(
        halfStates,
        `transcript rendered without its links in mutation batch(es) ${halfStates.join(', ')} of ${batches}`,
      ).toHaveLength(0);
    })();
  });

  it('🔴 THE SWITCH LOADER IS PINNED TOO — boot into one chat, switch to another', () => {
    return (async () => {
      // 🔴 THIS EXISTS BECAUSE CONSOLIDATION SILENTLY UN-PINNED A CALL SITE.
      // Both loaders now route through `applyLoadedMessages`, which is the fix —
      // but every other reload test boots STRAIGHT INTO the grounded chat, so the
      // BOOT loader alone satisfies all of them. Measured: replacing the SWITCH
      // site with a bare `setMessages` left the whole suite green, where the
      // equivalent deletion before the consolidation killed two tests. The fix
      // improved the product and weakened the suite about one of the two routes
      // its own comment names.
      //
      // The discriminator is a chat you did NOT boot into: boot loads the newest
      // session, so reaching the grounded one goes through the switch path, and
      // its grounding can only come from that call site.
      toolItems = [{ id: DREAMSHAPER, name: 'DreamShaper', type: 'Checkpoint' }];
      pollQueue = [
        toolCallSnapshot(),
        textSnapshot(`[DreamShaper](https://civitai.com/models/${DREAMSHAPER}) is great.`),
      ];
      await startChat();
      await send('what is DreamShaper?', 'is great');

      // A second, NEWER conversation, so boot lands here and not on the grounded one.
      fireEvent.click(screen.getByTestId('new-session-button'));
      await waitFor(() => expect(screen.queryByText(/is great/)).toBeNull());
      pollQueue = [textSnapshot('Nothing looked up here.')];
      await send('hello', 'Nothing looked up here');

      cleanup();
      render(<App />);
      await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
      // Booted into the ungrounded chat, as designed — if this ever boots into the
      // grounded one the test silently stops exercising the switch path.
      await waitFor(() => expect(screen.getByText(/Nothing looked up here/)).toBeTruthy());
      expect(anchorFor(DREAMSHAPER), 'booted into the wrong session').toBeNull();

      const rows = document.querySelectorAll<HTMLElement>('[data-testid^="session-item-"]');
      expect(rows, 'expected both conversations in the switcher').toHaveLength(2);
      fireEvent.click(rows[rows.length - 1]);

      await waitFor(() => expect(screen.getByText(/is great/)).toBeTruthy());
      await waitFor(() => expect(anchorFor(DREAMSHAPER)).toBeTruthy());
    })();
  });

  it('🔴 A FAILED SWITCH KEEPS THE OUTGOING TRANSCRIPT’S LINKS', () => {
    return (async () => {
      // 🔴 THE DURABLE HALF-STATE, and the reason this is worth a state cell.
      // `selectSession` moves `activeSessionId` and deliberately does NOT clear
      // `messages`, so the outgoing conversation stays readable while the next
      // one loads. The grounded set used to key on `activeSessionId`, so during
      // that read the outgoing transcript was rendered against the INCOMING
      // session's empty set and its citations turned to plain text. Usually a
      // tick — but if the read FAILS there is nothing to end it, and the viewer
      // is left looking at a real transcript whose links have silently been
      // refused, next to an error about a DIFFERENT chat.
      //
      // The failure arm is what makes this deterministic: no timing, no
      // observer, just a rejected read and a DOM that must still be correct.
      toolItems = [{ id: DREAMSHAPER, name: 'DreamShaper', type: 'Checkpoint' }];
      pollQueue = [
        toolCallSnapshot(),
        textSnapshot(`[DreamShaper](https://civitai.com/models/${DREAMSHAPER}) is great.`),
      ];
      await startChat();
      await send('what is DreamShaper?', 'is great');

      fireEvent.click(screen.getByTestId('new-session-button'));
      await waitFor(() => expect(screen.queryByText(/is great/)).toBeNull());
      pollQueue = [textSnapshot('Nothing looked up here.')];
      await send('hello', 'Nothing looked up here');

      // Back to the grounded conversation, so IT is the transcript on screen.
      const rows = () => document.querySelectorAll<HTMLElement>('[data-testid^="session-item-"]');
      expect(rows()).toHaveLength(2);
      fireEvent.click(rows()[rows().length - 1]);
      await waitFor(() => expect(anchorFor(DREAMSHAPER)).toBeTruthy());

      // Now make the NEXT switch's read fail.
      const storage = h.storage!.appStorage;
      const realGet = storage.get.bind(storage);
      storage.get = (async (key: string) => {
        if (key.startsWith('sensei:messages:')) throw new Error('storage is unavailable');
        return realGet(key);
      }) as typeof storage.get;

      fireEvent.click(rows()[0]);
      await waitFor(() => expect(screen.getByText(/Couldn't open that chat/)).toBeTruthy());

      // 🔴 The transcript on screen is still the grounded conversation's — so its
      // links must still be links. Before this fix they were plain text, and
      // stayed that way, because the grounded set had already moved on.
      expect(screen.getByText(/is great/)).toBeTruthy();
      expect(
        anchorFor(DREAMSHAPER),
        'the visible transcript lost its links to a failed load of a DIFFERENT chat',
      ).toBeTruthy();
    })();
  });

  it('🔴 RELOAD KEEPS THE GROUNDING — the ids ride the stored assistant turn', () => {
    return (async () => {
      // ⚠️ THIS CASE USED TO ASSERT THE OPPOSITE, and the inversion is the fix.
      // `role:'tool'` is a transcript role and is never stored, so a reloaded
      // conversation rebuilt an EMPTY grounded set and every stored model link
      // rendered as plain text — the gate refusing links it had approved
      // minutes earlier because the EVIDENCE was gone, not because the id was
      // bad. The old comment here named this exact remedy: carry the ids on the
      // stored assistant message, riding the write that already happens.
      toolItems = [{ id: DREAMSHAPER, name: 'DreamShaper', type: 'Checkpoint' }];
      pollQueue = [
        toolCallSnapshot(),
        textSnapshot(`[DreamShaper](https://civitai.com/models/${DREAMSHAPER}) is great.`),
      ];
      await startChat();
      await send('what is DreamShaper?', 'is great');
      expect(anchorFor(DREAMSHAPER)).toBeTruthy();

      cleanup();
      render(<App />);
      await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
      // The transcript came back…
      await waitFor(() => expect(screen.getByText(/is great/)).toBeTruthy());
      // …and so did its link. 🔴 Waited for, not sampled: the text renders before
      // the grounded set is restored, so a synchronous anchor assertion here is
      // the same race that was measured flaky in the sibling test below. Same
      // shape, same fix — a timeout here still fails, so waiting cannot mask a
      // link that never comes back.
      await waitFor(() => expect(anchorFor(DREAMSHAPER)).toBeTruthy());
      // The full link contract, not merely the presence of an anchor — a
      // restored link that lost `rel` would be a quieter regression than a
      // missing one.
      expect(anchorFor(DREAMSHAPER)?.getAttribute('rel')).toBe('noopener noreferrer');
    })();
  });

  it('🔴 RELOAD DOES NOT TRUST WHAT THE GATE NEVER APPROVED — an invented id stays plain text', () => {
    return (async () => {
      // 🔴 THE SECURITY HALF, and the one that makes the case above safe rather
      // than merely convenient. Restoring evidence must not become "restore a
      // permissive set": only ids a tool round actually RETURNED are written, so
      // an id the model invented was never stored and is still refused after a
      // reload. Without this, "keeps the grounding" could be satisfied by a fix
      // that simply stopped applying the rule to restored transcripts.
      toolItems = [{ id: DREAMSHAPER, name: 'DreamShaper', type: 'Checkpoint' }];
      pollQueue = [
        toolCallSnapshot(),
        // The tool returned DREAMSHAPER; the reply cites CARDOS as well, which
        // nothing in this conversation ever grounded.
        // 🔴 `twice`, because the ungrounded citation makes Layer 2's correction
        // round fire and re-submit. A single snapshot leaves the queue empty on
        // that second submit and the turn never settles — which presents as the
        // RELOAD losing the transcript, not as a queue underrun.
        ...twice(
          textSnapshot(
            `[DreamShaper](https://civitai.com/models/${DREAMSHAPER}) and ` +
              `[Cardos](https://civitai.com/models/${CARDOS}) are great.`,
          ),
        ),
      ];
      await startChat();
      await send('what is DreamShaper?', 'are great');

      cleanup();
      render(<App />);
      await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());
      await waitFor(() => expect(screen.getByText(/are great/)).toBeTruthy());
      // 🔴 WAIT FOR THE ANCHOR, NOT FOR THE TEXT. The text is a PROXY, and on a
      // reload it lands FIRST. The cause is not "restored a tick later" — it is
      // that the session is loaded TWICE: `App.tsx`'s mount path commits
      // `setMessages` carrying NO grounding, and the `[activeSessionId]` effect
      // then does the same read PLUS `recordGrounded`. `app-loading` clears in
      // between, so a real committed render exists at `msgs=2 grounded=0
      // loading=false` and BOTH preceding waits can resolve inside it. Measured
      // flaky 1 run in 12 here, and independently 1 in 15 at the sibling site.
      //
      // 🔴 WHAT THIS DOES AND DOES NOT BUY, because an earlier version of this
      // comment overstated it and was refuted by measurement. It claimed the
      // CARDOS assertion below "would have passed against a build that grounded
      // nothing at all". IT WOULD NOT: the DREAMSHAPER assertion sat immediately
      // above it and threw FIRST, so CARDOS was never reached — the race made
      // this test flaky RED, never silently green, and both mutants (gate
      // disabled, restore grounding nothing) killed the old CARDOS line too.
      // What is true is narrower and still worth the wait: CARDOS is not
      // SELF-SUFFICIENT — "no anchor" only means "the gate refused it" once
      // something establishes that anchors render here at all. That guarantee is
      // the line below, and before the wait it was racy rather than reliable.
      await waitFor(() => expect(anchorFor(DREAMSHAPER)).toBeTruthy());
      // …and the invented one is still refused. Its TEXT is still readable —
      // refusing a link keeps the words, it does not delete the sentence.
      expect(anchorFor(CARDOS)).toBeNull();
      expect(screen.getByText(/Cardos/)).toBeTruthy();
    })();
  });
});
