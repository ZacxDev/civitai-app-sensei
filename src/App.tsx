import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useAppStorage,
  useBlockAnalytics,
  useBlockContext,
  useBlockResize,
  useBlockToken,
  useBuzzBalance,
  useBuzzWorkflow,
} from '@civitai/blocks-react';
import type { UseAppStorage } from '@civitai/blocks-react';
import { Badge, Button, Group, Loader, Stack } from '@civitai/blocks-react/ui';

import { palette, pageStyle, token, radius, mutedText } from './theme.js';
import type { AppSettings, Message, Session } from './types.js';
import { DEFAULT_SETTINGS } from './types.js';
import { hasGenerateScope } from './scopes.js';
import { createOrchestrator } from './lib/orchestrator.js';
import { TextOutputWithheldError } from './lib/orchestrator-bridge.js';
import { CIVITAI_TOOLS, parseToolArguments } from './lib/tools.js';
import * as sessionsLib from './lib/sessions.js';
import * as researchLib from './lib/research.js';
import { delegateToNsfwAgent } from './lib/nsfw-agent.js';
import { generateMessageId, withSystemPrompt } from './lib/chat.js';
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

  const selectSession = useCallback(async (id: string) => {
    setActiveSessionId(id);
    const msgs = await sessionsLib.getMessages(depsRef.current.appStorage, id);
    setMessages(msgs);
  }, []);

  const handleSend = useCallback(async (content: string) => {
    if (!activeSessionId || isStreaming) return;

    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === 'user' && lastMsg.content === content) return;

    if (!viewer) {
      // Not signed in — the host will handle the consent flow
      return;
    }

    if (!canGenerate) {
      // Need consent
      return;
    }

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
      const apiMessages = withSystemPrompt(
        updatedMessages.map((m) => ({ role: m.role, content: m.content })),
        settings.systemPrompt,
      );

      let response;
      let maxToolRounds = 5;

      while (maxToolRounds > 0) {
        response = await orchestrator.submitChatCompletion(
          {
            model: settings.model,
            messages: apiMessages,
            temperature: settings.temperature,
            max_tokens: settings.maxTokens,
            tools: CIVITAI_TOOLS,
            stream: true,
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

        const choice = response.choices[0];

        // Handle tool calls
        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
          // Add the assistant message with tool calls
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last.id === assistantMsg.id) {
              return [...prev.slice(0, -1), {
                ...last,
                toolCalls: choice.message.tool_calls,
              }];
            }
            return prev;
          });

          // Execute tools and add results
          for (const tc of choice.message.tool_calls) {
            const args = parseToolArguments(tc.function.arguments);
            let result: string;

            if (tc.function.name === 'delegate_to_nsfw_agent') {
              const nsfwResult = await delegateToNsfwAgent(orchestrator, {
                task: (args.task as string) ?? '',
                context: (args.context as string) ?? content,
              });
              result = nsfwResult.choices[0].message.content;
            } else if (tc.function.name === 'search_models') {
              const searchRes = await researchLib.searchModels(
                (args.query as string) ?? '',
                { type: args.type as string, sort: args.sort as string, limit: args.limit as number },
              );
              result = JSON.stringify(searchRes);
              setSearchResults(searchRes);
            } else if (tc.function.name === 'get_model_details') {
              const details = await researchLib.getModelDetails(args.modelId as number);
              result = JSON.stringify(details);
            } else if (tc.function.name === 'search_images') {
              const images = await researchLib.searchImages({
                modelId: args.modelId as number,
                query: args.query as string,
                sort: args.sort as string,
                limit: args.limit as number,
              });
              result = JSON.stringify(images);
            } else {
              result = `Unknown tool: ${tc.function.name}`;
            }

            const toolMsg: Message = {
              id: generateMessageId(),
              role: 'tool',
              content: result,
              toolCallId: tc.id,
              timestamp: Date.now(),
            };
            setMessages((prev) => [...prev, toolMsg]);
            apiMessages.push({ role: 'tool', content: result, tool_call_id: tc.id });
          }

          maxToolRounds -= 1;
          continue;
        }

        // No tool calls — we have a final text response
        if (choice.message.content) {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last.id === assistantMsg.id) {
              return [...prev.slice(0, -1), { ...last, content: choice.message.content }];
            }
            return prev;
          });
        }
        break;
      }

      // Persist final assistant message
      const finalMsg: Message = {
        id: assistantMsg.id,
        role: 'assistant',
        content: response?.choices[0].message.content ?? '',
        toolCalls: response?.choices[0].message.tool_calls,
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
  }, [activeSessionId, isStreaming, messages, settings, sessions, canGenerate, viewer]);

  const handleStopStream = useCallback(() => {
    streamingRef.current = false;
    setIsStreaming(false);
    abortControllerRef.current?.abort();
    orchestrator.cancel?.();
  }, [orchestrator]);

  const handleRegenerate = useCallback(async (messageId: string) => {
    // Find the last user message before this assistant message
    const msgIdx = messages.findIndex((m) => m.id === messageId);
    if (msgIdx < 0) return;
    const lastUserMsg = [...messages.slice(0, msgIdx)].reverse().find((m) => m.role === 'user');
    if (lastUserMsg) {
      // Remove the assistant message and resend
      setMessages((prev) => prev.slice(0, msgIdx));
      await handleSend(lastUserMsg.content);
    }
  }, [messages, handleSend]);

  const handleResearchSearch = useCallback(async (query: string) => {
    setIsSearching(true);
    try {
      const results = await researchLib.searchModels(query);
      setSearchResults(results);
    } catch {
      setSearchResults(null);
    } finally {
      setIsSearching(false);
    }
  }, []);

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
              <ChatArea
                messages={messages}
                isStreaming={isStreaming}
                onSend={handleSend}
                onStopStream={handleStopStream}
                onRegenerate={handleRegenerate}
                onInsertResearch={handleInsertResearch}
              />
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
