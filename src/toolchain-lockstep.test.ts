import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * 🔴 A LOCAL SHELL AND CI THAT INSTALL DIFFERENT TOOLCHAINS MAKE A GREEN RUN
 * MEAN NOTHING.
 *
 * `flake.nix` is what a contributor's shell installs (`nix develop` / direnv);
 * `.github/workflows/*` is what the merge gate installs. When those disagree,
 * "it passes locally" stops being evidence about the gate and the gate stops
 * being evidence about anyone's machine — and nothing announces the split,
 * because both sides stay green while testing different things.
 *
 * That is the state this repo was in until the flake landed. There was no dev
 * shell at all, so there was nothing for CI to agree WITH: the workflow carried
 * a literal `node-version: 22` and `cache: npm`, and every contributor ran
 * whatever node their machine happened to have. A version written down in one
 * place and nowhere else looks pinned while being pinned to nothing, and the
 * failure it produces is not a red X but a green run against a toolchain nobody
 * else has.
 *
 * The two pins are handled asymmetrically, on purpose:
 *
 *   node — ONE authority, `.nvmrc`. flake.nix reads it with `builtins.readFile`
 *          and CI reads it via `actions/setup-node`'s `node-version-file`.
 *          Neither restates a version, so neither can drift. What this file
 *          guards is that the arrangement is still WIRED THAT WAY.
 *
 *   pnpm — TWO statements, because `pnpm/action-setup` reads only its own
 *          `version:` input or `package.json`'s `packageManager` field, and
 *          adding `packageManager` would change what the PLATFORM's builder
 *          does (`block.manifest.json`'s `buildCommand` runs against that same
 *          file). So the major is written down twice and asserted equal here.
 *
 * ---------------------------------------------------------------------------
 * 🔴 THIS FILE WAS AUDITED AND FOUND TO PASS WITH THE HAZARD PRESENT.
 *
 * The first version was a near-verbatim port from `civitai-app-gen-matrix`. An
 * adversarial pass on PR #66 built six mutants that reinstated exactly what the
 * docstring above promises to catch, and the suite stayed 4/4 GREEN for every
 * one of them. They are listed because each one is a SHAPE, not a typo, and the
 * shapes recur:
 *
 *   G1  `"node-version": 22` — a QUOTED yaml key. The settings regex required
 *       the key to start with a letter, so the literal was invisible while
 *       GitHub read it and preferred it over `node-version-file`.
 *   G2  `# was: builtins.readFile ./.nvmrc` plus `nodeMajor = "22";` — a
 *       SPELLED guard. `toContain(…)` matched the words inside a comment.
 *   G3  `pnpmMajor = "11";` kept, but `pkgs."pnpm_10"` used. Nothing asserted
 *       the DECLARATION was the thing the flake actually consumed.
 *   G4  a second job whose setup-node carried a literal. Only the FIRST step in
 *       the file was inspected.
 *   G5  a second workflow file carrying a literal. Only `ci.yml` was read.
 *   G6  every `pnpm` command reverted to `npm`, `cache: pnpm` → `cache: npm`,
 *       the action-setup step left in place as decoration. The docstring named
 *       `cache: npm` as half the original defect; the implementation inspected
 *       neither `cache:` nor any `run:` step. A DESCRIPTION wider than its
 *       implementation reads as coverage while providing none.
 *
 * So the assertions below pin STATE — a resolved value, an enumerated set,
 * every occurrence — rather than the presence of a word another edit can spell.
 * `describes the extractors` is the control that keeps them honest: a guard
 * whose parser silently matches nothing is indistinguishable from a green run.
 *
 * Read off disk rather than imported, for the same reason `manifest.test.ts`
 * does it: the bytes on disk are what ship and what CI executes, and
 * `import.meta.url` makes the paths independent of the runner's cwd.
 *
 * Every extractor THROWS when the shape it expects is missing, rather than
 * returning undefined.
 */

function repoFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

/**
 * EVERY workflow, not just `ci.yml` (mutant G5). A literal `node-version` in a
 * release or nightly workflow splits the toolchain exactly as well as one in
 * the merge gate.
 */
function allWorkflows(): Array<[name: string, content: string]> {
  const dir = new URL('../.github/workflows/', import.meta.url);
  const names = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort();
  if (names.length === 0) {
    throw new Error('.github/workflows contains no workflow files to check');
  }
  return names.map((n) => [n, readFileSync(new URL(n, dir), 'utf8')]);
}

/** A yaml scalar as written: `.nvmrc`, `".nvmrc"`, `.nvmrc  # why`. */
function scalar(raw: string): string {
  const withoutComment = raw.replace(/\s+#.*$/, '').trim();
  const quoted = withoutComment.match(/^(["'])(.*)\1$/);
  return quoted ? quoted[2] : withoutComment;
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
      // A sibling list item ends the step; so does any dedent out of it. The
      // dedent case matters: without it an over-extended block absorbs a later
      // step's settings, and `new Map` is last-wins, so the guard would read a
      // value that belongs to something else.
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
 * Every `key: value` at any depth inside a step block, as pairs.
 *
 * The key may be quoted (mutant G1). `"node-version": 22` is valid YAML and
 * GitHub reads it as the `node-version` input; a regex anchored on a bare
 * letter cannot see it, which is how a literal node version hid in plain sight
 * next to the `node-version-file` this guard was checking.
 */
function settingsIn(block: string[]): Array<[string, string]> {
  return block
    .map((line) => line.match(/^\s*(?:"([\w.-]+)"|'([\w.-]+)'|([A-Za-z][\w.-]*))\s*:\s*(\S.*?)\s*$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => [m[1] ?? m[2] ?? m[3], scalar(m[4])] as [string, string]);
}

/**
 * Every command a workflow runs — inline `run: x` AND the lines of a block
 * scalar `run: |`.
 *
 * The block-scalar half is not an edge case, it is the SAME hole in a second
 * shape. The first fix for G6 only read the inline form, so a workflow could
 * revert wholesale to npm inside a `run: |` block and the guard stayed 8/8
 * green — measured before this line existed. Multi-line `run:` is the ordinary
 * way to write more than one command, so it is the shape a real revert takes.
 */
function runCommands(workflow: string): string[] {
  const lines = workflow.split('\n');
  const commands: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\s*)-?\s*run:\s*(.*?)\s*$/);
    if (!m) continue;

    const indent = m[1].length;
    const inline = m[2];

    // `|`, `>`, and their chomping/indent indicators (`|-`, `>+`, `|2`) all
    // introduce a block; a bare `run:` with nothing after it does too.
    if (inline === '' || /^[|>][-+]?\d*$/.test(inline) || /^[|>]\d*[-+]?$/.test(inline)) {
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

/** flake.nix with full-line comments removed (mutant G2). */
function flakeCode(): string {
  return repoFile('../flake.nix')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

const NVMRC = repoFile('../.nvmrc').trim();

describe('toolchain lockstep', () => {
  it('states the node major once, in .nvmrc, in the form the flake can consume', () => {
    // flake.nix interpolates this straight into the attribute name
    // `pkgs."nodejs_${nodeMajor}"`. A patch-level `.nvmrc` (`24.19.0`) names an
    // attribute nixpkgs does not have, so the shell dies on eval rather than
    // falling back — and `actions/setup-node` accepts a bare major just as
    // happily.
    expect(NVMRC).toMatch(/^\d+$/);
  });

  it('has flake.nix READ .nvmrc, and use what it read, rather than restating the node version', () => {
    const flake = flakeCode();

    // Not `toContain` on the raw file: mutant G2 satisfied that from inside a
    // comment while the code below it hardcoded a different major.
    expect(flake).toContain('builtins.readFile ./.nvmrc');

    // …and the value has to be the one the packages are actually built from.
    // A read whose result is never used is decoration.
    expect(flake).toContain('nodejs_${nodeMajor}');
    expect(flake).toContain('nodejs-slim_${nodeMajor}');

    // No literal node major anywhere in the code, in either attribute spelling.
    // This is the assertion that makes the two above load-bearing.
    expect(flake).not.toMatch(/nodejs(-slim)?_\d+/);
  });

  it('has flake.nix use the pnpm major it declares, rather than a literal', () => {
    const flake = flakeCode();

    // Mutant G3 kept `pnpmMajor = "11";` as a decoy and built `pkgs."pnpm_10"`.
    // Reading the declaration is not enough; the declaration has to be the
    // thing consumed.
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
        const byKey = new Map(settingsIn(block));
        expect(byKey.get('node-version-file'), `${name}: node-version-file`).toBe('.nvmrc');

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
        const ciPin = new Map(settingsIn(block)).get('version');
        if (ciPin === undefined) {
          // Not a soft pass. `pnpm/action-setup` falls back to package.json's
          // `packageManager` when `version:` is absent — and this repo declares
          // no such field, so the step would fail at runtime. Either way the
          // pins are no longer comparable, which is the state this guard exists
          // to catch.
          throw new Error(`${name}: pnpm/action-setup declares no \`version:\` to compare against`);
        }

        // Majors, not full versions: nixpkgs carries whatever patch it carries
        // and the action resolves the latest of the major. Pinning the patch
        // would rot on a routine `nix flake update` and turn trunk red for
        // nothing — a permanently-red gate teaches everyone to merge through
        // it. A more precise CI pin (`11.25.0`) is therefore accepted.
        expect(ciPin.split('.')[0], `${name}: pnpm major`).toBe(flakePin[1]);
        checked += 1;
      }
    }

    expect(checked, 'pnpm/action-setup steps inspected').toBeGreaterThan(0);
  });

  it('has CI actually RUN pnpm, not merely install it', () => {
    // Mutant G6 left the `pnpm/action-setup` step in place as decoration and
    // reverted everything that uses it — `cache: pnpm` → `npm`, `pnpm install`
    // → `npm ci`, every `pnpm run X` → `npm run X`. Every assertion above
    // stayed green: they all describe how pnpm is INSTALLED, and none of them
    // asked whether anything uses it. The docstring named `cache: npm` as half
    // the original defect, so the implementation has to look at it.
    let sawPnpmRun = false;

    for (const [name, workflow] of allWorkflows()) {
      for (const command of runCommands(workflow)) {
        // `\b` before `npm` does not match inside `pnpm` — `p` and `n` are both
        // word characters — so this does not flag pnpm's own invocations.
        expect(command, `${name}: run step invokes npm/yarn`).not.toMatch(/\b(npm|yarn)\b/);
        if (/\bpnpm\b/.test(command)) sawPnpmRun = true;
      }

      let blocks: string[][];
      try {
        blocks = stepBlocks(workflow, 'actions/setup-node@');
      } catch {
        continue;
      }
      for (const block of blocks) {
        const cache = new Map(settingsIn(block)).get('cache');
        if (cache !== undefined) {
          expect(cache, `${name}: setup-node cache`).toBe('pnpm');
        }
      }
    }

    expect(sawPnpmRun, 'a workflow that actually runs pnpm').toBe(true);
  });

  it('keeps block.manifest.json buildCommand and the committed lockfile in agreement', () => {
    // 🔴 This is the PLATFORM's rule, not a preference. The app-blocks build
    // pipeline selects which lockfile it demands from the FIRST WORD of
    // `buildCommand`: `pnpm run build` requires `pnpm-lock.yaml` and installs
    // with `pnpm install --frozen-lockfile`, while anything else requires
    // `package-lock.json` and `npm ci`, exiting 1 with "no package-lock.json is
    // committed" when it is missing.
    //
    // So after the npm→pnpm conversion, reverting this one word — without also
    // restoring a lockfile that no longer exists in the repo — hard-fails the
    // build of the LIVE app, and nothing in CI goes red, because `.github/` is
    // not part of the submitted bundle. Nothing here guarded that until it was
    // pointed out on PR #66.
    const manifest = JSON.parse(repoFile('../block.manifest.json')) as { buildCommand?: unknown };
    if (typeof manifest.buildCommand !== 'string') {
      throw new Error('block.manifest.json has no string "buildCommand"');
    }

    const packageManager = manifest.buildCommand.trim().split(/\s+/)[0];
    expect(packageManager).toBe('pnpm');

    const lockfiles = readdirSync(new URL('../', import.meta.url));
    expect(lockfiles).toContain('pnpm-lock.yaml');
    // Exactly one lockfile may remain, or the two can disagree silently.
    expect(lockfiles).not.toContain('package-lock.json');
    expect(lockfiles).not.toContain('yarn.lock');
  });

  it('🔴 describes the extractors — they can FAIL, and they do match this repo', () => {
    // The control the first version of this file lacked. Every assertion above
    // is only as good as these three parsers; a parser that silently matches
    // nothing produces a confident green. `manifest.test.ts` carries the same
    // kind of self-control for its own regex.
    const sample = [
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          # a comment that mentions node-version: 99',
      '          "node-version": 22',
      '          node-version-file: ".nvmrc"  # quoted, with a trailing comment',
      '      - name: after',
      '        run: pnpm test',
      '',
    ].join('\n');

    const settings = new Map(settingsIn(stepBlocks(sample, 'actions/setup-node@')[0]));

    // Quoted key is seen (G1), quotes and trailing comments are stripped (G8),
    // and the block stops at the sibling step rather than swallowing its `run`.
    expect(settings.get('node-version')).toBe('22');
    expect(settings.get('node-version-file')).toBe('.nvmrc');
    expect(settings.has('run')).toBe(false);

    // The extractor throws rather than returning empty for an absent step.
    expect(() => stepBlocks(sample, 'pnpm/action-setup@')).toThrow(/no `- uses: pnpm/);

    // `runCommands` finds commands, and is not a regex that matches anything.
    expect(runCommands(sample)).toEqual(['pnpm test']);
    expect(runCommands('jobs:\n  build:\n')).toEqual([]);

    // …including inside a block scalar, which the first fix for G6 missed
    // entirely: a wholesale revert to npm written as `run: |` stayed green.
    const block = [
      '      - name: Install',
      '        run: |',
      '          npm ci',
      '          npm run build',
      '      - run: pnpm test',
      '',
    ].join('\n');
    expect(runCommands(block)).toEqual(['npm ci', 'npm run build', 'pnpm test']);

    // And the parsers are pointed at files that exist and are non-empty.
    expect(allWorkflows().length).toBeGreaterThan(0);
    expect(flakeCode().length).toBeGreaterThan(0);
  });
});
