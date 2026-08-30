import { useState, useRef, useEffect, useCallback } from 'react';
import { Button, Textarea } from '@civitai/blocks-react/ui';
import type { Message } from '../types.js';
import type { ResolvedResource } from '../lib/mentions.js';
import { MessageBubble } from './MessageBubble.js';
import {
  MentionPickerButton,
  ResourceMentionCard,
  type MentionPickerType,
} from './ResourceMention.js';
import { token, mutedText } from '../theme.js';

export interface ChatAreaProps {
  messages: Message[];
  isStreaming: boolean;
  onSend: (content: string) => void;
  onStopStream?: () => void;
  onRegenerate?: (messageId: string) => void;
  /**
   * Resources the viewer has attached to the message they are composing. Owned
   * by the parent, not by this component: they survive a re-render of the
   * composer and are consumed by `handleSend`, which is where the wire is built.
   */
  pendingMentions: ResolvedResource[];
  /** Ask the HOST to open its own native picker for this type. */
  onPickMention: (type: MentionPickerType) => void;
  onRemoveMention: (versionId: number) => void;
  /**
   * The query the MODEL wrote when it called a catalog tool, shown while that
   * lookup is in flight.
   *
   * 🔴 THIS IS WHAT SURVIVES OF THE RESEARCH PANEL, AND IT IS THE HALF WORTH
   * KEEPING. The panel did two things: it let the viewer search inside the
   * iframe, and it showed the query the model actually sent. The search moved to
   * the host's own picker (better: the catalog never enters this iframe). The
   * transparency did not have anywhere else to go, and dropping it would make a
   * bad query invisible again — which is precisely how the DreamShaper case went
   * unnoticed.
   */
  lookupQuery?: string | null;
  /**
   * Non-null when the app currently CANNOT send — the viewer is anonymous, or
   * the block token is missing the consent-gated spend scope. Supplied by the
   * parent because only it can see the token.
   *
   * 🔴 REQUIRED, and deliberately not optional-with-a-default. The safe default
   * would have to be `null` ("sending is fine"), so a caller who simply forgot
   * the prop would silently get the 0.1.0-0.1.3 behaviour back — a blocked send
   * that clears the composer and does nothing. Required makes that a compile
   * error instead of a production regression nobody can see.
   */
  sendGate: 'signin' | 'consent' | null;
  /** Ask the host for whatever `sendGate` says is missing. Required for the same reason. */
  onGatedSend: () => void;
}

export function ChatArea({
  messages,
  isStreaming,
  onSend,
  onStopStream,
  onRegenerate,
  sendGate,
  onGatedSend,
  pendingMentions,
  onPickMention,
  onRemoveMention,
  lookupQuery,
}: ChatAreaProps) {
  const [input, setInput] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendingRef = useRef(false);

  useEffect(() => {
    if (messagesEndRef.current?.scrollIntoView) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isStreaming]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming || sendingRef.current) return;

    // 🔴 THE GATE COMES FIRST — BEFORE THE DEDUP AND BEFORE THE CLEAR.
    //
    // Before the clear, because clearing ahead of a parent that could silently
    // refuse is what made a blocked send look like "Send is dead": the text
    // vanished and nothing replaced it. Keeping the text in the box is also
    // what lets the parent hold no state — nothing to stash, misroute or lose.
    //
    // Before the DEDUP, because the dedup returns silently too. Whenever
    // `messages` already ends with a user message — after a gated Regenerate,
    // or in any session reloaded from storage after a failed completion, since
    // the assistant reply is only persisted on success — retyping that same
    // text hit the dedup FIRST and the viewer got no consent prompt, no
    // banner, and no feedback of any kind. That is this bug reappearing behind
    // a different guard, so the ordering here is load-bearing, not cosmetic.
    if (sendGate) {
      onGatedSend();
      return;
    }

    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === 'user' && lastMsg.content === trimmed) return;

    sendingRef.current = true;
    onSend(trimmed);
    setInput('');
    // Reset after a tick so the next event-loop turn sees the guard cleared
    // (isStreaming will take over as the primary guard once the request starts)
    setTimeout(() => { sendingRef.current = false; }, 0);
  }, [input, isStreaming, messages, onSend, sendGate, onGatedSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
        data-testid="messages-container"
      >
        {messages.length === 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 1,
              ...mutedText,
            }}
          >
            Ask me about AI models, checkpoints, or anything related to AI art generation.
          </div>
        )}
        {messages.map((msg) => {
          // 🔴 LEGACY ONLY. Nothing writes a `'tool'` message any more, but
          // sessions saved by the tool-loop build still hold them in KV storage.
          // Rendering a raw JSON tool payload as a chat bubble would be worse
          // than dropping it.
          if (msg.role === 'tool') return null;
          return (
            <div key={msg.id}>
              <MessageBubble
                message={msg}
                onRegenerate={msg.role === 'assistant' ? () => onRegenerate?.(msg.id) : undefined}
                onCopy={() => navigator.clipboard.writeText(msg.content)}
              />
            </div>
          );
        })}
        {isStreaming && (
          <div style={{ ...mutedText, padding: '0 12px' }}>
            <span data-testid="streaming-indicator">Thinking…</span>
            {lookupQuery ? (
              <span data-testid="lookup-query" style={{ marginLeft: 8 }}>
                Looking up: <strong>{lookupQuery}</strong>
              </span>
            ) : null}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div
        style={{
          padding: '12px 16px',
          borderTop: `1px solid ${token.border}`,
          background: token.surface,
        }}
      >
        {/*
          The resources attached to the message being composed. Above the input
          row rather than inside it: a chip row that grows must not squeeze the
          textarea, and each chip is removable before sending.
        */}
        {pendingMentions.length > 0 && (
          <div
            data-testid="pending-mentions"
            style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}
          >
            {pendingMentions.map((r) => (
              <ResourceMentionCard
                key={r.versionId}
                resource={r}
                onRemove={() => onRemoveMention(r.versionId)}
              />
            ))}
          </div>
        )}
        {/*
          🔴 THE PICKER BUTTON IS THE FIRST CHILD OF THIS ROW, AND THAT ORDER IS
          THE REQUIREMENT, NOT A PREFERENCE. `flexDirection` is the row default,
          so DOM order IS visual order here — a test can therefore read the
          layout off the DOM rather than off a `getBoundingClientRect` jsdom
          cannot compute. Do not give this row `row-reverse` or the button an
          `order`, and do not move it after the textarea.
        */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <MentionPickerButton
            open={menuOpen}
            onOpenChange={setMenuOpen}
            onPick={(t) => {
              setMenuOpen(false);
              onPickMention(t);
            }}
          />
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Sensei anything…"
            rows={1}
            style={{ flex: 1 }}
            data-testid="chat-input"
          />
          {isStreaming ? (
            <Button
              variant="light"
              color="red"
              onClick={onStopStream}
              data-testid="stop-button"
            >
              Stop
            </Button>
          ) : (
            <Button
              onClick={handleSend}
              disabled={!input.trim() || isStreaming}
              data-testid="send-button"
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
