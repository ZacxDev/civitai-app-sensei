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
 *   - **GREEN over a STALE tree, which is what `installedCivitaiVersions` was
 *     rewritten for** — install `trunk`'s lockfile, copy this PR's `package.json`
 *     + `pnpm-lock.yaml` in, `pnpm install --frozen-lockfile`. Orphaned
 *     `.pnpm/<pkg>@<oldver>` directories survive that install; the guard must not
 *     read them as second copies. It used to, and went red on a correct tree.
 *   - **RED in the two-package skew state**: 4 of the 7 cases fail, each with its
 *     own message — `@civitai/components is installed 2 times: 0.3.1, 0.4.1`;
 *     `components-react@0.3.1 pins @civitai/components@0.3.1 but
 *     blocks-react@0.49.0 pins 0.4.1`; `bootTokens.test.ts asserts index.html
 *     against @civitai/theme@0.2.1, but blocks-react@0.49.0 renders against
 *     0.3.1`; and the duplicate ledger, which now names `@civitai/components` and
 *     `@civitai/theme` and NOTHING ELSE. Green at three tree states and red at the
 *     one that is wrong is the whole claim.
 *   - In that same skew state the **entire rest of the suite is green** — 56 files
 *     / 670 tests — which is why this file exists at all.
 *
 * Every expectation is read out of the INSTALLED packages, never from a number
 * typed here, so a routine bump moves them together and cannot rot this file into
 * a vacuous pass.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
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
 * Every `@civitai/*` package the app can actually RESOLVE, keyed by name → sorted
 * list of distinct versions. Deduped by REALPATH, so pnpm's symlink farm counts
 * once per store entry rather than once per link.
 *
 * 🔴 A RESOLUTION WALK, NOT A STORE WALK — AND THE DIFFERENCE IS THE WHOLE POINT.
 * This function used to `readdirSync` its way down `node_modules` counting every
 * `@civitai` manifest PHYSICALLY PRESENT. That conflates two states this file
 * exists to keep apart, because **`pnpm install --frozen-lockfile` does not prune
 * orphaned `.pnpm/<pkg>@<oldver>` store directories**: they stay on disk, fully
 * populated, with their own sibling links intact, reachable from nothing.
 *
 * So the store walk counted them as second copies, and the failure landed on the
 * ORDINARY REVIEW FLOW — check out a branch over an existing `node_modules`,
 * install, test. Measured: install `trunk`'s lockfile, copy this PR's
 * `package.json` + `pnpm-lock.yaml` in, `pnpm install --frozen-lockfile`. The tree
 * ends at exactly this PR's four versions (`readlink -f node_modules/@civitai/*`
 * confirms it, and `pnpm-lock.yaml` references the orphans zero times) — yet the
 * store walk reported ALL FIVE packages duplicated and 2 of the 7 cases below went
 * red on a CORRECT tree. A permanently-red gate is worse than no gate.
 *
 * 🔴 AND IT MISLED EVEN WHEN IT FIRED CORRECTLY. In the genuine two-package skew
 * the store walk listed `@civitai/components-react: 0.3.1, 0.4.1` — an orphan —
 * beside the two REAL duplicates, with nothing in the message marking which was
 * which. A guard whose output cannot distinguish a skewed tree from a stale one
 * does not answer the question it is asked. Re-measured in the fix round over a
 * tree carrying both, the store walk's ledger read:
 *
 *     @civitai/app-sdk: 0.31.0, 0.39.0
 *     @civitai/blocks-react: 0.39.0, 0.49.0
 *     @civitai/components: 0.3.0, 0.3.1, 0.4.1
 *     @civitai/theme: 0.2.0, 0.2.1, 0.3.1
 *     @civitai/components-react: 0.3.0, 0.3.1, 0.4.1
 *
 * — i.e. it reported `blocks-react` and `app-sdk` duplicated, which the retraction
 * paragraph above proves is UNREACHABLE. The resolution walk reports exactly
 * `@civitai/theme: 0.2.1, 0.3.1` and `@civitai/components: 0.3.1, 0.4.1` on that
 * same tree: the two that genuinely duplicate, and nothing else.
 *
 * What is resolvable is the reachable set, so this walks reachability instead:
 * start at the app's own top-level `node_modules/@civitai/*` links, and from each
 * resolved copy follow ITS dependency scope — the `<store>/node_modules` directory
 * whose `@civitai` entries are the versions THAT copy resolves. An orphan is
 * excluded because nothing links to it; a real duplicate is still found because
 * two reachable packages each link their own copy. `orphansAreNotSecondCopies`
 * below is the control on exactly that, in both directions.
 *
 * 🔴 THE ALTERNATIVES, AND WHY NOT. `createRequire().resolve` needs the names
 * typed here — a spelled list that rots on the next package the starters repo
 * publishes, and it cannot discover `@civitai/components`, which has no top-level
 * link. The lockfile's `snapshots` keys describe the LOCKFILE, so they are green by
 * construction on a tree that disagrees with it — the one hazard `CLAUDE.md` names
 * about this very gate (`pnpm install --frozen-lockfile` prints `Already up to
 * date` over a tree linked to the wrong versions). Reading the tree is the point;
 * reading only the REACHABLE tree is the fix.
 *
 * Deliberately not `pnpm list` output either: parsing a tool's text makes its
 * FORMAT an unpinned dependency, and an empty match set would then read as "no
 * duplicates" when it may mean "wrong pattern". `atLeastFivePackages` below is the
 * positive control that this walk finds anything at all.
 */
function installedCivitaiVersions(nodeModules: string = NODE_MODULES): Map<string, string[]> {
  const byName = new Map<string, Set<string>>();
  const visitedScopes = new Set<string>();

  // Each frontier entry is a `node_modules` directory node would resolve a bare
  // `@civitai/*` specifier from. Seeded with the app's own, which is what makes
  // this a reachability walk rather than a directory sweep.
  const frontier: string[] = [nodeModules];

  while (frontier.length > 0) {
    const scope = frontier.pop() as string;
    let realScope;
    try {
      realScope = realpathSync(scope);
    } catch {
      continue;
    }
    if (visitedScopes.has(realScope)) continue;
    visitedScopes.add(realScope);

    let entries;
    try {
      entries = readdirSync(join(realScope, '@civitai'), { withFileTypes: true });
    } catch {
      continue; // nothing in this scope declares a `@civitai` dependency
    }

    for (const entry of entries) {
      let resolved;
      let manifest;
      try {
        resolved = realpathSync(join(realScope, '@civitai', entry.name));
        // 🔴 BOTH READS INSIDE THE `try`, AND THE STRAY-FILE CASE IS WHY. A
        // non-directory entry in a scope — `.DS_Store`, a `.yaml`, an editor swap
        // file — realpaths FINE, so realpathSync alone does not filter it; the
        // failure lands on `<entry>/package.json` with `ENOTDIR`. With that read
        // outside the `try` it escaped `installedCivitaiVersions`, which runs at
        // MODULE LOAD, so the whole file aborted before a single test name printed:
        // `Test Files 1 failed`, `Tests no tests` — including
        // `atLeastFivePackages`, the positive control. Fail-closed, but the
        // diagnostic reads as a broken gate rather than as one stray byte on disk,
        // and a reader has nothing to tell them which. The store walk this replaced
        // tolerated the entry and ran its cases; with both reads inside the `try`,
        // so does this — measured with the stray file in the real tree, all 9 green.
        manifest = readManifest(join(resolved, 'package.json'));
      } catch {
        continue;
      }
      const versions = byName.get(manifest.name) ?? new Set<string>();
      versions.add(manifest.version);
      byName.set(manifest.name, versions);
      // pnpm materialises a package at `<store>/node_modules/@civitai/<name>`, so
      // the sibling links it resolves THROUGH are two levels up.
      //
      // 🔴 STATED AS THE WALK'S REACH, NOT AS NODE'S ALGORITHM — an earlier version
      // of this comment claimed "Node's own algorithm agrees", which overclaims.
      // `NODE_MODULES_PATHS` yields `<resolved>/node_modules` FIRST, then
      // `<resolved>/../node_modules`, and only then this directory; the walk jumps
      // straight to the third candidate. What it therefore covers is exactly the
      // pnpm isolated layout: an `@civitai` package's own dependency scope is its
      // store sibling directory. Three states it CANNOT see, recorded rather than
      // chased (all three latent today, and the reason for that is measured):
      //   - a copy nested INSIDE a package (`bundleDependencies`), which lives at
      //     the first candidate this skips.
      //   - a duplicate reachable only through a NON-`@civitai` intermediary: the
      //     frontier follows `@civitai → @civitai` edges only. Probed across all
      //     407 manifests under `node_modules/.pnpm`: the only declarers of a
      //     `@civitai` dependency are `blocks-react`, `components-react` and
      //     `components` — 0 non-`@civitai` packages — so there is no such path to
      //     follow, which is what makes both of these latent rather than live.
      //   - a `node-linker=hoisted` install, where `dirname(dirname(resolved))`
      //     lands back on the top-level scope instead of a store sibling. This repo
      //     has no `.npmrc` setting it; nothing here would notice if that changed.
      frontier.push(dirname(dirname(resolved)));
    }
  }

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

  it('orphansAreNotSecondCopies — the walk separates a STALE tree from a SKEWED one', () => {
    // 🔴 THE CONTROL ON THE RESOLUTION WALK, IN BOTH DIRECTIONS — and both halves
    // are load-bearing. A walk that reported 1 version for the skewed tree too
    // would make every "exactly one version" assertion below vacuous, which is a
    // worse failure than the red-on-a-correct-tree one this replaced. So the
    // fixture is built once and read twice, differing ONLY in whether anything
    // links the old copy.
    //
    // The shape mirrors the real skew exactly: two reachable packages (`holder`
    // standing in for `components-react`, `root` for `blocks-react`) each with
    // their own pinned copy of one dependency, laid out the way pnpm lays it out —
    // relative sibling links three levels up out of `<store>/node_modules/@civitai`.
    const scratch = mkdtempSync(join(tmpdir(), 'civitai-lockstep-'));
    try {
      const storeCopy = (pkg: string, version: string): string => {
        const dir = join(scratch, '.pnpm', `${pkg}@${version}`, 'node_modules', '@civitai', pkg);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({ name: `@civitai/${pkg}`, version }),
        );
        return dir;
      };

      storeCopy('dep', '1.0.0'); // the OLD copy: on disk, linked by nobody yet
      storeCopy('dep', '2.0.0');
      storeCopy('holder', '1.0.0');

      // `dep@2.0.0` is the app's own dependency and is the only top-level link.
      mkdirSync(join(scratch, '@civitai'), { recursive: true });
      symlinkSync(
        join('..', '.pnpm', 'dep@2.0.0', 'node_modules', '@civitai', 'dep'),
        join(scratch, '@civitai', 'dep'),
      );

      // POINT A — the stale tree the ordinary review flow produces. `dep@1.0.0` is
      // a fully populated orphan store directory and must not be counted.
      expect(
        [...installedCivitaiVersions(scratch)],
        'an unreachable orphan store directory was counted as a second copy',
      ).toEqual([['@civitai/dep', ['2.0.0']]]);

      // POINT B — the genuine skew. `holder` becomes reachable and pins the OLD
      // copy, so two resolvable copies now exist and the walk must say so.
      symlinkSync(
        join('..', '.pnpm', 'holder@1.0.0', 'node_modules', '@civitai', 'holder'),
        join(scratch, '@civitai', 'holder'),
      );
      symlinkSync(
        join('..', '..', '..', 'dep@1.0.0', 'node_modules', '@civitai', 'dep'),
        join(scratch, '.pnpm', 'holder@1.0.0', 'node_modules', '@civitai', 'dep'),
      );

      expect(
        new Map(installedCivitaiVersions(scratch)).get('@civitai/dep'),
        'the walk cannot see a REAL duplicate — every assertion below is then vacuous',
      ).toEqual(['1.0.0', '2.0.0']);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('a stray non-directory entry is skipped — the read that used to abort this file at load', () => {
    // 🔴 THE FAILURE MODE IS THE DIAGNOSTIC, NOT THE VERDICT. `installedCivitaiVersions`
    // runs at MODULE LOAD, so anything it throws aborts this file before a single test
    // name prints. Measured at `7de41a8`: `touch node_modules/@civitai/.DS_Store` then
    // run the guard →
    //
    //     Error: ENOTDIR … '@civitai/.DS_Store/package.json'
    //     Test Files  1 failed
    //     Tests       no tests
    //
    // — `atLeastFivePackages`, the positive control, never ran either. Fail-closed, so
    // it blocks nothing that should pass; but "the dependency gate is broken" and
    // "somebody's file manager wrote a dot-file" are indistinguishable in that output,
    // and the store walk this replaced tolerated the entry. With the fix and the same
    // stray file present, all 9 cases in this file run and pass.
    //
    // 🔴 SCOPE, STATED SO IT IS NOT READ AS MORE. This calls the walk DIRECTLY on a
    // fixture, so pre-fix it reports as one red case rather than reproducing the
    // file-level abort — the abort needs the entry in the REAL tree, where the walk
    // runs at import. What it pins is the cause of both: a non-directory entry is
    // skipped rather than thrown out of.
    //
    // The two halves are both load-bearing. The FIRST proves the walk survives the
    // entry; the SECOND proves it still sees the tree around it — a `catch` that
    // swallowed the whole scope would satisfy the first alone and silently reduce
    // every "exactly one version" assertion to a vacuous pass over an empty map.
    const scratch = mkdtempSync(join(tmpdir(), 'civitai-lockstep-stray-'));
    try {
      const dir = join(scratch, '.pnpm', 'dep@1.0.0', 'node_modules', '@civitai', 'dep');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: '@civitai/dep', version: '1.0.0' }),
      );
      mkdirSync(join(scratch, '@civitai'), { recursive: true });
      symlinkSync(
        join('..', '.pnpm', 'dep@1.0.0', 'node_modules', '@civitai', 'dep'),
        join(scratch, '@civitai', 'dep'),
      );

      // The stray byte: a plain FILE where the walk expects a package directory.
      // `realpathSync` resolves it happily — which is exactly why realpath alone is
      // not the filter — and it is the manifest read that used to blow up.
      writeFileSync(join(scratch, '@civitai', '.DS_Store'), 'stray');

      expect(
        [...installedCivitaiVersions(scratch)],
        'a stray non-directory entry aborted the walk instead of being skipped',
      ).toEqual([['@civitai/dep', ['1.0.0']]]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
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
    // pin-equality assertions above: it needs no `dependencies` block to be read
    // correctly, only the RESOLVABLE tree to be counted. "Resolvable" is the word
    // that matters — see `installedCivitaiVersions`; counting what is merely on
    // disk made this the case that fired on a stale install.
    const duplicated = [...INSTALLED].filter(([, versions]) => versions.length > 1);
    expect(
      duplicated.map(([name, versions]) => `${name}: ${versions.join(', ')}`),
      'a second copy of a @civitai package is installed',
    ).toEqual([]);
  });
});
