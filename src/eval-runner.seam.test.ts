import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 🔴 THE SEAM BETWEEN THE EVAL AND THE APP — the one thing neither side's own
 * tests can see.
 *
 * `eval/run-eval.mjs` is the instrument that decides whether a prompt or a
 * mechanism improved grounding. It used to carry its own inline copy of the
 * citation regex and the set-membership test. Two copies of one predicate is
 * the seam that lets a green suite coexist with a broken shipped path: the
 * runner measures ITS rule, `linkHref` enforces ANOTHER, and neither ever
 * disagrees out loud. So the relationship — "the runner grades with the module
 * the renderer enforces" — is what gets pinned here, not either side alone.
 *
 * 🔴 AND THE RUNNER IS EXERCISED IN ITS OWN RUNTIME, NOT IN VITEST'S. Vitest
 * transpiles TypeScript itself, so importing `lib/grounding.ts` from a test
 * proves nothing about whether plain `node eval/run-eval.mjs` can load it. The
 * chosen approach — a `.ts` specifier resolved by Node's own type stripping —
 * lives or dies on that, so the first case below actually spawns Node.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RUNNER = 'eval/run-eval.mjs';

/** Source with block and line comments removed, so prose cannot satisfy a guard. */
function codeOf(relPath: string): string {
  return readFileSync(new URL(relPath, new URL(ROOT, 'file:')), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('🔴 eval/run-eval.mjs grades with the SHIPPED predicate', () => {
  it('🔴 LOADS under plain Node — the `.ts` import from `.mjs` really resolves', () => {
    // The runner refuses to run without a bearer, and that check sits AFTER
    // every import. Exit 2 therefore proves the whole module graph — including
    // `src/lib/grounding.ts`, type-stripped by Node itself — resolved and
    // executed. A broken import exits 1 with ERR_MODULE_NOT_FOUND, and a
    // non-erasable construct in that module exits 1 with a SyntaxError, so
    // this single number separates all three.
    const run = spawnSync(process.execPath, [RUNNER], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CIVITAI_OAUTH_TOKEN: '' },
    });
    expect(run.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|SyntaxError|ERR_UNSUPPORTED/);
    expect(run.stderr).toContain('CIVITAI_OAUTH_TOKEN is required');
    expect(run.status).toBe(2);
  });

  it('imports the shared module rather than re-deriving the rule', () => {
    const code = codeOf(RUNNER);
    expect(code).toMatch(/from\s+'\.\.\/src\/lib\/grounding\.ts'/);
    for (const fn of ['citedModelIds', 'groundedIdsFromToolPayload', 'ungroundedModelIds']) {
      expect(code).toContain(fn);
    }
  });

  it('🔴 holds NO second copy of the citation pattern or the membership test', () => {
    // The mutation that matters is someone re-inlining the regex "just for a
    // one-off". Comments are stripped above, so the module header may keep
    // describing the old code without satisfying this.
    const code = codeOf(RUNNER);
    // The ESCAPED host — `civitai\.com` with a backslash — only ever occurs
    // inside a regex literal. The runner legitimately holds the plain string
    // (`CIVITAI_BASE ?? 'https://civitai.com'`), so matching that instead would
    // be a guard that can never pass, which is worse than none.
    expect(code).not.toMatch(/civitai\\\.com/);
    expect(code).not.toMatch(/models\\\/\(\\d/);
    expect(code).not.toMatch(/toolResultIds\.has/);
  });

  it("🔴 Layer 2's decision is callable from PLAIN NODE, not just from Vitest", () => {
    // 🔴 THE MODULE LOADING IS NOT THE SAME CLAIM AS THE FUNCTION WORKING.
    // The case above proves `run-eval.mjs` resolves the module; it imports three
    // names and none of them is `planCorrectionRound`, so a Layer 2 export that
    // used non-erasable syntax IN ITS SIGNATURE — a parameter property, an enum
    // default — would still let that case pass while being uncallable from the
    // instrument that has to measure it. Vitest transpiles TypeScript itself, so
    // importing it from a test proves nothing about `node` either. This spawns
    // the real runtime and reads the answer back.
    // 🔴 AN ABSOLUTE `file:` URL, NOT `'./src/lib/grounding.ts'`. A bare relative
    // specifier inside `node -e` has no importing file to resolve against, so
    // whether it resolves at all is a property of the Node version rather than
    // of this module — and CI runs 22 while this box runs 26. Resolving it here
    // makes the probe test the thing it is named for.
    const mod = JSON.stringify(pathToFileURL(`${ROOT}src/lib/grounding.ts`).href);
    const probe =
      `const m = await import(${mod});` +
      "const p = m.planCorrectionRound('see https://civitai.com/models/7878 now', new Set(), 0);" +
      'process.stdout.write(JSON.stringify([p.correct, p.reason, p.ungroundedIds, m.MAX_CORRECTION_ROUNDS]));';
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(run.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|SyntaxError|ERR_UNSUPPORTED/);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([true, 'ungrounded', ['7878'], 1]);
  });

  it('🔴 `lib/grounding.ts` has NO imports, which is what keeps the runner loadable', () => {
    // Node's type stripping erases annotations; it does not resolve a `.js`
    // specifier that only exists as `.ts` on disk, which is how every other
    // module in `src/lib` imports its neighbours. One import here breaks the
    // runner and NOTHING in the app's suite would notice — hence this guard.
    const code = codeOf('src/lib/grounding.ts');
    expect(code).not.toMatch(/^\s*import\s/m);
    // And no syntax Node cannot erase.
    expect(code).not.toMatch(/^\s*(?:const\s+)?enum\s/m);
    expect(code).not.toMatch(/^\s*namespace\s/m);
  });
});
