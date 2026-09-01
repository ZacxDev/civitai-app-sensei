import { describe, it, expect } from 'vitest';
import {
  citedModelIds,
  correctionMessage,
  groundedIdsFromToolPayload,
  groundedIdsFromToolResult,
  MAX_CORRECTION_ROUNDS,
  mergeGroundedIds,
  modelIdInHref,
  planCorrectionRound,
  ungroundedModelIds,
} from './grounding.js';

/**
 * 🔴 EVERY FIXTURE ID HERE IS A REAL MEASURED ONE, from the 18-turn seam probe
 * (`eval/results/seam-baseline-2026-08-31.json`). Inventing tidy ids would have
 * hidden two of the three failure shapes: `4823`/`18619` are 404s, while `7878`
 * and `22220` are REAL models cited under other models' names — the shape that
 * resolves 200 and is therefore invisible on screen.
 *
 * 🔴 AND THEY ARE PAIRWISE DISTINCT, AND DISTINCT FROM EVERY CONSTANT ANY
 * ASSERTION BELOW NAMES. A fixture that can only ever produce the value an
 * assertion hardcodes cannot see a mutant that hardcodes that same literal, and
 * survives a fully green suite.
 */
const REALISTIC_VISION = '4201'; // real id, correctly named by the model
const DREAMSHAPER = '4384'; // real id, correctly named by the model
const DEAD_A = '4823'; // 404 — no such model
const DEAD_B = '18619'; // 404 — no such model
const EMILIA = '7878'; // real: Emilia (Re:Zero). Cited as "Detail Tweaker LoRA".
const CARDOS = '22220'; // real: CarDos Animated. Cited as "Face Slider".
const DETAIL_TWEAKER = '58390'; // where Detail Tweaker LoRA ACTUALLY lives

/** The measured S6 answer shape, verbatim. Bare URLs in parens, inside a list. */
const S6_FRAGMENT =
  `     - **Detail Tweaker LoRA** (https://civitai.com/models/${EMILIA}) improves facial features.\n` +
  `     - **Face Slider** (https://civitai.com/models/${CARDOS}) allows fine-tuning facial expressions and details.`;

/** The measured S2 answer shape: proper markdown links, one of them a 404. */
const S2_FRAGMENT =
  `1. **DreamShaper**\n   → [DreamShaper](https://civitai.com/models/${DREAMSHAPER})\n` +
  `2. **Realistic Vision**\n   → [Realistic Vision](https://civitai.com/models/${REALISTIC_VISION})\n` +
  `3. **Deliberate**\n   → [Deliberate](https://civitai.com/models/${DEAD_A})`;

describe('citedModelIds — the one extraction both callers share', () => {
  it('finds every id in the measured S6 answer, in order, duplicates and all', () => {
    expect(citedModelIds(S6_FRAGMENT)).toEqual([EMILIA, CARDOS]);
    // Duplicates are PRESERVED: this doubles as the eval's `citedIds` record of
    // what an answer actually said, and de-duplicating would quietly rewrite it.
    expect(citedModelIds(`${S6_FRAGMENT}\n${S6_FRAGMENT}`)).toEqual([
      EMILIA,
      CARDOS,
      EMILIA,
      CARDOS,
    ]);
  });

  it('reads the id through a trailing slug and a query string', () => {
    expect(citedModelIds(`https://civitai.com/models/${REALISTIC_VISION}/realistic-vision-v50`)).toEqual([
      REALISTIC_VISION,
    ]);
    expect(
      citedModelIds(`https://civitai.com/models/${DREAMSHAPER}?modelVersionId=128713`),
    ).toEqual([DREAMSHAPER]);
  });

  it('🔴 is CASE-INSENSITIVE on the path, because `new URL` only lowercases the HOST', () => {
    // A case-sensitive pattern reads this as "not a model link" and waves it
    // past the grounding gate entirely.
    expect(citedModelIds(`https://civitai.com/MODELS/${DEAD_A}`)).toEqual([DEAD_A]);
  });

  it('negative control: prose with no model URL cites nothing', () => {
    expect(citedModelIds('Use a CFG scale of 7-10 and the Euler a sampler.')).toEqual([]);
    expect(citedModelIds('')).toEqual([]);
    // A version id in another kind of civitai URL is not a model citation.
    expect(citedModelIds('https://civitai.com/images/1234567')).toEqual([]);
  });
});

describe('modelIdInHref — what the renderer asks about one link', () => {
  it('returns the id for a model URL and null for anything else on the same host', () => {
    expect(modelIdInHref(`https://civitai.com/models/${DEAD_B}`)).toBe(DEAD_B);
    expect(modelIdInHref('https://civitai.com/user/someone')).toBeNull();
    expect(modelIdInHref('https://civitai.com/')).toBeNull();
    expect(modelIdInHref('')).toBeNull();
  });

  it('takes the LEFTMOST id, which is the one in the path', () => {
    // A tracking parameter carrying another model URL must not decide the gate.
    expect(
      modelIdInHref(`https://civitai.com/models/${DEAD_A}?ref=civitai.com/models/${DREAMSHAPER}`),
    ).toBe(DEAD_A);
  });
});

describe('ungroundedModelIds — the grading predicate', () => {
  it('🔴 names ONLY the ids no tool returned, and the measured S2 answer has exactly one', () => {
    const grounded = new Set([DREAMSHAPER, REALISTIC_VISION]);
    expect(ungroundedModelIds(S2_FRAGMENT, grounded)).toEqual([DEAD_A]);
  });

  it('is empty when every citation is grounded', () => {
    const grounded = new Set([DREAMSHAPER, REALISTIC_VISION, DEAD_A]);
    expect(ungroundedModelIds(S2_FRAGMENT, grounded)).toEqual([]);
  });

  it('🔴 an EMPTY grounded set makes every citation ungrounded — the measured defect turn', () => {
    // S6 called no tool at all. This is the case the whole guard exists for, so
    // an empty set must not be mistaken for "nothing to check".
    expect(ungroundedModelIds(S6_FRAGMENT, new Set())).toEqual([EMILIA, CARDOS]);
  });

  it('de-duplicates, in first-cited order', () => {
    const text = `[a](https://civitai.com/models/${DEAD_B}) [b](https://civitai.com/models/${DEAD_A}) [c](https://civitai.com/models/${DEAD_B})`;
    expect(ungroundedModelIds(text, new Set())).toEqual([DEAD_B, DEAD_A]);
  });

  it('an answer that cites nothing is grounded — vacuously, and that is correct', () => {
    expect(ungroundedModelIds('No models named here.', new Set())).toEqual([]);
  });

  it('🔴 grounding is per-ID, not per-answer: the right name at the WRONG id still fails', () => {
    // "Detail Tweaker LoRA" is a real model — at 58390. The answer cited 7878.
    // Nothing readable in the sentence distinguishes the two; only the id does.
    expect(ungroundedModelIds(S6_FRAGMENT, new Set([DETAIL_TWEAKER]))).toEqual([EMILIA, CARDOS]);
  });
});

describe('groundedIdsFromToolPayload — what a tool round grounds', () => {
  it('🔴 reads the LIVE envelope the eval sees: { result: { items: [...] } }', () => {
    expect(
      groundedIdsFromToolPayload({ result: { items: [{ id: 958009 }, { id: 125703 }] } }),
    ).toEqual(['958009', '125703']);
  });

  it('🔴 reads the BARE envelope the app re-serialises: { items: [...], truncated }', () => {
    // Both callers must get the same answer from the same data at different
    // depths. A fixed path grounds NOTHING for one of them, and an empty
    // grounded set looks exactly like "the model cited nothing".
    expect(
      groundedIdsFromToolPayload({
        items: [{ id: 1234, name: 'DreamShaper', type: 'Checkpoint' }],
        truncated: 0,
      }),
    ).toEqual(['1234']);
  });

  it('🔴 grounds an ATTACHED MENTION, which carries `modelId` and no `id` at all', () => {
    // `ResolvedResource` is { versionId, modelId, … }. Without `modelId` the
    // mention feature breaks: the viewer attaches a model in host chrome and
    // the link to it is refused as ungrounded.
    expect(
      groundedIdsFromToolPayload({
        items: [{ versionId: 128713, modelId: Number(DREAMSHAPER), modelName: 'DreamShaper' }],
        truncated: 0,
      }),
    ).toEqual([DREAMSHAPER]);
  });

  it('de-duplicates across items and normalises digit-strings', () => {
    expect(
      groundedIdsFromToolPayload({ items: [{ id: '4201' }, { id: 4201 }, { id: '0004201' }] }),
    ).toEqual([REALISTIC_VISION]);
  });

  it('🔴 does NOT ground a model URL sitting in third-party description text', () => {
    // A record's blurb is uploader-authored. Treating it as catalog provenance
    // would let any uploader vouch for any id they like.
    expect(
      groundedIdsFromToolPayload({
        items: [{ id: 1, blurb: `see also https://civitai.com/models/${DEAD_A}` }],
      }),
    ).toEqual(['1']);
  });

  it('ignores non-positive, non-integer and non-numeric ids', () => {
    expect(
      groundedIdsFromToolPayload({ items: [{ id: 0 }, { id: -5 }, { id: 1.5 }, { id: 'abc' }, {}] }),
    ).toEqual([]);
  });

  it('total on junk: null, scalars, arrays, and an items array of scalars', () => {
    expect(groundedIdsFromToolPayload(null)).toEqual([]);
    expect(groundedIdsFromToolPayload('nope')).toEqual([]);
    expect(groundedIdsFromToolPayload([{ items: [{ id: 9 }] }])).toEqual(['9']);
    expect(groundedIdsFromToolPayload({ items: [1, 2, null] })).toEqual([]);
  });
});

describe('groundedIdsFromToolResult — the string form the app holds', () => {
  it('parses what `callTool` returns', () => {
    const raw = JSON.stringify({ items: [{ id: Number(DREAMSHAPER) }], truncated: 0 });
    expect(groundedIdsFromToolResult(raw)).toEqual([DREAMSHAPER]);
  });

  it('🔴 a FAILED lookup grounds nothing and does not throw', () => {
    // `callTool` never throws — it returns `{"error":"…"}` so the model can
    // react. Grounding must degrade the same way, or a rate limit takes the
    // whole turn down.
    expect(groundedIdsFromToolResult(JSON.stringify({ error: 'rate limited' }))).toEqual([]);
    expect(groundedIdsFromToolResult('{ not json')).toEqual([]);
    expect(groundedIdsFromToolResult('')).toEqual([]);
  });
});

describe('mergeGroundedIds — accumulation across a conversation', () => {
  it('appends only what is new, preserving order', () => {
    expect(mergeGroundedIds([DREAMSHAPER], [REALISTIC_VISION, DEAD_B])).toEqual([
      DREAMSHAPER,
      REALISTIC_VISION,
      DEAD_B,
    ]);
  });

  it('🔴 returns the ORIGINAL array by reference when nothing is new', () => {
    // The App relies on this identity to skip a re-render of every bubble when
    // a round returns ids the conversation already had.
    const prev = [DREAMSHAPER, REALISTIC_VISION];
    expect(mergeGroundedIds(prev, [DREAMSHAPER])).toBe(prev);
    expect(mergeGroundedIds(prev, [])).toBe(prev);
  });

  it('de-duplicates within the added batch too', () => {
    expect(mergeGroundedIds(undefined, [CARDOS, CARDOS, EMILIA])).toEqual([CARDOS, EMILIA]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — `planCorrectionRound`, THE WHOLE DECISION, IN ISOLATION.
//
// 🔴 THREE PROPERTIES, AND ONLY ONE OF THEM IS ABOUT CORRECTNESS. The other two
// are about MONEY: a firing costs a real extra submit (4 Buzz at
// `maxTokens: 2048`), so "does not fire on a clean reply" and "cannot fire
// twice" are the assertions that keep the feature from silently doubling the
// cost of every turn. `correction-round.e2e.test.tsx` proves the App honours
// what this decides; this file proves what it decides.
// ─────────────────────────────────────────────────────────────────────────────

/** No conversation has grounded anything — the measured no-tool-call posture. */
const NOTHING_GROUNDED: ReadonlySet<string> = new Set<string>();

describe('planCorrectionRound — the no-fire cases, which are the cost cases', () => {
  it('🔴 does NOT fire when the reply cites nothing at all', () => {
    // The single most common turn in the app. A guard that fired here would
    // double the Buzz cost of every conversation, and nothing on screen would
    // say so.
    const plan = planCorrectionRound(
      'Lower your CFG to around 4 and raise the step count. Nothing to look up.',
      NOTHING_GROUNDED,
      0,
    );
    expect(plan.correct).toBe(false);
    // 🔴 THE REASON IS THE POINT, not just the boolean: it is what separates
    // "cited nothing" from "cited only grounded ids" in the field, and those two
    // are the pair a fire-rate has to be measured against.
    expect(plan.reason).toBe('no-citations');
    expect(plan.ungroundedIds).toEqual([]);
    expect(plan.message).toBeNull();
  });

  it('🔴 does NOT fire when EVERY citation is grounded', () => {
    const grounded = new Set([DREAMSHAPER, REALISTIC_VISION, DEAD_A]);
    const plan = planCorrectionRound(S2_FRAGMENT, grounded, 0);
    expect(plan.correct).toBe(false);
    expect(plan.reason).toBe('grounded');
    expect(plan.ungroundedIds).toEqual([]);
    expect(plan.message).toBeNull();
  });

  it('a citation that is NOT a model link is not a citation', () => {
    // Grounding has nothing to say about a profile or an article URL, so a reply
    // full of them must not be charged a corrective submit.
    const plan = planCorrectionRound(
      'See [the creator](https://civitai.com/user/tester) and [this article](https://civitai.com/articles/99).',
      NOTHING_GROUNDED,
      0,
    );
    expect(plan.correct).toBe(false);
    expect(plan.reason).toBe('no-citations');
  });
});

describe('planCorrectionRound — the firing case', () => {
  it('🔴 fires on the measured S6 answer, naming both invented ids', () => {
    // The verbatim shape from the seam probe: BARE parenthesised URLs, which
    // were never anchors, so Layer 1 had nothing to refuse and the false names
    // ("Detail Tweaker LoRA" at Emilia's id) reached the viewer intact.
    const plan = planCorrectionRound(S6_FRAGMENT, NOTHING_GROUNDED, 0);
    expect(plan.correct).toBe(true);
    expect(plan.reason).toBe('ungrounded');
    expect(plan.ungroundedIds).toEqual([EMILIA, CARDOS]);
    expect(plan.message).toContain(EMILIA);
    expect(plan.message).toContain(CARDOS);
  });

  it('🔴 fires on the ONE ungrounded id in an otherwise grounded answer', () => {
    // The partial case, and the one a "did it cite anything?" test would miss:
    // two of the three ids in S2 came out of the catalog and the third did not.
    const plan = planCorrectionRound(S2_FRAGMENT, new Set([DREAMSHAPER, REALISTIC_VISION]), 0);
    expect(plan.correct).toBe(true);
    expect(plan.ungroundedIds).toEqual([DEAD_A]);
    // 🔴 IT NAMES ONLY WHAT IS ACTUALLY WRONG. Listing the grounded ids too
    // would tell the model to re-look-up work it already did correctly, which is
    // how a correction turns into a suppression — the failure mode that got the
    // prompt-only fix rejected.
    expect(plan.message).not.toContain(DREAMSHAPER);
    expect(plan.message).not.toContain(REALISTIC_VISION);
  });

  it('de-duplicates a repeated invented id into one complaint', () => {
    const plan = planCorrectionRound(
      `${S6_FRAGMENT}\n${S6_FRAGMENT}`,
      new Set([CARDOS]),
      0,
    );
    expect(plan.ungroundedIds).toEqual([EMILIA]);
  });
});

describe('🔴 planCorrectionRound — THE CAP. It must be impossible to loop.', () => {
  it('the ceiling is one', () => {
    expect(MAX_CORRECTION_ROUNDS).toBe(1);
  });

  it('🔴 refuses a SECOND round on text that is still ungrounded', () => {
    // The whole bound, in one assertion: the same text that fired at
    // `roundsUsed: 0` must not fire at `roundsUsed: 1`.
    const first = planCorrectionRound(S6_FRAGMENT, NOTHING_GROUNDED, 0);
    expect(first.correct).toBe(true);

    const second = planCorrectionRound(S6_FRAGMENT, NOTHING_GROUNDED, 1);
    expect(second.correct).toBe(false);
    expect(second.reason).toBe('cap-reached');
    expect(second.message).toBeNull();
    // 🔴 THE IDS SURVIVE THE REFUSAL, and that is deliberate: the caller records
    // "we spent a round and it did NOT work", which needs to know what is still
    // wrong. Zeroing them here would make the failure indistinguishable from a
    // clean reply.
    expect(second.ungroundedIds).toEqual([EMILIA, CARDOS]);
  });

  it('🔴 refuses at every count above the ceiling, not just at exactly one', () => {
    // A `=== MAX_CORRECTION_ROUNDS` comparison passes the case above and lets a
    // caller that somehow reached 2 fire forever. Walked, not reasoned about.
    for (const used of [1, 2, 3, 7, 99]) {
      const plan = planCorrectionRound(S6_FRAGMENT, NOTHING_GROUNDED, used);
      expect(plan.correct, `roundsUsed=${used} must not fire`).toBe(false);
      expect(plan.reason).toBe('cap-reached');
    }
  });

  it('🔴 the cap does NOT mask a corrected reply that came back clean', () => {
    // The ordering trap: checking the cap before the grounding test would report
    // `cap-reached` here — recording the SUCCESS case as the failure case, and
    // inverting the only observability this feature has.
    const plan = planCorrectionRound(S2_FRAGMENT, new Set([DREAMSHAPER, REALISTIC_VISION, DEAD_A]), 1);
    expect(plan.correct).toBe(false);
    expect(plan.reason).toBe('grounded');
  });
});

describe('correctionMessage — what the model is actually told', () => {
  it('🔴 contains NO civitai model URL, so the complaint is not itself a citation', () => {
    // This string is appended to `apiMessages`, where anything is a candidate
    // for being read back by `citedModelIds` — by the eval, by a test, by a
    // future caller that scans the payload. Spelling the ids as
    // `.../models/<id>` would make the instruction to stop citing them parse as
    // a citation of them.
    const msg = correctionMessage([EMILIA, CARDOS, DEAD_A]);
    expect(citedModelIds(msg)).toEqual([]);
    // Positive control on that assertion: the extractor DOES fire on the shape
    // being forbidden, so the empty result above is a fact about the message and
    // not about a mis-aimed matcher.
    expect(citedModelIds(`${msg}\nhttps://civitai.com/models/${DETAIL_TWEAKER}`)).toEqual([
      DETAIL_TWEAKER,
    ]);
  });

  it('🔴 names no tool by name — declarations are fetched, not authored here', () => {
    // `App.tsx` fetches the declarations from the host precisely so a model is
    // never shown a contract the route does not enforce. Hard-coding
    // `search_models` here would put a tool name in the instructions that the
    // route is free to rename or withdraw, and the failure would be a model
    // apologising for a tool it cannot see.
    expect(correctionMessage([EMILIA])).not.toContain('search_models');
  });

  it('tells the model both permitted outs — look it up, or drop the id', () => {
    const msg = correctionMessage([DEAD_B]);
    expect(msg).toMatch(/look .*up/i);
    // The suppression-safe escape hatch: a model that cannot verify must say so
    // rather than stay silent about the model entirely.
    expect(msg).toMatch(/no link/i);
  });

  it('🔴 stays bounded when an answer invents a great many ids', () => {
    // The host truncates one message at 8,000 chars, silently and
    // mid-sentence — which would cut the instruction off after the id list and
    // leave the model with a complaint and no task.
    const many = Array.from({ length: 400 }, (_, i) => String(900_000 + i));
    const msg = correctionMessage(many);
    expect(msg.length).toBeLessThan(2_000);
    // The overflow is REPORTED, not silently dropped.
    expect(msg).toMatch(/\d+ more/);
    // And the first id is still named, so the message is about something.
    expect(msg).toContain(many[0]);
  });
});
