import { useState, useRef, useEffect, useCallback } from 'react';
import { Button, Textarea } from '@civitai/blocks-react/ui';
import type { Message } from '../types.js';
import type { ResolvedResource } from '../lib/mentions.js';
import type { GroundedModelIds } from '../lib/grounding.js';
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
  /**
   * The model ids THIS conversation's tool rounds have returned, accumulated
   * across turns. Forwarded to every bubble; see `lib/grounding.ts`.
   *
   * 🔴 REQUIRED, for the same reason `sendGate` is. The safe-looking default
   * would be `undefined` — "do not apply the rule" — so a caller who simply
   * forgot the prop would silently ship the ungrounded-citation behaviour back,
   * with every test still green. Required makes that a compile error.
   */
  groundedModelIds: GroundedModelIds;
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
  groundedModelIds,
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
          // 🔴 DEFENCE IN DEPTH, NOT A KNOWN LEGACY POPULATION. Nothing writes
          // a `'tool'` message, and — corrected from what this comment used to
          // claim — no shipped build ever did (the history is in `lib/chat.ts`'s
          // `deserializeMessages`). `deserializeMessages` casts `role` straight
          // off the stored row, so a row that carried one would render, and
          // rendering a raw JSON tool payload as a chat bubble would be worse
          // than dropping it. Kept for that reason, not because such sessions
          // are out there.
          if (msg.role === 'tool') return null;
          return (
            <div key={msg.id}>
              <MessageBubble
                message={msg}
                groundedModelIds={groundedModelIds}
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
          {/*
            🔴 GATED ON THE SAME CONDITIONS AS THE SEND, because attaching only
            has meaning as grounding for the NEXT send. `disabled` existed on
            this component and was passed by NOBODY, which is worse than not
            having it: it reads as a gate on review and is inert at runtime.

            🔴 THE TWO CONDITIONS GET THE TWO TREATMENTS THE SEND BUTTON GIVES
            THEM, WHICH ARE NOT THE SAME TREATMENT. Disabling on both was tried
            and is wrong: `sendGate === 'consent'` is the DEFAULT state of a
            first-time viewer — `ai:write:budgeted` is consent-gated and simply
            opening the app does not grant it — so `disabled` there ships a dead
            `＋ Model` button to every new viewer with nothing to explain it.
            That is the 0.1.4 defect class this file's own comments are about.

            `isStreaming` → DISABLED, because Send itself is replaced by Stop for
            the duration. A chip attached now cannot travel with the message it
            was attached to; it would sit in the composer and silently ground the
            NEXT question — the same leak as carrying attachments across a
            session switch.

            `sendGate` → ASK FOR WHAT IS MISSING, because that is exactly what
            Send does (`onGatedSend()`, never `disabled`). The host picker is not
            opened and no resolve is issued, so the hazard is closed; the viewer
            gets the banner that tells them how to fix it instead of a control
            that does nothing.

            🔴 INTERCEPTED AT BOTH DOORS. Gating only the launcher is a SPELLED
            guard: a menu already open when the gate closes keeps four live type
            buttons that reach `onPickMention` directly. So the pick is gated
            too, and it is the pick that actually opens host chrome.

            NOT gated: removing a chip already attached. Gating what ADDS
            grounding must not trap what is already there.
          */}
          <MentionPickerButton
            open={menuOpen}
            disabled={isStreaming}
            onOpenChange={(next) => {
              if (next && sendGate) {
                onGatedSend();
                return;
              }
              setMenuOpen(next);
            }}
            onPick={(t) => {
              setMenuOpen(false);
              if (sendGate) {
                onGatedSend();
                return;
              }
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
