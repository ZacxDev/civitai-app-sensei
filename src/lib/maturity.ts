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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THIS IS TESTED, AND WHY EVERY MOCK IN THE SUITE SAYS `false`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * All 22 test files that mock `@civitai/blocks-react` stub the hook as
 * `useDomainMaturity: () => ({ isSfw: true, isLevelAllowed: () => false })`.
 * That is fail-closed SFW: what a green/blue-domain viewer really gets, and also
 * what the hook returns before `BLOCK_INIT` lands. So every case in those files
 * runs with NSFW mode hidden and the SFW arm on the wire — the production
 * default. 🔴 DO NOT READ THAT LITERAL AS THE CONTRACT. It is a fixture value,
 * and the two places that actually exercise the policy are:
 *
 *   • `lib/maturity.test.ts` — the policy math, resolved through the SDK's own
 *     `effectiveBrowsingCeiling`/`isLevelAllowed` rather than through a stub, so
 *     a mutant that swaps the ceiling for the `domain` string dies there.
 *   • `components/SettingsBar.test.tsx` — the component gate, including the
 *     discriminating red-domain-but-viewer-opted-out case and the positive
 *     control that stops "hidden" being satisfied by a toggle that never
 *     renders at all.
 *
 * This paragraph is here ONCE on purpose. It was previously pasted verbatim into
 * all 22 files — ~154 lines restating one fact, which is the "one rule, one
 * place" failure applied to prose: 22 copies drift, and a reader who finds one
 * has no way to know it is a copy. The mock LINE has to be in each factory; the
 * explanation does not, and each site now carries a two-line pointer here.
 */

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ASK WAS DOMAIN-SHAPED. THE GATE IS CEILING-SHAPED. THEY COINCIDE — AND
 * THIS IS THE ONLY PLACE THAT RECORDS WHY.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The request this control answers was phrased as a DOMAIN rule: show the NSFW
 * toggle "only on .red … and not on .com". What is implemented above is
 * `isLevelAllowed(BrowsingLevel.X)` over the effective browsing ceiling — a
 * LEVEL predicate. Those are not obviously the same set, and nothing in THIS
 * repo makes them one, so the equivalence was read out of the host on
 * 2026-09-13 and is written down here rather than left to be re-derived by the
 * next reader (who would otherwise, reasonably, suspect the ask was missed):
 *
 *   • `civitai/civitai` `src/server/routers/blocks.router.ts:483-501` —
 *     `resolveBlockMaturity` derives `isGreen: allowMatureContent === false`
 *     from the host-minted `maxBrowsingLevel`, i.e. from the CEILING, and its
 *     own comment at `:496-499` states the choice: "Tie it to the maturity
 *     ceiling rather than the literal green domain: a blue (SFW, per the
 *     App-Blocks product decision) block gets the SFW audit too."
 *
 *   • `civitai/civitai` `src/server/utils/buzz-helpers.ts:130-138` — states the
 *     mapping outright: the ceiling is "identical in result to keying on the
 *     domain (green domain ⇒ SFW ceiling; red domain ⇒ mature ceiling)", where
 *     SFW covers green AND blue and mature is red. It gives the reason the
 *     ceiling is preferred: it is FORGE-SAFE, where the advisory `domain`
 *     string is not.
 *
 * And a viewer's own setting can only NARROW a ceiling, never widen it — that
 * is exactly what `effectiveBrowsingCeiling` computes. So the state a level
 * gate would let through and a domain gate would not — an adult opted-in `.com`
 * viewer whose effective ceiling carries the `X` bit — CANNOT EXIST upstream.
 * The level predicate answers the domain question, and answers it more safely
 * than a domain check would, because `domain` is a string the SDK documents as
 * informational and the host itself declines to key on.
 *
 * 🔴 THIS IS A CROSS-REPO READING OF ANOTHER REPO AT A POINT IN TIME. IT IS NOT
 * AN INVARIANT THIS REPO ASSERTS, AND NO GATE IN EITHER REPO COVERS THE
 * COUPLING. Nothing in `src/` can see `blocks.router.ts`; no test here goes red
 * if the two files above change. The consequence, stated plainly: if upstream
 * ever revises the blue ⇒ SFW product decision, or stops deriving `isGreen`
 * from the ceiling, THIS APP BEGINS OFFERING THE UNCENSORED TOGGLE ON `.com`
 * SILENTLY. Nothing fails, the disclosure copy still renders, and the first
 * signal is a viewer on the green domain being shown an uncensored affordance.
 * Re-read both files before trusting this paragraph.
 *
 * 🔴 AND DO NOT `&&` A `domain` CHECK IN AS BELT-AND-BRACES. The SDK documents
 * that field as informational; it is the WEAKER input. ANDing a weaker signal
 * into a stronger one buys no safety and creates a second place for one policy
 * to live — the failure this file's own `clampModelToMaturity` note is about.
 * If the coupling above ever needs enforcing, the instrument is a guard in
 * `civitai/civitai`, not a second predicate here.
 */

/**
 * The bit NSFW mode is gated on.
 *
 * 🔴 `X`, NOT `R` — AND THE JUSTIFICATION IS AN ASSUMPTION, NOT A MEASUREMENT.
 * The argument is that an uncensored model's output is not bounded at R (that is
 * what "uncensored" means), so offering it to a viewer whose ceiling stops at R
 * would buy a reply the host's output scan WITHHOLDS, on a submit that was
 * already quoted and charged.
 *
 * ⚠️ NOBODY HAS OBSERVED THAT, and it is not observable here. The spend loop is
 * Turnstile + auth gated, so no local run, harness run or test in this repo can
 * produce a charged R-capped submit and read whether its output came back
 * released or withheld. Read the paragraph above as the reason the narrowing was
 * CHOSEN, not as evidence that the wider gate misbehaves.
 *
 * It is kept anyway because it is the cheap direction on both axes. If the
 * assumption is WRONG, the whole cost is that a viewer who may see R but not X
 * keeps the grounded SFW arm — the one that can still look things up — which is
 * a smaller loss than a charged reply with nothing to show. And it is reversible
 * in one token.
 *
 * 🔴 WHAT WOULD SETTLE IT: one real submit on the uncensored arm, in a real
 * mod-gated host, as a viewer whose effective ceiling allows `R` but not `X` —
 * then read whether the reply was released or withheld and whether Buzz moved.
 * That needs a human in that host; nothing in this repo can run it.
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

/**
 * Whether this model may be NAMED to this viewer at all.
 *
 * 🔴 DERIVED FROM THE CLAMP, NOT A SECOND PREDICATE. "Offerable" is exactly
 * "the clamp leaves it alone", so this asks the one rule rather than restating
 * it — the failure mode `clampModelToMaturity`'s own note is about. Add a second
 * gated model and both answers move together with no edit here.
 *
 * 🔴 WHY A SEPARATE QUESTION IS NEEDED AT ALL, given the clamp. The clamp
 * answers "what do I SEND"; a label answers "what do I SHOW", and substituting
 * is wrong for the second one. A sidebar row records the model a past
 * conversation actually used, so a row holding the uncensored id must go SILENT
 * rather than be relabelled with the clamp's target — relabelling would tell the
 * viewer that conversation ran on a model it did not run on.
 *
 * The consumer is `SessionList`. `SettingsBar.tsx:91-94` already forbids the
 * mirror image for the toggle — "an advertisement for something the platform has
 * decided they will not be shown, on a surface that cannot explain why" — and the
 * sidebar was applying the opposite rule to the same fact.
 */
export function isModelOfferable(model: string, nsfwAllowed: boolean): boolean {
  return clampModelToMaturity(model, nsfwAllowed) === model;
}
