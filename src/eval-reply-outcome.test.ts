import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error - plain .mjs with no types; that is the point (it must load
// under bare `node` for the runner, so it deliberately has no build step).
import { classifyReplyOutcome } from '../eval/reply-outcome.mjs';

/**
 * 🔴 RANK 5 — `withheld` NAMED A CAUSE IT NEVER OBSERVED.
 *
 * The runner used to emit `withheld: succeeded && no text`. A withhold and the
 * empty-reply defect (clawgate #476) produce the SAME observable, so that field
 * could not distinguish them and reported whichever one the reader already had
 * in mind — on which basis a content-policy incident that does not exist was
 * reported to the operator.
 *
 * These cases pin the DISTINCTION, not either field alone: the pair
 * (withheld, emptyReply) must move independently, and the only thing that may
 * set `withheld` is a verdict read back from the host.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const src = (rel: string) =>
  readFileSync(new URL(rel, new URL(ROOT, 'file:')), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('🔴 classifyReplyOutcome splits the verdict from the symptom', () => {
  it('a REAL withhold is withheld, not empty — and carries its reason', () => {
    const out = classifyReplyOutcome({
      status: 'succeeded',
      textOutputWithheld: { reason: 'This response was withheld…' },
      text: '',
    });
    expect(out).toEqual({
      withheld: true,
      withheldReason: 'This response was withheld…',
      emptyReply: false,
    });
  });

  it('🔴 an unexplained empty reply is emptyReply, and asserts NOTHING about policy', () => {
    // This is the case the old field mislabelled. #476's whole population.
    const out = classifyReplyOutcome({ status: 'succeeded', textOutputWithheld: null, text: '   ' });
    expect(out).toEqual({ withheld: false, withheldReason: null, emptyReply: true });
  });

  it('a normal answered turn is neither', () => {
    const out = classifyReplyOutcome({
      status: 'succeeded',
      textOutputWithheld: null,
      text: 'DreamShaper is a good general checkpoint.',
    });
    expect(out).toEqual({ withheld: false, withheldReason: null, emptyReply: false });
  });

  it('🔴 a FAILED turn with no text is NOT the empty-reply defect', () => {
    // Without the `succeeded` clause every timeout and every expiry would be
    // counted into #476, inflating a defect rate with turns that have an
    // obvious unrelated explanation.
    for (const status of ['failed', 'expired', 'canceled', null]) {
      const out = classifyReplyOutcome({ status, textOutputWithheld: null, text: '' });
      expect(out.emptyReply, `status=${status}`).toBe(false);
      expect(out.withheld, `status=${status}`).toBe(false);
    }
  });

  it('🔴 a withhold with NO reason string is still a withhold', () => {
    // Presence of the field is the signal — the host attaches it only on a
    // withhold. Keying on a truthy `reason` instead would silently reclassify
    // such a turn as the #476 defect.
    const out = classifyReplyOutcome({ status: 'succeeded', textOutputWithheld: {}, text: '' });
    expect(out.withheld).toBe(true);
    expect(out.withheldReason).toBeNull();
    expect(out.emptyReply).toBe(false);
  });

  it('🔴 the two outcomes are MUTUALLY EXCLUSIVE across every combination', () => {
    // The property that makes the pair readable: a turn is at most one of them,
    // so `emptyReply` is exactly the unexplained residue after withholds are
    // removed — which is the count #476 needs.
    for (const status of ['succeeded', 'failed', null]) {
      for (const wh of [null, { reason: 'r' }, {}]) {
        for (const text of ['', '  ', 'an answer']) {
          const o = classifyReplyOutcome({ status, textOutputWithheld: wh, text });
          expect(o.withheld && o.emptyReply, `${status}/${JSON.stringify(wh)}/"${text}"`).toBe(
            false
          );
        }
      }
    }
  });
});

describe('🔴 the runner reads the verdict the SHIPPED path branches on', () => {
  it('🔴 branches on `textOutputWithheld` — the same field as orchestrator-bridge', () => {
    // The seam: if the host renames the field, the app throws and the eval goes
    // silently back to inferring. Pinning the RELATIONSHIP (both sides name the
    // same field) is what makes that a test failure rather than a slow drift.
    const runner = src('eval/run-eval.mjs');
    const bridge = src('src/lib/orchestrator-bridge.ts');
    expect(bridge).toContain('textOutputWithheld');
    expect(runner).toContain('textOutputWithheld');
  });

  it('🔴 no longer DERIVES a withhold from emptiness', () => {
    // The mutation that matters is someone reinstating the old one-liner. This
    // asserts the specific defect is absent, not merely that a field exists —
    // `withheld:` would still be present in the fixed code.
    const runner = src('eval/run-eval.mjs');
    expect(runner).not.toMatch(/withheld:\s*lastStatus\s*===\s*'succeeded'/);
    expect(runner).toContain('classifyReplyOutcome');
  });

  it('🔴 LOADS under plain Node — the runner imports this at startup', () => {
    // Same reasoning as eval-runner.seam.test.ts: Vitest transpiles, `node`
    // does not. Exit 2 is the runner's own no-bearer guard, which sits after
    // every import, so reaching it proves the new module resolved too.
    const run = spawnSync(process.execPath, ['eval/run-eval.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CIVITAI_OAUTH_TOKEN: '' },
    });
    expect(run.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|SyntaxError|ERR_UNSUPPORTED/);
    expect(run.stderr).toContain('CIVITAI_OAUTH_TOKEN is required');
    expect(run.status).toBe(2);
  });
});

describe('🔴 summarize.mjs cannot silently re-read a legacy file with new meanings', () => {
  it('🔴 remaps a schema-1 `withheld` to EMPTY and reports the withhold as unobserved', () => {
    // 15 result files on trunk carry the old field. Read with schema-2
    // semantics they would report withholds nobody ever observed — the exact
    // misreading this change exists to end, re-committed by the reader.
    const code = src('eval/summarize.mjs');
    expect(code).toContain('resultSchema');
    expect(code).toMatch(/legacy\s*\?\s*Boolean\(r\.withheld\)/);
    expect(code).toMatch(/legacy\s*\?\s*null/);
  });
});
