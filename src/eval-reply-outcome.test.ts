import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * 🔴 RUN THE SCRIPT, DO NOT GREP IT. The predecessor of this block asserted the
 * SOURCE contained `legacy ? Boolean(r.withheld)` — which is how it certified a
 * remap that was wrong: the grep passed on the exact line that carried the
 * defect. A guard on the words is walkable by rewording, and worse, it cannot
 * see the meaning at all. These cases execute `summarize.mjs` and read what a
 * human would read.
 */
function summarizeFixture(doc: unknown): string {
  const p = join(tmpdir(), `sensei-fixture-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(doc));
  try {
    const run = spawnSync(process.execPath, ['eval/summarize.mjs', p], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
    return run.stdout;
  } finally {
    rmSync(p, { force: true });
  }
}

/**
 * The per-question table row for `qid`, trimmed. Fails loudly rather than
 * returning '' — a helper that quietly yields an empty string turns every
 * assertion built on it into a vacuous pass.
 */
function dataRow(out: string, qid: string): string {
  const row = out.split('\n').find((l) => l.trimStart().startsWith(`${qid} `));
  expect(row, `no data row for ${qid} in:\n${out}`).toBeDefined();
  return (row as string).trimEnd();
}

const turn = (over: Record<string, unknown> = {}) => ({
  questionId: 'Q1',
  arm: 'recommend',
  expectTool: true,
  toolCalled: true,
  toolExpectationMet: true,
  argsIncludeOk: null,
  argsOmitOk: null,
  answerMentionsOk: null,
  groundedCitations: null,
  errors: [],
  buzz: 8,
  ...over,
});

const doc = (over: Record<string, unknown>) => ({
  arm: 'recommend',
  model: 'm',
  temperature: 0.7,
  repeats: 1,
  systemPromptChars: 1,
  buzzSpent: 8,
  ...over,
});

describe('🔴 summarize.mjs refuses to attribute a cause a legacy file never recorded', () => {
  it('🔴 a schema-1 file reports noText and NOT OBSERVED for BOTH causes', () => {
    // The bug this replaces: #37 mapped the old union onto `emptyReply` and
    // printed "empty replies (#476): 4" for turns that may well have been
    // policy withholds. A schema-1 file supports neither number.
    const out = summarizeFixture(
      doc({ results: [turn({ withheld: true }), turn({ withheld: false })] })
    );
    expect(out).toContain('SCHEMA 1');
    expect(out).toMatch(/no-text turns:\s*1/);
    expect(out).toMatch(/empty replies \(#476\):\s*NOT OBSERVED/);
    expect(out).toMatch(/withheld turns:\s*NOT OBSERVED/);
    // 🔴 THE NEGATIVE HALF, and the one that actually catches the old bug: no
    // NUMBER may appear against either cause. Asserting only the presence of
    // "NOT OBSERVED" would still pass if a count were printed elsewhere.
    expect(out).not.toMatch(/empty replies \(#476\):\s*\d/);
    expect(out).not.toMatch(/withheld turns:\s*\d/);
    // 🔴 AND THE PER-QUESTION ROW, WHICH IS WHERE A READER ACTUALLY LOOKS.
    // Two mutants that reinstate #37's bug — mapping the legacy union onto
    // `emptyReply`, and printing 0 rather than `?` for withheld — leave the
    // totals line untouched and corrupt ONLY this row. Asserting the summary
    // alone let both survive a mutation sweep; the table is the wider claim
    // this test's name makes, so it is the one that has to be checked.
    expect(dataRow(out, 'Q1')).toMatch(/\?\s+\?$/);
  });

  it('🔴 a schema-2 file DOES separate them — so the `?` above is about the data, not the reader', () => {
    // The positive control. Without it, a summariser hard-wired to print NOT
    // OBSERVED forever would pass the case above.
    const out = summarizeFixture(
      doc({
        resultSchema: 2,
        results: [
          turn({ withheld: true, emptyReply: false }),
          turn({ withheld: false, emptyReply: true }),
          turn({ withheld: false, emptyReply: false }),
        ],
      })
    );
    expect(out).not.toContain('SCHEMA 1');
    expect(out).toMatch(/no-text turns:\s*2/);
    expect(out).toMatch(/empty replies \(#476\):\s*1/);
    expect(out).toMatch(/withheld turns:\s*1/);
    // The row carries real counts, and no `?` anywhere — the mirror of the
    // legacy case, so neither can pass by printing one shape unconditionally.
    expect(dataRow(out, 'Q1')).toMatch(/\s2\s+1\s+1$/);
    expect(dataRow(out, 'Q1')).not.toContain('?');
  });

  it('🔴 an UNSTAMPED file carrying the new field is still read as schema 2', () => {
    // Key-presence fallback. A file written between the two schemas must not be
    // demoted to "unobservable" when it did record the verdict.
    const out = summarizeFixture(
      doc({ results: [turn({ withheld: false, emptyReply: true })] })
    );
    expect(out).not.toContain('SCHEMA 1');
    expect(out).toMatch(/empty replies \(#476\):\s*1/);
  });

  it('🔴 every file already in eval/results/ is schema 1 and none reports a cause count', () => {
    // Real data, not a fixture: the recorded arms are exactly the population
    // that got mislabelled, so they are the population worth pinning.
    // ⚠️ There are TEN of them. #37's commit message and PR body both say
    // "15 result files" — that number was never counted and is wrong; this
    // assertion is what caught it. The floor is a positive control that the
    // loop below actually iterated over something.
    const dir = join(ROOT, 'eval/results');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const f of files) {
      const out = summarizeFixture(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      expect(out, f).toContain('SCHEMA 1');
      expect(out, f).not.toMatch(/empty replies \(#476\):\s*\d/);
    }
  });
});
