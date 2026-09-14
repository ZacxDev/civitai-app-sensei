import { describe, it, expect } from 'vitest';
import {
  BrowsingLevel,
  SFW_LEVELS,
  effectiveBrowsingCeiling,
  isLevelAllowed as sdkIsLevelAllowed,
} from '@civitai/app-sdk/blocks';
import { NSFW_MODE_LEVEL, clampModelToMaturity, nsfwModeAllowed } from './maturity.js';
import { NSFW_MODEL_ID, SFW_MODEL_ID } from './models.js';

/**
 * 🔴 DRIVEN THROUGH THE SDK'S OWN POLICY FUNCTIONS, NOT THROUGH A HAND-WRITTEN
 * `isLevelAllowed` STUB. A stub would make these cases assertions about the stub:
 * the thing that can actually be wrong is whether a (domain ceiling, viewer level)
 * pair resolves the way the platform resolves it, and `effectiveBrowsingCeiling` +
 * `isLevelAllowed` are the platform's answer, shipped as pure functions. So the
 * fixture below builds the hook's `isLevelAllowed` exactly as `useDomainMaturity`
 * does and the tests pass real bitmasks through it.
 */
/**
 * 🔴 THE FIXTURE RETURNS THE WHOLE HOOK SHAPE, NOT JUST THE ONE FIELD THE
 * IMPLEMENTATION HAPPENS TO READ — and that is a measured correction, not
 * thoroughness for its own sake.
 *
 * The first version returned `{ isLevelAllowed }` alone. Mutant P — the
 * `maxBrowsingLevel`/domain-ceiling implementation this module exists to forbid —
 * then read `undefined`, resolved to `false` everywhere, and was killed ONLY by
 * the positive control while the DISCRIMINATING case ("red domain, viewer opted
 * out") passed for entirely the wrong reason: not because the gate is
 * viewer-aware, but because the mutant could see nothing at all. A fixture that
 * withholds the field a wrong implementation would reach cannot tell a right
 * implementation from a blind one.
 *
 * So every field `useDomainMaturity` really projects is supplied, resolved through
 * the SDK's own functions. A wrong implementation now has the wrong answer
 * AVAILABLE to it, which is the only condition under which choosing the right one
 * is observable.
 */
function maturityFor(ceiling?: number | null, viewerLevel?: number | null) {
  const effective = effectiveBrowsingCeiling(ceiling, viewerLevel);
  return {
    // Supplied precisely so a `domain`/domain-ceiling implementation is REACHABLE
    // and therefore killable here, not only in the seam test.
    maxBrowsingLevel: ceiling ?? undefined,
    effectiveBrowsingLevel: viewerLevel ?? undefined,
    isSfw: !sdkIsLevelAllowed(BrowsingLevel.R, effective),
    isLevelAllowed: (level: number) => sdkIsLevelAllowed(level, effective),
  };
}

describe('🔴 nsfwModeAllowed — the gate on the uncensored arm', () => {
  it('is gated on the X bit, not on a domain string', () => {
    // Pins the BINDING, not a number: the constant must be a real `BrowsingLevel`
    // bit rather than something that happens to equal one today.
    expect(NSFW_MODE_LEVEL).toBe(BrowsingLevel.X);
  });

  it('🔴 FAIL CLOSED: no ceiling at all ⇒ hidden', () => {
    // A host that predates the projection sends neither field. The SDK's
    // fail-closed default is SFW-only, so the toggle must not appear.
    expect(nsfwModeAllowed(maturityFor(undefined, undefined))).toBe(false);
    expect(nsfwModeAllowed(maturityFor(null, null))).toBe(false);
  });

  it('🔴 FAIL CLOSED: before BLOCK_INIT lands ⇒ hidden', () => {
    // Same absent-ceiling shape, different cause, and it is the one that would
    // otherwise flash an uncensored affordance for the width of a handshake on
    // EVERY boot — including on a green domain.
    expect(nsfwModeAllowed(maturityFor(undefined))).toBe(false);
  });

  it('a green/blue domain (SFW ceiling) ⇒ hidden', () => {
    expect(nsfwModeAllowed(maturityFor(SFW_LEVELS))).toBe(false);
    expect(nsfwModeAllowed(maturityFor(BrowsingLevel.PG | BrowsingLevel.PG13))).toBe(false);
  });

  it('🔴 A RED DOMAIN WHOSE VIEWER OPTED OUT ⇒ HIDDEN — the case `domain === "red"` gets wrong', () => {
    // THE POINT OF THE WHOLE DESIGN. `maxBrowsingLevel` is a property of the
    // DOMAIN, so it is identical for every viewer on civitai.red — including one
    // who has turned their own NSFW setting off. An implementation reading the
    // `domain` string, or reading `maxBrowsingLevel` instead of the effective
    // ceiling, offers an uncensored model to exactly that person, and is GREEN in
    // any test that only ever drives a domain.
    const redCeiling =
      BrowsingLevel.PG | BrowsingLevel.PG13 | BrowsingLevel.R | BrowsingLevel.X | BrowsingLevel.XXX;

    // Viewer capped at PG13 on a full-ceiling domain.
    expect(nsfwModeAllowed(maturityFor(redCeiling, SFW_LEVELS))).toBe(false);
    // Viewer who allows R but not X — still no, because an uncensored model's
    // output is not bounded at R and the host would withhold it after charging.
    expect(
      nsfwModeAllowed(maturityFor(redCeiling, BrowsingLevel.PG | BrowsingLevel.PG13 | BrowsingLevel.R)),
    ).toBe(false);
  });

  it('🔴 POSITIVE CONTROL: a red domain AND a viewer who allows X ⇒ SHOWN', () => {
    // Without this, every refusal above is satisfied by `nsfwModeAllowed` returning
    // `false` unconditionally — a gate wired to nothing is indistinguishable from a
    // gate that works when you only ever read zeros.
    const redCeiling =
      BrowsingLevel.PG | BrowsingLevel.PG13 | BrowsingLevel.R | BrowsingLevel.X | BrowsingLevel.XXX;
    expect(nsfwModeAllowed(maturityFor(redCeiling, redCeiling))).toBe(true);
    // And with no per-viewer field at all (an older host), the domain ceiling
    // stands — which is the documented "upgrading is safe" behaviour.
    expect(nsfwModeAllowed(maturityFor(redCeiling, undefined))).toBe(true);
  });

  it('a MALFORMED viewer level is not a licence to widen', () => {
    // `-1` is the counter-intuitive one: two's complement sets every high bit, so a
    // masked `-1` resolves to the FULL domain ceiling — junk reading as the widest
    // possible viewer. The SDK fails it closed to `ceiling ∩ SFW`.
    const redCeiling = 31;
    expect(nsfwModeAllowed(maturityFor(redCeiling, -1))).toBe(false);
    expect(nsfwModeAllowed(maturityFor(redCeiling, Number.NaN))).toBe(false);
  });
});

describe('🔴 clampModelToMaturity — hiding the control is not the guard', () => {
  it('replaces the NSFW arm with the SFW arm when the gate is shut', () => {
    // `settings.model` is PERSISTED, so a viewer who chose the uncensored arm on a
    // red domain and then narrowed their own level still has that id in storage.
    // Without this the app would go on SENDING it with the toggle nowhere on
    // screen — a state no amount of care in the component can reach, because the
    // component is not what puts the model on the wire.
    expect(clampModelToMaturity(NSFW_MODEL_ID, false)).toBe(SFW_MODEL_ID);
  });

  it('🔴 leaves the NSFW arm ALONE when the gate is open — negative control', () => {
    // Without this, the clamp is satisfied by one that always returns the SFW arm,
    // i.e. by a feature that can never be switched on.
    expect(clampModelToMaturity(NSFW_MODEL_ID, true)).toBe(NSFW_MODEL_ID);
  });

  it('is TOTAL — any other stored model passes through untouched, either way', () => {
    // Both still on the host allowlist and both reachable from settings written by
    // an older build. Clamping them would be us overwriting a choice a viewer may
    // have made on purpose.
    for (const allowed of [false, true]) {
      expect(clampModelToMaturity('deepseek/deepseek-chat', allowed)).toBe('deepseek/deepseek-chat');
      expect(clampModelToMaturity('openai/gpt-4o-mini', allowed)).toBe('openai/gpt-4o-mini');
      expect(clampModelToMaturity(SFW_MODEL_ID, allowed)).toBe(SFW_MODEL_ID);
    }
  });

  it('the two arms are distinct, and neither is the other', () => {
    // Cheap, but it is the assertion that catches a copy-paste making both
    // constants the same id — which would make every clamp test above pass
    // vacuously.
    expect(SFW_MODEL_ID).not.toBe(NSFW_MODEL_ID);
  });
});
