import { Button, ResourceCard, resourceDisplayName } from '@civitai/blocks-react/ui';
import type { ResolvedResource } from '../lib/mentions.js';
import { IconButton } from './Icon.js';
import { token, radius } from '../theme.js';

/**
 * One attached resource, rendered by the PACK'S OWN `ResourceCard`.
 *
 * 🔴 EVERY FIELD HERE CAME BACK FROM `GET /api/v1/blocks/generation-resources`,
 * which is maturity-clamped and `hasAccess`-filtered server-side. Nothing is
 * carried over from the picker result and nothing is synthesised for an id the
 * endpoint declined to return — a card the viewer can see is a card the clamp
 * released. That is why `resolveMentions` drops rather than placeholders.
 *
 * 🔴 HAND-ROLLED UNTIL NOW, AND THAT WAS THE DEFECT RATHER THAN A STYLE CHOICE.
 * `ResourceCard` + `resourceDisplayName` are new at `@civitai/blocks-react`
 * 0.49.0 and exist for exactly this case: a list of already-picked resources.
 * What the local version was getting WRONG, from that component's own header:
 *
 *  - `modelName` is typed `string` (REQUIRED) and that type is optimistic — a
 *    first-party block has already seen it absent at runtime. The local card
 *    rendered it raw, so an absent name produced a chip with a border and no
 *    text: indistinguishable from a broken card, with nothing telling the viewer
 *    which of the two it was. `resourceDisplayName` falls back to `#<versionId>`
 *    — still wrong-LOOKING, but it identifies the resource and can be pasted
 *    into a URL. Whitespace-only counts as absent.
 *  - The name fallback, the type label, the missing-thumbnail copy, the
 *    non-colour selected mark and the accessible-name composition are all
 *    deliberately NOT props: each is a statement about what a resource IS, and
 *    three apps disagreeing about it is three apps telling one viewer different
 *    things about the same model.
 *
 * 🔴 `variant="row"` IS REQUIRED AND PASSED AS A LITERAL. There is no defensible
 * default, so the prop is a discriminant — and a widened `string`/`boolean`
 * VARIABLE narrows to no arm and fails with an opaque `TS2322` naming nothing
 * useful. Literals here, always.
 *
 * 🔴 THE REMOVE CONTROL GOES IN `actions`, AND THAT SLOT EXISTS FOR A REASON THIS
 * FILE MUST NOT REDISCOVER. `actions` renders as a SIBLING of the card's
 * interactive hit area. A `<button>` nested inside a `<button>` is invalid HTML:
 * the parser REPARENTS it, so the inner control becomes unreachable by keyboard
 * and its click is eaten by the outer one. Wrapping our own control around the
 * card, or dropping it into any other slot, recreates exactly that.
 *
 * 🔴 WHAT THIS GIVES UP: the chip is no longer a LINK. `ResourceCard` is
 * deliberately not one — a block renders in a sandboxed iframe where a
 * top-level navigation is host-mediated (`useCivitaiNavigate`), so an `<a href>`
 * would either be inert or punch the viewer out of the app mid-task. That is a
 * real (small) loss of affordance, accepted rather than worked around:
 * re-adding an anchor would put back a control that is inert in the embedded
 * case, which is the "reads as a gate and is not" shape this repo keeps
 * removing.
 */
export function ResourceMentionCard({
  resource,
  onRemove,
}: {
  resource: ResolvedResource;
  onRemove?: () => void;
}) {
  return (
    <ResourceCard
      variant="row"
      // `ResolvedResource` IS the host's projection — `projectSafeGenerationResource`
      // builds both this endpoint's `items[]` and `RESOURCE_PICKER_RESULT.selected`
      // — so it is passed through, not re-shaped. The component's own doc says:
      // do not pre-format it and do not re-type it locally.
      resource={resource}
      // No `thumbnailUrl`: `BlockResourceInfo` carries no image field and the
      // host's picker returns none, so the absence is the NORMAL case and the
      // component is built for it.
      data-testid={`mention-${resource.versionId}`}
      style={{ maxWidth: '100%' }}
      actions={
        onRemove ? (
          // 🔴 THE NAME IS RESOURCE-SPECIFIC, NOT "Remove". A composer can carry
          // up to `MAX_MENTIONS` (8) chips, and eight controls all announced as
          // "Remove" are eight indistinguishable targets to a screen-reader user.
          // `resourceDisplayName` rather than `resource.modelName` so the control
          // and the card agree about what this resource is CALLED even when the
          // name is absent — a button announced "Remove " is worse than one
          // announced "Remove #8765".
          <IconButton
            label={`Remove ${resourceDisplayName(resource)}`}
            icon="close"
            onClick={onRemove}
            testId={`remove-mention-${resource.versionId}`}
            size={13}
          />
        ) : undefined
      }
    />
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
  /**
   * Closes the whole affordance — the launcher AND the menu.
   *
   * 🔴 THIS PROP EXISTED AND NOTHING PASSED IT, which made it a control that
   * READ as gated while being fully live. `ChatArea` now wires it to the send
   * gate; see the note at that call site for which conditions and why.
   */
  disabled?: boolean;
}) {
  // 🔴 THE MENU IS GATED TOO, NOT JUST THE BUTTON. Disabling the launcher alone
  // is a SPELLED guard: a menu already open when the gate closes keeps four live
  // buttons that call `onPick` directly, so the hazard survives in a different
  // shape. Derived rather than pushed into state, so the two cannot drift.
  //
  // KNOWN AND ACCEPTED: `open` is the parent's state and is not reset here, so a
  // menu opened before the gate closed reappears when it reopens. That is a
  // menu the viewer themselves opened, on a composer that can now attach —
  // surprising at worst, and strictly better than resetting parent state from a
  // presentational component.
  const menuVisible = open && !disabled;
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <Button
        variant="light"
        size="sm"
        onClick={() => onOpenChange(!open)}
        disabled={disabled}
        data-testid="add-mention-button"
        aria-expanded={menuVisible}
        title="Attach a model from the Civitai catalog"
      >
        ＋ Model
      </Button>
      {menuVisible && (
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
