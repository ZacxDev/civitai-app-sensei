import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 🔴 A LOCAL SHELL AND CI THAT INSTALL DIFFERENT TOOLCHAINS MAKE A GREEN RUN
 * MEAN NOTHING.
 *
 * `flake.nix` is what a contributor's shell installs (`nix develop` / direnv);
 * `.github/workflows/*` is what the merge gate installs; `block.manifest.json`'s
 * `buildCommand` is what the PLATFORM's builder runs to produce the live app.
 * When those disagree, "it passes locally" stops being evidence about the gate
 * and the gate stops being evidence about anyone's machine — and nothing
 * announces the split, because both sides stay green while testing different
 * things.
 *
 * That is the state this repo was in until the flake landed. There was no dev
 * shell at all, so there was nothing for CI to agree WITH: the workflow carried
 * a literal `node-version: 22` and `cache: npm`, and every contributor ran
 * whatever node their machine happened to have.
 *
 * The pins are handled asymmetrically, on purpose:
 *
 *   node — ONE authority, `.nvmrc`. flake.nix reads it with `builtins.readFile`
 *          and CI reads it via `actions/setup-node`'s `node-version-file`.
 *   pnpm — TWO statements, because `pnpm/action-setup` reads only its own
 *          `version:` input or `package.json`'s `packageManager` field, and
 *          adding `packageManager` would change what the platform's builder
 *          does. So the major is written down twice and asserted equal here.
 *
 * ---------------------------------------------------------------------------
 * 🔴 FOUR ADVERSARIAL ROUNDS. EVERY ROUND FOUND THIS FILE PASSING WITH THE
 * HAZARD PRESENT — AND THREE OF THEM BROKE THE PREVIOUS ROUND'S FIX.
 *
 * Do not read the assertions below as obviously sufficient. They are the
 * residue of mutants that were watched going GREEN. Each is a SHAPE, and the
 * shapes recur — which is why they are written down rather than summarised.
 *
 * Round 1 (against the version ported from `civitai-app-gen-matrix`):
 *   G1  `"node-version": 22` — a QUOTED yaml key, invisible to a regex anchored
 *       on a bare letter, while GitHub reads it and PREFERS it.
 *   G2  the `builtins.readFile` words kept in a comment while the code beneath
 *       hardcoded a major — a SPELLED guard.
 *   G3  `pnpmMajor = "11";` kept as a decoy while `pkgs."pnpm_10"` was used.
 *   G4  a literal in a SECOND job — only the first step was inspected.
 *   G5  a literal in a SECOND workflow file — only `ci.yml` was read.
 *   G6  every command reverted to npm with the pnpm step left as decoration —
 *       the docstring named `cache: npm` as half the defect while the code
 *       inspected neither `cache:` nor any `run:` step.
 *
 * Round 2 (the round-1 fix, found by re-running its own claim):
 *   G6b the SAME npm revert written as a `run: |` block scalar. The G6 fix read
 *       only the inline `run: x` form. Multi-line `run:` is how anyone actually
 *       writes several commands, so this was the likely shape, not an edge one.
 *
 * Round 3 (the round-1/2 fixes, adversarially):
 *   G2b `nodeMajor = "22"; # replaces builtins.readFile ./.nvmrc` — a TRAILING
 *       comment on a code line. The fix stripped only FULL-LINE comments.
 *   G2c bind the read to an unused name, hardcode the real one. Nothing checked
 *       that the value read was the value used — while a comment in this very
 *       file claimed "a read whose result is never used is decoration".
 *   N7  `cache: npm` under `with:`, masked by a deeper `env: cache: pnpm`.
 *   N9  the same trick on `node-version-file`. `settingsIn` matched any depth
 *       and `new Map` is last-wins, so a sibling mapping overrode the real one.
 *   G7b `buildCommand: "pnpm  run build"` (two spaces) — first-word parsing said
 *       pnpm, while the platform's own validator REJECTS the string outright.
 *   G7f `pnpm run buildx` — a script that does not exist.
 *   N2  a literal inside a composite action under `.github/actions/`.
 *
 * Round 4 (the round-3 fix, adversarially — and the sharpest, because several
 * mutants were confirmed with `nix eval` to actually change the installed
 * toolchain rather than merely to slip past a regex):
 *   A1  a literal in a second workflow whose setup-node is written the
 *   A5  IDIOMATIC way — `- name: Set up Node` then `uses: …`, or a quoted
 *   N2b `uses: "actions/setup-node@v4"`. `stepBlocks` anchored on `- uses:`,
 *       so it could not see such a step AT ALL; it threw, the caller swallowed
 *       it, and the literal passed. The same bug was a FALSE RED in the other
 *       direction: adding a `name:` to this repo's own step turned CI red.
 *   B1  `nodeMajor = if false then (…readFile ./.nvmrc) else "22";`
 *   B2  `nodeMajor = (_: "22") (builtins.readFile ./.nvmrc);`
 *       The read is present and DISCARDED. `nix eval` → node 22.23.2.
 *   C1  keep `[ pkgs."nodejs_${nodeMajor}" ]` as an unused decoy, build the
 *   C2b real derivation from a second name (`hardMajor = "22"`). No digits, so
 *       "no literal `nodejs_<n>`" passed. `nix eval` → node 22.23.2, pnpm 10.
 *   D1  `note = "…/x#pins"; nodejs = pkgs."nodejs_22";` — `#` inside a Nix
 *       STRING is not a comment, but the stripper deleted the rest of the line
 *       anyway. The identical line with `-` instead of `#` was killed.
 *   E1  npm invoked behind `CI=1`, `env NODE_ENV=…`, `bash -c "…"`, backticks,
 *   E7  or an `else` branch. The detector only understood `sudo` and a few
 *       separators, so a full revert to npm passed again.
 *
 * The lesson each time is the same and is worth more than the assertions: a
 * guard that checks a WORD IS PRESENT can be walked around by an edit that
 * spells the word somewhere harmless. Pin the VALUE, the BINDING, or the whole
 * normalised string.
 *
 * 🔴 AND KNOW THIS FILE'S CEILING. These are textual assertions over Nix, a
 * Turing-complete expression language — B1/B2/C1 are proof that source-text
 * matching cannot decide what a flake EVALUATES to. The assertions below are a
 * tripwire for drift, not a proof of correctness. The proof is evaluation:
 * `nix flake check --all-systems`, and comparing
 * `nix eval .#packages.<system>.nodejs.version` against `.nvmrc`. CI does not
 * run nix, so no automated gate does this today — run it by hand when you
 * touch flake.nix, and do not read a green suite as more than it is.
 *
 * `describes the extractors` is the control that keeps all of it honest: every
 * assertion here is only as good as the four parsers, and a parser that
 * silently matches nothing produces a confident green.
 *
 * Read off disk rather than imported, for the same reason `manifest.test.ts`
 * does it: the bytes on disk are what ship and what CI executes.
 */

function repoFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

/**
 * Every workflow AND every composite action (mutant G5, mutant N2). A literal
 * in a release workflow, or in `.github/actions/setup/action.yml`, splits the
 * toolchain exactly as well as one in the merge gate.
 */
function allWorkflows(): Array<[name: string, content: string]> {
  const found: Array<[string, string]> = [];

  const workflows = new URL('../.github/workflows/', import.meta.url);
  for (const n of readdirSync(workflows).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    found.push([n, readFileSync(new URL(n, workflows), 'utf8')]);
  }
  if (found.length === 0) {
    throw new Error('.github/workflows contains no workflow files to check');
  }

  // Composite actions are optional — none exists today. Scanning them is what
  // stops the whole guard being sidestepped by moving the steps one directory
  // over, which is an ordinary refactor rather than an attack. GitHub resolves
  // a local action at ANY repo path (`uses: ./ci/setup` is as valid as
  // `uses: ./.github/actions/setup`), so the scan cannot be scoped to
  // `.github/actions/` — that was mutant N2 one directory further over.
  found.push(...actionFiles(fileURLToPath(new URL('../', import.meta.url))));

  return found;
}

/**
 * `action.y[a]ml` anywhere in the repo, as [repo-relative path, contents].
 *
 * Pruned at the DIRECTORY level rather than filtered afterwards: a
 * `readdirSync(root, { recursive: true })` descends into `node_modules` before
 * any filter can reject it — measured at 17,641 entries here, walked on every
 * run of every test in this file, to find files that live in two or three
 * places.
 *
 * Paths are built relative to the repo root rather than sliced out of an
 * absolute path using the repo's own directory NAME. That slice silently
 * stopped working the moment the tree was checked out under a different name —
 * which is what a scratch copy, a `git worktree`, or a fork does, and it would
 * have degraded the failure message rather than the verdict, so nothing would
 * have complained.
 */
function actionFiles(dir: string, relative = ''): Array<[string, string]> {
  const SKIP = new Set(['node_modules', 'dist', '.git', '.direnv', 'coverage']);
  const out: Array<[string, string]> = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue;
      out.push(...actionFiles(`${dir}/${entry.name}`, child));
    } else if (/^action\.ya?ml$/.test(entry.name)) {
      out.push([child, readFileSync(`${dir}/${entry.name}`, 'utf8')]);
    }
  }

  return out;
}

/**
 * A yaml scalar as written: `.nvmrc`, `".nvmrc"`, `.nvmrc  # why`.
 *
 * Unquote BEFORE stripping a trailing comment, not after: a quoted value that
 * legitimately contains ` # ` was being truncated at the hash.
 */
function scalar(raw: string): string {
  const trimmed = raw.trim();
  const quoted = trimmed.match(/^(["'])(.*?)\1\s*(?:#.*)?$/);
  if (quoted) return quoted[2];
  return trimmed.replace(/\s+#.*$/, '').trim();
}

/**
 * The `with:` blocks of EVERY `- uses: <action>` step in one workflow (mutant
 * G4), as raw lines.
 *
 * Deliberately not a YAML parse: this repo ships no YAML dependency, and adding
 * one to read these workflows would be a bigger change than the thing it
 * verifies. A line scan bounded by the next list item at the step's own
 * indentation — or by any dedent out of the step — is sufficient, and it fails
 * loudly if the step is gone.
 */
/**
 * How many times this action is referenced at all, by a dumb line scan.
 *
 * 🔴 The parser must ACCOUNT FOR every occurrence. Both call sites used to do
 * `try { stepBlocks(…) } catch { continue }`, which cannot tell "this workflow
 * has no such step" from "this workflow has one and I could not parse it" —
 * so a step written in flow style (`- { uses: actions/setup-node@v4, with: {
 * node-version: 22 } }`) or after a bare `-` marker made the whole workflow
 * silently skip, and the global `checked > 0` was satisfied by a DIFFERENT
 * file. That is the round-4 root cause — an extractor narrower than the
 * hazard — surviving its own fix. Comparing this count to the parsed count
 * turns an unparseable step into a failure instead of a pass.
 */
function usesOccurrences(workflow: string, actionPrefix: string): number {
  const escaped = actionPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return workflow.split('\n').filter((line) =>
    new RegExp(`(?:^|[\\s{,-])uses:\\s*["']?${escaped}`).test(line),
  ).length;
}

function stepBlocks(workflow: string, actionPrefix: string): string[][] {
  const lines = workflow.split('\n');
  const escaped = actionPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // 🔴 `uses:` may be the step's FIRST line (`- uses: x`) or ANY later line of
  // the same list item — `- name: Set up Node` / `  uses: actions/setup-node@v4`
  // is the idiomatic GitHub spelling and is what a contributor reaches for. An
  // earlier version anchored on `- uses:` and therefore could not see such a
  // step at all: it threw, the caller's `catch { continue }` swallowed it, and
  // a literal `node-version: 22` in a second workflow written that way passed
  // 8/8. That is mutants G4/G5/N2 reborn out of the extractor rather than the
  // assertions. It was ALSO a false red: adding a `name:` to this repo's own
  // setup-node step turned the gate red for nothing.
  const usesRe = new RegExp(`^\\s*(?:-\\s+)?uses:\\s*["']?${escaped}`);
  const blocks: string[][] = [];

  for (let i = 0; i < lines.length; i += 1) {
    // 🔴 `-(\s|$)`, not `-\s`. A bare `-` alone on its line is a valid list
    // item marker. Requiring whitespace after it meant such a line neither
    // OPENED an item nor TERMINATED the previous one, so a second setup-node
    // step written that way was absorbed into the first step's block —
    // `withMapping` takes the FIRST `with:`, so its literal `node-version: 22`
    // was never read, and GitHub runs both steps with the later one winning.
    // One keystroke, in this repo's own merge gate.
    const m = lines[i].match(/^(\s*)-(?:\s|$)/);
    if (!m) continue;
    const indent = m[1].length;
    const item: string[] = [lines[i]];
    for (const line of lines.slice(i + 1)) {
      if (line.trim() === '') {
        item.push(line);
        continue;
      }
      const lineIndent = line.match(/^\s*/)![0].length;
      // A sibling list item ends the step; so does any dedent out of it.
      if (lineIndent < indent) break;
      if (lineIndent === indent && /^\s*-(?:\s|$)/.test(line)) break;
      item.push(line);
    }
    if (item.some((line) => usesRe.test(line))) blocks.push(item);
  }

  if (blocks.length === 0) {
    throw new Error(`no step using ${actionPrefix}… found`);
  }
  return blocks;
}

/**
 * ONLY the `with:` mapping of a step (mutants N7 / N9).
 *
 * Reading every `key: value` at any depth in the step looked harmless and was
 * not: a step's `env:` is a sibling of its `with:`, `settingsIn` matched both,
 * and `new Map` is last-wins — so `env: node-version-file: .nvmrc` sitting
 * below a `with:` that named a DIFFERENT file made the guard read the value it
 * wanted to see while CI installed from the other one. Only `with:` carries an
 * action's inputs, so only `with:` is read.
 */
function withMapping(block: string[]): string[] {
  const start = block.findIndex((l) => /^\s*with:\s*(\{.*\})?\s*(#.*)?$/.test(l));
  if (start === -1) return [];

  const line = block[start];
  // Flow style — `with: { node-version-file: .nvmrc, cache: pnpm }` — is valid
  // yaml and GitHub reads its members as inputs. `settingsIn` unpacks it.
  if (/^\s*with:\s*\{.*\}\s*$/.test(line)) return [line];

  const indent = line.match(/^\s*/)![0].length;
  const out: string[] = [];
  for (const l of block.slice(start + 1)) {
    if (l.trim() === '') continue;
    if (l.match(/^\s*/)![0].length <= indent) break;
    out.push(l);
  }
  return out;
}

/**
 * Every `key: value` in a mapping, as pairs.
 *
 * The key may be quoted (mutant G1). `"node-version": 22` is valid YAML and
 * GitHub reads it as the `node-version` input; a regex anchored on a bare
 * letter cannot see it, which is how a literal node version hid in plain sight
 * next to the `node-version-file` this guard was checking.
 */
function settingsIn(lines: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const KV = /^\s*(?:"([\w.-]+)"|'([\w.-]+)'|([A-Za-z][\w.-]*))\s*:\s*(\S.*?)\s*$/;

  for (const line of lines) {
    const m = line.match(KV);
    if (!m) continue;
    const key = m[1] ?? m[2] ?? m[3];
    const raw = m[4];

    const flow = raw.match(/^\{(.*)\}$/);
    if (flow) {
      for (const member of flow[1].split(',')) {
        const kv = member.match(/^\s*(?:"([\w.-]+)"|'([\w.-]+)'|([A-Za-z][\w.-]*))\s*:\s*(.*?)\s*$/);
        if (kv) pairs.push([kv[1] ?? kv[2] ?? kv[3], scalar(kv[4])]);
      }
      continue;
    }

    pairs.push([key, scalar(raw)]);
  }

  return pairs;
}

/**
 * Every command a workflow runs — inline `run: x` AND the lines of a block
 * scalar `run: |` (mutant G6b).
 *
 * The block-scalar half is not an edge case, it is the SAME hole in a second
 * shape: the first fix for G6 read only the inline form, so a workflow could
 * revert wholesale to npm inside a `run: |` block and stay green.
 */
function runCommands(workflow: string): string[] {
  const lines = workflow.split('\n');
  const commands: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\s*)-?\s*run:\s*(.*?)\s*$/);
    if (!m) continue;

    const indent = m[1].length;
    const inline = m[2];

    // `|`, `>` and their chomping/indent indicators (`|-`, `>+`, `|2`) all
    // introduce a block; a bare `run:` with nothing after it does too.
    if (inline === '' || /^[|>]\d*[-+]?$/.test(inline) || /^[|>][-+]?\d*$/.test(inline)) {
      for (const line of lines.slice(i + 1)) {
        if (line.trim() === '') continue;
        if (line.match(/^\s*/)![0].length <= indent) break;
        // A shell comment is not an invocation.
        if (/^\s*#/.test(line)) continue;
        commands.push(line.trim());
      }
      continue;
    }

    commands.push(inline);
  }

  return commands;
}

/**
 * Does this command INVOKE npm or yarn, as opposed to merely mentioning one?
 *
 * A bare `/\bnpm\b/` turned `pnpm dlx npm-check-updates` red — a false red is
 * how a gate gets disabled. Only the command position counts: start of line, or
 * after a shell separator.
 */
const INVOKES_NPM_OR_YARN =
  /(?:^|[;&|(`'"]|\s)(?:[A-Za-z_]\w*=\S*\s+)*(?:sudo\s+)?["'`]?(?:[\w./-]*\/)?(?:npm|yarn)(?:[\s;&|)"'`]|$)/;

/**
 * Remove Nix comments — and ONLY comments.
 *
 * 🔴 THREE attempts at this line-wise, three mutants that passed 8/8 while
 * `nix eval` reported node 22.23.2 instead of 24.19.0:
 *   - no stripping at all (round 1): a comment could SPELL the thing the guard
 *     looked for (mutant G2).
 *   - `#.*$` (round 3): deleted `nodejs = pkgs."nodejs_22";` that followed a
 *     `#` inside a STRING — `note = "…/x#pins"; nodejs = …` (mutant D1).
 *   - `(^|\s)#.*$` (round 4): fixed exactly that example and nothing else. Put
 *     a SPACE before the hash — `note = "a #b"; nodejs = pkgs."nodejs_22";` —
 *     and the literal was invisible again (mutant D3). One character.
 *
 * Whether a `#` opens a comment depends on whether you are inside a string,
 * and no line-wise regex can know that. So this is a scanner. It stays small
 * because it only tracks three states, and it is the difference between a
 * guard that reads flake.nix and one that reads an arbitrary prefix of it.
 *
 * String CONTENTS are deliberately preserved: the thing being asserted on —
 * `pkgs."nodejs_${nodeMajor}"` — lives inside a string.
 */
function stripNixComments(src: string): string {
  let out = '';
  let i = 0;
  let state: 'code' | 'string' | 'indented' = 'code';

  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);

    if (state === 'code') {
      if (two === "''") { state = 'indented'; out += two; i += 2; continue; }
      if (c === '"') { state = 'string'; out += c; i += 1; continue; }
      if (two === '/*') {
        const end = src.indexOf('*/', i + 2);
        i = end === -1 ? src.length : end + 2;
        out += ' ';
        continue;
      }
      if (c === '#') {
        const nl = src.indexOf('\n', i);
        i = nl === -1 ? src.length : nl; // keep the newline itself
        continue;
      }
      out += c; i += 1; continue;
    }

    if (state === 'string') {
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '"') { state = 'code'; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }

    // Indented string: `'''`, `''$` and `''\` are escapes; a bare `''` ends it.
    if (two === "''") {
      const third = src[i + 2];
      if (third === "'" || third === '$' || third === '\\') {
        out += src.slice(i, i + 3); i += 3; continue;
      }
      state = 'code'; out += two; i += 2; continue;
    }
    out += c; i += 1;
  }

  return out;
}

function flakeCode(): string {
  return stripNixComments(repoFile('../flake.nix'));
}

const NVMRC = repoFile('../.nvmrc').trim();

/**
 * The platform's OWN accepted form for `buildCommand`, copied from the
 * app-blocks pipeline's `resolve-build.mjs`. Reproduced rather than
 * approximated because the whole point is to fail here instead of there.
 */
const PLATFORM_BUILD_COMMAND_RE =
  /^(?:(?:npm|pnpm|yarn) run [a-zA-Z0-9:_-]+|(?:npx )?vite build)$/;

describe('toolchain lockstep', () => {
  it('states the node major once, in .nvmrc, in the form the flake can consume', () => {
    // flake.nix interpolates this straight into `pkgs."nodejs_${nodeMajor}"`.
    // A patch-level `.nvmrc` (`24.19.0`) names an attribute nixpkgs does not
    // have, so the shell dies on eval — and `actions/setup-node` accepts a bare
    // major just as happily.
    expect(NVMRC).toMatch(/^\d+$/);
  });

  it('BINDS the node major to what it read from .nvmrc, rather than restating it', () => {
    const flake = flakeCode();

    // 🔴 Not `toContain('builtins.readFile ./.nvmrc')`. That is a spelled
    // guard, walked around twice: once by leaving the words in a comment
    // (G2/G2b) and once by binding the read to an unused name (G2c).
    //
    // The RHS must be the read itself, optionally wrapped in calls like
    // `nixpkgs.lib.trim (…)`. Allowing anything up to the `;` was not enough:
    // `nodeMajor = if false then (builtins.readFile ./.nvmrc) else "22";` and
    // `nodeMajor = (_: "22") (builtins.readFile ./.nvmrc);` both contained the
    // read, both passed, and `nix eval` confirmed the shell then installed
    // node 22.23.2 instead of 24.19.0. The read has to BE the value.
    expect(flake).toMatch(
      /\bnodeMajor\s*=\s*(?:[\w.]+\s*\(\s*)*builtins\.readFile\s*\(?\s*\.\/\.nvmrc\s*\)?[\s)]*;/,
    );

    // 🔴 Exactly one DEFINITION of the name, in any spelling. Counting only
    // `nodeMajor =` was defeated by re-binding it as a LAMBDA PARAMETER, which
    // is spelled `nodeMajor:` and so was not counted at all:
    //
    //   mk = nodeMajor: pnpmMajor: { nodejs = pkgs."nodejs_${nodeMajor}"; … };
    //   in mk "22" "10";
    //
    // The top-level readFile binding survives untouched, every interpolation
    // still names `${nodeMajor}` — just a DIFFERENT one — and all four flake
    // assertions passed 8/8 while `nix eval` reported node 22.23.2 and pnpm
    // 10.34.5. Pinning the NAME is not pinning the BINDING.
    expect(flake.match(/\bnodeMajor\s*[:=](?!=)/g)).toHaveLength(1);

    // 🔴 And EVERY node attribute must interpolate that exact name. Asserting
    // `nodejs_${nodeMajor}` merely OCCURS plus "no literal `nodejs_<digits>`"
    // was defeated by a decoy: keep `[ pkgs."nodejs_${nodeMajor}" ]` in an
    // unused binding, then build the real derivations from a second let-bound
    // name (`hardMajor = "22"`). No digits appear, so the literal check passed —
    // and `nix eval` showed node 22.23.2. This form has no such gap: any
    // `nodejs_`/`nodejs-slim_` not followed by `${nodeMajor}` fails, whether it
    // is a digit, another name, or anything else.
    expect(flake).toContain('nodejs_${nodeMajor}');
    expect(flake).toContain('nodejs-slim_${nodeMajor}');
    expect(flake).not.toMatch(/nodejs(?:-slim)?_(?!\$\{nodeMajor\})/);
  });

  it('uses the pnpm major it declares, rather than a literal', () => {
    const flake = flakeCode();

    // Mutant G3 kept `pnpmMajor = "11";` as a decoy and built `pkgs."pnpm_10"`.
    // C2b then did the same one level up — decoy interpolation retained, real
    // derivation built from `pnpmPin = "10"` — and `nix eval` reported pnpm
    // 10.34.5 against a base of 11.25.0. Same fix as for node: every `pnpm_`
    // must interpolate this exact name.
    expect(flake).toMatch(/\bpnpmMajor\s*=\s*"\d+";/);
    // Same lambda-parameter shadowing applies here — see the node assertion.
    expect(flake.match(/\bpnpmMajor\s*[:=](?!=)/g)).toHaveLength(1);
    expect(flake).toContain('pnpm_${pnpmMajor}');
    expect(flake).not.toMatch(/pnpm_(?!\$\{pnpmMajor\})/);
  });

  it('has EVERY setup-node step in EVERY workflow read .nvmrc, with no literal beside it', () => {
    let checked = 0;

    for (const [name, workflow] of allWorkflows()) {
      // A workflow may legitimately not set node up — but if it REFERENCES the
      // action, every reference must be parsed. `catch { continue }` alone made
      // an unparseable step (flow style, a bare `-` marker) indistinguishable
      // from an absent one, and the global `checked > 0` was then satisfied by
      // a different file entirely.
      const occurrences = usesOccurrences(workflow, 'actions/setup-node@');
      if (occurrences === 0) continue;
      const blocks = stepBlocks(workflow, 'actions/setup-node@');
      expect(blocks.length, `${name}: setup-node steps parsed vs referenced`).toBe(occurrences);

      for (const block of blocks) {
        const byKey = new Map(settingsIn(withMapping(block)));

        // `./.nvmrc` and `.nvmrc` are the same file to setup-node; failing on
        // the prefix would be a false red.
        const versionFile = byKey.get('node-version-file')?.replace(/^\.\//, '');
        expect(versionFile, `${name}: node-version-file`).toBe('.nvmrc');

        // The half that actually stops the drift. `node-version-file` being
        // present proves nothing on its own: `actions/setup-node` accepts BOTH
        // inputs and PREFERS the literal `node-version`, so a step carrying
        // both reads `.nvmrc` in this assertion's eyes and installs something
        // else in reality.
        expect(byKey.has('node-version'), `${name}: literal node-version present`).toBe(false);
        checked += 1;
      }
    }

    // Not a soft pass. Zero steps checked means every workflow lost its
    // setup-node — or the extractor stopped matching — and the loop above would
    // have been vacuously green.
    expect(checked, 'setup-node steps inspected').toBeGreaterThan(0);
  });

  it('pins the same pnpm major in flake.nix and in every workflow that installs pnpm', () => {
    const flakePin = flakeCode().match(/^\s*pnpmMajor = "(\d+)";/m);
    if (!flakePin) {
      throw new Error('flake.nix has no `pnpmMajor = "<n>";` line to compare against');
    }

    let checked = 0;
    for (const [name, workflow] of allWorkflows()) {
      const occurrences = usesOccurrences(workflow, 'pnpm/action-setup@');
      if (occurrences === 0) continue;
      const blocks = stepBlocks(workflow, 'pnpm/action-setup@');
      expect(blocks.length, `${name}: pnpm steps parsed vs referenced`).toBe(occurrences);

      for (const block of blocks) {
        const ciPin = new Map(settingsIn(withMapping(block))).get('version');
        if (ciPin === undefined) {
          // Not a soft pass. `pnpm/action-setup` falls back to package.json's
          // `packageManager` when `version:` is absent — and this repo declares
          // no such field, so the step would fail at runtime.
          throw new Error(`${name}: pnpm/action-setup declares no \`version:\` to compare against`);
        }

        // Majors, not full versions: nixpkgs carries whatever patch it carries
        // and the action resolves the latest of the major. Pinning the patch
        // would rot on a routine `nix flake update` and turn trunk red for
        // nothing — a permanently-red gate teaches everyone to merge through it.
        expect(ciPin.split('.')[0], `${name}: pnpm major`).toBe(flakePin[1]);
        checked += 1;
      }
    }

    expect(checked, 'pnpm/action-setup steps inspected').toBeGreaterThan(0);
  });

  it('has CI actually RUN pnpm, not merely install it', () => {
    // Mutant G6 left the `pnpm/action-setup` step in place as decoration and
    // reverted everything that uses it. Every other assertion stayed green:
    // they all describe how pnpm is INSTALLED and none asked whether anything
    // uses it. G6b then did the same inside a `run: |` block.
    let sawPnpmRun = false;

    for (const [name, workflow] of allWorkflows()) {
      for (const command of runCommands(workflow)) {
        expect(command, `${name}: run step invokes npm/yarn`).not.toMatch(INVOKES_NPM_OR_YARN);
        if (/\bpnpm\b/.test(command)) sawPnpmRun = true;
      }

      if (usesOccurrences(workflow, 'actions/setup-node@') === 0) continue;
      for (const block of stepBlocks(workflow, 'actions/setup-node@')) {
        const cache = new Map(settingsIn(withMapping(block))).get('cache');
        if (cache !== undefined) {
          expect(cache, `${name}: setup-node cache`).toBe('pnpm');
        }
      }
    }

    expect(sawPnpmRun, 'a workflow that actually runs pnpm').toBe(true);
  });

  it('keeps buildCommand in a form the PLATFORM accepts, and agreeing with the lockfile', () => {
    // 🔴 This is the platform's rule, not a preference. The app-blocks build
    // pipeline validates `buildCommand` against its own regex and then selects
    // which lockfile it demands from the command's package manager: `pnpm …`
    // requires `pnpm-lock.yaml` and installs with `pnpm install
    // --frozen-lockfile`; anything else requires `package-lock.json` and
    // `npm ci`, exiting 1 with "no package-lock.json is committed".
    //
    // After the npm→pnpm conversion, reverting this one word — without also
    // restoring a lockfile that no longer exists — hard-fails the build of the
    // LIVE app, and nothing in CI goes red, because `.github/` is not in the
    // submitted bundle.
    const manifest = JSON.parse(repoFile('../block.manifest.json')) as { buildCommand?: unknown };
    if (typeof manifest.buildCommand !== 'string') {
      throw new Error('block.manifest.json has no string "buildCommand"');
    }
    const buildCommand = manifest.buildCommand;

    // The WHOLE normalised string, not its first token. `"pnpm  run build"`
    // (two spaces) has the first token `pnpm` and is REJECTED by the platform
    // validator — so first-token parsing was green on a manifest that cannot
    // build, which is precisely the failure this guard exists to prevent.
    expect(buildCommand).toMatch(PLATFORM_BUILD_COMMAND_RE);
    expect(buildCommand).toBe('pnpm run build');

    // …and the script it names has to exist, or the builder runs a command
    // that resolves to nothing (`pnpm run buildx`).
    const pkg = JSON.parse(repoFile('../package.json')) as { scripts?: Record<string, string> };
    const script = buildCommand.replace(/^pnpm run /, '');
    expect(Object.keys(pkg.scripts ?? {}), 'package.json scripts').toContain(script);

    const lockfiles = readdirSync(new URL('../', import.meta.url));
    expect(lockfiles).toContain('pnpm-lock.yaml');
    // Exactly one lockfile may remain, or the two can disagree silently — and
    // this reads the working tree on purpose: an untracked `package-lock.json`
    // still lands in a `civitai app submit` bundle.
    expect(lockfiles).not.toContain('package-lock.json');
    expect(lockfiles).not.toContain('yarn.lock');
  });

  it('🔴 describes the extractors — they can FAIL, and they do match this repo', () => {
    // The control the first version of this file lacked. Every assertion above
    // is only as good as these parsers; one that silently matches nothing
    // produces a confident green. `manifest.test.ts` carries the same kind of
    // self-control for its own regex.
    const sample = [
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          # a comment that mentions node-version: 99',
      '          "node-version": 22',
      '          node-version-file: ".nvmrc"  # quoted, with a trailing comment',
      '        env:',
      '          node-version-file: .decoy',
      '      - name: after',
      '        run: pnpm test',
      '',
    ].join('\n');

    const step = stepBlocks(sample, 'actions/setup-node@')[0];
    const settings = new Map(settingsIn(withMapping(step)));

    // Quoted key is seen (G1); quotes and trailing comments are stripped (G8);
    // and the sibling `env:` mapping is NOT read (N7/N9) — that decoy would
    // otherwise win, because `new Map` is last-wins.
    expect(settings.get('node-version')).toBe('22');
    expect(settings.get('node-version-file')).toBe('.nvmrc');
    expect(settings.has('run')).toBe(false);

    // Flow style is unpacked rather than swallowed whole.
    const flow = ['        with: { node-version: 22, cache: pnpm }'];
    expect(new Map(settingsIn(flow)).get('node-version')).toBe('22');

    // `scalar` unquotes before stripping a comment, so a hash inside a quoted
    // value survives.
    expect(new Map(settingsIn(['  k: "a # b"'])).get('k')).toBe('a # b');

    // The extractor throws rather than returning empty for an absent step.
    expect(() => stepBlocks(sample, 'pnpm/action-setup@')).toThrow(/no step using pnpm/);

    // …and it finds a step whose `uses:` is NOT the first line, which is the
    // idiomatic spelling an earlier version could not see at all.
    const named = [
      '      - name: Set up Node',
      '        uses: "actions/setup-node@v4"',
      '        with:',
      '          node-version: 22',
      '',
    ].join('\n');
    expect(new Map(settingsIn(withMapping(stepBlocks(named, 'actions/setup-node@')[0]))).get('node-version')).toBe('22');

    // `runCommands` finds commands, and is not a regex that matches anything.
    expect(runCommands(sample)).toEqual(['pnpm test']);
    expect(runCommands('jobs:\n  build:\n')).toEqual([]);

    // …including inside a block scalar, which the G6 fix missed entirely.
    const block = [
      '      - name: Install',
      '        run: |',
      '          npm ci',
      '          npm run build',
      '      - run: pnpm test',
      '',
    ].join('\n');
    expect(runCommands(block)).toEqual(['npm ci', 'npm run build', 'pnpm test']);

    // The npm detector fires on an INVOCATION and not on a mere mention.
    // Both directions matter: missing an invocation reinstates mutant G6, and
    // firing on a mention (`pnpm dlx npm-check-updates`) is a false red, which
    // is how a gate gets disabled.
    for (const yes of [
      'npm ci',
      'cd app && npm ci',
      'yarn install',
      'CI=1 npm ci',                                  // leading env assignment
      'env NODE_ENV=production npm run build',        // via `env`
      'bash -c "npm ci"',                             // nested shell
      'echo `npm ci`',                                // backticks
      'if [ -f x ]; then pnpm i; else npm ci; fi',    // a conditional revert
    ]) {
      expect(yes, `should be detected: ${yes}`).toMatch(INVOKES_NPM_OR_YARN);
    }
    for (const no of [
      'pnpm install --frozen-lockfile',
      'pnpm test',
      'pnpm dlx npm-check-updates',                   // a MENTION, not a call
      'echo "see npmjs.com"',
    ]) {
      expect(no, `should NOT be detected: ${no}`).not.toMatch(INVOKES_NPM_OR_YARN);
    }

    // The platform buildCommand regex accepts the real value and rejects the
    // shapes the platform rejects — copied from its validator, so a control is
    // the only thing proving it was copied correctly.
    expect('pnpm run build').toMatch(PLATFORM_BUILD_COMMAND_RE);
    expect('npx vite build').toMatch(PLATFORM_BUILD_COMMAND_RE);
    expect('pnpm  run build').not.toMatch(PLATFORM_BUILD_COMMAND_RE);
    expect('pnpm run build && echo hi').not.toMatch(PLATFORM_BUILD_COMMAND_RE);

    // 🔴 The Nix comment scanner, both directions. Three line-wise versions of
    // this shipped a mutant that passed 8/8 while `nix eval` showed node 22, so
    // it gets the most explicit control in the file.
    //
    // Strips REAL comments…
    expect(stripNixComments('a = 1; # nodejs_22\nb = 2;')).not.toContain('nodejs_22');
    expect(stripNixComments('# nodejs_22\nb = 2;')).not.toContain('nodejs_22');
    expect(stripNixComments('a = /* nodejs_22 */ 1;')).not.toContain('nodejs_22');
    // …and keeps the code around them.
    expect(stripNixComments('a = 1; # c\nb = 2;')).toContain('b = 2;');

    // …but a `#` INSIDE a string is not a comment, with or without a space
    // before it — these are mutants D1 and D3, and each one survived a
    // different regex.
    expect(stripNixComments('note = "x#pins"; n = "nodejs_22";')).toContain('nodejs_22');
    expect(stripNixComments('note = "a #b"; n = "nodejs_22";')).toContain('nodejs_22');
    expect(stripNixComments("h = ''echo a # b''; n = \"nodejs_22\";")).toContain('nodejs_22');
    // An escaped quote must not end the string early.
    expect(stripNixComments('s = "a\\"# b"; n = "nodejs_22";')).toContain('nodejs_22');

    // And the parsers are pointed at files that exist and are non-empty.
    expect(allWorkflows().length).toBeGreaterThan(0);
    expect(flakeCode().length).toBeGreaterThan(0);
    // The real flake still has its comments removed — otherwise the assertions
    // above would be reading prose that legitimately mentions `nodejs_24`.
    //
    // 🔴 Structural, not spelled. This control used to assert
    // `not.toContain('A public OSS reference block')` — one sentence from one
    // comment in flake.nix. Reword that comment and the control goes green
    // while proving nothing: the spelled-guard failure this entire file exists
    // to catch, committed inside the control meant to catch it. It would also
    // have been vacuously green in any repo this file is ported to.
    const rawFlake = repoFile('../flake.nix');
    expect(rawFlake, 'flake.nix has comments to strip').toMatch(/^\s*#/m);
    expect(flakeCode().length, 'comments were removed').toBeLessThan(rawFlake.length);
    expect(flakeCode(), 'no comment lines survive').not.toMatch(/^\s*#/m);
  });
});
