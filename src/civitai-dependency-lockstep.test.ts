/**
 * THE `@civitai/*` PACKAGES MOVE AS ONE SET, AND NOTHING USED TO CHECK IT.
 *
 * `@civitai/blocks-react` declares EXACT pins for `@civitai/theme` and
 * `@civitai/components` in its own `dependencies` (at 0.49.0: `theme 0.3.1`,
 * `components 0.4.1`), and `@civitai/components-react` declares exact pins for the
 * same two. Exact pins on both sides cannot be deduped, so bumping `app-sdk` +
 * `blocks-react` while leaving `components-react` and `theme` behind installs a
 * SECOND copy of each. Measured: with `package.json` at `blocks-react ^0.49.0` +
 * `components-react ^0.3.0` + `theme ^0.2.0`, `node_modules/.pnpm` holds
 * `@civitai+components@{0.3.1,0.4.1}` and `@civitai+theme@{0.2.1,0.3.1}`.
 *
 * ── WHAT THE SKEW ACTUALLY DOES, MEASURED IN THAT STATE ─────────────────────
 *
 * `src/main.tsx` reaches the theme twice, by two different resolutions, and only
 * one of them is the app's own dependency:
 *
 *   - line 7, `import '@civitai/theme/styles.css'` — resolves through the APP'S
 *     DIRECT dependency. In the skew state that is `theme@0.2.1`.
 *   - lines 15-16, `injectBlocksStyles()` then `injectStyles()` — resolve through
 *     `blocks-react`'s own pins. Probed in jsdom in the skew state: exactly THREE
 *     `<style>` elements land — `data-civitai-theme` (5826 bytes = `theme@0.3.1`
 *     exactly), `data-civitai-components` (≈31.9 kB = `components@0.4.1`, not
 *     0.3.1's 28.0 kB) and `data-civitai-blocks-ui`.
 *
 * 🔴 SO `components-react`'s `injectStyles()` AT LINE 16 IS A COMPLETE NO-OP HERE,
 * and an earlier draft of this note had it backwards. Both copies of
 * `@civitai/components` spell their marker `data-civitai-components`, so the
 * second caller's `querySelector` finds the first caller's sheet and returns
 * early — first writer wins, and `injectBlocksStyles()` is the first writer. The
 * skew therefore does NOT ship old component CSS into a new tree; the runtime CSS
 * is entirely `blocks-react`'s pins. Do not re-derive "two injectors, both inject"
 * — it was measured false.
 *
 * 🔴 THE ONE THING THAT ACTUALLY DIVERGES IS WHAT THE BOOT-PARITY TEST MEASURES.
 * `src/bootTokens.test.ts` asserts every hardcoded boot colour in `index.html`
 * against "the INSTALLED `@civitai/theme`", and it finds that theme by resolving
 * `@civitai/theme/styles.css` — the line-7 resolution, i.e. the DIRECT dependency.
 * The rendered tree uses the line-15 one. Measured in the skew state:
 * `bootTokens.test.ts` is GREEN while pinning `index.html` against `theme@0.2.1`
 * and the document is painted by `theme@0.3.1`. It is not that the test fails to
 * fire — it fires against the wrong stylesheet and reports success. That is what
 * this file refuses, and it is the defensible reason the `sdk-pair-bump` PR moved
 * four packages rather than the two its ledger entry named.
 *
 * 🔴 STATED AT THE STRENGTH IT WAS MEASURED, WHICH IS NOT VERY. At these exact
 * versions the skew's visible consequence is UNCONFIRMED: `theme` 0.2.1 → 0.3.1 is
 * purely ADDITIVE (five `--civitai-bp-*` variables; every pre-existing declaration
 * byte-identical, `diff`ed) and nothing in `src/` or `index.html` references them
 * (grepped, with a positive control on `--civitai-color`). **Nobody has rendered
 * either state.** So this guard is NOT justified by a demonstrated visual defect —
 * it is justified by the parity test above being structurally unable to see the
 * divergence, which is what makes the NEXT theme release that changes a VALUE ship
 * silently. Do not upgrade this into a claim about a layout bug.
 *
 * 🔴 THE CLASS-IDENTITY MECHANISM IS RETRACTED — DO NOT RE-DERIVE IT. The bump's
 * first draft justified the four-package scope by saying two copies of
 * `blocks-react` would be two class identities, so the `instanceof
 * WorkflowEstimateError` / `instanceof WorkflowSubmitError` branches in
 * `lib/orchestrator-bridge.ts` would silently return false and the viewer would be
 * shown the SDK's developer-facing constant. **That is unreachable, and it was
 * measured false.** No `@civitai` package depends on `@civitai/blocks-react` at
 * all — `app-sdk` declares no dependencies; `blocks-react` and `components-react`
 * each depend on `{theme, components}`; `components` on `{theme}`; `theme` on
 * nothing — so `blocks-react` is in the tree only as this app's DIRECT dependency
 * and no transitive path can introduce a second copy. `app-sdk` is the same: its
 * only in-tree declarer is `blocks-react`, as a PEER, which resolves to the app's
 * own copy. `theme` and `components` duplicate; `blocks-react` and `app-sdk`
 * cannot. Confirmed behaviourally too: in the skew state all 71
 * `orchestrator-bridge.test.ts` tests pass, including every one of the 16
 * `instanceof` guards the claim said would break.
 *
 * ── RED → GREEN, so this is not trusted on its wording ──────────────────────
 *
 *   - GREEN at `trunk`'s four packages (app-sdk 0.31.0, blocks-react 0.39.0,
 *     components-react 0.3.0, theme 0.2.0). **So this is an INVARIANT guard with
 *     respect to `trunk`, not regression coverage** — nothing had broken it.
 *   - GREEN at this PR's four (0.39.0 / 0.49.0 / 0.4.1 / 0.3.1).
 *   - **RED in the two-package skew state**: 4 of the 7 cases fail, each with its
 *     own message — `@civitai/components is installed 2 times: 0.3.1, 0.4.1`;
 *     `components-react@0.3.1 pins @civitai/components@0.3.1 but
 *     blocks-react@0.49.0 pins 0.4.1`; `bootTokens.test.ts asserts index.html
 *     against @civitai/theme@0.2.1, but blocks-react@0.49.0 renders against
 *     0.3.1`; and the duplicate ledger. Green at two version sets and red at the
 *     one that is wrong is the whole claim.
 *   - In that same skew state the **entire rest of the suite is green** — 56 files
 *     / 670 tests — which is why this file exists at all.
 *
 * Every expectation is read out of the INSTALLED packages, never from a number
 * typed here, so a routine bump moves them together and cannot rot this file into
 * a vacuous pass.
 */
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const NODE_MODULES = join(REPO_ROOT, 'node_modules');

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

function readManifest(packageJsonPath: string): Manifest {
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Manifest;
  if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
    throw new Error(`not a package manifest: ${packageJsonPath}`);
  }
  return parsed;
}

/**
 * Every `@civitai/*` manifest physically present under `node_modules`, deduped by
 * REALPATH so pnpm's symlink farm is counted once per store entry rather than once
 * per link. Returns name → sorted list of distinct installed versions.
 *
 * Deliberately a directory walk rather than `pnpm list` output: parsing a tool's
 * text makes its FORMAT an unpinned dependency, and an empty match set would then
 * read as "no duplicates" when it may mean "wrong pattern". `atLeastFivePackages`
 * below is the positive control that this walk finds anything at all.
 */
function installedCivitaiVersions(): Map<string, string[]> {
  const byName = new Map<string, Set<string>>();
  const seen = new Set<string>();

  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.name === '@civitai') {
        for (const pkg of readdirSync(path, { withFileTypes: true })) {
          let manifestPath;
          try {
            manifestPath = realpathSync(join(path, pkg.name, 'package.json'));
          } catch {
            continue;
          }
          if (seen.has(manifestPath)) continue;
          seen.add(manifestPath);
          const manifest = readManifest(manifestPath);
          const versions = byName.get(manifest.name) ?? new Set<string>();
          versions.add(manifest.version);
          byName.set(manifest.name, versions);
        }
        continue;
      }
      if (entry.isDirectory()) walk(path, depth + 1);
    }
  };

  walk(NODE_MODULES, 0);
  return new Map([...byName].map(([name, versions]) => [name, [...versions].sort()]));
}

const INSTALLED = installedCivitaiVersions();

/** The single installed version of a package, or a failure naming what it found. */
function soleVersion(name: string): string {
  const versions = INSTALLED.get(name);
  if (!versions || versions.length === 0) throw new Error(`${name} is not installed at all`);
  if (versions.length > 1) {
    throw new Error(`${name} is installed ${versions.length} times: ${versions.join(', ')}`);
  }
  return versions[0];
}

function manifestOf(topLevelPackage: string): Manifest {
  return readManifest(join(NODE_MODULES, topLevelPackage, 'package.json'));
}

/** The `@civitai/*` entries of a manifest's own `dependencies`. */
function civitaiPins(manifest: Manifest): Record<string, string> {
  return Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).filter(([dep]) => dep.startsWith('@civitai/')),
  );
}

const BLOCKS_REACT = manifestOf('@civitai/blocks-react');
const COMPONENTS_REACT = manifestOf('@civitai/components-react');
const BLOCKS_REACT_PINS = civitaiPins(BLOCKS_REACT);

describe('@civitai/* dependency lockstep', () => {
  // ── self-controls: the extractors must be able to FAIL ─────────────────────
  it('the extractors can fail — a missing package throws rather than reading as absent', () => {
    expect(() => manifestOf('@civitai/not-a-real-package')).toThrow();
    expect(() => soleVersion('@civitai/not-a-real-package')).toThrow(/not installed at all/);
  });

  it('atLeastFivePackages — the walk actually finds the tree (positive control)', () => {
    // A zero here would make every "exactly one version" assertion below pass
    // vacuously. Five is what the starters repo publishes; more is fine, fewer is
    // the walk having been broken. `@civitai/components` is named explicitly
    // because it is the one with NO top-level symlink — it exists only inside
    // `.pnpm`, so listing it proves the walk descends rather than reading the
    // top level and stopping.
    expect(INSTALLED.size).toBeGreaterThanOrEqual(5);
    expect([...INSTALLED.keys()].sort()).toContain('@civitai/blocks-react');
    expect([...INSTALLED.keys()].sort()).toContain('@civitai/components');
  });

  it("blocks-react's pins are EXACT versions, which is what makes equality the right test", () => {
    // If upstream ever loosens these to ranges, the assertions below would be
    // comparing a range to a version and this test is where that gets noticed
    // rather than silently inverted into a vacuous pass.
    expect(Object.keys(BLOCKS_REACT_PINS).sort()).toEqual([
      '@civitai/components',
      '@civitai/theme',
    ]);
    for (const [dep, pin] of Object.entries(BLOCKS_REACT_PINS)) {
      expect(pin, `${dep} pin is not an exact version`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  // ── the relationship ───────────────────────────────────────────────────────
  it('every version blocks-react PINS is the only one installed, at exactly that version', () => {
    for (const [dep, pin] of Object.entries(BLOCKS_REACT_PINS)) {
      expect(soleVersion(dep), `${dep}: blocks-react pins ${pin}`).toBe(pin);
    }
  });

  it('components-react pins the SAME versions blocks-react does', () => {
    // The half a `pnpm peers check` cannot see: nothing here is a peer range, so
    // that tool reports `No peer dependency issues found` in the skewed state too.
    const theirs = civitaiPins(COMPONENTS_REACT);
    for (const [dep, pin] of Object.entries(BLOCKS_REACT_PINS)) {
      expect(
        theirs[dep],
        `components-react@${COMPONENTS_REACT.version} pins ${dep}@${theirs[dep]} but ` +
          `blocks-react@${BLOCKS_REACT.version} pins ${pin}`,
      ).toBe(pin);
    }
  });

  it('the theme bootTokens.test.ts measures against is the one blocks-react renders against', () => {
    // 🔴 THE SAME RESOLUTION `bootTokens.test.ts` PERFORMS, not a re-spelling of it:
    // that file does `createRequire(import.meta.url).resolve('@civitai/theme/styles.css')`
    // from `src/`, which goes through the app's DIRECT dependency — the same
    // resolution as `main.tsx`'s line-7 CSS import. Reading the version off the
    // manifest above the resolved stylesheet ties the boot-parity assertions to
    // the theme the rendered tree is actually painted by.
    const stylesheet = createRequire(import.meta.url).resolve('@civitai/theme/styles.css');
    let dir = dirname(stylesheet);
    let resolved: Manifest | undefined;
    for (let up = 0; up < 5 && !resolved; up += 1) {
      try {
        resolved = readManifest(join(dir, 'package.json'));
      } catch {
        dir = dirname(dir);
      }
    }
    expect(resolved?.name, `no package manifest above ${stylesheet}`).toBe('@civitai/theme');
    expect(
      resolved?.version,
      `bootTokens.test.ts asserts index.html against @civitai/theme@${resolved?.version}, but ` +
        `blocks-react@${BLOCKS_REACT.version} renders against ${BLOCKS_REACT_PINS['@civitai/theme']}`,
    ).toBe(BLOCKS_REACT_PINS['@civitai/theme']);
  });

  it('noSecondCopyOfAnyPackage — one installed version per @civitai package', () => {
    // A second instrument on the same question, failing differently from the
    // pin-equality assertions above: it needs no manifest to be read correctly,
    // only the tree to be counted.
    const duplicated = [...INSTALLED].filter(([, versions]) => versions.length > 1);
    expect(
      duplicated.map(([name, versions]) => `${name}: ${versions.join(', ')}`),
      'a second copy of a @civitai package is installed',
    ).toEqual([]);
  });
});
