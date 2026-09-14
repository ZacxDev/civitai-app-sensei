import { useState } from 'react';
import { Group } from '@civitai/blocks-react/ui';
import type { Message } from '../types.js';
import type { GroundedModelIds } from '../lib/grounding.js';
import { formatRoleLabel, isPlainBody } from '../lib/chat.js';
import { MarkdownText } from './MarkdownText.js';
import { ResourceMentionCard } from './ResourceMention.js';
import { IconButton } from './Icon.js';
import { useMotion } from '../lib/motion.js';
import { token, brand, radius } from '../theme.js';

export interface MessageBubbleProps {
  message: Message;
  onRegenerate?: () => void;
  /**
   * Copy this message's text, resolving to whether the clipboard ACCEPTED it.
   *
   * 🔴 THE RETURN VALUE IS THE WHOLE POINT, AND IT USED TO BE `void`. The button
   * flipped to a tick unconditionally while the parent called
   * `navigator.clipboard.writeText(...)` with no `await` and no `.catch()`. In a
   * sandboxed cross-origin iframe that promise can reject — permissions policy,
   * missing transient activation, or no `navigator.clipboard` at all on an
   * insecure context — so the control claimed success having copied nothing, with
   * an unhandled rejection behind it. A `boolean` is what lets this component
   * render the truth; see `lib/clipboard.ts` for the shared helper that produces
   * it.
   */
  onCopy?: () => boolean | Promise<boolean>;
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
  /**
   * 🔴 THREE STATES, NOT A BOOLEAN, BECAUSE `false` MEANT TWO DIFFERENT THINGS.
   * The old `copied` flag could not distinguish "not copied yet" from "the
   * clipboard refused", so the only renderable outcome was success — which is
   * how a control that had copied nothing came to show a tick.
   */
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle');
  const motion = useMotion();
  const isUser = message.role === 'user';
  const roleColor = ROLE_COLORS[message.role] ?? token.text;

  const handleCopy = async () => {
    // `onCopy` may be sync (a test stub) or async (the real guarded helper);
    // `await` covers both and `?? false` makes a caller still on the old `void`
    // signature read as a FAILURE rather than as a success. That direction is
    // deliberate: the defect being fixed is a control claiming success it could
    // not observe, so an unobservable outcome must not render as one.
    const ok = (await onCopy?.()) ?? false;
    setCopyState(ok ? 'done' : 'failed');
    setTimeout(() => setCopyState('idle'), 1500);
  };

  /**
   * 🔴 THE ACCESSIBLE NAME CARRIES THE OUTCOME, NOT THE GLYPH. A test asserting
   * a glyph is walked around by swapping glyphs; the name is the contract, and
   * "Copy failed" is the only thing that tells a screen-reader user the write
   * did not land. The tick is never shown for a refused write.
   */
  const copyLabel =
    copyState === 'done' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy';

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
        <Group gap={4}>
          {onRegenerate && (
            <IconButton
              label="Regenerate"
              icon="regenerate"
              onClick={onRegenerate}
              testId="regenerate-button"
            />
          )}
          {onCopy && (
            <IconButton
              label={copyLabel}
              icon={copyState === 'done' ? 'check' : 'copy'}
              tone={copyState === 'failed' ? 'error' : 'default'}
              onClick={handleCopy}
              testId="copy-button"
            />
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
        {/* 🔴 EVERY APP-AUTHORED BODY STAYS PLAIN — WITHHOLDS AND FAILURES BOTH,
            and the comment here is now true of the code under it. It used to say
            exactly this while testing `message.withheld` alone, which `App`'s
            catch sets ONLY for a `TextOutputWithheldError`; every other failure
            was `Error: <message>` with `withheld: false` and went through
            `MarkdownText` — server text off `snapshot.error` since PR #69,
            rendered as markdown. The predicate lives in `lib/chat.ts`'s
            `isPlainBody`, sharing ONE prefix constant with the catch that writes
            it, so the reader and the writer cannot drift; read that function's
            header for the measured exposure and the role scoping. Closes
            `error-text-through-markdown` in `taste.json`. */}
        {message.content
          ? isPlainBody(message)
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
