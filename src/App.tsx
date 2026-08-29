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
} from '@civitai/blocks-react';
import type { UseAppStorage } from '@civitai/blocks-react';
import { Button, Group, Loader, Stack } from '@civitai/blocks-react/ui';

import { palette, pageStyle, token, radius, mutedText } from './theme.js';
import type { AppSettings, Message, Session } from './types.js';
import { DEFAULT_SETTINGS, migrateSettings, NO_TOOLS_NOTICE } from './types.js';
import { AI_WRITE_BUDGETED, BUZZ_READ_SELF, hasGenerateScope } from './scopes.js';
import { createOrchestrator } from './lib/orchestrator.js';
import { TextOutputWithheldError } from './lib/orchestrator-bridge.js';
import * as sessionsLib from './lib/sessions.js';
import * as researchLib from './lib/research.js';
import * as toolsLib from './lib/tools.js';
import { generateMessageId, withSystemPrompt } from './lib/chat.js';
import { generateTitle } from './lib/sessions.js';

import { ChatArea } from './components/ChatArea.js';
import { SessionList } from './components/SessionList.js';
import { ResearchPanel, ResearchToggle } from './components/ResearchPanel.js';
import { SettingsBar } from './components/SettingsBar.js';
import { SettingsModal } from './components/SettingsModal.js';

export interface AppDeps {
  appStorage: UseAppStorage;
  track: (eventName: string, properties?: Record<string, unknown>) => void;
}

export interface AppProps {
  deps?: Partial<AppDeps>;
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
  const [researchOpen, setResearchOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<researchLib.ModelSearchResult | null>(null);
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  // 🔴 A REJECTED STORAGE CALL MUST NOT BE INDISTINGUISHABLE FROM SUCCESS. Every
  // storage call in this app used to be either unguarded (`createSession`, whose
  // rejection propagated as an unhandled promise and showed the viewer NOTHING —
  // "+ New" was observably dead in production) or swallowed by a bare `catch {}`.
  // Both present as "the click did nothing", which is the same signature as the
  // 0.1.4 consent bug and takes a session of measurement to tell apart. Now every
  // one of them goes through `persist` and lands here.
  const [storageError, setStorageError] = useState<string | null>(null);
  // Whether the viewer has actually run into the capability gate. The gate
  // ITSELF is derived (below), never stored — storing it is what let an earlier
  // draft show a stale "sign in" banner to a viewer who had since signed in but
  // still lacked the spend scope, with nothing to escalate it.
  const [gateRaised, setGateRaised] = useState(false);

  const streamingRef = useRef(false);
  /**
   * The live message array, for the one caller that must read it OUTSIDE React's
   * render flow: {@link handleStopStream}. A functional `setMessages` updater
   * could read the same value, but side-effecting inside an updater double-fires
   * under StrictMode and this effect WRITES TO STORAGE.
   */
  const messagesRef = useRef<Message[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
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

  // Mirror the message array into a ref so `handleStopStream` can persist the
  // partial reply without depending on React's render cycle. Cheap, and the
  // alternative (reading state inside a setState updater) writes to storage
  // twice under StrictMode.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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
    setSearchResults(null);
    setSearchQuery(null);
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

  const selectSession = useCallback(async (id: string) => {
    // The `[activeSessionId]` effect above loads the messages; doing it here too
    // was a second concurrent read of the same key for no benefit. Setting the id
    // is the whole action.
    setActiveSessionId(id);
  }, []);

  const handleSend = useCallback(async (content: string) => {
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
    const userMsg: Message = {
      id: generateMessageId(),
      role: 'user',
      content,
      timestamp: Date.now(),
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
    await persist('save your message', async () => {
      await sessionsLib.saveMessages(depsRef.current.appStorage, activeSessionId, updatedMessages);
      await sessionsLib.saveSessions(depsRef.current.appStorage, nextSessions);
    });

    setIsStreaming(true);
    streamingRef.current = true;
    abortControllerRef.current = new AbortController();

    const assistantMsg: Message = {
      id: generateMessageId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    setMessages([...updatedMessages, assistantMsg]);

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
        declarations = await toolsLib.fetchToolDeclarations({ token: token_.raw });
      } catch {
        declarations = [];
      }

      // 🔴 THE PROMPT MUST MATCH THE CAPABILITY THIS REQUEST ACTUALLY CARRIES.
      // `declarations` is the same value the `tools` key below is derived from,
      // so the claim and the wire cannot disagree — including on the degraded
      // path, where the fetch failed and no tools are sent at all.
      const toolsAvailable = declarations.length > 0;
      let apiMessages = withSystemPrompt(
        updatedMessages.map((m) => ({ role: m.role, content: m.content })),
        toolsAvailable ? settings.systemPrompt : settings.systemPrompt + NO_TOOLS_NOTICE,
      );

      const onChunk = (chunk: string) => {
        if (!streamingRef.current) return;
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
          abortControllerRef.current?.signal,
        );

      let response = await submit();
      let rounds = 0;
      // 🔴 COUNTS `role:'tool'` MESSAGES, NOT ROUNDS — the quantity the host's
      // `.superRefine` actually counts. One round answering N parallel calls
      // contributes N. Counting rounds here let a single 5-call round exceed a
      // mirrored cap of 3 on the first iteration.
      let toolMessages = 0;
      let hitRoundCap = false;

      for (;;) {
        // Stop must end the loop, not just the in-flight request. Without this
        // a Stop pressed while a tool POST is in flight still fell through to
        // another `submit()` — a second BILLED estimate+submit after the viewer
        // asked to stop.
        if (abortControllerRef.current?.signal.aborted) break;

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
        setSearchResults(null);
        const firstQuery = toolsLib.readQueryArgument(calls[0]);
        if (firstQuery) {
          // The tool result is not wired in as panel items deliberately: its
          // projected shape (name/tags/creator/downloads/baseModel) is not
          // `ModelSearchItem`, and mapping it here would be a second definition
          // of the host's projection that can drift from the real one. So the
          // panel shows the model's own query over nothing, which is honest.
          setSearchQuery(firstQuery);
        }

        setIsSearching(true);
        let results: string[];
        try {
          results = await Promise.all(
            calls.map((c) =>
              toolsLib.callTool(c, {
                token: token_.raw,
                signal: abortControllerRef.current?.signal,
              }),
            ),
          );
        } finally {
          setIsSearching(false);
        }

        // A Stop landing while the tool POSTs were in flight must not be spent
        // on another submit.
        if (abortControllerRef.current?.signal.aborted) break;

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
      if (abortControllerRef.current?.signal.aborted) return;

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
      await persist('save the reply', () =>
        sessionsLib.saveMessages(depsRef.current.appStorage, activeSessionId, [
          ...updatedMessages,
          finalMsg,
        ]),
      );
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
      if (abortControllerRef.current?.signal.aborted) {
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
      await persist('save the reply', () =>
        sessionsLib.saveMessages(depsRef.current.appStorage, activeSessionId, [
          ...updatedMessages,
          { ...assistantMsg, content: body, ...(withheld ? { withheld: true } : {}) },
        ]),
      );
      if (withheld) depsRef.current.track('completion_withheld');
    } finally {
      setIsStreaming(false);
      streamingRef.current = false;
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
    const current = messagesRef.current;
    if (activeSessionId && current.length > 0) {
      void persist('save the stopped reply', () =>
        sessionsLib.saveMessages(depsRef.current.appStorage, activeSessionId, current),
      );
    }
  }, [orchestrator, persist, activeSessionId]);

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
      await handleSend(lastUserMsg.content);
    }
  }, [messages, handleSend, sendGate, raiseGate, activeSessionId, isStreaming]);

  const handleResearchSearch = useCallback(async (query: string) => {
    setIsSearching(true);
    try {
      const results = await researchLib.searchModels(query, { token: token_.raw });
      setSearchResults(results);
      // A panel search is shown VERBATIM — nothing rewrites it.
      setSearchQuery(query);
    } catch {
      setSearchResults(null);
    } finally {
      setIsSearching(false);
    }
  }, [token_.raw]);

  const handleInsertResearch = useCallback((text: string) => {
    // Append the model name to the chat input area (handled by ChatArea internally)
    // For now, just send it as a message
    handleSend(`Tell me more about ${text}`);
  }, [handleSend]);

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
            🔴 BOTH HEADER CONTROLS ARE SIBLINGS IN THIS FLEX ROW, AND THAT IS
            LOAD-BEARING. The Research toggle used to be rendered by
            `ResearchPanel` as `position: absolute; right: 8; top: 8`, which put
            it on top of ⚙️ — `elementFromPoint` at the centre of
            `settings-button` returned `open-research`, so Settings could not be
            opened at all. Laid out by flex, neither is out of flow and they
            cannot overlap at any width. Do not absolutely position either.
          */}
          <Group gap={8}>
            <ResearchToggle isOpen={researchOpen} onToggle={() => setResearchOpen(!researchOpen)} />
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
                <ChatArea
                  messages={messages}
                  isStreaming={isStreaming}
                  onSend={handleSend}
                  sendGate={sendGate}
                  onGatedSend={raiseGate}
                  onStopStream={handleStopStream}
                  onRegenerate={handleRegenerate}
                  onInsertResearch={handleInsertResearch}
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

          {/* Research panel — the toggle for it lives in the header. */}
          <ResearchPanel
            isOpen={researchOpen}
            onToggle={() => setResearchOpen(!researchOpen)}
            searchResults={searchResults}
            lastQuery={searchQuery}
            isSearching={isSearching}
            onSearch={handleResearchSearch}
            onInsert={handleInsertResearch}
          />
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
