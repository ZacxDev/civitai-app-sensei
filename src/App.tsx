import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useAppStorage,
  useBlockAnalytics,
  useBlockContext,
  useBlockResize,
  useBlockToken,
  useBuzzBalance,
  useBuzzWorkflow,
  useRequestConsent,
  useRequestSignIn,
} from '@civitai/blocks-react';
import type { UseAppStorage } from '@civitai/blocks-react';
import { Badge, Button, Group, Loader, Stack } from '@civitai/blocks-react/ui';

import { palette, pageStyle, token, radius, mutedText } from './theme.js';
import type { AppSettings, Message, Session } from './types.js';
import { DEFAULT_SETTINGS } from './types.js';
import { AI_WRITE_BUDGETED, BUZZ_READ_SELF, hasGenerateScope } from './scopes.js';
import { createOrchestrator } from './lib/orchestrator.js';
import { TextOutputWithheldError } from './lib/orchestrator-bridge.js';
import * as sessionsLib from './lib/sessions.js';
import * as researchLib from './lib/research.js';
import { generateMessageId, withSystemPrompt, withRetrievalContext } from './lib/chat.js';
import { generateTitle } from './lib/sessions.js';

import { ChatArea } from './components/ChatArea.js';
import { SessionList } from './components/SessionList.js';
import { ResearchPanel } from './components/ResearchPanel.js';
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
  const buzz = useBuzzBalance();
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
  const [isSearching, setIsSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  // Whether the viewer has actually run into the capability gate. The gate
  // ITSELF is derived (below), never stored — storing it is what let an earlier
  // draft show a stale "sign in" banner to a viewer who had since signed in but
  // still lacked the spend scope, with nothing to escalate it.
  const [gateRaised, setGateRaised] = useState(false);

  const streamingRef = useRef(false);
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
        if (storedSettings) setSettings(storedSettings);
        if (loaded.length > 0) {
          setActiveSessionId(loaded[0].id);
          const msgs = await sessionsLib.getMessages(depsRef.current.appStorage, loaded[0].id);
          if (!cancelled) setMessages(msgs);
        }
      } catch {
        // best-effort
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
    sessionsLib.getMessages(depsRef.current.appStorage, activeSessionId).then((msgs) => {
      if (!cancelled) setMessages(msgs);
    });
    return () => { cancelled = true; };
  }, [activeSessionId]);

  // ---- Actions ----
  const createSession = useCallback(async () => {
    const session = await sessionsLib.createSession(depsRef.current.appStorage, settings.model);
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setMessages([]);
    depsRef.current.track('session_create');
  }, [settings.model]);

  const deleteSession = useCallback(async (id: string) => {
    await sessionsLib.deleteSession(depsRef.current.appStorage, id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (activeSessionId === id) {
      const remaining = sessions.filter((s) => s.id !== id);
      setActiveSessionId(remaining[0]?.id ?? null);
    }
    depsRef.current.track('session_delete');
  }, [activeSessionId, sessions]);

  const renameSession = useCallback(async (id: string) => {
    const title = prompt('Rename session:');
    if (!title) return;
    await sessionsLib.renameSession(depsRef.current.appStorage, id, title);
    setSessions((prev) => prev.map((s) => s.id === id ? { ...s, title } : s));
  }, []);

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
    setActiveSessionId(id);
    const msgs = await sessionsLib.getMessages(depsRef.current.appStorage, id);
    setMessages(msgs);
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
    await sessionsLib.appendMessage(depsRef.current.appStorage, activeSessionId, userMsg);

    // Auto-title from first user message
    const session = sessions.find((s) => s.id === activeSessionId);
    if (session?.title === 'New Chat') {
      const title = generateTitle(updatedMessages);
      await sessionsLib.renameSession(depsRef.current.appStorage, activeSessionId, title);
      setSessions((prev) => prev.map((s) => s.id === activeSessionId ? { ...s, title } : s));
    }

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
      // ── (a) RETRIEVE, then (b) INJECT, then (c) ONE completion. ────────────
      //
      // 🔴 THIS REPLACES A LOOP THAT COULD NEVER RUN. The old code sent
      // `tools: CIVITAI_TOOLS` and looped up to 5 rounds on `tool_calls` — but
      // the host's params schema is `.strict()`, so `tools` was a
      // `BAD_REQUEST`, and even had it not been, a `'textOutput'` step cannot
      // return a tool call at all. The loop was unreachable code that made the
      // system prompt's claim of catalog access look supported.
      //
      // Retrieval is deterministic and needs no model call: a search engine
      // handles free text, so the user's own words ARE the query. It runs
      // before the single completion and costs no Buzz — a wasted search is one
      // HTTP request, never a charge. Failures are swallowed on purpose: an
      // ungrounded answer is much better than no answer, and the rewritten
      // system prompt tells the model to say when nothing was attached.
      let catalogContext = '';
      if (researchLib.shouldRetrieve(content)) {
        setIsSearching(true);
        try {
          const results = await researchLib.searchModels(
            content,
            { token: token_.raw },
            { limit: researchLib.MAX_CONTEXT_MODELS },
          );
          catalogContext = researchLib.formatCatalogContext(results, content);
          // The ResearchPanel then shows exactly what grounded the answer —
          // the user can SEE the sources rather than take them on trust.
          setSearchResults(results);
        } catch {
          catalogContext = '';
        } finally {
          setIsSearching(false);
        }
      }

      const apiMessages = withRetrievalContext(
        withSystemPrompt(
          updatedMessages.map((m) => ({ role: m.role, content: m.content })),
          settings.systemPrompt,
        ),
        catalogContext,
      );

      const response = await orchestrator.submitChatCompletion(
        {
          model: settings.model,
          messages: apiMessages,
          temperature: settings.temperature,
          max_tokens: settings.maxTokens,
        },
        (chunk) => {
          if (!streamingRef.current) return;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last.id === assistantMsg.id) {
              return [...prev.slice(0, -1), { ...last, content: last.content + chunk }];
            }
            return prev;
          });
        },
        abortControllerRef.current?.signal,
      );

      const replyText = response.choices[0].message.content;
      if (replyText) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last.id === assistantMsg.id) {
            return [...prev.slice(0, -1), { ...last, content: replyText }];
          }
          return prev;
        });
      }

      // Persist final assistant message
      const finalMsg: Message = {
        id: assistantMsg.id,
        role: 'assistant',
        content: replyText ?? '',
        timestamp: assistantMsg.timestamp,
      };
      await sessionsLib.appendMessage(depsRef.current.appStorage, activeSessionId, finalMsg);
    } catch (e) {
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
  ]);

  const handleStopStream = useCallback(() => {
    streamingRef.current = false;
    setIsStreaming(false);
    abortControllerRef.current?.abort();
    orchestrator.cancel?.();
  }, [orchestrator]);

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

  const buzzTotal =
    buzz.balance != null ? buzz.balance.blue + buzz.balance.green + buzz.balance.yellow : null;

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
          <Group gap={8}>
            {buzzTotal != null && (
              <Badge variant="light" size="sm" data-testid="buzz-balance">
                {buzzTotal.toLocaleString()} Buzz
              </Badge>
            )}
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

          {/* Research panel */}
          <ResearchPanel
            isOpen={researchOpen}
            onToggle={() => setResearchOpen(!researchOpen)}
            searchResults={searchResults}
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
