import { Button } from '@civitai/blocks-react/ui';
import type { ResolvedResource } from '../lib/mentions.js';
import { mentionLabel, mentionUrl } from '../lib/mentions.js';
import { token, radius, mutedText } from '../theme.js';

/**
 * One attached resource, rendered from its RESOLVED projection.
 *
 * 🔴 EVERY FIELD HERE CAME BACK FROM `GET /api/v1/blocks/generation-resources`,
 * which is maturity-clamped and `hasAccess`-filtered server-side. Nothing is
 * carried over from the picker result and nothing is synthesised for an id the
 * endpoint declined to return — a card the viewer can see is a card the clamp
 * released. That is why `resolveMentions` drops rather than placeholders.
 */
export function ResourceMentionCard({
  resource,
  onRemove,
}: {
  resource: ResolvedResource;
  onRemove?: () => void;
}) {
  return (
    <div
      data-testid={`mention-${resource.versionId}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 8px',
        borderRadius: radius.sm,
        border: `1px solid ${token.border}`,
        background: token.body,
        maxWidth: '100%',
      }}
    >
      <span style={{ fontSize: 11, color: token.primary, fontWeight: 600 }}>
        {resource.modelType}
      </span>
      <a
        href={mentionUrl(resource)}
        target="_blank"
        rel="noreferrer noopener"
        style={{
          fontSize: 12,
          color: token.text,
          textDecoration: 'none',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={`${mentionLabel(resource)} — ${resource.baseModel}`}
      >
        {mentionLabel(resource)}
      </a>
      <span style={{ ...mutedText, fontSize: 11 }}>{resource.baseModel}</span>
      {onRemove && (
        <button
          onClick={onRemove}
          aria-label={`Remove ${resource.modelName}`}
          data-testid={`remove-mention-${resource.versionId}`}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: token.dimmed,
            fontSize: 12,
            padding: 0,
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

/**
 * The picker launcher — the button on the LEFT of the input bar, plus the type
 * menu it opens.
 *
 * 🔴 A TYPE MENU EXISTS BECAUSE `OPEN_RESOURCE_PICKER` TAKES EXACTLY ONE TYPE.
 * The host's `resolveResourcePickerRequest` resolves a single `resourceType` and
 * returns `null` for anything outside its allowlist — the modal simply never
 * opens — so the block has to say which kind of resource is wanted before the
 * host chrome can be shown. The four offered here are precisely
 * `PAGE_RESOURCE_PICKER_TYPES` as widened by civitai#4494; offering a fifth
 * would ship a control whose modal never opens.
 */
export const MENTION_PICKER_TYPES = ['Checkpoint', 'LORA', 'LoCon', 'DoRA'] as const;
export type MentionPickerType = (typeof MENTION_PICKER_TYPES)[number];

export function MentionPickerButton({
  open,
  onOpenChange,
  onPick,
  disabled,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onPick: (type: MentionPickerType) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <Button
        variant="light"
        size="sm"
        onClick={() => onOpenChange(!open)}
        disabled={disabled}
        data-testid="add-mention-button"
        aria-expanded={open}
        title="Attach a model from the Civitai catalog"
      >
        ＋ Model
      </Button>
      {open && (
        <div
          data-testid="mention-type-menu"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            marginBottom: 6,
            padding: 4,
            borderRadius: radius.sm,
            border: `1px solid ${token.border}`,
            background: token.surface,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            zIndex: 5,
            minWidth: 140,
          }}
        >
          {MENTION_PICKER_TYPES.map((t) => (
            <Button
              key={t}
              variant="subtle"
              size="sm"
              onClick={() => onPick(t)}
              data-testid={`mention-type-${t}`}
            >
              {t}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
