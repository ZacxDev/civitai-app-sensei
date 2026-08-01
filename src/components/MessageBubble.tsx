import { useState } from 'react';
import { Group } from '@civitai/blocks-react/ui';
import type { Message } from '../types.js';
import { formatRoleLabel } from '../lib/chat.js';
import { token, radius } from '../theme.js';

export interface MessageBubbleProps {
  message: Message;
  onRegenerate?: () => void;
  onCopy?: () => void;
}

const ROLE_COLORS: Record<string, string> = {
  user: token.primary,
  assistant: token.success,
  system: token.dimmed,
  tool: token.error,
};

export function MessageBubble({ message, onRegenerate, onCopy }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';
  const roleColor = ROLE_COLORS[message.role] ?? token.text;

  const handleCopy = () => {
    onCopy?.();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: '10px 12px',
        borderRadius: radius.sm,
        background: isUser ? token.primaryLight : 'transparent',
        border: isUser ? undefined : `1px solid ${token.border}`,
      }}
      data-testid={`message-${message.role}`}
    >
      <Group justify="space-between" align="center" style={{ marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: roleColor }}>
          {formatRoleLabel(message.role)}
        </span>
        <Group gap={8}>
          {onRegenerate && (
            <button
              onClick={onRegenerate}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: token.dimmed,
                fontSize: 11,
                padding: 0,
              }}
              title="Regenerate"
              data-testid="regenerate-button"
            >
              🔄
            </button>
          )}
          {onCopy && (
            <button
              onClick={handleCopy}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: token.dimmed,
                fontSize: 11,
                padding: 0,
              }}
              title="Copy"
              data-testid="copy-button"
            >
              {copied ? '✓' : '📋'}
            </button>
          )}
        </Group>
      </Group>
      <div
        style={{
          fontSize: 14,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
        data-testid="message-content"
      >
        {message.content || '…'}
      </div>
    </div>
  );
}
