import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MAX_CORRECTION_ROUNDS } from './lib/grounding.js';
import { MAX_TOOL_RESULT_MESSAGES } from './lib/tools.js';

/**
 * 🔴 THE STORE READS ONE VERSION AND THE BUILD READS THE OTHER.
 *
 * `block.manifest.json` is what the platform reads: it decides the submitted
 * version, and `civitai app submit` refuses anything not above the highest
 * approved one. `package.json` is what the build and the toolchain read. A
 * release that bumps only one of them is a real, shippable defect, and nothing
 * else in this repo notices it.
 *
 * That is not hypothetical. On 2026-08-27 a batch that added the manifest's
 * `repository` key bumped the manifest and left `package.json` behind in SEVEN
 * apps at once. Two of them — civitai-app-model-benchmarking and
 * civitai-app-playable-collections — already had this assertion and went red
 * immediately (`expected '0.3.2' to be '0.3.1'`). The other five, this repo
 * among them, took the same bad change silently and one of them MERGED and
 * shipped that way. This file is the port of the guard that worked.
 *
 * Deliberately NOT a literal (`toBe('1.2.3')`). A literal pins nothing worth
 * knowing — "the version is the version" teaches a reader nothing — and it rots
 * on every single bump, turning the default branch red on a release that broke
 * nothing. A permanently-red gate is worse than no gate: it trains everyone to
 * merge through it, and the next real defect arrives looking exactly like this
 * one. The relationship between the two files cannot rot on a bump, and it
 * still fires when someone bumps only one.
 *
 * Read off disk rather than imported, on purpose: it asserts against the bytes
 * on disk that actually ship, and it stays correct if `resolveJsonModule` or
 * the `include` scope in `tsconfig.json` ever changes. `import.meta.url` makes
 * the paths independent of the working directory the runner happens to use.
 */
function versionOf(relativePath: string): string {
  const raw = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string') {
    // Not a soft pass: a missing `version` is exactly the state this guard
    // exists to notice, so it must fail loudly rather than compare undefined
    // against undefined and go green.
    throw new Error(`${relativePath} has no string "version" field`);
  }
  return parsed.version;
}

describe('release versions', () => {
  it('keeps block.manifest.json and package.json versions in lockstep', () => {
    const manifestVersion = versionOf('../block.manifest.json');
    expect(manifestVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(versionOf('../package.json')).toBe(manifestVersion);
  });
});

/**
 * 🔴 THE CONSENT COPY QUOTES A COST CEILING, AND NOTHING TIED IT TO THE CODE.
 *
 * `scopeJustifications["ai:write:budgeted"]` is what a viewer reads before
 * granting the scope that spends their Buzz. It named "up to 4 budgeted
 * requests" from 0.1.6 until 0.1.11 — and #27 (the bounded correction round)
 * had already made 5 reachable. Nobody noticed, because the number lived in
 * prose and the caps lived in two other modules. That is a DISCLOSURE gap, not
 * a cosmetic one: the copy understated what the viewer was consenting to pay.
 *
 * The reachable maximum, derived rather than counted by hand: every submit
 * either returns tool calls or does not. Ones that DO consume at least one
 * tool-result slot, so there are at most `MAX_TOOL_RESULT_MESSAGES` of them —
 * the loop breaks before executing calls that would exceed it. Ones that do
 * NOT are the answer itself, and the first such answer can fire at most
 * `MAX_CORRECTION_ROUNDS` corrective re-submits, each of which produces one
 * more. So the ceiling is `MAX_TOOL_RESULT_MESSAGES + 1 + MAX_CORRECTION_ROUNDS`,
 * and it holds whatever order the rounds arrive in.
 *
 * 🔴 Deliberately NOT a literal `toContain('up to 5')`, for the same reason the
 * version guard above is not one: a literal pins the number somebody typed, not
 * the number the code can actually reach, so it would have gone green on the
 * wrong value for the whole time the defect existed. This asserts the
 * RELATIONSHIP — change either cap and this goes red, pointing at the sentence
 * that has to be rewritten.
 *
 * The extractor is defined ONCE and shared. A guard whose "control" re-spells
 * its own regex proves nothing: breaking the assertion's copy would leave the
 * control green with the defect fully reinstated.
 */
const BUDGETED_CEILING_RE = /Up to (\d+) budgeted requests per question/;

function disclosedCeiling(): number {
  const raw = readFileSync(new URL('../block.manifest.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as {
    scopeJustifications?: Record<string, unknown>;
  };
  const text = parsed.scopeJustifications?.['ai:write:budgeted'];
  if (typeof text !== 'string') {
    throw new Error('block.manifest.json has no ai:write:budgeted justification');
  }
  const m = BUDGETED_CEILING_RE.exec(text);
  if (!m) {
    // Not a soft pass. A justification that no longer states a ceiling is the
    // state this guard exists to notice — a reworded sentence that quietly
    // drops the number discloses less, not more.
    throw new Error(
      `ai:write:budgeted states no "Up to N budgeted requests per question" ceiling: ${text}`,
    );
  }
  return Number(m[1]);
}

describe('consent copy', () => {
  it('discloses the cost ceiling the submit loop can actually reach', () => {
    expect(disclosedCeiling()).toBe(
      MAX_TOOL_RESULT_MESSAGES + 1 + MAX_CORRECTION_ROUNDS,
    );
  });

  it('🔴 the extractor can FAIL — it is not a regex that matches anything', () => {
    // The positive half of the control. Without this, a `BUDGETED_CEILING_RE`
    // that had been broken into matching nothing would surface as a thrown
    // error above and read like a manifest problem rather than a guard problem.
    expect(BUDGETED_CEILING_RE.exec('no ceiling stated here')).toBeNull();
    expect(
      BUDGETED_CEILING_RE.exec('Up to 7 budgeted requests per question')?.[1],
    ).toBe('7');
  });
});
