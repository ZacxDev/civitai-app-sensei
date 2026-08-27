import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

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
