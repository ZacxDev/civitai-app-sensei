import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_PROMPT,
  LEGACY_DEFAULT_SYSTEM_PROMPTS,
  migrateSettings,
} from './types.js';

/**
 * 🔴 THE V5 PARAGRAPH'S EXACT BYTES, held in the test rather than read back from
 * `types.ts`, so the assertion cannot be satisfied by whatever the constant
 * happens to say. Full-prompt equality with `eval/prompt.rewrite.v5.txt` is
 * pinned separately below; this is the brief-ranked addition itself.
 */
const V5_PARAGRAPH = `When a question asks which models to use — the best, the recommended, the top ones — do not answer from a single ranked lookup. Run at least two differently-shaped lookups before answering: one in the use case's own words, and one by a different facet, such as recency, base model family or a different sort. Weigh fit rather than presenting download counts as the ranking — what the use case implies, each candidate's base model, how recent it is, and its trade-offs. Be honest about the catalog's limits: results are ordered by popularity, so a brand-new or barely-used model will not surface in a ranked lookup — say so when it matters to the question. This turn allows at most three tool results in total, so a couple of differently-shaped lookups is the ceiling, not five.`;

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE SYSTEM PROMPT IS A CLAIM ABOUT THE WIRE, AND IT HAS BEEN WRONG TWICE
// IN OPPOSITE DIRECTIONS.
//
// Round one: it told the model it could search while the host exposed no
// tool-calling surface — so the model, told it could search and unable to,
// fabricated results.
//
// Round two: the fix for that said "You cannot browse, search, or call tools"
// and described results arriving pre-attached under a "CIVITAI CATALOG RESULTS"
// label. Landing the tool loop made that false in both halves — the app now
// sends tool declarations, and `CATALOG_CONTEXT_MARKER` was deleted — but the
// guard that had pinned the text was deleted along with the retrieval suite it
// lived in, so nothing caught it.
//
// This suite is that guard, restored in BOTH directions: the prompt must not
// deny tool access, and it must not reference the pre-attachment mechanism that
// no longer exists.
// ─────────────────────────────────────────────────────────────────────────────

describe('DEFAULT_SYSTEM_PROMPT — must describe the retrieval the app actually does', () => {
  it('🔴 does NOT deny tool access', () => {
    // The exact sentence that shipped through 0.1.5, plus the general shape.
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain('You cannot browse, search, or call tools');
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/cannot\s+(browse|search|call tools)/i);
  });

  it('🔴 does NOT reference the deleted pre-attachment mechanism', () => {
    // `CATALOG_CONTEXT_MARKER` produced this label and was deleted with the
    // heuristic. A prompt still promising it describes a message the app will
    // never send.
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain('CIVITAI CATALOG RESULTS');
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/attaches the results|already attached/i);
  });

  it('tells the model it can call tools, which is what the app now does', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/call(ing)? the tools|tools you have been given/i);
  });

  it('still forbids inventing catalog facts — the reason the prompt exists at all', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/never invent/i);
  });

  it('🔴 is byte-identical to eval/prompt.rewrite.v5.txt — the arm file the next eval run sends', () => {
    // 🔴 THE ATTRIBUTION MOVED ONE GENERATION BACK, AND THIS GUARD NOW CARRIES
    // THE DRIFT. It used to pin the constant itself at 1831 chars as "the prompt
    // the eval actually measured" — that text was v4, whose recorded numbers
    // (14/24 → 23/24 lookups, 7 → 0 ungrounded) are attributable to it and to
    // nothing else. v5 edits the constant IN PLACE, per the change brief, which
    // voids that attribution for THIS text until a new arm runs. So:
    //
    //   - the v4 bytes and their 1831-char measurement are pinned on the
    //     LEGACY list entry instead, byte-for-byte against the prompt recorded
    //     in `eval/results/recommend-rewrite-v4-2026-09-01.json` (the arm the
    //     eval actually paid for) — see the test below;
    //   - THIS constant is pinned byte-for-byte against
    //     `eval/prompt.rewrite.v5.txt`, the exact bytes the next
    //     `run-eval.mjs --prompt-file` arm will send, and at 2610 chars;
    //   - the v5 paragraph is asserted as exact bytes, not word-presence —
    //     this repo's guards get walked around by rewording.
    //
    // ⚠️ HONESTLY UNMEASURED: v5 has NOT been scored by the eval. No number in
    // the eval results is its number. Do not cite the v4 numbers for it.
    const v5 = readFileSync(new URL('../eval/prompt.rewrite.v5.txt', import.meta.url), 'utf8').trim();
    expect(DEFAULT_SYSTEM_PROMPT).toBe(v5);
    expect(DEFAULT_SYSTEM_PROMPT).toHaveLength(2610);
    expect(DEFAULT_SYSTEM_PROMPT).toContain(V5_PARAGRAPH);

    // The two clauses v4 added, which the measured gains were ascribed to —
    // v5 must not drop them while adding its own.
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Recommending a model is a catalog question');
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/answer as Civitai's own assistant/i);
  });

  it('🔴 the v4 default is in the migration list, byte-identical to the recorded eval arm', () => {
    // The v4 default's bytes are an independent record, not a transcription of
    // this repo's source: `eval/run-eval.mjs` stamped the prompt it actually
    // SENT into `eval/results/recommend-rewrite-v4-2026-09-01.json` (24 paid
    // turns). Pinning the legacy entry against THAT file means a transcription
    // error in `types.ts` is red rather than silent, and the eval's attribution
    // follows the bytes into the migration list.
    const recorded = (
      JSON.parse(
        readFileSync(
          new URL('../eval/results/recommend-rewrite-v4-2026-09-01.json', import.meta.url),
          'utf8',
        ),
      ) as { systemPrompt: string }
    ).systemPrompt;
    expect(recorded, 'the recorded v4 arm prompt must be present').toBeTruthy();
    expect(recorded).toHaveLength(1831);

    // 🔴 EXACT-BYTES membership, and exactly ONE entry carries them — a `find`
    // would quietly pick the first of several and keep passing while testing
    // something else.
    const inList = LEGACY_DEFAULT_SYSTEM_PROMPTS.filter((p) => p === recorded);
    expect(
      inList,
      'the v4 default must be in the migration list with its exact recorded bytes',
    ).toHaveLength(1);
    // And the migration actually moves a viewer holding it onto the current
    // default — the whole reason the entry exists.
    expect(migrateSettings({ ...DEFAULT_SETTINGS, systemPrompt: recorded }).systemPrompt).toBe(
      DEFAULT_SYSTEM_PROMPT,
    );
  });

  it('POSITIVE CONTROL — the legacy prompt this replaces DOES trip both guards', () => {
    // Without this, the two `not.toContain` assertions above would pass on any
    // string that merely omits the phrases — including an empty prompt. This
    // pins that they are testing the thing they name.
    //
    // 🔴 FOUND BY ITS OWN INDEX. This read `LEGACY_DEFAULT_SYSTEM_PROMPTS[0]`,
    // which silently became a DIFFERENT prompt the moment an older default was
    // prepended to the list — the control then asserted the 0.1.0 text contains
    // phrases only the 0.1.5 text ever had, and went red for a reason that had
    // nothing to do with what it guards. A positional reference into a list
    // that is documented "newest last" is a coupling waiting to break.
    const legacy = LEGACY_DEFAULT_SYSTEM_PROMPTS.find((p) =>
      p.includes('You cannot browse, search, or call tools'),
    );
    expect(legacy, 'the 0.1.5 default must still be in the legacy list').toBeDefined();
    expect(legacy).toContain('CIVITAI CATALOG RESULTS');
  });

  it('🔴 the v0.1.0 default is in the legacy list too — it was shipped and is still stored', () => {
    // The list is the ONLY thing deciding whether a stored prompt gets upgraded,
    // so an omission here is invisible: the viewer keeps the stale prompt and
    // nothing reports it. 0.1.0 lived inline in `DEFAULT_SETTINGS.systemPrompt`
    // rather than as a named constant, which is exactly why grepping the history
    // for `DEFAULT_SYSTEM_PROMPT` missed it.
    //
    // It is the more dangerous of the two: it CLAIMS catalog access while
    // carrying none of the anti-fabrication rules.
    const v010 = LEGACY_DEFAULT_SYSTEM_PROMPTS.find((p) =>
      p.includes('an AI research assistant specializing in AI art'),
    );
    expect(v010, 'the 0.1.0 default must be in the legacy list').toBeDefined();
    expect(v010).not.toMatch(/never invent/i);
    expect(migrateSettings({ ...DEFAULT_SETTINGS, systemPrompt: v010! }).systemPrompt).toBe(
      DEFAULT_SYSTEM_PROMPT,
    );
  });

  it('🔴 the 0.1.6–0.1.11 default is in the legacy list — it is the one most viewers hold', () => {
    // The prompt this release supersedes. It shipped for six versions and is
    // the CURRENT stored value for anyone who opened Settings during them, so
    // omitting it from the list is the whole migration silently doing nothing
    // for the population it exists to serve.
    //
    // Identified by content, not by index — the list is documented "newest
    // last" and this entry was appended, so `[N-1]` would rot the moment
    // another default lands. Two predicates are needed because ONE does not
    // separate it: it is the only legacy entry describing the tool loop
    // ("tools you have been given" — the two older defaults predate it), and
    // the negative predicate keeps it distinct from the current default and any
    // successor built on it, which carry the recommendation clause it lacks.
    const matches = LEGACY_DEFAULT_SYSTEM_PROMPTS.filter(
      (p) =>
        p.includes('tools you have been given') &&
        !p.includes('Recommending a model is a catalog question'),
    );
    // 🔴 Assert the discriminator still resolves to exactly one entry. A `find`
    // would quietly pick the first of several and keep passing while testing
    // something else — the failure mode the positive control above was written
    // for after an index reference drifted.
    expect(matches, 'the 0.1.6–0.1.11 default must be uniquely identifiable').toHaveLength(1);

    const superseded = matches[0]!;
    expect(superseded).not.toBe(DEFAULT_SYSTEM_PROMPT);
    expect(migrateSettings({ ...DEFAULT_SETTINGS, systemPrompt: superseded }).systemPrompt).toBe(
      DEFAULT_SYSTEM_PROMPT,
    );
  });

  it('every legacy default is distinct — a duplicate would mean one was mis-transcribed', () => {
    expect(new Set(LEGACY_DEFAULT_SYSTEM_PROMPTS).size).toBe(
      LEGACY_DEFAULT_SYSTEM_PROMPTS.length,
    );
  });

  it('the shipped default is the current prompt, not a legacy one', () => {
    expect(DEFAULT_SETTINGS.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(LEGACY_DEFAULT_SYSTEM_PROMPTS).not.toContain(DEFAULT_SYSTEM_PROMPT);
  });
});

describe('migrateSettings — a stored prompt is not reached by changing the default', () => {
  const base = { model: 'm', temperature: 0.7, maxTokens: 2048 };

  it('🔴 upgrades a stored prompt that is an untouched legacy default', () => {
    // The whole point: `sensei:settings` is persisted, so a viewer who has ever
    // opened Settings keeps a prompt telling the model it cannot call tools —
    // while being handed tools. Fixing only the default reaches none of them.
    const stored = { ...base, systemPrompt: LEGACY_DEFAULT_SYSTEM_PROMPTS[0] };
    expect(migrateSettings(stored).systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it('🔴 leaves a CUSTOMISED prompt alone, even one character off a legacy default', () => {
    // This is why the test is exact-match rather than a version stamp: a stamp
    // would license overwriting a prompt the viewer wrote.
    const edited = `${LEGACY_DEFAULT_SYSTEM_PROMPTS[0]} And be brief.`;
    const stored = { ...base, systemPrompt: edited };
    expect(migrateSettings(stored).systemPrompt).toBe(edited);
  });

  it('leaves an already-current prompt alone', () => {
    const stored = { ...base, systemPrompt: DEFAULT_SYSTEM_PROMPT };
    expect(migrateSettings(stored)).toEqual(stored);
  });

  it('preserves every other setting while migrating', () => {
    const stored = {
      model: 'custom/model',
      temperature: 0.1,
      maxTokens: 99,
      systemPrompt: LEGACY_DEFAULT_SYSTEM_PROMPTS[0],
    };
    const out = migrateSettings(stored);
    expect(out.model).toBe('custom/model');
    expect(out.temperature).toBe(0.1);
    expect(out.maxTokens).toBe(99);
  });
});
