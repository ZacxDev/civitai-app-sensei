import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * 🔴 A LOCAL SHELL AND CI THAT INSTALL DIFFERENT TOOLCHAINS MAKE A GREEN RUN
 * MEAN NOTHING.
 *
 * `flake.nix` is what a contributor's shell installs (`nix develop` / direnv);
 * `.github/workflows/ci.yml` is what the merge gate installs;
 * `block.manifest.json`'s `buildCommand` is what the PLATFORM's builder runs to
 * produce the live app. When those disagree, "it passes locally" stops being
 * evidence about the gate and the gate stops being evidence about anyone's
 * machine — and nothing announces the split, because both sides stay green
 * while testing different things. That is the state this repo was in until the
 * flake landed: no dev shell at all, a literal `node-version: 22` and
 * `cache: npm` in the workflow.
 *
 * The pins are asymmetric on purpose. Node has ONE authority, `.nvmrc`, read by
 * flake.nix (`builtins.readFile`) and by CI (`node-version-file`) — neither
 * restates a version, so what is guarded is that the wiring is still that way.
 * pnpm takes TWO statements, because `pnpm/action-setup` reads only its own
 * `version:` input or `package.json`'s `packageManager` field, and adding
 * `packageManager` would change what the PLATFORM's builder does
 * (`buildCommand: pnpm run build` runs against that same file). So the pnpm
 * major is written down twice and asserted equal here.
 *
 * Every extractor below THROWS when the shape it expects is missing rather than
 * returning undefined: a guard that passes once someone deletes the step it
 * inspects reads as coverage while providing none.
 *
 * 🔴 KNOW THIS FILE'S CEILING — it is a tripwire for drift, not a proof.
 *
 * These are textual assertions over YAML and over Nix, a Turing-complete
 * expression language. An earlier version grew to 858 lines and eight
 * assertions across six adversarial rounds of hand-rolled parsing, and every
 * round still ended with mutants that passed it. It documented five and
 * concluded three could not be closed textually at all. They are properties of
 * the APPROACH rather than of that file's parsers, so all five are still open:
 *
 *   1. A decoy in a Nix STRING: use no `nodejs_` attribute at all
 *      (`nodejs = pkgs.nodejs;`) while a shellHook line spells
 *      `nodejs_${nodeMajor}`. String contents are code to a text scan.
 *   2. `inherit (pins) nodeMajor;`, or re-binding it as a lambda parameter
 *      (`mk = nodeMajor: …; in mk "22"`), binds the name with no `=` this file
 *      can see, leaving the real readFile binding intact and unused. The
 *      858-line version counted definitions to catch this; that count is gone.
 *   3. A quoted `"run":` key hides a command from `runCommands`, so a wholesale
 *      revert to npm can be written where nothing reads it.
 *   4. A step whose `uses:` value sits on the FOLLOWING line, or a flow-style
 *      step, cannot be parsed here — that now fails LOUDLY (the extractors
 *      throw, the ledger goes red) rather than silently skipping a workflow.
 *   5. A composite action (`action.yml`) carrying its own setup steps is not
 *      read at all. A second WORKFLOW is caught, but only because the ledger
 *      below asserts the workflow set is exactly `['ci.yml']`.
 *
 * The fix for all five is structural, not another regex: parse the workflow
 * with a real YAML parser, and pin the flake by EVALUATION in CI —
 * `nix flake check --all-systems`, and `nix eval
 * .#packages.<system>.nodejs.version` compared against `.nvmrc`. CI does not
 * run nix today, so NOTHING AUTOMATED DOES THIS: run it by hand whenever you
 * touch flake.nix, and do not read a green suite as covering it.
 *
 * Read off disk rather than imported: `.nvmrc`, `flake.nix` and a YAML workflow
 * have no import form at all, and the bytes on disk are what CI executes.
 */

function repoFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

/**
 * flake.nix with full-line comments removed — necessary, not decorative: this
 * flake writes `nodejs_24` inside a comment explaining why the major is not
 * restated, and the "no literal node attribute" assertion would match it.
 * Whether a TRAILING `#` opens a comment depends on whether you are inside a
 * string and no line-wise regex can know that, so a trailing `# … nodejs_22`
 * gives a FALSE RED (the safe direction); a decoy inside a Nix string stays
 * invisible (survivor 1).
 */
function flakeCode(): string {
  return repoFile('../flake.nix')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * The lines of the step that uses `<actionPrefix>…`, excluding its first line.
 *
 * `uses:` may be the step's first line (`- uses: x`) or a LATER line of the same
 * list item (`- name: Set up Node` / `  uses: x`) — the idiomatic spelling.
 * Anchoring on `- uses:` alone was both a false red (adding a `name:` to this
 * repo's own step reddened CI) and a false green (such a step was invisible).
 * Deliberately not a YAML parse — this repo ships no YAML dependency; see the
 * CEILING note above for what that costs.
 */
function stepBlock(workflow: string, actionPrefix: string): string[] {
  const lines = workflow.split('\n');
  const escaped = actionPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = lines.findIndex((line) =>
    new RegExp(`^\\s*(?:-\\s+)?uses:\\s*["']?${escaped}`).test(line),
  );
  if (start === -1) {
    throw new Error(`ci.yml has no step using ${actionPrefix}…`);
  }

  // The key's own indentation, whether or not it carries the `- ` marker.
  const indent = lines[start].replace(/^(\s*)-\s+/, '$1').match(/^\s*/)![0].length;
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    const lineIndent = line.match(/^\s*/)![0].length;
    if (lineIndent < indent) break; // dedent out of the step
    if (lineIndent === indent && /^\s*-\s/.test(line)) break; // a sibling step
    block.push(line);
  }
  return block;
}

/**
 * ONLY the `with:` mapping of a step. Reading every `key: value` at any depth
 * looks harmless and is not: a step's `env:` is a sibling of its `with:` and
 * `new Map` is last-wins, so `env: { node-version-file: .nvmrc }` below a
 * `with:` naming a DIFFERENT file makes the guard read the value it wants to
 * see while CI installs the other one. Only `with:` carries an action's inputs.
 */
function withMapping(block: string[]): string[] {
  const start = block.findIndex((line) => /^\s*with:\s*(#.*)?$/.test(line));
  if (start === -1) return [];
  const indent = block[start].match(/^\s*/)![0].length;

  const out: string[] = [];
  for (const line of block.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (line.match(/^\s*/)![0].length <= indent) break;
    out.push(line);
  }
  return out;
}

/**
 * Every `key: value` in a mapping, quotes and trailing comments stripped. The
 * key may be QUOTED: `"node-version": 22` is valid YAML and GitHub reads it as
 * the `node-version` input, but a regex anchored on a bare letter cannot see it
 * — which is how a literal node version hid in plain sight next to the
 * `node-version-file` this guard was checking.
 */
function settingsIn(lines: string[]): Array<[string, string]> {
  const KV = /^\s*(?:"([\w.-]+)"|'([\w.-]+)'|([A-Za-z][\w.-]*))\s*:\s*(\S.*?)\s*$/;

  return lines.flatMap((line) => {
    const m = line.match(KV);
    if (!m) return [];
    // Unquote BEFORE stripping a trailing comment, or a quoted value that
    // legitimately contains ` # ` is truncated at the hash.
    const quoted = m[4].match(/^(["'])(.*?)\1\s*(?:#.*)?$/);
    const value = quoted ? quoted[2] : m[4].replace(/\s+#.*$/, '').trim();
    return [[m[1] ?? m[2] ?? m[3], value] as [string, string]];
  });
}

/**
 * Every command a workflow runs — inline `run: x` AND the lines of a block
 * scalar `run: |`. Multi-line `run:` is how anyone actually writes several
 * commands, so reading only the inline form leaves the likely shape of a revert
 * to npm entirely unread.
 */
function runCommands(workflow: string): string[] {
  const lines = workflow.split('\n');
  const commands: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*#/.test(lines[i])) continue;
    const m = lines[i].match(/^(\s*)-?\s*run:\s*(.*?)\s*$/);
    if (!m) continue;

    const indent = m[1].length;
    // `|`, `>` and their chomping/indent indicators (`|-`, `>+`, `|2`) all
    // introduce a block; so does a bare `run:` with nothing after it.
    if (m[2] !== '' && !/^[|>][-+0-9]*$/.test(m[2])) {
      commands.push(m[2]);
      continue;
    }
    for (const line of lines.slice(i + 1)) {
      if (line.trim() === '') continue;
      if (line.match(/^\s*/)![0].length <= indent) break;
      if (/^\s*#/.test(line)) continue; // a shell comment is not an invocation
      commands.push(line.trim());
    }
  }

  return commands;
}

/**
 * Does this command INVOKE npm or yarn, as opposed to merely mentioning one? A
 * bare `/\bnpm\b/` turns `pnpm dlx npm-check-updates` red, and a false red is
 * how a gate gets disabled — so only the command position counts. The negative
 * lookbehind on a short flag is what keeps `command -v npm` (a PROBE) out, and
 * `|` is deliberately not a terminator so `sed -e "s|npm|pnpm|"` stays green
 * while `npm ci | tee log` still matches on the space.
 */
const INVOKES_NPM_OR_YARN =
  /(?:^|[;&|(`'"]|\s)(?:[A-Za-z_]\w*=\S*\s+)*(?:sudo\s+)?["'`]?(?:[\w./-]*\/)?(?<!-[a-zA-Z] )(?:npm|yarn)(?:[\s;&)"'`]|$)/;

/**
 * The platform's OWN accepted form for `buildCommand`, copied from the
 * app-blocks pipeline's `resolve-build.mjs`. Reproduced rather than
 * approximated because the whole point is to fail here instead of there.
 */
const PLATFORM_BUILD_COMMAND_RE = /^(?:(?:npm|pnpm|yarn) run [a-zA-Z0-9:_-]+|(?:npx )?vite build)$/;

/**
 * The package manager CI installs with, READ OUT OF the workflow.
 * `pnpm/action-setup` is what puts a pnpm on the runner's PATH at all; without
 * it the only package manager a job has is the npm that ships with node via
 * `actions/setup-node`. So that step's presence IS CI's statement of which
 * package manager it uses, and deriving from it is what makes the assertion
 * below a claim about CI rather than about a literal typed into this file.
 */
function ciPackageManager(workflow: string): string {
  const hasPnpmSetup = /^\s*(?:-\s+)?uses:\s*["']?pnpm\/action-setup@/m.test(workflow);

  // A workflow that invokes no package manager has none to compare against, and
  // answering "npm" for it would be an invention rather than a reading.
  if (!/\b(?:npm|pnpm|yarn|bun)\s+(?:install|ci|run|test|build|exec)\b/.test(workflow)) {
    throw new Error(
      'ci.yml invokes no npm/pnpm/yarn/bun command — there is no CI package manager to compare against',
    );
  }

  return hasPnpmSetup ? 'pnpm' : 'npm';
}

describe('toolchain lockstep', () => {
  const workflow = repoFile('../.github/workflows/ci.yml');

  it('states the node major once, in .nvmrc, in the form the flake can consume', () => {
    // flake.nix interpolates this straight into the attribute name
    // `pkgs."nodejs_${nodeMajor}"`, so a patch-level `.nvmrc` (`24.19.0`) names
    // an attribute nixpkgs does not have and the shell dies on eval.
    // `actions/setup-node` accepts a bare major just as happily.
    expect(repoFile('../.nvmrc').trim()).toMatch(/^\d+$/);
  });

  it('BINDS the node major in flake.nix to what it read from .nvmrc', () => {
    const flake = flakeCode();

    // 🔴 Not `toContain('builtins.readFile ./.nvmrc')` — that is a SPELLED
    // guard, walked around twice: once by leaving the words in a comment while
    // the code beneath hardcoded a major, once by binding the read to an unused
    // name. The read has to BE the right-hand side, modulo wrapping calls like
    // `nixpkgs.lib.trim (…)` — which also rejects `if false then (…readFile…)
    // else "22"` and `(_: "22") (…readFile…)`, both of which contain the read,
    // discard it, and were confirmed with `nix eval` to install node 22.
    expect(flake).toMatch(
      /^\s*nodeMajor\s*=\s*(?:[\w.]+\s*\(\s*)*builtins\.readFile\s*\(?\s*\.\/\.nvmrc/m,
    );

    // …and every node attribute must interpolate that name. Asserting only that
    // `nodejs_${nodeMajor}` occurs was defeated by a decoy: keep the
    // interpolation in an unused binding, build the real derivation from a
    // second let-bound literal. Survivor 1 is what this still misses.
    expect(flake).toContain('nodejs_${nodeMajor}');
    expect(flake).toContain('nodejs-slim_${nodeMajor}');
    expect(flake).not.toMatch(/nodejs(?:-slim)?_(?!\$\{nodeMajor\})/);
  });

  it('reads every workflow, and every toolchain step in them', () => {
    // A LEDGER, not a scan. The assertions below read `ci.yml` and the FIRST
    // step using each action, so a second workflow — or a second setup-node
    // step further down this one — would carry its own toolchain past them
    // unseen. The 858-line version answered that by walking every workflow and
    // every `action.yml` in the tree; asserting the SET is the cheap half.
    // Adding either turns this red and makes someone widen the guard on
    // purpose, instead of it quietly covering less than its name says.
    const workflows = readdirSync(new URL('../.github/workflows/', import.meta.url)).sort();
    expect(workflows, 'workflow files this guard reads').toEqual(['ci.yml']);

    // `?? []` so a step that vanished reads as "0 steps", not as a null target.
    const count = (re: RegExp) => workflow.match(re) ?? [];
    expect(count(/uses:\s*["']?actions\/setup-node@/g), 'setup-node steps').toHaveLength(1);
    expect(count(/uses:\s*["']?pnpm\/action-setup@/g), 'pnpm steps').toHaveLength(1);
  });

  it('has CI read .nvmrc rather than restating the node version', () => {
    const byKey = new Map(settingsIn(withMapping(stepBlock(workflow, 'actions/setup-node@'))));

    // `./.nvmrc` and `.nvmrc` are the same file to setup-node; failing on the
    // prefix would be a false red.
    expect(byKey.get('node-version-file')?.replace(/^\.\//, '')).toBe('.nvmrc');

    // The half that actually stops the drift. `node-version-file` being present
    // proves nothing on its own: `actions/setup-node` accepts BOTH inputs and
    // PREFERS the literal `node-version`, so a step carrying both would read
    // `.nvmrc` in this assertion's eyes and install something else in reality —
    // precisely the `node-version: 22` this repo shipped until the flake landed.
    expect(byKey.has('node-version')).toBe(false);
  });

  it('pins the same pnpm major in flake.nix and in CI, and builds from it', () => {
    const flake = flakeCode();
    const flakePin = flake.match(/^\s*pnpmMajor = "(\d+)";/m);
    if (!flakePin) {
      throw new Error('flake.nix has no `pnpmMajor = "<n>";` line to compare against');
    }

    // Declaring the pin is not using it: a decoy `pnpmMajor = "11";` beside a
    // real `pkgs."pnpm_10"` keeps the comparison below green.
    expect(flake).toContain('pnpm_${pnpmMajor}');
    expect(flake).not.toMatch(/pnpm_(?!\$\{pnpmMajor\})/);

    const ciPin = new Map(
      settingsIn(withMapping(stepBlock(workflow, 'pnpm/action-setup@'))),
    ).get('version');
    if (ciPin === undefined) {
      // Not a soft pass: `pnpm/action-setup` falls back to package.json's
      // `packageManager` when `version:` is absent, and this repo declares no
      // such field, so the step would fail at runtime. Either way the pins stop
      // being comparable, which is the state this guard exists to catch.
      throw new Error('ci.yml pnpm/action-setup step declares no `version:` to compare against');
    }

    // Majors, not full versions: nixpkgs carries whatever patch it carries and
    // the action resolves the latest of the major. Pinning the patch would rot
    // on a routine `nix flake update` and turn trunk red for nothing — a
    // permanently-red gate teaches everyone to merge through it.
    expect(ciPin.split('.')[0]).toBe(flakePin[1]);
  });

  it('has CI actually RUN pnpm, not merely install it', () => {
    // Every other assertion here describes how pnpm is INSTALLED and none asks
    // whether anything uses it, so leaving the `pnpm/action-setup` step as
    // decoration while reverting every command to npm kept the whole file
    // green. It also makes `ciPackageManager` — which derives CI's package
    // manager from that step's presence — tell a lie.
    let sawPnpm = false;
    for (const command of runCommands(workflow)) {
      expect(command, 'run step invokes npm/yarn').not.toMatch(INVOKES_NPM_OR_YARN);
      if (/\bpnpm\b/.test(command)) sawPnpm = true;
    }
    expect(sawPnpm, 'a run step that actually invokes pnpm').toBe(true);

    // `cache:` picks which lockfile setup-node restores; `npm` here caches
    // nothing useful and states the wrong package manager.
    const cache = new Map(
      settingsIn(withMapping(stepBlock(workflow, 'actions/setup-node@'))),
    ).get('cache');
    if (cache !== undefined) expect(cache).toBe('pnpm');
  });

  it("keeps buildCommand in the form the PLATFORM accepts, on CI's package manager", () => {
    // 🔴 `buildCommand` is what the PLATFORM's builder runs against the
    // submitted bundle, and `.github/` is not IN that bundle — so the merge gate
    // never executes this command and CI being green says nothing about it. The
    // builder validates it against its own regex, then picks which lockfile it
    // demands from the command's package manager: `pnpm …` requires
    // `pnpm-lock.yaml`, anything else `package-lock.json`, which this repo no
    // longer has. A mismatch hands the builder a tree its package manager cannot
    // install while every signal this repo produces stays green. Not
    // hypothetical: `generate-from-model` shipped exactly that state and only
    // `civitai app validate` caught it, at submission time.
    const manifest = JSON.parse(repoFile('../block.manifest.json')) as { buildCommand?: unknown };
    if (typeof manifest.buildCommand !== 'string') {
      throw new Error('block.manifest.json has no string "buildCommand" to compare against');
    }
    const buildCommand = manifest.buildCommand;

    // The WHOLE normalised string, not its first token: `"pnpm  run build"` (two
    // spaces) has the first token `pnpm` and is REJECTED by the platform
    // validator, so first-token parsing alone is green on a manifest that cannot
    // build.
    expect(buildCommand).toMatch(PLATFORM_BUILD_COMMAND_RE);
    expect(buildCommand).toBe('pnpm run build');

    // …and the script it names has to exist, or the builder runs a command that
    // resolves to nothing (`pnpm run buildx`).
    const pkg = JSON.parse(repoFile('../package.json')) as { scripts?: Record<string, string> };
    expect(Object.keys(pkg.scripts ?? {}), 'package.json scripts').toContain(
      buildCommand.replace(/^pnpm run /, ''),
    );

    // BOTH sides derived. An earlier draft hardcoded 'pnpm' for CI, which made
    // its own name false: it would have gone on passing through a CI switch to
    // npm, the precise drift it claims to catch.
    expect(buildCommand.trim().split(/\s+/)[0]).toBe(ciPackageManager(workflow));

    // Exactly one lockfile may exist or the two disagree silently — and this
    // reads the working tree on purpose: an untracked `package-lock.json` still
    // lands in a `civitai app submit` bundle.
    const rootFiles = readdirSync(new URL('../', import.meta.url));
    expect(rootFiles).toContain('pnpm-lock.yaml');
    expect(rootFiles).not.toContain('package-lock.json');
    expect(rootFiles).not.toContain('yarn.lock');
  });

  it('🔴 describes the extractors — they can FAIL, and they do match this repo', () => {
    // Every assertion above is only as good as these parsers, and one that
    // silently matches nothing produces a confident green. `INVOKES_NPM_OR_YARN`
    // needs this most: a regex that never fires reinstates the npm revert while
    // the suite stays green, and nothing else here would notice.
    const sample = [
      '      - name: Set up Node', //                 `uses:` is NOT the first
      '        uses: "actions/setup-node@v4"', //      line — idiomatic spelling
      '        with:',
      '          # a comment that mentions node-version: 99',
      '          "node-version": 22', //               a QUOTED key
      '          node-version-file: ".nvmrc"  # quoted, trailing comment',
      '        env:',
      '          node-version-file: .decoy', //        a sibling mapping
      '      - run: pnpm test',
      '',
    ].join('\n');

    const settings = new Map(settingsIn(withMapping(stepBlock(sample, 'actions/setup-node@'))));
    expect(settings.get('node-version')).toBe('22');
    expect(settings.get('node-version-file')).toBe('.nvmrc'); // not `.decoy`
    expect(() => stepBlock(sample, 'pnpm/action-setup@')).toThrow(/no step using pnpm/);

    expect(runCommands(sample)).toEqual(['pnpm test']);
    expect(runCommands('jobs:\n  build:\n')).toEqual([]);
    expect(runCommands('      - run: |\n          npm ci\n          npm run build\n')).toEqual([
      'npm ci',
      'npm run build',
    ]);

    // The npm detector fires on an INVOCATION and not on a mere mention. Both
    // directions matter: missing an invocation reinstates the revert, and firing
    // on a mention is a false red, which is how a gate gets disabled.
    const invocations = ['npm ci', 'CI=1 npm ci', 'bash -c "npm ci"', 'x && npm ci | tee log'];
    const mentions = ['pnpm install -r', 'pnpm dlx npm-check-updates', 'sed "s|npm|pnpm|" x', 'if ! command -v npm; then :; fi'];
    for (const yes of invocations) expect(yes, `detected: ${yes}`).toMatch(INVOKES_NPM_OR_YARN);
    for (const no of mentions) expect(no, `not detected: ${no}`).not.toMatch(INVOKES_NPM_OR_YARN);

    // The platform regex accepts the real value and rejects what the platform
    // rejects — it was copied from that validator, so a control is the only
    // thing proving it was copied correctly.
    expect('npx vite build').toMatch(PLATFORM_BUILD_COMMAND_RE);
    expect('pnpm  run build').not.toMatch(PLATFORM_BUILD_COMMAND_RE);
    expect('pnpm run build && echo hi').not.toMatch(PLATFORM_BUILD_COMMAND_RE);

    // …and `ciPackageManager` reads CI rather than answering from a literal.
    expect(ciPackageManager('- uses: pnpm/action-setup@v4\n- run: pnpm install')).toBe('pnpm');
    expect(ciPackageManager('- run: npm ci')).toBe('npm');
    expect(() => ciPackageManager('- uses: actions/checkout@v4')).toThrow(/no npm\/pnpm/);

    // The flake comment filter removes comment lines and keeps the code.
    expect(repoFile('../flake.nix'), 'flake.nix has comments to strip').toMatch(/^\s*#/m);
    expect(flakeCode(), 'no comment lines survive').not.toMatch(/^\s*#/m);
    expect(flakeCode()).toContain('pnpmMajor');
  });
});
