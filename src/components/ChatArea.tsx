import { useState, useRef, useEffect, useCallback } from 'react';
import { Button, Textarea } from '@civitai/blocks-react/ui';
import type { Message } from '../types.js';
import { MessageBubble } from './MessageBubble.js';
import { ToolCallCard } from './ToolCallCard.js';
import { token, mutedText } from '../theme.js';

export interface ChatAreaProps {
  messages: Message[];
  isStreaming: boolean;
  onSend: (content: string) => void;
  onStopStream?: () => void;
  onRegenerate?: (messageId: string) => void;
  onInsertResearch?: (text: string) => void;
}

export function ChatArea({
  messages,
  isStreaming,
  onSend,
  onStopStream,
  onRegenerate,
}: ChatAreaProps) {
  const [input, setInput] = useState('');
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

    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === 'user' && lastMsg.content === trimmed) return;

    sendingRef.current = true;
    onSend(trimmed);
    setInput('');
    // Reset after a tick so the next event-loop turn sees the guard cleared
    // (isStreaming will take over as the primary guard once the request starts)
    setTimeout(() => { sendingRef.current = false; }, 0);
  }, [input, isStreaming, messages, onSend]);

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
          if (msg.role === 'tool') return null;
          return (
            <div key={msg.id}>
              <MessageBubble
                message={msg}
                onRegenerate={msg.role === 'assistant' ? () => onRegenerate?.(msg.id) : undefined}
                onCopy={() => navigator.clipboard.writeText(msg.content)}
              />
              {msg.toolCalls?.map((tc) => {
                const toolResult = messages.find(
                  (m) => m.role === 'tool' && m.toolCallId === tc.id,
                );
                const isActive = isStreaming && !toolResult;
                return (
                  <ToolCallCard
                    key={tc.id}
                    toolCall={tc}
                    result={toolResult}
                    isLoading={isActive}
                  />
                );
              })}
            </div>
          );
        })}
        {isStreaming && (
          <div style={{ ...mutedText, padding: '0 12px' }}>
            <span data-testid="streaming-indicator">Thinking…</span>
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
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
