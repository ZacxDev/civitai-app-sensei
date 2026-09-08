import { readFileSync, readdirSync, existsSync } from 'node:fs';

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
 * 🔴 THREE ADVERSARIAL ROUNDS. EVERY ROUND FOUND THIS FILE PASSING WITH THE
 * HAZARD PRESENT — INCLUDING TWO ROUNDS THAT BROKE THE PREVIOUS ROUND'S FIX.
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
 * The lesson each time is the same and is worth more than the assertions: a
 * guard that checks a WORD IS PRESENT can be walked around by an edit that
 * spells the word somewhere harmless. Pin the VALUE, the BINDING, or the whole
 * normalised string.
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
  // over, which is an ordinary refactor rather than an attack.
  const actionsDir = new URL('../.github/actions/', import.meta.url);
  if (existsSync(actionsDir)) {
    for (const entry of readdirSync(actionsDir, { withFileTypes: true, recursive: true })) {
      if (!/^action\.ya?ml$/.test(entry.name)) continue;
      const path = `${entry.parentPath}/${entry.name}`;
      found.push([path.replace(/.*\.github\//, '.github/'), readFileSync(path, 'utf8')]);
    }
  }

  return found;
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
function stepBlocks(workflow: string, actionPrefix: string): string[][] {
  const lines = workflow.split('\n');
  const escaped = actionPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^(\\s*)-\\s+uses:\\s*${escaped}`);
  const blocks: string[][] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const m = header.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const block: string[] = [];
    for (const line of lines.slice(i + 1)) {
      if (line.trim() === '') {
        block.push(line);
        continue;
      }
      const lineIndent = line.match(/^\s*/)![0].length;
      // A sibling list item ends the step; so does any dedent out of it.
      if (lineIndent < indent) break;
      if (lineIndent === indent && /^\s*-\s/.test(line)) break;
      block.push(line);
    }
    blocks.push(block);
  }

  if (blocks.length === 0) {
    throw new Error(`no \`- uses: ${actionPrefix}…\` step found`);
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
  const start = block.findIndex((l) => /^\s*with:\s*(\{.*\})?\s*$/.test(l));
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
const INVOKES_NPM_OR_YARN = /(?:^|&&|\|\||;|\||\()\s*(?:sudo\s+)?(?:npm|yarn)(?:\s|$)/;

/**
 * flake.nix with comments removed — FULL-LINE and TRAILING (mutant G2b).
 *
 * Stripping only full-line comments left `nodeMajor = "22"; # …readFile
 * ./.nvmrc` satisfying a `toContain` while the code hardcoded the major.
 */
function flakeCode(): string {
  return repoFile('../flake.nix')
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
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
    // guard, and it was walked around twice: once by leaving the words in a
    // comment (G2/G2b) and once by binding the read to an unused name while a
    // second binding hardcoded the major (G2c). What has to be true is that
    // the name the packages are built from IS the name bound to the read.
    expect(flake).toMatch(/\bnodeMajor\s*=\s*[^;]*builtins\.readFile\s+\.\/\.nvmrc[^;]*;/);

    // Exactly one binding of it, so a second cannot shadow the first.
    expect(flake.match(/\bnodeMajor\s*=/g)).toHaveLength(1);

    // …and that name is what the derivations actually use.
    expect(flake).toContain('nodejs_${nodeMajor}');
    expect(flake).toContain('nodejs-slim_${nodeMajor}');

    // No literal node major in the code, in either attribute spelling. This is
    // what makes the assertions above load-bearing rather than decorative.
    expect(flake).not.toMatch(/nodejs(-slim)?_\d+/);
  });

  it('uses the pnpm major it declares, rather than a literal', () => {
    const flake = flakeCode();

    // Mutant G3 kept `pnpmMajor = "11";` as a decoy and built `pkgs."pnpm_10"`.
    expect(flake).toMatch(/\bpnpmMajor\s*=\s*"\d+";/);
    expect(flake.match(/\bpnpmMajor\s*=/g)).toHaveLength(1);
    expect(flake).toContain('pnpm_${pnpmMajor}');
    expect(flake).not.toMatch(/pnpm_\d+/);
  });

  it('has EVERY setup-node step in EVERY workflow read .nvmrc, with no literal beside it', () => {
    let checked = 0;

    for (const [name, workflow] of allWorkflows()) {
      let blocks: string[][];
      try {
        blocks = stepBlocks(workflow, 'actions/setup-node@');
      } catch {
        continue; // a workflow may legitimately not set node up at all
      }

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
      let blocks: string[][];
      try {
        blocks = stepBlocks(workflow, 'pnpm/action-setup@');
      } catch {
        continue;
      }

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

      let blocks: string[][];
      try {
        blocks = stepBlocks(workflow, 'actions/setup-node@');
      } catch {
        continue;
      }
      for (const block of blocks) {
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
    expect(() => stepBlocks(sample, 'pnpm/action-setup@')).toThrow(/no `- uses: pnpm/);

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

    // The npm detector fires on an invocation and NOT on a mere mention —
    // `pnpm dlx npm-check-updates` turning the branch red is a false red, and a
    // permanently-red gate is worse than no gate.
    expect('npm ci').toMatch(INVOKES_NPM_OR_YARN);
    expect('cd app && npm ci').toMatch(INVOKES_NPM_OR_YARN);
    expect('yarn install').toMatch(INVOKES_NPM_OR_YARN);
    expect('pnpm install --frozen-lockfile').not.toMatch(INVOKES_NPM_OR_YARN);
    expect('pnpm dlx npm-check-updates').not.toMatch(INVOKES_NPM_OR_YARN);

    // The platform buildCommand regex accepts the real value and rejects the
    // shapes the platform rejects — copied from its validator, so a control is
    // the only thing proving it was copied correctly.
    expect('pnpm run build').toMatch(PLATFORM_BUILD_COMMAND_RE);
    expect('npx vite build').toMatch(PLATFORM_BUILD_COMMAND_RE);
    expect('pnpm  run build').not.toMatch(PLATFORM_BUILD_COMMAND_RE);
    expect('pnpm run build && echo hi').not.toMatch(PLATFORM_BUILD_COMMAND_RE);

    // And the parsers are pointed at files that exist and are non-empty.
    expect(allWorkflows().length).toBeGreaterThan(0);
    expect(flakeCode().length).toBeGreaterThan(0);
  });
});
