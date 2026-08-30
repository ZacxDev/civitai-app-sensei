import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useAppStorage,
  useBlockAnalytics,
  useBlockContext,
  useBlockResize,
  useBlockToken,
  useBuzzWorkflow,
  useRequestConsent,
  useRequestSignIn,
  useResourcePicker,
} from '@civitai/blocks-react';
import type { UseAppStorage } from '@civitai/blocks-react';
import { Button, Group, Loader, Stack } from '@civitai/blocks-react/ui';

import { palette, pageStyle, token, radius, mutedText } from './theme.js';
import type { AppSettings, Message, Session } from './types.js';
import { DEFAULT_SETTINGS, migrateSettings, NO_TOOLS_NOTICE } from './types.js';
import { AI_WRITE_BUDGETED, BUZZ_READ_SELF, hasGenerateScope } from './scopes.js';
import { createOrchestrator } from './lib/orchestrator.js';
import { TextOutputWithheldError, toStepMessages } from './lib/orchestrator-bridge.js';
import * as sessionsLib from './lib/sessions.js';
import * as toolsLib from './lib/tools.js';
import * as mentionsLib from './lib/mentions.js';
import type { ResolvedResource } from './lib/mentions.js';
import { generateMessageId, withSystemPrompt } from './lib/chat.js';
import { generateTitle } from './lib/sessions.js';
import { claimMessageWrite, ownsMessageWrite } from './lib/write-ownership.js';

import { ChatArea } from './components/ChatArea.js';
import type { MentionPickerType } from './components/ResourceMention.js';
import { SessionList } from './components/SessionList.js';
import { SettingsBar } from './components/SettingsBar.js';
import { SettingsModal } from './components/SettingsModal.js';

export interface AppDeps {
  appStorage: UseAppStorage;
  track: (eventName: string, properties?: Record<string, unknown>) => void;
}

export interface AppProps {
  deps?: Partial<AppDeps>;
}

/**
 * The turn currently in flight, as the turn itself sees it. (clawgate #427.)
 *
 * 🔴 THIS EXISTS BECAUSE `handleStopStream` HAD NO WAY TO ASK THE TURN ANYTHING.
 * It read `activeSessionId` and `messagesRef` — both of which describe the
 * session the viewer is LOOKING AT, not the session the in-flight turn belongs
 * to. `isStreaming` is instance-wide and nothing disables the session switcher
 * mid-stream, so the two diverge the moment a viewer switches sessions with a
 * turn in flight, and Stop then wrote one conversation's transcript under
 * another conversation's key.
 *
 * Both halves have to travel together. Fixing only the key would make Stop write
 * the VIEWED session's array (already reset to `[]` by the switch) under the
 * STREAMING session's key — which is not a smaller bug than the original, it is
 * a larger one: it would delete the transcript instead of misfiling it. So the
 * turn carries the id it was sent in AND the array it is entitled to persist.
 *
 * A ref is the transport, not the source: every field is written from inside
 * `handleSend`'s own closure at the moment the turn starts, and nothing reads a
 * viewer-facing cell at Stop time.
 */
interface StreamingTurn {
  /** The session this turn was sent in. Captured at send; never re-read. */
  readonly sessionId: string;
  /**
   * What this turn is entitled to persist, as of now — the user turn it was
   * built with plus whatever of the reply has streamed so far.
   *
   * A function rather than an array because the reply grows: Stop must persist
   * the prose the viewer has already been CHARGED for, not the empty shell the
   * turn started with.
   */
  transcript: () => Message[];
}

export function App({ deps: depsOverride }: AppProps = {}) {
  const { ready, viewer, theme } = useBlockContext();
  const token_ = useBlockToken();
  const appStorageHook = useAppStorage();
  // 🔴 NO `useBuzzBalance()` HERE ANY MORE. The in-app Buzz badge was removed in
  // 0.1.5 — the on-site header already shows the balance, so a second copy was
  // redundant chrome inside a small iframe. `buzz:read:self` DELIBERATELY STAYS
  // in `block.manifest.json`: consent is keyed on the granted SCOPE SET
  // (`app_user_scope_grants.granted_scopes`, unique per user+app), so dropping
  // the scope would re-prompt everyone who has already granted it, for a
  // cosmetic change.
  const { track } = useBlockAnalytics();
  const { requestConsent } = useRequestConsent();
  const { requestSignIn } = useRequestSignIn();
  const rootRef = useRef<HTMLDivElement>(null);
  useBlockResize(rootRef);

  const c = palette();

  const deps: AppDeps = useMemo(
    () => ({
      appStorage: appStorageHook,
      track,
      ...depsOverride,
    }),
    [depsOverride],
  );
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const canGenerate = hasGenerateScope(token_.scopes);

  // ---- State ----
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 🔴 THE RESEARCH PANEL IS GONE, NOT HIDDEN. `researchOpen`, `searchResults`
  // and the in-iframe search that fed them were removed with it (clawgate #434).
  // The viewer now searches in the HOST's own picker chrome, so this iframe
  // never receives a catalog list at all — a strictly narrower surface than the
  // panel had. What survives is the model's own query, shown inline while a
  // lookup is in flight; see `ChatArea`'s `lookupQuery`.
  const [lookupQuery, setLookupQuery] = useState<string | null>(null);
  const [pendingMentions, setPendingMentions] = useState<ResolvedResource[]>([]);
  const [loading, setLoading] = useState(true);
  // 🔴 A REJECTED STORAGE CALL MUST NOT BE INDISTINGUISHABLE FROM SUCCESS. Every
  // storage call in this app used to be either unguarded (`createSession`, whose
  // rejection propagated as an unhandled promise and showed the viewer NOTHING —
  // "+ New" was observably dead in production) or swallowed by a bare `catch {}`.
  // Both present as "the click did nothing", which is the same signature as the
  // 0.1.4 consent bug and takes a session of measurement to tell apart. Now every
  // one of them goes through `persist` and lands here.
  const [storageError, setStorageError] = useState<string | null>(null);
  // Attaching a model can fail for reasons that are NOT storage and NOT the
  // send: the host declined to open the picker, the resolve 429'd, or the clamp
  // withheld the resource. Given its own cell so the sentence can be accurate —
  // "Couldn't save…" for a failed attach would be a second lie on top of the
  // first, which is the defect `storageError` itself exists to prevent.
  const [mentionError, setMentionError] = useState<string | null>(null);
  // Whether the viewer has actually run into the capability gate. The gate
  // ITSELF is derived (below), never stored — storing it is what let an earlier
  // draft show a stale "sign in" banner to a viewer who had since signed in but
  // still lacked the spend scope, with nothing to escalate it.
  const [gateRaised, setGateRaised] = useState(false);

  const streamingRef = useRef(false);
  // 🔴 THERE IS NO `messagesRef` ANY MORE, AND ITS ABSENCE IS LOAD-BEARING.
  // It mirrored the RENDERED message array — i.e. whatever session the viewer
  // was looking at — and existed for exactly one reader, `handleStopStream`.
  // That is the wrong array for that reader: a viewer who switches sessions
  // mid-stream leaves it holding the NEW session's messages while the turn
  // being stopped belongs to the old one (clawgate #427). The turn now carries
  // its own transcript (see {@link StreamingTurn}), so re-adding a mirror of
  // rendered state would only give a future Stop-like caller the wrong answer
  // again.
  const abortControllerRef = useRef<AbortController | null>(null);
  /**
   * Monotonic turn number. A turn increments it on entry and keeps the value;
   * `turnSeqRef.current === mine` is therefore "I am still the current turn".
   *
   * 🔴 THIS IS NOT A DUPLICATE OF `abortControllerRef` — it answers a DIFFERENT
   * question, and conflating them is what made the last fix incomplete.
   * `aborted()` answers "was MY turn stopped"; this answers "is my turn still
   * the one that owns the shared UI state". A turn that was never aborted but
   * has been SUPERSEDED must still keep its hands off `isStreaming`, and no
   * abort predicate can see that case.
   *
   * A plain counter rather than `abortControllerRef.current === controller`
   * because that comparison is a fourth read of the mutable ref, which
   * `App.abort-scope.test.ts` refuses by design — and rightly: the point of that
   * guard is that abort questions go through `aborted()`. Ownership is a
   * different axis and gets its own cell.
   */
  const turnSeqRef = useRef(0);
  /**
   * The turn in flight right now, or `null`. See {@link StreamingTurn}.
   *
   * 🔴 IT HOLDS THE CURRENT TURN, DELIBERATELY, AND THAT PAIRS IT WITH
   * `abortControllerRef`. Stop aborts whichever turn is in flight now; it must
   * persist THAT turn's transcript, under THAT turn's session. A superseded turn
   * leaves this cell alone for the same reason it leaves `isStreaming` alone —
   * the check is object identity, which is `turnSeqRef`'s question asked about
   * this cell rather than a second counter to keep in step.
   */
  const streamingTurnRef = useRef<StreamingTurn | null>(null);
  const { open: openResourcePicker } = useResourcePicker();
  const { estimate, submit, poll, cancel } = useBuzzWorkflow();
  const orchestrator = useMemo(
    () => createOrchestrator({ estimate, submit, poll, cancel }),
    [estimate, submit, poll, cancel],
  );

  // ── DEV-ONLY dogfood handle ────────────────────────────────────────────────
  // 🔴 STRIPPED FROM A PRODUCTION BUILD by the `import.meta.env.DEV` guard —
  // Vite statically replaces it with `false` and drops the branch.
  //
  // WHY IT EXISTS. Every path to the orchestrator ran through a button inside a
  // CROSS-ORIGIN iframe, and the bridge's only tool for that dispatches
  // SYNTHETIC clicks. That left the moderated (withheld) branch executable ONLY
  // in a fixture — a fixture that, until this commit, encoded a reply shape the
  // host never sends. A capability nobody can drive is a capability nobody has
  // verified. This gives a dev tunnel a direct handle on the real adapter, so a
  // clean AND a flagged completion can each be driven against the deployed step.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__senseiDogfood = {
      send: (content: string, model: string = settings.model) =>
        orchestrator.submitChatCompletion({
          model,
          messages: [{ role: 'user', content }],
          max_tokens: 256,
          temperature: 0.7,
        }),
    };
  }, [orchestrator, settings.model]);

  /**
   * Run one storage interaction and REPORT ITS FAILURE TO THE VIEWER.
   *
   * Returns whether it succeeded, so a caller can decline to update the UI for a
   * change that was not saved — showing a session that does not exist is a
   * second lie on top of the first.
   *
   * `what` completes the sentence "Couldn't …", so it is a verb phrase.
   */
  const persist = useCallback(
    async (what: string, run: () => Promise<unknown>): Promise<boolean> => {
      try {
        await run();
        setStorageError(null);
        return true;
      } catch (e) {
        const detail = e instanceof Error && e.message ? e.message : 'storage is unavailable';
        setStorageError(`Couldn't ${what} — ${detail}.`);
        depsRef.current.track('storage_error', { what });
        return false;
      }
    },
    [],
  );

  // ---- Load sessions on mount ----
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      try {
        const loaded = await sessionsLib.listSessions(depsRef.current.appStorage);
        const storedSettings = await depsRef.current.appStorage.get<AppSettings>('sensei:settings');
        if (cancelled) return;
        setSessions(loaded);
        // Migrated at LOAD, not at save: a viewer who has never reopened
        // Settings still gets a corrected default prompt on their next send.
        // `migrateSettings` is total — an edited prompt passes through.
        if (storedSettings) setSettings(migrateSettings(storedSettings));
        if (loaded.length > 0) {
          setActiveSessionId(loaded[0].id);
          const msgs = await sessionsLib.getMessages(depsRef.current.appStorage, loaded[0].id);
          if (!cancelled) setMessages(msgs);
        }
      } catch (e) {
        // 🔴 NOT SWALLOWED ANY MORE. A failed load leaves the app showing an
        // EMPTY session list, which is indistinguishable from a new user — and
        // the next write would then persist that empty list over real history.
        if (!cancelled) {
          const detail = e instanceof Error && e.message ? e.message : 'storage is unavailable';
          setStorageError(
            `Couldn't load your saved chats — ${detail}. Anything you send now may not be saved.`,
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ready]);

  // ---- Composer state belongs to ONE conversation ----
  //
  // 🔴 ONE PLACE, KEYED ON THE ID ITSELF, RATHER THAN A CLEAR AT EACH CALLER.
  // `createSession` used to be the only route that cleared this, with the right
  // reason attached to it — "Attachments belong to the message being composed…
  // carrying them across would silently ground a question the viewer has not
  // asked yet" — and that reason is about the CONVERSATION CHANGING, not about
  // the "+ New" button. Three routes move `activeSessionId`: `createSession`,
  // `selectSession`, and `deleteSession` (to `next[0]`, without ever being a
  // switcher click, which is exactly the one a per-call-site fix forgets). This
  // is the #427 class in the composer axis — state keyed on the VIEWED session
  // written by something that does not check which session it is in — and the
  // lesson from #427 is that it closes at the state, not at the control.
  //
  // WHAT IS CLEARED AND WHY EACH ONE:
  //  - `pendingMentions`: the attachments that would ground the next question.
  //    Carrying them across attaches another conversation's resources — and
  //    they are BILLED grounding, not decoration.
  //  - `mentionError`: describes a failed attach on the composer just left. A
  //    banner about a conversation you are no longer in is the "say only what is
  //    true on every path" defect one banner over.
  //  - `lookupQuery`: the model's own query for a lookup in flight. `ChatArea`
  //    renders it whenever `isStreaming` is true, and `isStreaming` is
  //    INSTANCE-wide, so after a switch it would label the new conversation with
  //    the old one's query. Clearing under-reports (the label stays blank until
  //    the next round sets it, and switching back does not restore it), and an
  //    under-report about a conversation you are in beats an accurate report
  //    about one you are not.
  //
  // `storageError` is deliberately NOT cleared: it is app-level, not composer
  // state, and a failed `deleteSession` sets it on exactly the route that then
  // moves the id — clearing it here would hide the failure it just reported.
  useEffect(() => {
    setPendingMentions([]);
    setMentionError(null);
    setLookupQuery(null);
  }, [activeSessionId]);

  // ---- Load messages when session changes ----
  useEffect(() => {
    if (!activeSessionId) { setMessages([]); return; }
    let cancelled = false;
    sessionsLib
      .getMessages(depsRef.current.appStorage, activeSessionId)
      .then((msgs) => {
        if (!cancelled) setMessages(msgs);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const detail = e instanceof Error && e.message ? e.message : 'storage is unavailable';
        setStorageError(`Couldn't open that chat — ${detail}.`);
      });
    return () => { cancelled = true; };
  }, [activeSessionId]);

  // ---- Actions ----
  //
  // 🔴 EVERY ONE OF THESE WRITES THE WHOLE LIST FROM STATE AND NEVER READS IT
  // BACK FIRST. See the header of `lib/sessions.ts` for the measurement: the
  // deployed host cannot serve a block its own write, so a read-modify-write
  // silently computes from a pre-write snapshot and drops whatever landed in
  // between. Persist FIRST, update state only on success.
  const createSession = useCallback(async () => {
    const session = sessionsLib.createSessionRecord(settings.model);
    const next = [session, ...sessions];
    const ok = await persist('start a new chat', () =>
      sessionsLib.saveSessions(depsRef.current.appStorage, next),
    );
    if (!ok) return;
    setSessions(next);
    setActiveSessionId(session.id);
    setMessages([]);
    // 🔴 THE COMPOSER CLEAR USED TO LIVE HERE AND HAS MOVED to the
    // `[activeSessionId]` effect above — one rule, one place. It was correct
    // here and absent from `selectSession` and `deleteSession`, which move the
    // same id for the same viewer-visible effect. Do not re-add a local copy:
    // a second copy is how the two drift.
    depsRef.current.track('session_create');
  }, [settings.model, sessions, persist]);

  const deleteSession = useCallback(async (id: string) => {
    const next = sessionsLib.without(sessions, id);
    const ok = await persist('delete that chat', async () => {
      await sessionsLib.saveSessions(depsRef.current.appStorage, next);
      await sessionsLib.deleteMessages(depsRef.current.appStorage, id);
    });
    if (!ok) return;
    setSessions(next);
    if (activeSessionId === id) setActiveSessionId(next[0]?.id ?? null);
    depsRef.current.track('session_delete');
  }, [activeSessionId, sessions, persist]);

  const renameSession = useCallback(async (id: string) => {
    const title = prompt('Rename session:');
    if (!title) return;
    const next = sessionsLib.withTitle(sessions, id, title);
    const ok = await persist('rename that chat', () =>
      sessionsLib.saveSessions(depsRef.current.appStorage, next),
    );
    if (!ok) return;
    setSessions(next);
  }, [sessions, persist]);

  // ── The capability gate, DERIVED. ──────────────────────────────────────────
  // `null` = the send can proceed. Deriving it means the banner corrects itself
  // the instant the host re-mints: a granted scope clears it with no effect and
  // no bookkeeping, and a viewer who signs in but still lacks the spend scope
  // escalates 'signin' → 'consent' on its own rather than sitting on a dead
  // end. Order matters — an anonymous viewer cannot grant a scope.
  const sendGate: null | 'signin' | 'consent' = !viewer
    ? 'signin'
    : !canGenerate
      ? 'consent'
      : null;

  // Ask the host for whatever is missing. Safe to call repeatedly — it is the
  // banner's button as well as the send path, and the host treats each message
  // independently.
  const raiseGate = useCallback(() => {
    setGateRaised(true);
    if (!viewer) {
      requestSignIn();
      depsRef.current.track('signin_requested');
      return;
    }
    // Ask for both consent-gated scopes the manifest declares: the reply spends
    // Buzz and the composer shows the balance beside it. The hint is advisory —
    // the host grants the missing set it computed at mint — but asking for what
    // the app actually uses keeps the two in step.
    requestConsent({ scopes: [AI_WRITE_BUDGETED, BUZZ_READ_SELF] });
    depsRef.current.track('consent_requested');
  }, [viewer, requestConsent, requestSignIn]);

  // ── MENTIONS: pick in HOST chrome, resolve through the clamped endpoint ─────
  //
  // 🔴 THE ITERATION BOUNDARY DOES NOT MOVE, AND THIS HANDLER IS WHERE IT WOULD
  // MOVE IF ANYTHING EVER MOVED IT. `openResourcePicker` asks the HOST to open
  // its OWN modal; the viewer searches there, in host chrome, and the host posts
  // back exactly ONE chosen resource. This iframe never receives a list, the
  // search API, or the catalog. Nothing below widens that: the only outbound
  // request is an ID-keyed resolve.
  //
  // 🔴 RESOLVED AT PICK TIME, NOT AT SEND TIME, AND THAT IS THE SAFER ORDER.
  // `GET /api/v1/blocks/generation-resources` is the authoritative maturity
  // clamp and it DROPS a resource that exceeds the token's ceiling or fails
  // `hasAccess`. Resolving here means the chip the viewer sees is built from
  // clamp-RELEASED data rather than from the picker's own projection, and a
  // dropped resource is refused visibly now instead of vanishing silently from
  // a message that has already been paid for. It also keeps the billed send
  // path synchronous in this respect: by then there is nothing left to resolve
  // and nothing left to fail.
  const handlePickMention = useCallback(
    async (resourceType: MentionPickerType) => {
      setMentionError(null);
      let picked: { versionId: number } | null = null;
      try {
        // 🔴 THE CAST IS THE SDK'S TYPE LAGGING THE HOST, AND IT IS DELIBERATE
        // RATHER THAN A TYPE HOLE. `@civitai/app-sdk` declares
        // `BlockResourcePickerType = 'Checkpoint' | 'LORA'`
        // (`dist/blocks/types.d.ts`), while the host's
        // `PAGE_RESOURCE_PICKER_TYPES` was widened to the LoRA family
        // (`+ LoCon, DoRA`) by civitai#4494 — merged to `main` as `bedcccc42b`.
        //
        // 🔴 ARGUED FROM THE PACKAGE ACTUALLY IN THE PATH, which an earlier
        // version of this comment was not. It reasoned that `@civitai/app-sdk`'s
        // `types.js` "ships NO runtime that sends `OPEN_RESOURCE_PICKER`" — true
        // of that module, and beside the point, because the call above does not
        // go through it. It goes through `@civitai/blocks-react`'s
        // `useResourcePicker`, which DOES send the message. Naming the wrong
        // package made the argument unfalsifiable by reading the code it names.
        //
        // The conclusion holds on the right package, verified against the
        // installed dist (`blocks-react/dist/hooks/useResourcePicker.js`): `open`
        // builds `{ type: 'OPEN_RESOURCE_PICKER', payload: { resourceType:
        // opts.resourceType, … } }` — the value is forwarded VERBATIM, with no
        // allowlist, no normalisation and no membership check — and
        // `sendTypedRequest` (`internal/transport.js`) is a pass-through that
        // validates nothing outbound. The union is imported from the SDK purely
        // to TYPE the parameter, so it bounds AUTHORING only; what decides
        // whether the modal opens is the HOST's `resolveResourcePickerRequest`,
        // which now accepts all four. Measured on that PR: a raw untyped
        // `{resourceType:'LoCon'}` opens the modal.
        //
        // Remove the cast when the SDK release widens the union; do NOT narrow
        // `MENTION_PICKER_TYPES` to satisfy it, which would ship a control for
        // two types while the host offers four.
        picked = await openResourcePicker({
          resourceType: resourceType as 'Checkpoint' | 'LORA',
        });
      } catch (e) {
        setMentionError(
          `Couldn't open the model picker — ${e instanceof Error && e.message ? e.message : 'the host did not respond'}.`,
        );
        return;
      }
      // Dismissed without picking. Not an error, and nothing to say about it.
      if (!picked) return;

      try {
        const [resolved] = await mentionsLib.resolveMentions([picked.versionId], {
          token: token_.raw,
        });
        if (!resolved) {
          // The endpoint returned nothing for this id — it is out of reach for
          // this viewer at this browsing ceiling. Say so; never synthesise a
          // card from the picker's own copy of the name, which is exactly the
          // unclamped value the clamp exists to withhold.
          setMentionError('That model is not available here, so it was not attached.');
          return;
        }
        // ⚠️ THIS UPDATER IS NOT PURE, AND THAT IS RECORDED RATHER THAN
        // DEFENDED. `setMentionError` is a side effect inside a `setState`
        // updater, which React may invoke more than once for one update —
        // StrictMode does so deliberately in development. It is idempotent
        // TODAY (the same message, set twice, is one banner), so it has no
        // observable consequence, and it is left alone because the pure
        // rewrites available are worse: hoisting the decision needs either a
        // mirror ref of `pendingMentions` (a second source of truth for the
        // thing this cell IS) or a closure variable written from inside the
        // updater, which is the same impurity with more moving parts.
        //
        // What would make it unsafe is any future side effect here that is NOT
        // idempotent — an analytics `track`, a counter, a request. Do not add
        // one. This note exists because "it is fine" was the only thing anyone
        // could have concluded from silence.
        setPendingMentions((prev) => {
          const next = mentionsLib.addPendingMention(prev, resolved);
          if (next === prev && !prev.some((p) => p.versionId === resolved.versionId)) {
            setMentionError(
              `You can attach up to ${mentionsLib.MAX_MENTIONS} models to one message.`,
            );
          }
          return next;
        });
        depsRef.current.track('mention_added', { modelType: resolved.modelType });
      } catch (e) {
        setMentionError(
          `Couldn't look that model up — ${e instanceof Error && e.message ? e.message : 'the catalog is unavailable'}.`,
        );
      }
    },
    [openResourcePicker, token_.raw],
  );

  const handleRemoveMention = useCallback((versionId: number) => {
    setPendingMentions((prev) => prev.filter((r) => r.versionId !== versionId));
  }, []);

  const selectSession = useCallback(async (id: string) => {
    // The `[activeSessionId]` effect above loads the messages; doing it here too
    // was a second concurrent read of the same key for no benefit. Setting the id
    // is the whole action.
    setActiveSessionId(id);
  }, []);

  /**
   * Send `content` as a new user turn.
   *
   * `groundedWith` overrides where the attachments come from. Absent (the
   * composer path) means "take the composer's pending chips and consume them";
   * PRESENT means "ground this turn with exactly these, and leave the composer
   * alone" — which is what `handleRegenerate` needs, because the attachments it
   * must replay live on the STORED message, while the composer may hold chips
   * for a message the viewer has not sent yet. An empty array is therefore a
   * meaningful value, distinct from `undefined`: "this turn had no grounding,
   * and that is not an invitation to borrow the composer's".
   *
   * 🔴 NEVER PASS THIS FUNCTION BY REFERENCE TO `.map`/`.forEach`. A callback
   * with an optional second parameter has `Array.prototype.map`'s shape, and
   * this repo has been bitten by that class before. Here the parameter's type
   * (`ResolvedResource[]`) makes `arr.map(handleSend)` a compile error rather
   * than a silent index-as-argument — an optional NUMBER would not — but the
   * rule is about the shape, so keep every call site explicit.
   */
  const handleSend = useCallback(async (content: string, groundedWith?: ResolvedResource[]) => {
    if (!activeSessionId || isStreaming) return;

    // The gate is checked before the dedup here for the same reason as in
    // `ChatArea` — a silent dedup return ahead of it re-hides the whole defect.
    // This is NOT redundant with ChatArea's copy: `handleRegenerate` and
    // `handleInsertResearch` call this directly and never touch the composer,
    // so for those two paths this is the ONLY gate, and it stands between a
    // missing spend scope and `submitChatCompletion`.
    if (sendGate) {
      raiseGate();
      return;
    }

    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === 'user' && lastMsg.content === content) return;

    // ── THE CAPABILITY GATE. ──────────────────────────────────────────────────
    //
    // 🔴 THIS USED TO BE TWO BARE `return`s, AND THAT WAS THE 0.1.0–0.1.3
    // "SEND IS DEAD" DEFECT. `ChatArea` cleared the composer BEFORE this
    // handler could refuse, so a bare `return` presented as: the text vanishes,
    // no bubble renders, no error appears, no Buzz moves — and the viewer was
    // given no way to fix it, because the app never asked for what it was
    // missing.
    //
    // The gate that actually fires in production is `!canGenerate`.
    // `ai:write:budgeted` is a CONSENT-GATED scope: the platform withholds it
    // from the block token until the viewer has granted it, and simply opening
    // the app does not grant it. Storage scopes are NOT consent-gated, which is
    // why sessions kept saving and the app looked healthy while chat was dead.
    //
    // Both requests are FIRE-AND-FORGET — the host never replies. It answers a
    // grant by re-minting the token, so the only observable is
    // `useBlockToken().scopes` gaining the entry.
    //
    // 🔴 NOTHING IS HELD HERE, DELIBERATELY. An earlier version of this fix
    // stashed the message and auto-sent it when the scope arrived. That
    // re-created the very defect this exists to remove, four ways: the stash
    // carried no session id, so a viewer who switched sessions while the
    // consent prompt was open got their question — and their Buzz — delivered
    // into the wrong conversation; deleting the session dropped the message
    // with no signal at all; a second attempt silently overwrote the first; and
    // on the sign-in branch the host reloads the page, which destroys the stash
    // regardless. `ChatArea` now keeps the viewer's text in the composer
    // instead. Nothing to lose, misroute, duplicate, or promise.
    //
    // The gate itself is checked at the top of this function, above the dedup.
    // 🔴 CAPTURED ONCE, HERE, AND CONSUMED. Read after the refusals above so a
    // gated or deduped send leaves the composer's attachments exactly where they
    // were — the same reasoning that keeps the viewer's TEXT in the box. From
    // this point the turn owns them, and clearing the state cannot take them
    // away from the request being built.
    //
    // 🔴 ONLY THE COMPOSER PATH CONSUMES THE COMPOSER. When `groundedWith` was
    // supplied the attachments came from somewhere else (a stored message being
    // regenerated), so clearing here would delete chips the viewer attached to a
    // message they have not sent — the same loss the refusals above are ordered
    // to avoid, arriving through a different door.
    const fromComposer = groundedWith === undefined;
    const attachedMentions = groundedWith ?? pendingMentions;
    if (fromComposer) setPendingMentions([]);

    const userMsg: Message = {
      id: generateMessageId(),
      role: 'user',
      content,
      timestamp: Date.now(),
      ...(attachedMentions.length > 0 ? { mentions: attachedMentions } : {}),
    };

    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);

    // ── ONE WRITE OF THE WHOLE ARRAY, AND THE SESSION LIST FROM STATE. ────────
    //
    // 🔴 THIS IS THE DEFECT THAT ATE EVERY USER MESSAGE. It used to be
    // `appendMessage(user)` (read → append → write) followed by
    // `renameSession` (read → map → write), then `appendMessage(assistant)`
    // (read → append → write) after the completion. On the deployed host the
    // second and third reads are served from a cache that the first write never
    // invalidated, so the assistant write was computed WITHOUT the user message
    // and replaced it. Read out of the live KV afterwards: two stored elements,
    // both `assistant`. The auto-title died the same way — written, then
    // overwritten by a later write off a stale snapshot.
    //
    // Both keys are now written from values this component already holds, in one
    // interaction, with no read in between. Title and timestamp go in the SAME
    // session write rather than two.
    const session = sessions.find((s) => s.id === activeSessionId);
    const now = Date.now();
    const nextSessions =
      session?.title === 'New Chat'
        ? sessionsLib.withTitle(sessions, activeSessionId, generateTitle(updatedMessages), now)
        : sessionsLib.touched(sessions, activeSessionId, now);
    setSessions(nextSessions);

    // 🔴 CLAIM THIS SESSION'S MESSAGE KEY BEFORE THE FIRST WRITE OF THE TURN.
    //
    // `turnSeqRef` below answers "is my turn still current" WITHIN this
    // component instance. It cannot answer it across an UNMOUNT: a remounted
    // instance gets a fresh `turnSeqRef` at 0, so a turn stranded by the unmount
    // still reads `turnSeqRef.current === mine` as true and believes it owns a
    // transcript the new instance now owns. No abort predicate sees it either —
    // a stranded turn was never aborted.
    //
    // Claiming here supersedes any stranded turn on this session, so the newest
    // writer wins without having to find the old one. The deferred writes at the
    // end of this function check the ticket back; this write does not need to,
    // because it is the claim. See `lib/write-ownership.ts` for why a
    // read-back-and-merge is not available instead. (clawgate #425.)
    const myWrite = claimMessageWrite(activeSessionId);

    await persist('save your message', async () => {
      await sessionsLib.saveMessages(depsRef.current.appStorage, activeSessionId, updatedMessages);
      await sessionsLib.saveSessions(depsRef.current.appStorage, nextSessions);
    });

    setIsStreaming(true);
    streamingRef.current = true;

    // 🔴 CAPTURE THE CONTROLLER; NEVER READ THE REF AGAIN IN THIS TURN.
    //
    // Every abort check in this function used to read `abortControllerRef
    // .current`, which is MUTABLE and belongs to whichever turn started most
    // recently — not to this one. `handleStopStream` clears `isStreaming`
    // synchronously, so a viewer can send again immediately, and that second
    // send replaces the ref with a FRESH, UN-ABORTED controller. Turn 1, still
    // in flight, then read turn 2's controller and every guard evaluated false:
    //
    //   write 2: [u:"FIRST",  a:""]                  ← Stop's own transcript
    //   write 3: [u:"FIRST",  a:"", u:"SECOND"]      ← turn 2's send
    //   write 4: [u:"FIRST",  a:"Error: Aborted"]    ← turn 1, guard bypassed
    //
    // Turn 2's user message is gone. When turn 1 settles LAST the loss is
    // permanent. This was the third consecutive fix to an abort exit that
    // created the next one, and the reason is that all four exits asked a
    // shared mutable cell "are we aborted?" instead of asking their own turn.
    //
    // 🔴 `aborted()` IS THE ONLY ABORT PREDICATE IN THIS FUNCTION, and that is
    // the structural point rather than a style choice: it closes over THIS
    // turn's controller, so a future guard written by reaching for what is in
    // scope gets the right one by construction. `abortControllerRef` is written
    // here and read only by `handleStopStream` — which SHOULD abort whatever
    // turn is current. `App.abort-scope.test.ts` pins that split.
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const aborted = () => controller.signal.aborted;

    // 🔴 CLAIM OWNERSHIP OF THE SHARED STREAMING STATE, SO THE `finally` CAN
    // CHECK IT. `setIsStreaming(false)` / `streamingRef.current = false` in this
    // function's `finally` are writes to state shared by every turn, and they
    // ran unconditionally — so a superseded turn settling late switched them off
    // underneath the turn that now owned them.
    //
    // Measured, an ordinary Stop → send → send with no second Stop: turn 1's
    // `finally` landed ~1 poll after turn 2 began, turn 2's Stop button
    // disappeared, `onChunk`'s `!streamingRef.current` guard then dropped turn
    // 2's chunks, and the reopened send gate accepted a THIRD send. Turn 2
    // settled last and persisted an array built before turn 3 existed:
    //
    //   ["user:FIRST","assistant:","user:SECOND","assistant:TWO reply"]
    //
    // `THIRD question` and its BILLED reply were gone permanently. The viewer
    // paid and had no record of it.
    //
    // 🔴 THE CAPTURED CONTROLLER CANNOT ANSWER THIS. Turn 1 was aborted here, so
    // `aborted()` happens to be true — but turns 2 and 3 involve no Stop at all
    // and the same clobber applies to any turn that is merely superseded. The
    // question is ownership, not abortion, which is why this is a separate cell
    // and why the previous round's "fixed structurally" claim was too broad: it
    // closed every abort READ and left this shared WRITE untouched.
    const mine = ++turnSeqRef.current;

    const assistantMsg: Message = {
      id: generateMessageId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    setMessages([...updatedMessages, assistantMsg]);

    // 🔴 THE TURN PUBLISHES ITS OWN SESSION AND ITS OWN TRANSCRIPT, so Stop can
    // ask the turn instead of asking the screen. (clawgate #427.)
    //
    // `activeSessionId` here is THIS TURN'S session — the value the closure was
    // built with, the same one `claimMessageWrite` and both deferred writes
    // already use. Reading it at Stop time instead is what produced the defect:
    // by then it means "whatever the viewer switched to".
    //
    // `streamedText` accumulates in `onChunk` below. It is a second copy of text
    // that also goes into React state, and that is deliberate: state belongs to
    // the session being VIEWED and is emptied by a switch, while this belongs to
    // the turn and survives one. What the viewer was charged for does not stop
    // being owed to them because they clicked away.
    let streamedText = '';
    const turn: StreamingTurn = {
      sessionId: activeSessionId,
      transcript: () => [...updatedMessages, { ...assistantMsg, content: streamedText }],
    };
    streamingTurnRef.current = turn;

    try {
      // ── TOOL CALLING: the model forms its own query; one submit per round ──
      //
      // 🔴 THIS IS THE LOOP THE OLD COMMENT SAID COULD NEVER RUN, AND NOW IT
      // CAN. A previous revision sent `tools` and looped, which was dead code
      // because the host's params schema was `.strict()` without them and a
      // text-posture step had no channel to return a call on. Both have since
      // changed host-side: `tools`/`tool_choice` are accepted, and structured
      // calls arrive on a `toolCalls` snapshot field released only when the
      // output scan releases.
      //
      // 🔴 EACH ROUND IS ITS OWN SUBMIT — the money design, not a detail. A
      // server-side loop would spend N times the token's PER-CALL budget inside
      // one call, and a mid-loop failure would have already paid for the
      // completed rounds with nothing to show for them. Per-round submits mean
      // every round is separately quoted against the live orchestrator price,
      // separately gated on `buzzBudget`, and separately reserved against the
      // per-user, per-app and dev-session caps.
      //
      // 🔴 THE ROUND CAP IS THE HOST'S. `MAX_TOOL_ROUNDS` is mirrored here only
      // so the app can stop cleanly and SAY SO; the host counts `role:'tool'`
      // messages in a `.superRefine` on both the estimate and the submit path,
      // so exceeding it is a BAD_REQUEST no matter what this code believes.
      //
      // Declarations are FETCHED, never authored here — a model must not be
      // shown a contract the route does not enforce. Failing to fetch them
      // degrades to a tool-less conversation rather than taking the turn down.
      let declarations: toolsLib.ToolDeclaration[] = [];
      try {
        declarations = await toolsLib.fetchToolDeclarations({
          // 🔴 STOP MUST REACH THIS REQUEST TOO. Without the signal this GET
          // was unabortable: its only deadline was the 15 s request timeout,
          // and a 429 inside it slept a further clamped 15 s with no caller
          // signal at all — so Stop was a no-op for up to ~45 s.
          token: token_.raw,
          signal: controller.signal,
        });
      } catch {
        declarations = [];
      }

      // 🔴 THE SIGNAL ALONE DOES NOT FIX IT — THE CATCH ABOVE SWALLOWS THE
      // ABORT. `fetchToolDeclarations` rejecting with an AbortError is
      // indistinguishable here from a 500 or a parse failure, and BOTH degrade
      // to `[]` so the turn can continue tool-lessly. That degradation is right
      // for a failure and wrong for a Stop: measured, a Stop pressed while this
      // GET was parked produced 0 submits at the time of the Stop and then ONE
      // BILLED SUBMIT when the request finally landed. The bridge submits
      // before its first signal check, so the charge is real — and the catch
      // guard below then correctly suppresses the write, leaving the viewer
      // charged for an abandoned turn with no record of it.
      //
      // This exit is why "pass the signal" was not the whole fix: the signal
      // ends the REQUEST, this ends the TURN.
      if (aborted()) return;

      // 🔴 THE PROMPT MUST MATCH THE CAPABILITY THIS REQUEST ACTUALLY CARRIES.
      // `declarations` is the same value the `tools` key below is derived from,
      // so the claim and the wire cannot disagree — including on the degraded
      // path, where the fetch failed and no tools are sent at all.
      const toolsAvailable = declarations.length > 0;
      let apiMessages = withSystemPrompt(
        updatedMessages.map((m) => ({ role: m.role, content: m.content })),
        toolsAvailable ? settings.systemPrompt : settings.systemPrompt + NO_TOOLS_NOTICE,
      );

      // ── THE PRE-FILLED GROUNDING (clawgate #434). ────────────────────────────
      //
      // 🔴 APPENDED AFTER THE MAPPED HISTORY, WHICH PUTS IT DIRECTLY AFTER THIS
      // TURN'S USER MESSAGE — `userMsg` is the last element of
      // `updatedMessages`, and `withSystemPrompt` only hoists the system turn.
      // The order is the contract: the host builds its `declaredCallIds` set in
      // ITERATION ORDER, so the assistant `tool_calls` turn must PHYSICALLY
      // precede the result it correlates to. `buildMentionExchange` returns both
      // in that order, together, so the pair cannot be split or reversed here.
      //
      // 🔴 ONLY THIS TURN'S MENTIONS, NEVER THE CONVERSATION'S. The map above
      // takes `role` and `content` only, so an older turn's attachment does not
      // come back as a second tool message. That is deliberate: the host's cap
      // is PER PAYLOAD and counts `role:'tool'` messages with no provenance
      // test, so replaying history's mentions would spend a slot per mentioned
      // turn — silencing tool calling on the third and BAD_REQUESTing the
      // fourth. One turn, one slot, two real rounds left.
      const mentionExchange = mentionsLib.buildMentionExchange(attachedMentions);
      if (mentionExchange.length > 0) {
        apiMessages = [...apiMessages, ...mentionExchange];
        depsRef.current.track('mention_grounding_sent', { count: attachedMentions.length });
      }

      const onChunk = (chunk: string) => {
        if (!streamingRef.current) return;
        // 🔴 ACCUMULATED BEFORE THE RENDER UPDATE, NOT DERIVED FROM IT. The
        // update below is CONDITIONAL — it drops the chunk unless the message
        // being looked at is still this turn's — so a transcript derived from
        // rendered state loses exactly the prose a viewer who switched sessions
        // was charged for. Behind the same `streamingRef` guard, so a stopped
        // turn stops accumulating at the same instant it stops rendering.
        streamedText += chunk;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last.id === assistantMsg.id) {
            return [...prev.slice(0, -1), { ...last, content: last.content + chunk }];
          }
          return prev;
        });
      };

      const submit = () =>
        orchestrator.submitChatCompletion(
          {
            model: settings.model,
            messages: apiMessages,
            temperature: settings.temperature,
            max_tokens: settings.maxTokens,
            ...(toolsAvailable ? { tools: declarations, toolChoice: 'auto' as const } : {}),
          },
          onChunk,
          controller.signal,
        );

      let response = await submit();
      let rounds = 0;
      // 🔴 COUNTS `role:'tool'` MESSAGES, NOT ROUNDS — the quantity the host's
      // `.superRefine` actually counts. One round answering N parallel calls
      // contributes N. Counting rounds here let a single 5-call round exceed a
      // mirrored cap of 3 on the first iteration.
      //
      // 🔴 SEEDED FROM THE PAYLOAD, NOT FROM ZERO, AND THAT IS WHAT MAKES THE
      // PRE-FILLED MENTION SAFE. A mention exchange has ALREADY put one
      // `role:'tool'` message into `apiMessages`, and the host's cap is on the
      // payload, not on this loop — starting at 0 would let three real rounds
      // stack on top of it for FOUR tool messages and a `BAD_REQUEST` on the
      // last submit, after the viewer had paid for the rounds that got there.
      //
      // 🔴 COUNTED ON `toStepMessages(apiMessages)`, NOT ON `apiMessages`, AND
      // THAT DIFFERENCE IS THE WHOLE CORRECTNESS OF THE SEED. The host counts
      // the array it RECEIVES; `apiMessages` is the array before the transform
      // that decides what it receives. `toStepMessages` drops a `role:'tool'`
      // message that carries no `tool_call_id` — precisely the shape the mapped
      // history above produces, since `.map(m => ({ role, content }))` discards
      // the id — and it also drops empty content and trims to `MAX_MESSAGES`.
      // Counting before the transform therefore counts messages the host never
      // sees, and every one of them steals a real round from the viewer with
      // "That needed more lookups at once than I am allowed to make".
      //
      // The previous comment here claimed to seed "with the same predicate the
      // host uses". The PREDICATE was the same; the ARRAY was not, and it is the
      // array that decides the number. Calling the same transform the wire is
      // built from is what actually makes the two agree, rather than each
      // injector remembering to add itself.
      let toolMessages = toStepMessages(apiMessages).filter((m) => m.role === 'tool').length;
      let hitRoundCap = false;

      for (;;) {
        // Stop must end the loop, not just the in-flight request. Without this
        // a Stop pressed while a tool POST is in flight still fell through to
        // another `submit()` — a second BILLED estimate+submit after the viewer
        // asked to stop.
        if (aborted()) break;

        const calls = response.toolCalls ?? [];
        if (calls.length === 0) break;

        if (toolMessages + calls.length > toolsLib.MAX_TOOL_RESULT_MESSAGES) {
          // A terminal state with a user-visible explanation, not a silent stop
          // and not an unhandled rejection. The viewer has been charged for
          // every round that ran and is owed an account of why it stopped.
          // Checked BEFORE executing the calls: running them would spend on
          // results that could never be submitted.
          hitRoundCap = true;
          break;
        }
        rounds += 1;
        toolMessages += calls.length;

        // Show the model's OWN query in the Research panel. This is the whole
        // argument for the change: the query is authored by the model from the
        // user's sentence, not stripped out of it by a stopword list.
        // 🔴 CLEAR FIRST, UNCONDITIONALLY. Clearing inside `if (firstQuery)`
        // left a previous manual search's results — and its label — on screen
        // whenever the model called a tool that takes no `query` (an id lookup,
        // say). Declarations are fetched, not authored here, so which tools
        // have a `query` argument is not ours to assume. Any tool round makes
        // the standing results stale; the label is what may or may not be
        // replaceable.
        //
        // `calls[0]` is deliberate and not an oversight: the panel shows ONE
        // query, so a round of parallel calls has no single label to display.
        // Taking the first is honest about that; joining them would invent a
        // query the model never wrote.
        // Show the model's OWN query while the lookup runs. `calls[0]` is
        // deliberate and not an oversight: one line shows ONE query, so a round
        // of parallel calls has no single label — taking the first is honest,
        // joining them would invent a query the model never wrote.
        setLookupQuery(toolsLib.readQueryArgument(calls[0]));

        let results: string[];
        try {
          results = await Promise.all(
            calls.map((c) =>
              toolsLib.callTool(c, {
                token: token_.raw,
                signal: controller.signal,
              }),
            ),
          );
        } finally {
          setLookupQuery(null);
        }

        // A Stop landing while the tool POSTs were in flight must not be spent
        // on another submit.
        if (aborted()) break;

        apiMessages = [
          ...apiMessages,
          // The ask. Carries the model's own interim prose when it wrote any —
          // discarding it would replay a history the viewer saw stream and then
          // saw vanish. `toStepMessages` keeps this message for its `tool_calls`
          // even when the content is empty.
          {
            role: 'assistant',
            content: response.choices[0]?.message?.content ?? '',
            tool_calls: calls,
          },
          // The answers, each correlated to the id it answers.
          ...calls.map((c, k) => ({
            role: 'tool',
            content: results[k],
            tool_call_id: c.id,
          })),
        ];

        response = await submit();
      }

      // 🔴 A STOP THAT LEFT THE LOOP MUST NOT REACH THE PERSIST BELOW. The two
      // `break`s above exit on `signal.aborted` and then FELL THROUGH to the
      // `persist('save the reply', …)` at the end of this block — which
      // overwrote the transcript `handleStopStream` had just written, silently
      // losing every earlier round's prose from storage.
      //
      // 🔴 THE CATCH'S GUARD DOES NOT COVER THIS. It only sees the THROW route,
      // and `callTool` never throws on abort — it converts the AbortError into
      // a tool-error string (`tools.ts`), so an abort during a tool POST leaves
      // the loop normally and never touches the catch. The guard added there
      // for the ordinary abort path and this one are two different exits from
      // the same function; fixing one did not fix the other.
      //
      // Placed after the loop rather than at each `break` so a future `break`
      // inherits it — the defect was one unguarded exit, and adding a third
      // exit should not be able to reintroduce it.
      if (aborted()) return;

      // On the cap, keep whatever prose the model DID write alongside its last
      // batch of calls and append the explanation — discarding it threw away
      // content the viewer had already been charged for, and often the most
      // useful part of the turn.
      // 🔴 `rounds` IS INCREMENTED AFTER THE CAP CHECK, so it is 0 in exactly
      // the case this notice exists for: a first round whose parallel calls
      // already exceed the cap. "I looked things up 0 times" is both absurd and
      // wrong about what happened — nothing was looked up because the request
      // was refused before spending on it. The guarding test matched only
      // /could not finish that/i and read straight past it.
      const capNotice =
        rounds === 0
          ? 'That needed more lookups at once than I am allowed to make. Try asking about one thing at a time.'
          : `I looked things up ${rounds} time${rounds === 1 ? '' : 's'} and still could not finish that. Try asking something narrower.`;
      const partial = response.choices[0]?.message?.content?.trim();
      const replyText = hitRoundCap
        ? partial
          ? `${partial}\n\n${capNotice}`
          : capNotice
        : response.choices[0].message.content;

      if (replyText) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last.id === assistantMsg.id) {
            return [...prev.slice(0, -1), { ...last, content: replyText }];
          }
          return prev;
        });
      }

      // Persist the WHOLE conversation, built from the array this send already
      // owns — never from a read-back. `updatedMessages` already contains the
      // user turn, so both halves of the exchange land in one write and neither
      // can overwrite the other.
      const finalMsg: Message = {
        id: assistantMsg.id,
        role: 'assistant',
        content: replyText ?? '',
        timestamp: assistantMsg.timestamp,
      };
      // 🔴 ONLY IF THIS TURN STILL OWNS THE TRANSCRIPT. `updatedMessages` was
      // built when this turn started; writing it now would drop anything a newer
      // writer has added since. Within one instance that cannot happen, but a
      // turn stranded by an unmount settles against a REMOUNTED instance that
      // has since taken the key — and that write deletes the viewer's newer
      // message permanently. Losing this reply is the lesser harm and the trade
      // is argued in `lib/write-ownership.ts`.
      if (ownsMessageWrite(activeSessionId, myWrite)) {
        await persist('save the reply', () =>
          sessionsLib.saveMessages(depsRef.current.appStorage, activeSessionId, [
            ...updatedMessages,
            finalMsg,
          ]),
        );
      } else {
        // 🔴 THE ACCEPTED LOSS, MADE OBSERVABLE. Discarding this reply is the
        // deliberate trade — the alternative is deleting the viewer's newer
        // message — but the viewer WAS charged for it, and every other
        // cost-bearing outcome in this file emits an event
        // (`completion_withheld`, `storage_error`). Without this one the
        // frequency of the trade is unmeasurable in production, so no evidence
        // could ever accumulate to justify revisiting it once the host can
        // serve a block its own write (civitai #4456) and a merge becomes
        // possible. A silent accepted cost is how an accepted cost stops being
        // reviewed.
        depsRef.current.track('reply_discarded_superseded');
      }
    } catch (e) {
      // 🔴 A USER STOP IS NOT AN ERROR, AND MUST NOT OVERWRITE ITS OWN WRITE.
      // `handleStopStream` aborts and persists what was streamed; aborting then
      // rejects the in-flight submit and lands HERE, where the write below used
      // to replace that content with `Error: Aborted` — so Stop's whole purpose
      // was undone a moment after it ran, on the ordinary abort path.
      //
      // 🔴 THE ORIGINAL REGRESSION TEST COULD NOT SEE THIS. It used a poll that
      // never settles, which structurally removes this catch — pinning the one
      // shape where the fix is decisive rather than the ordinary one. Both paths
      // are covered now; see `stop-stream.e2e.test.tsx`.
      if (aborted()) {
        return;
      }
      // 🔴 A WITHHOLD IS NOT AN ERROR. The host scanned the generated reply and
      // refused to release it; the Buzz was spent and the capability worked as
      // designed. Rendering the host's own user-facing reason — rather than
      // "Error: …" — is the difference between reporting a policy outcome and
      // reporting a bug. The reason is deliberately generic and never names the
      // labels that triggered.
      const withheld = e instanceof TextOutputWithheldError;
      const body = withheld
        ? (e as TextOutputWithheldError).reason
        : `Error: ${e instanceof Error ? e.message : 'Failed to get response'}`;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last.id === assistantMsg.id) {
          return [...prev.slice(0, -1), { ...last, content: body, withheld }];
        }
        return prev;
      });
      // 🔴 PERSIST THE WITHHOLD TOO. A withheld reply means the capability ran
      // and the Buzz was SPENT; leaving it unsaved made the whole exchange
      // disappear on reload, so the viewer saw a charge with nothing to show for
      // it and no record of why. The user turn is saved either way — that is the
      // point of writing the full array rather than appending.
      // 🔴 SAME OWNERSHIP GATE AS THE SUCCESS PATH ABOVE, for the same reason: a
      // turn stranded by an unmount reaches this exit too — an error or a
      // withhold arriving after a remount would otherwise write a transcript
      // built before the new instance's messages existed.
      if (ownsMessageWrite(activeSessionId, myWrite)) {
        await persist('save the reply', () =>
          sessionsLib.saveMessages(depsRef.current.appStorage, activeSessionId, [
            ...updatedMessages,
            { ...assistantMsg, content: body, ...(withheld ? { withheld: true } : {}) },
          ]),
        );
      } else {
        // Same accepted loss as the success path above, same reason for
        // counting it. A withhold reaching here was still CHARGED.
        depsRef.current.track('reply_discarded_superseded');
      }
      if (withheld) depsRef.current.track('completion_withheld');
    } finally {
      // 🔴 ONLY THE CURRENT TURN MAY CLEAR THE SHARED STREAMING STATE. See
      // `mine` above for the measured three-turn message loss this prevents. A
      // superseded turn settling late must leave `isStreaming` alone: the turn
      // that owns it now is still running, and clearing it removes that turn's
      // Stop button, makes `onChunk` drop its chunks, and reopens the send gate.
      //
      // 🔴 THE `catch` AND `try` EXITS ABOVE ARE ALREADY TURN-SAFE FOR A
      // DIFFERENT REASON and this is not a substitute for them: they guard on
      // `aborted()`, which asks whether THIS turn was stopped. This asks whether
      // this turn is still current. A turn can be superseded without ever being
      // aborted — that is precisely turns 2 and 3 in the case above.
      if (turnSeqRef.current === mine) {
        setIsStreaming(false);
        streamingRef.current = false;
      }
      // 🔴 SAME OWNERSHIP QUESTION, ASKED BY IDENTITY. A superseded turn must
      // not clear the cell out from under the turn that owns it now — that
      // would leave Stop with nothing to persist for a live, billed turn.
      if (streamingTurnRef.current === turn) streamingTurnRef.current = null;
    }
  }, [
    activeSessionId,
    isStreaming,
    messages,
    settings,
    sessions,
    token_.raw,
    sendGate,
    raiseGate,
    persist,
    // 🔴 OMITTING THIS MADE THE WHOLE MENTION FEATURE INERT, AND EVERY TEST
    // STILL PASSED. `handleSend` reads `pendingMentions` to build the synthetic
    // tool exchange; without it here the callback closes over the array as it
    // was when the callback was last built — i.e. EMPTY — so the attachment the
    // viewer just made never reaches the wire and never reaches storage.
    //
    // 🔴 WHY THE SUITE COULD NOT SEE IT, because that is the reusable half.
    // Every mock in this repo returned a FRESH object from `useBlockContext`
    // (`viewer: { id: 1 }`) and a fresh `vi.fn()` from `useRequestConsent` on
    // every render. `raiseGate` depends on both identities, and `handleSend`
    // depends on `raiseGate` — so the callback was rebuilt on every render and
    // the missing dep was silently repaired by the fixture. The real SDK's
    // callbacks are stable, so production would have had the stale array.
    // `mention-grounding.e2e.test.tsx` now hoists those to module constants and
    // goes RED (7 cases) with this line removed. Measured, not reasoned.
    pendingMentions,
  ]);

  const handleStopStream = useCallback(() => {
    streamingRef.current = false;
    setIsStreaming(false);
    abortControllerRef.current?.abort();
    orchestrator.cancel?.();

    // 🔴 PERSIST WHAT WAS STREAMED, HERE, RATHER THAN LEAVING IT TO THE
    // COMPLETION PROMISE. Aborting rejects the in-flight submit, and the catch
    // below DOES eventually write — but it is asynchronous, and a viewer who
    // stops a reply and immediately reloads beats it. Measured on the live
    // store: after a two-exchange verification the array was
    // `[user, assistant, user]` — three elements. The second reply was not
    // written incompletely, it was never written AT ALL.
    //
    // 🔴 THE BUZZ WAS ALREADY SPENT. The submit was charged the moment it was
    // made; stopping the stream stops the RENDERING, not the billing. Losing
    // the partial reply means the viewer paid and has nothing, and no record of
    // why — the same reasoning the withhold path already applies one branch
    // over, which was applied to withholds and missed here.
    // 🔴 THE TURN, NOT THE SCREEN. (clawgate #427 — this used to read
    // `activeSessionId` and `messagesRef.current`, and BOTH describe the
    // session the viewer is looking at.) `isStreaming` is instance-wide and
    // nothing disables the session switcher mid-stream, so send in S1, click
    // "+ New", press Stop, and the write went to S2: S1 — the conversation the
    // viewer was charged for — got nothing, and a brand-new empty chat silently
    // acquired another conversation's question.
    //
    // Measured at `462b7a2`, the outcome was the first harm alone: the switch
    // resets `messagesRef.current` to `[]`, so the length guard refused and
    // Stop wrote NOTHING AT ALL. Pinned in `App.stop-session-key.e2e.test.tsx`,
    // which asserts both sides — S1 written AND S2 untouched — because a fix
    // that captured only the key would write the emptied array over S1's real
    // transcript and pass a one-sided test.
    //
    // 🔴 STOP DELIBERATELY DOES NOT CLAIM a write ticket. A claim here looks
    // like prudent defence-in-depth; it cannot change an outcome, and it was
    // removed when a mutation deleting it survived all 278 tests. The reason is
    // what this write CONTAINS, not who claimed last: the turn's own transcript
    // is the user message it was sent with plus the prose it has itself
    // streamed, which is a subset of anything a live claimant on that session
    // would write. There is no state in which bumping the ticket first changes
    // what ends up stored.
    const turn = streamingTurnRef.current;
    if (!turn) return;
    const current = turn.transcript();
    if (current.length > 0) {
      void persist('save the stopped reply', () =>
        sessionsLib.saveMessages(depsRef.current.appStorage, turn.sessionId, current),
      );
    }
    // 🔴 `activeSessionId` IS NO LONGER A DEPENDENCY, and that is the structural
    // half of this fix rather than tidying: Stop cannot key its write on the
    // viewed session because it can no longer see it.
  }, [orchestrator, persist]);

  const handleRegenerate = useCallback(async (messageId: string) => {
    // 🔴 GATE BEFORE THE DESTRUCTIVE SLICE. The slice below removes the
    // assistant reply from view, and `handleSend` may then refuse — which used
    // to leave the viewer with their reply deleted and nothing sent. Asking
    // first means a refused Regenerate changes nothing at all.
    if (sendGate) {
      raiseGate();
      return;
    }
    // 🔴 AND EVERY OTHER REASON `handleSend` CAN REFUSE, for the same reason.
    // Gating only on `sendGate` closed half the hole: the slice below also ran
    // ahead of `handleSend`'s own `!activeSessionId || isStreaming` refusal.
    // Clicking Regenerate on a reply that is still streaming therefore removed
    // that reply from view, re-sent nothing, and let the in-flight completion
    // finish and persist — so the viewer paid Buzz for an answer that vanished
    // from the screen and came back only on reload. Every refusal must be
    // asked BEFORE anything is destroyed.
    if (!activeSessionId || isStreaming) return;

    // Find the last user message before this assistant message
    const msgIdx = messages.findIndex((m) => m.id === messageId);
    if (msgIdx < 0) return;
    const lastUserMsg = [...messages.slice(0, msgIdx)].reverse().find((m) => m.role === 'user');
    if (lastUserMsg) {
      // Remove the assistant message and resend
      setMessages((prev) => prev.slice(0, msgIdx));
      // 🔴 RE-ATTACH WHAT THAT MESSAGE WAS GROUNDED IN. Re-sending the CONTENT
      // alone drops the `mentions` stored on the turn, so the model either
      // answers ungrounded or spends a REAL charged round looking up what it had
      // already been handed — the exact cost this feature exists to remove, and
      // it makes the manifest's "answers in one round without spending a lookup"
      // false on this path.
      //
      // 🔴 `?? []` RATHER THAN OMITTING THE ARGUMENT, and the difference is
      // load-bearing: omitting it means "take the composer's chips", which would
      // ground a REGENERATED turn with attachments belonging to a message the
      // viewer is still writing — and consume them. An ungrounded message
      // regenerates ungrounded.
      await handleSend(lastUserMsg.content, lastUserMsg.mentions ?? []);
    }
  }, [messages, handleSend, sendGate, raiseGate, activeSessionId, isStreaming]);

  // 🔴 `handleResearchSearch` AND `handleInsertResearch` ARE DELETED, NOT
  // DISABLED (clawgate #434). The first ran `searchModels` from inside the
  // iframe and rendered the catalog into it; the second synthesised
  // `Tell me more about <name>` and SENT it — a spend path that never touched
  // the composer, which is why it needed its own copy of the capability gate.
  // Both are gone: the viewer picks in host chrome and the pick grounds the
  // question they actually wrote, so there is no second send path and no
  // in-iframe catalog render left to keep in step.

  const handleSettingsChange = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      depsRef.current.appStorage.set('sensei:settings', next).catch(() => {});
      return next;
    });
  }, []);

  // ---- Render ----
  if (!ready) {
    return (
      <div ref={rootRef} data-theme={theme} style={pageStyle(c)}>
        <Stack align="center" gap={12} style={{ margin: 'auto' }} data-testid="app-loading">
          <Loader />
          <span style={mutedText}>Loading Sensei…</span>
        </Stack>
      </div>
    );
  }

  if (loading) {
    return (
      <div ref={rootRef} data-theme={theme} style={pageStyle(c)}>
        <Stack align="center" gap={12} style={{ margin: 'auto' }} data-testid="app-loading">
          <Loader />
          <span style={mutedText}>Loading sessions…</span>
        </Stack>
      </div>
    );
  }

  return (
    <div ref={rootRef} data-theme={theme} style={pageStyle(c)}>
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100dvh' }}>
        {/* Header */}
        <Group
          justify="space-between"
          align="center"
          gap={12}
          data-testid="app-header"
          style={{
            padding: '10px 16px',
            borderBottom: `1px solid ${token.border}`,
            background: token.surface,
            flexShrink: 0,
          }}
        >
          <Group gap={10} align="center" wrap={false}>
            <span
              style={{
                display: 'grid',
                placeItems: 'center',
                width: 32,
                height: 32,
                borderRadius: radius.md,
                color: token.primary,
                background: token.primaryLight,
                border: `1px solid ${c.border}`,
              }}
            >
              ✨
            </span>
            <Stack gap={0}>
              <strong style={{ fontSize: 16, lineHeight: 1.2 }}>Civitai Sensei</strong>
              <span style={{ ...mutedText, fontSize: 11 }}>AI Research Assistant</span>
            </Stack>
          </Group>
          {/*
            🔴 EVERY HEADER CONTROL IS A SIBLING IN THIS FLEX ROW, AND THAT IS
            STILL LOAD-BEARING WITH ONLY ONE LEFT. The Research toggle used to be
            rendered by `ResearchPanel` as `position: absolute; right: 8; top: 8`,
            which put it on top of ⚙️ — `elementFromPoint` at the centre of
            `settings-button` returned `open-research`, so Settings could not be
            opened at all. That toggle is gone with the panel (clawgate #434),
            which removes the instance but NOT the class: anything added here
            must be laid out by flex, in normal flow. Do not absolutely position
            a header control.
          */}
          <Group gap={8}>
            <Button
              variant="subtle"
              size="sm"
              onClick={() => setSettingsOpen(true)}
              data-testid="settings-button"
            >
              ⚙️
            </Button>
          </Group>
        </Group>

        {/* Storage failure — never silent. See `persist`. */}
        {storageError && (
          <div
            data-testid="storage-error"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: '10px 16px',
              borderBottom: `1px solid ${token.border}`,
              background: token.primaryLight,
              fontSize: 13,
              flexShrink: 0,
            }}
          >
            <span>{storageError}</span>
            <Button
              size="sm"
              variant="light"
              data-testid="storage-error-dismiss"
              onClick={() => setStorageError(null)}
            >
              Dismiss
            </Button>
          </div>
        )}

        {/* Main content */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Session sidebar */}
          {/*
            🔴 THE SWITCHER STAYS ENABLED MID-STREAM — A DECISION, NOT AN
            OVERSIGHT. (clawgate #427, criterion 4.) Do not add an
            `isStreaming`/`disabled` prop here without reading this first.

            The obvious reaction to #427 is to forbid the interaction that
            exposed it: grey the sidebar out while a turn is in flight. It was
            rejected for three reasons, in order of weight.

            1. IT DOES NOT CLOSE THE CLASS. The hazard is a WRITE keyed on the
               VIEWED session, and "+ New"/select is only one of the paths that
               move `activeSessionId`. `deleteSession` moves it too (to
               `next[0]`), and it is not a switcher click — a disabled sidebar
               would leave that route open, with the identical harm and no test
               able to tell the difference. Fixing it at the write closes every
               route at once; disabling the control closes one and makes the
               rest look impossible.

            2. IT COSTS THE VIEWER SOMETHING REAL. `isStreaming` is
               instance-wide, so ONE turn would lock the viewer out of EVERY
               other conversation. A turn parked on a slow or wedged workflow
               polls to its deadline, and the only escape would be Stop — i.e.
               abandoning a reply already paid for in order to read something
               else. That is a worse trade than the one it buys.

            3. IT IS A UI-SHAPED FIX FOR A STATE-OWNERSHIP BUG. The turn not
               knowing which session it belongs to is the defect; the switcher
               merely made it observable. With the turn carrying its own session
               and its own transcript, switching mid-stream is harmless — Stop
               files the transcript under the session that earned it, and
               reopening that session loads it from storage.

            The switch-mid-stream path is exercised by
            `App.stop-session-key.e2e.test.tsx`, which asserts a second session
            can still be created while a turn is in flight and fails with "the
            switcher may now be disabled" if that ever stops being true. So this
            decision cannot be reversed silently.

            KNOWN, SEPARATE, NOT FIXED HERE: if chunks are already REPLAYING
            when the switch happens, `onChunk`'s updater reads
            `prev[prev.length - 1].id` against the new session's empty array and
            throws `TypeError: Cannot read properties of undefined (reading
            'id')`. Measured at `462b7a2` — pre-existing, unchanged by this
            commit, and a different defect (a render crash, not a misfiled
            write). It is not folded in here for the same reason #427 was not
            folded into #425: it would mix a second red/green matrix into this
            one.
          */}
          <SessionList
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelect={selectSession}
            onCreate={createSession}
            onDelete={deleteSession}
            onRename={renameSession}
          />

          {/* Chat area */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {activeSessionId ? (
              <>
                {gateRaised && sendGate && (
                  // Rendered from the DERIVED gate, so it disappears by itself
                  // the moment the host re-mints with the scope — there is no
                  // "clear the banner" path that can be missed. On the copy
                  // itself, see the note beside the string below.
                  <div
                    data-testid={sendGate === 'consent' ? 'consent-notice' : 'signin-notice'}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: '10px 16px',
                      borderBottom: `1px solid ${token.border}`,
                      background: token.primaryLight,
                      fontSize: 13,
                      flexShrink: 0,
                    }}
                  >
                    <span>
                      {/*
                        🔴 SAY ONLY WHAT IS TRUE ON EVERY PATH. This used to
                        promise "your message is still in the box" — true when
                        the send came from the composer, FALSE when it came
                        from Research → Insert or from Regenerate, neither of
                        which puts anything in the box. A banner that lies is
                        the same class of defect this whole change removes, so
                        the copy now claims nothing about where the text went.
                      */}
                      {sendGate === 'consent'
                        ? 'Sensei needs your permission to spend Buzz on a reply. Grant it, then try again.'
                        : 'Sign in to chat with Sensei, then try again.'}
                    </span>
                    <Button
                      size="sm"
                      variant="light"
                      data-testid="gate-retry-button"
                      onClick={raiseGate}
                    >
                      {sendGate === 'consent' ? 'Grant permission' : 'Sign in'}
                    </Button>
                  </div>
                )}
                {mentionError && (
                  <div
                    data-testid="mention-error"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: '10px 16px',
                      borderBottom: `1px solid ${token.border}`,
                      background: token.primaryLight,
                      fontSize: 13,
                      flexShrink: 0,
                    }}
                  >
                    <span>{mentionError}</span>
                    <Button
                      size="sm"
                      variant="light"
                      data-testid="mention-error-dismiss"
                      onClick={() => setMentionError(null)}
                    >
                      Dismiss
                    </Button>
                  </div>
                )}
                <ChatArea
                  messages={messages}
                  isStreaming={isStreaming}
                  onSend={handleSend}
                  sendGate={sendGate}
                  onGatedSend={raiseGate}
                  onStopStream={handleStopStream}
                  onRegenerate={handleRegenerate}
                  pendingMentions={pendingMentions}
                  onPickMention={handlePickMention}
                  onRemoveMention={handleRemoveMention}
                  lookupQuery={lookupQuery}
                />
              </>
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flex: 1,
                  gap: 16,
                  ...mutedText,
                }}
              >
                <span style={{ fontSize: 48 }}>✨</span>
                <span style={{ fontSize: 16 }}>Start a new conversation with Sensei</span>
                <Button onClick={createSession} data-testid="start-chat-button">
                  New Chat
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Settings bar */}
        <SettingsBar settings={settings} onChange={handleSettingsChange} />

        {/* Settings modal */}
        <SettingsModal
          opened={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          settings={settings}
          onSave={handleSettingsChange}
        />
      </div>
    </div>
  );
}
