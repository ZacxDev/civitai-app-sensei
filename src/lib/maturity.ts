import { BrowsingLevel } from '@civitai/app-sdk/blocks';
import { NSFW_MODEL_ID, SFW_MODEL_ID } from './models.js';

/**
 * THE ONE GATE ON NSFW MODE, AND THE CLAMP BEHIND IT.
 *
 * 🔴 GATED ON `useDomainMaturity().isLevelAllowed`, NEVER ON THE `domain`
 * STRING. The SDK documents `domain` as "Informational ONLY", and
 * `maxBrowsingLevel` is a property of the DOMAIN — identical for every viewer on
 * `civitai.red`, INCLUDING one who has turned their own NSFW setting off. A
 * `domain === 'red'` implementation therefore offers an uncensored model to a
 * viewer who asked the platform not to show them mature content, and it is green
 * in every test that only ever drives a domain. `isLevelAllowed` is the domain
 * ceiling INTERSECTED with that viewer's own level, which is the question being
 * asked.
 *
 * 🔴 IT ALSO FAILS CLOSED, WHICH IS THE OTHER HALF. `isLevelAllowed` answers
 * SFW-only before `BLOCK_INIT` lands and against a host that projects no ceiling
 * at all — so the toggle is hidden during boot and on an old host, rather than
 * flashing an uncensored affordance for the width of a handshake.
 *
 * 🔴 AND IT ALIGNS THE APP'S GATE WITH THE SERVER'S RATHER THAN INVENTING A
 * SECOND ONE. The host withholds `NSFW`-labelled output against the same
 * server-minted ceiling this hook projects; a block cannot opt itself in by
 * sending a flag. So a toggle shown past this gate would buy a reply the host
 * refuses to release — charged, with nothing to show — which is why the clamp
 * below exists as well as the hidden control.
 */

/**
 * The bit NSFW mode is gated on.
 *
 * 🔴 `X`, NOT `R`, AND THE CHOICE IS ABOUT WHAT THE VIEWER GETS FOR THEIR BUZZ.
 * An uncensored model's output is not bounded at R — that is what "uncensored"
 * means — so offering it to a viewer whose ceiling stops at R buys a reply the
 * host's output scan will WITHHOLD, on a submit that was already quoted and
 * charged. Gating on the higher bit means the toggle appears only where the
 * answer can actually be released. It is the conservative direction on both
 * axes: a viewer who may see R but not X keeps the grounded SFW arm, which is
 * the one that can still look things up.
 */
export const NSFW_MODE_LEVEL: number = BrowsingLevel.X;

/**
 * The `useDomainMaturity()` surface this module needs — the ONE viewer-aware
 * predicate, nothing else.
 *
 * Declared structurally rather than importing `DomainMaturity`, so this module
 * (and its test) stay in the `node` vitest project: `@civitai/blocks-react`'s
 * hook entry pulls React in, and the only thing worth testing here is the
 * policy, which is pure.
 */
export interface MaturityGate {
  isLevelAllowed: (level: number) => boolean;
}

/** Whether this viewer, here, may be offered the uncensored arm. */
export function nsfwModeAllowed(maturity: MaturityGate): boolean {
  return maturity.isLevelAllowed(NSFW_MODE_LEVEL);
}

/**
 * The model the app will actually SEND, given what the viewer has selected and
 * whether they may be offered NSFW mode.
 *
 * 🔴 HIDING THE CONTROL IS NOT A GUARD — ONLY THIS BRANCH IS. `settings.model`
 * is PERSISTED per viewer, so a viewer who selected the uncensored arm on a red
 * domain and then narrowed their own browsing level (or opened the app on a
 * green one) still has that id in storage. Without this clamp the app would go on
 * sending it with the toggle nowhere on screen — a state no amount of care in
 * the component can reach, because the component is not what puts the model on
 * the wire.
 *
 * Total: anything that is not the NSFW arm passes through untouched, so a viewer
 * on `deepseek/deepseek-chat` or `openai/gpt-4o-mini` (both still on the host
 * allowlist, both reachable from settings written by an older build) keeps what
 * they had.
 */
export function clampModelToMaturity(model: string, nsfwAllowed: boolean): string {
  if (model === NSFW_MODEL_ID && !nsfwAllowed) return SFW_MODEL_ID;
  return model;
}
