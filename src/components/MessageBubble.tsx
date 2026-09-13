import { useState } from 'react';
import { Group } from '@civitai/blocks-react/ui';
import type { Message } from '../types.js';
import type { GroundedModelIds } from '../lib/grounding.js';
import { formatRoleLabel } from '../lib/chat.js';
import { MarkdownText } from './MarkdownText.js';
import { ResourceMentionCard } from './ResourceMention.js';
import { useMotion } from '../lib/motion.js';
import { token, brand, radius } from '../theme.js';

export interface MessageBubbleProps {
  message: Message;
  onRegenerate?: () => void;
  onCopy?: () => void;
  /**
   * The model ids this conversation's tool rounds have returned, accumulated.
   *
   * 🔴 APPLIED TO ASSISTANT PROSE ONLY — see the render below. The rule being
   * enforced is "the model must not cite an id it was never given", which is a
   * claim about MODEL output. A viewer who pastes a model link into their own
   * question is not citing anything, and refusing their link would be a
   * different (and wrong) product decision wearing this fix's clothes.
   */
  groundedModelIds?: GroundedModelIds;
}

/**
 * 🔴 THE VIEWER AND SENSEI ARE THE TWO BRAND-COLOURED ROLES, and they are the
 * only two the host token set is asked to give up. `assistant` used to be
 * `--civitai-color-success` — the platform's GREEN-FOR-OK — which read as a
 * status, not an identity, and collided with the brand hue by accident rather
 * than by design. It is now the app's own accent, which is a measured
 * dual-theme value (see `index.css`); `system` and `tool` stay on host tokens
 * because they ARE status.
 */
const ROLE_COLORS: Record<string, string> = {
  user: brand.accent,
  assistant: brand.accent,
  system: token.dimmed,
  tool: token.error,
};

export function MessageBubble({
  message,
  onRegenerate,
  onCopy,
  groundedModelIds,
}: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const motion = useMotion();
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
        borderRadius: radius.md,
        background: isUser ? brand.wash : 'transparent',
        border: isUser ? `1px solid ${brand.hairline}` : `1px solid ${token.border}`,
        // 🔴 THE ENTRY ANIMATION IS OMITTED, NOT ZEROED, under reduced motion —
        // see `lib/motion.ts` for why `undefined` rather than `'none'`. The
        // keyframe starts at `opacity: 0`, so a zero-duration variant would
        // flash the bubble rather than simply placing it.
        animation: motion.animation('senseiRise 160ms ease-out'),
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
          // 🔴 NOT `pre-wrap` ANY MORE for a rendered message. The markdown
          // renderer emits real block elements, and `pre-wrap` would preserve
          // the source newlines AROUND them — doubling every gap. A message
          // that renders as plain text still wraps, because the parser emits a
          // paragraph per blank-line-separated run.
          wordBreak: 'break-word',
        }}
        data-testid="message-content"
      >
        {/* 🔴 ONLY THE **WITHHELD** BRANCH STAYS PLAIN — AND THIS COMMENT USED TO
            CLAIM OTHERWISE. It read "THE WITHHELD/ERROR BRANCH STAYS PLAIN … an
            `Error: …` string [is] FIRST-PARTY text with no markdown in [it] …
            Only model prose is rendered." The branch below tests
            `message.withheld`, which `App`'s catch sets ONLY for a
            `TextOutputWithheldError`. Every other failure is written as
            `Error: <message>` with `withheld: false`, so it takes the
            `MarkdownText` arm — and since PR #69 that message is the SERVER's own
            words off `snapshot.error`, i.e. exactly the "future host-authored
            reason string" the comment said was excluded. The claim was false when
            written and the bump did not cause it.

            🔴 WHAT THE ACTUAL EXPOSURE IS, measured rather than assumed: the
            renderer builds React elements — there is no `dangerouslySetInnerHTML`
            anywhere in it — so server text cannot inject markup, and `linkHref`
            allowlists every href to an https civitai host carrying no userinfo.
            What server text CAN do is render as markdown: a Prisma constraint
            name with `_pairs_` in it emphasises, and `1. ` at a line start
            becomes a list. That is a cosmetic mangling of a diagnostic, not an
            injection — which is why this is recorded and deferred
            (`error-text-through-markdown` in `taste.json`) rather than fixed
            inside a dependency-bump PR that must not change render behaviour. */}
        {message.content
          ? message.withheld
            ? message.content
            : (
              <MarkdownText
                text={message.content}
                // 🔴 ASSISTANT ONLY. `undefined` for a user turn is the
                // "no grounding context" argument, i.e. exactly today's
                // behaviour — not an empty set, which would refuse the
                // viewer's own links. See {@link MessageBubbleProps}.
                groundedModelIds={message.role === 'assistant' ? groundedModelIds : undefined}
              />
            )
          : '…'}
      </div>
      {/*
        🔴 THE MESSAGE ENHANCEMENT. Rendered BESIDE the viewer's text, never
        spliced into it: what they typed stays what they typed, and what the
        model was handed is shown as its own resolved card. Every field on it
        came back from the maturity-clamped resolve endpoint — see
        `ResourceMentionCard`.
      */}
      {message.mentions && message.mentions.length > 0 && (
        <div
          data-testid="message-mentions"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}
        >
          {message.mentions.map((r) => (
            <ResourceMentionCard key={r.versionId} resource={r} />
          ))}
        </div>
      )}
    </div>
  );
}
