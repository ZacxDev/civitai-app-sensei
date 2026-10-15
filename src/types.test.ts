import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_PROMPT,
  LEGACY_DEFAULT_SYSTEM_PROMPTS,
  migrateSettings,
} from './types.js';

/**
 * 🔴 THE V5 PARAGRAPH'S EXACT BYTES — the multi-facet paragraph v6 replaced. v6
 * must NOT carry it (its "run at least two lookups" instruction is the one that
 * sent a recommendation question to popularity-sorted searches), and the v5
 * legacy entry MUST.
 */
const V5_PARAGRAPH = `When a question asks which models to use — the best, the recommended, the top ones — do not answer from a single ranked lookup. Run at least two differently-shaped lookups before answering: one in the use case's own words, and one by a different facet, such as recency, base model family or a different sort. Weigh fit rather than presenting download counts as the ranking — what the use case implies, each candidate's base model, how recent it is, and its trade-offs. Be honest about the catalog's limits: results are ordered by popularity, so a brand-new or barely-used model will not surface in a ranked lookup — say so when it matters to the question. This turn allows at most three tool results in total, so a couple of differently-shaped lookups is the ceiling, not five.`;


/**
 * 🔴 THE V6 ROUTING PARAGRAPH'S EXACT BYTES, held in the test rather than read
 * back from `types.ts`, so the assertion cannot be satisfied by whatever the
 * constant happens to say. Pinned whole because it carries a claim about the
 * wire — `recommend_resources` is named CONDITIONALLY ("If you have been given")
 * since `composeLocalTools` does not always send it — and a guard on a word
 * would be walked around by rewording that condition away.
 */
const V6_PARAGRAPH = `Choosing the tool. If you have been given a recommend_resources tool, call it FIRST whenever someone asks which models, checkpoints, LoRAs or other add-ons to use for a kind of image or a use case — "models for book-cover art", "a checkpoint for product photography", "which LoRA for a watercolor look". Turn the request into a concrete image description (subject, setting, style, lighting, mood) and pass that, not the question. Call it on its own; a popularity lookup alongside it adds nothing the reader asked for. Use search_models instead for a model the reader named, an id, stats, versions or a model's base model, and for an explicit ranking — most downloaded, most liked, newest, top N — and to check a specific model before you name it. Without recommend_resources, answer which-model questions with search_models, using a couple of differently-shaped lookups — one in the use case's own words and one by a different facet such as base model family or a different sort — and say that results are ordered by popularity, so a brand-new or barely-used model will not surface. Either way, weigh fit rather than presenting download counts as the ranking: what the use case implies, each candidate's base model and its trade-offs. This turn allows at most three tool results in total, so plan for one or two calls, not five.`;

/**
 * 🔴 THE V7 ROUTING PARAGRAPH'S EXACT BYTES — v6's paragraph plus the two
 * `needs` / hosted-models sentences. Held here, not read back from `types.ts`,
 * for the same reason as V6_PARAGRAPH. The added sentences sit INSIDE the
 * paragraph that opens "If you have been given a recommend_resources tool", so
 * they stay conditional on the tool being on the wire.
 */
const V7_PARAGRAPH = `Choosing the tool. If you have been given a recommend_resources tool, call it FIRST whenever someone asks which models, checkpoints, LoRAs or other add-ons to use for a kind of image or a use case — "models for book-cover art", "a checkpoint for product photography", "which LoRA for a watercolor look". Turn the request into a concrete image description (subject, setting, style, lighting, mood) and pass that, not the question. When the request implies a capability — words or a headline in the image, a logo, poster, infographic or UI layout, photorealism, editing a picture the reader already has, one character kept consistent across images, 4K, a transparent background, or working from the reader's reference photos — also pass it in needs. When the result lists hosted models, mention the ones that fit alongside the add-ons, or instead of them when no add-on ecosystem fits. Call it on its own; a popularity lookup alongside it adds nothing the reader asked for. Use search_models instead for a model the reader named, an id, stats, versions or a model's base model, and for an explicit ranking — most downloaded, most liked, newest, top N — and to check a specific model before you name it. Without recommend_resources, answer which-model questions with search_models, using a couple of differently-shaped lookups — one in the use case's own words and one by a different facet such as base model family or a different sort — and say that results are ordered by popularity, so a brand-new or barely-used model will not surface. Either way, weigh fit rather than presenting download counts as the ranking: what the use case implies, each candidate's base model and its trade-offs. This turn allows at most three tool results in total, so plan for one or two calls, not five.`;

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

  it('🔴 is byte-identical to eval/prompt.rewrite.v7.txt — the arm file the tool-choice probe sent', () => {
    // 🔴 WHAT THIS PIN DOES AND DOES NOT ATTRIBUTE. v7, like v6, was scored ONLY
    // by `eval/tool-choice-probe.mjs` (first-round tool choice and `needs`,
    // direct model call, no tool execution) — never by `run-eval.mjs`. The probe
    // sent the bytes of `eval/prompt.rewrite.v7.txt` (`.trim()`ed), so pinning the
    // constant to that file is what lets the `needs-v7` and `tool-choice-v7`
    // results under `eval/results/tool-choice/` be read as this constant's.
    const v7 = readFileSync(new URL('../eval/prompt.rewrite.v7.txt', import.meta.url), 'utf8').trim();
    expect(DEFAULT_SYSTEM_PROMPT).toBe(v7);
    expect(DEFAULT_SYSTEM_PROMPT).toHaveLength(3739);
    expect(DEFAULT_SYSTEM_PROMPT).toContain(V7_PARAGRAPH);
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain(V6_PARAGRAPH);
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain(V5_PARAGRAPH);

    // And the probe's own record of what it sent agrees — both arms that scored
    // v7 — so an edit made to both the .txt and the constant still goes red.
    for (const file of [
      'needs-v7-2026-10-15.json',
      'tool-choice-v7-2026-10-15.json',
      'needs-v7-decl2-2026-10-15.json',
      'tool-choice-v7-decl2-2026-10-15.json',
    ]) {
      const recorded = (
        JSON.parse(
          readFileSync(new URL(`../eval/results/tool-choice/${file}`, import.meta.url), 'utf8'),
        ) as { systemPrompt: string }
      ).systemPrompt;
      expect(DEFAULT_SYSTEM_PROMPT, file).toBe(recorded);
    }

    // The two clauses v4 added, which its measured gains were ascribed to —
    // v7 must not drop them while adding its own.
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Recommending a model is a catalog question');
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/answer as Civitai's own assistant/i);
  });

  it('🔴 the v6 default is in the migration list, byte-identical to its arm file and recorded probe prompt', () => {
    // v6 shipped 0.1.32, so viewers who opened Settings then hold it. Exactly
    // ONE entry carries its bytes, and the migration moves it to v7.
    const v6 = readFileSync(new URL('../eval/prompt.rewrite.v6.txt', import.meta.url), 'utf8').trim();
    expect(v6).toHaveLength(3285);
    expect(v6).toContain(V6_PARAGRAPH);
    const recorded = (
      JSON.parse(
        readFileSync(
          new URL('../eval/results/tool-choice/tool-choice-v6-iter2-2026-10-14.json', import.meta.url),
          'utf8',
        ),
      ) as { systemPrompt: string }
    ).systemPrompt;
    expect(v6).toBe(recorded);
    expect(LEGACY_DEFAULT_SYSTEM_PROMPTS.filter((p) => p === v6)).toHaveLength(1);
    expect(migrateSettings({ ...DEFAULT_SETTINGS, systemPrompt: v6 }).systemPrompt).toBe(
      DEFAULT_SYSTEM_PROMPT,
    );
  });

  it('🔴 the v5 default is in the migration list, byte-identical to its arm file', () => {
    // v5 shipped 0.1.27–0.1.31, so viewers who opened Settings then hold it.
    // Exactly ONE entry carries its bytes, and the migration moves it to the current default.
    const v5 = readFileSync(new URL('../eval/prompt.rewrite.v5.txt', import.meta.url), 'utf8').trim();
    expect(v5).toHaveLength(2610);
    expect(v5).toContain(V5_PARAGRAPH);
    expect(LEGACY_DEFAULT_SYSTEM_PROMPTS.filter((p) => p === v5)).toHaveLength(1);
    expect(migrateSettings({ ...DEFAULT_SETTINGS, systemPrompt: v5 }).systemPrompt).toBe(
      DEFAULT_SYSTEM_PROMPT,
    );
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
