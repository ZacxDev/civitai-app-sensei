/**
 * THE GROUNDED-CITATION PREDICATE — ONE COPY, TWO CALLERS.
 *
 * 🔴 WHAT THIS EXISTS TO STOP, MEASURED. Sensei answers with a `search_models`
 * tool round when it decides to look something up, and when it does, its
 * citations are correct: 15/15 grounded across the 36-turn `prompt-eval-set.v1`
 * baseline. When it does NOT call the tool and names a model anyway, it emits
 * `civitai.com/models/<id>` links from memory. On the 18-turn seam probe
 * (`eval/results/seam-baseline-2026-08-31.json`) that produced 4 ungrounded
 * answers covering 6 unique ids, in three distinct failure shapes:
 *
 *   4201  Realistic Vision   — real id, correct name  (memorised correctly)
 *   4384  DreamShaper        — real id, correct name  (memorised correctly)
 *   4823                     — 404, NO SUCH MODEL     (dead link)
 *   18619                    — 404, NO SUCH MODEL     (dead link)
 *   7878  cited as "Detail Tweaker LoRA … improves facial features"
 *                            — 7878 is *Emilia (Re:Zero)*. Detail Tweaker LoRA
 *                              is real, at 58390. The NAME was right and the ID
 *                              was wrong.
 *   22220 cited as "Face Slider … fine-tuning facial expressions"
 *                            — 22220 is *CarDos Animated*.
 *
 * 🔴 THE LAST TWO ARE THE DANGEROUS CLASS AND THE REASON THIS IS MECHANICAL.
 * A dead link 404s and the viewer knows something is wrong. A real id under an
 * invented name resolves **200** and sends the viewer to an unrelated model
 * with nothing on screen to indicate it. No amount of reading the answer
 * detects it; only comparing the id against what the catalog actually returned
 * does.
 *
 * A prompt-only fix was tried and REJECTED: it cut fabrication mainly by making
 * the model stop naming models at all (suppression), and regressed a question.
 * See `eval/results/seam-rewrite-2026-09-01.json`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 ONE MODULE, IMPORTED BY BOTH SIDES — THIS IS THE POINT OF THE FILE.
 *
 * `eval/run-eval.mjs` used to carry its own inline copy of the regex and the
 * set membership test. Two copies of a predicate is the exact seam that lets a
 * green suite coexist with a broken shipped path: the eval would have gone on
 * measuring ITS rule while the renderer enforced a subtly different one, and
 * the divergence would be invisible in both. The eval's whole job is to measure
 * the SHIPPED mechanism, so the shipped mechanism is what it must import.
 *
 * The runner is `.mjs` and this is `.ts`, so the import is a plain
 * `from '../src/lib/grounding.ts'` and Node's own type stripping (unflagged
 * since 23.6; this box runs v26) erases the annotations at load. That is why
 * this module has **ZERO IMPORTS** and uses only erasable syntax — no enums, no
 * parameter properties, no namespaces, nothing that needs a compiler. Adding an
 * import here breaks the eval runner, not the app, and the app's tests will not
 * notice. Keep it standalone.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * The ids a conversation's tool rounds have actually returned.
 *
 * 🔴 PER-CONVERSATION AND ACCUMULATED, NOT PER-TURN. If a tool returned 4384 on
 * turn 1, a link to 4384 on turn 5 is grounded — the id genuinely came out of
 * the catalog in this conversation, and the model is entitled to refer back to
 * it. A per-turn set would refuse every follow-up question about a model the
 * viewer just searched for, which is most of what this app is for.
 *
 * 🔴 `undefined` AND AN EMPTY SET ARE DIFFERENT ANSWERS. `undefined` means "no
 * grounding context was supplied, do not apply the rule" (the legacy behaviour,
 * and what every call site that has no tool results at all still gets). An
 * EMPTY set means "this conversation has grounded nothing, so refuse every
 * model link". Collapsing the two would make the guard inert in exactly the
 * case the measurement above is about — a turn that called no tool.
 */
export type GroundedModelIds = ReadonlySet<string>;

/**
 * The ONE pattern. A citation is a `civitai.com/models/<id>` URL.
 *
 * 🔴 CASE-INSENSITIVE, AND THAT IS A GUARD RATHER THAN TIDINESS. `new URL()`
 * lower-cases the HOST but leaves the PATH alone, so a case-sensitive pattern
 * reads `https://civitai.com/MODELS/4823` as "not a model link" and waves it
 * straight past the grounding check. The path 404s on the real site, so the
 * bypass buys a dead link rather than a wrong destination — but it is a bypass,
 * and it costs one flag to close.
 *
 * Shared with `matchAll`, which clones the regex internally and therefore does
 * NOT mutate `lastIndex` — a module-level `/g` literal is safe here.
 */
const MODEL_URL_RE = /civitai\.com\/models\/(\d+)/gi;

/**
 * Every model id cited in a block of text, in order, INCLUDING duplicates.
 *
 * Duplicates are preserved because this is also the eval's `citedIds` field and
 * that field is a record of what an answer actually said. De-duplication is the
 * caller's business; {@link ungroundedModelIds} does it.
 */
export function citedModelIds(text: string): string[] {
  if (!text) return [];
  return [...text.matchAll(MODEL_URL_RE)].map((m) => m[1]);
}

/**
 * The model id a single href points at, or `null` if it is not a model link.
 *
 * 🔴 DELIBERATELY THE SAME EXTRACTION AS {@link citedModelIds}, not a second
 * URL parse that happens to agree today. The renderer and the eval must be
 * unable to disagree about what counts as a citation; sharing the function is
 * the only version of that claim that cannot rot.
 *
 * `null` means "grounding has nothing to say about this link" — a profile page,
 * an image, an article — and such a link is left to the host allowlist alone,
 * which is the behaviour that shipped before this module existed.
 */
export function modelIdInHref(href: string): string | null {
  return citedModelIds(href)[0] ?? null;
}

/**
 * The cited ids that NO tool round returned — unique, in first-cited order.
 *
 * Empty means every citation in `text` is grounded. That includes the case of
 * no citations at all, which is a correct answer to "did this answer cite
 * anything ungrounded?" and is why the eval keeps its own separate `null` for
 * "nothing to grade".
 */
export function ungroundedModelIds(text: string, grounded: GroundedModelIds): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of citedModelIds(text)) {
    if (grounded.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** How deep into a tool payload the walk below will look for an `items` array. */
const MAX_WALK_DEPTH = 8;

/**
 * The item fields that carry a catalog-sourced MODEL id.
 *
 * `id` is what `search_models` returns per record, and it is what the eval
 * scored its baseline on. `modelId` is what a RESOLVED MENTION carries
 * (`ResolvedResource` in `lib/mentions.ts` has `versionId` + `modelId` and no
 * `id` at all) — and a mention is serialised onto the wire by the very same
 * `boundToolResponse({ items, truncated })` call a tool result is, so it is the
 * same shape arriving through a different door. Omitting `modelId` would leave
 * the mention feature broken: the viewer attaches a model from the host's
 * picker, the model links it, and the link would be refused as ungrounded.
 *
 * Both are ids the catalog handed us, which is the whole membership rule.
 */
const ID_KEYS = ['id', 'modelId'];

/** A positive integer id, normalised to its canonical decimal string, or null. */
function idOf(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
  }
  return null;
}

function collectFrom(node: unknown, out: Set<string>, depth: number): void {
  if (depth > MAX_WALK_DEPTH || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) collectFrom(child, out, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'items' && Array.isArray(value)) {
      for (const item of value) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
        for (const idKey of ID_KEYS) {
          const id = idOf((item as Record<string, unknown>)[idKey]);
          if (id !== null) out.add(id);
        }
      }
    }
    collectFrom(value, out, depth + 1);
  }
}

/**
 * The model ids a tool response grounds, from the already-parsed payload.
 *
 * 🔴 IT WALKS FOR `items` RATHER THAN READING ONE FIXED PATH, because the two
 * callers see the SAME data at two different depths and a fixed path would
 * silently ground nothing for one of them. The live endpoint answers
 * `{ result: { items: [...] } }` — that is the path `run-eval.mjs` read before
 * this module existed, and the baseline files prove it was the right one — while
 * `callTool` hands the app whatever `boundToolResponse` re-serialised, and the
 * in-repo fixtures use the bare `{ items: [...] }` envelope. A reassuring EMPTY
 * grounded set is indistinguishable from "the model cited nothing", so a wrong
 * path here would present as the guard refusing every link, in only one of the
 * two callers.
 *
 * Only `items[]` entries are read. A `civitai.com/models/<id>` URL appearing in
 * some record's free-text description is NOT grounded by it: that text is
 * third-party authored, so treating it as catalog provenance would let one
 * uploader's description vouch for any id they like.
 */
export function groundedIdsFromToolPayload(payload: unknown): string[] {
  const out = new Set<string>();
  collectFrom(payload, out, 0);
  return [...out];
}

/**
 * The model ids a tool response grounds, from the raw string the app holds.
 *
 * `callTool` returns a STRING (it is destined for a `role:'tool'` message), and
 * it never throws — a failed lookup comes back as `{"error":"…"}`. Unparseable
 * input therefore grounds nothing rather than throwing, for the same reason:
 * a lookup that failed must not be able to take the turn down.
 */
export function groundedIdsFromToolResult(raw: string): string[] {
  if (!raw) return [];
  try {
    return groundedIdsFromToolPayload(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

/**
 * Accumulate `added` onto a conversation's existing ids, preserving order.
 *
 * Returns the ORIGINAL array by reference when nothing is new, so a caller
 * holding it in React state can skip the update — a tool round that returns
 * only ids the conversation already had must not re-render every bubble.
 */
export function mergeGroundedIds(
  prev: readonly string[] | undefined,
  added: readonly string[],
): readonly string[] {
  const base = prev ?? [];
  const have = new Set(base);
  const fresh: string[] = [];
  for (const id of added) {
    if (have.has(id)) continue;
    have.add(id);
    fresh.push(id);
  }
  return fresh.length === 0 ? base : [...base, ...fresh];
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — THE CORRECTION ROUND'S DECISION, AS A PURE FUNCTION.
//
// Layer 1 (`linkHref`) refuses the HREF of an ungrounded citation. It cannot
// touch the SENTENCE: measured, S6 answered
//
//   - **Detail Tweaker LoRA** (https://civitai.com/models/7878) improves facial features.
//
// where 7878 is *Emilia (Re:Zero)* and Detail Tweaker LoRA actually lives at
// 58390. Layer 1 turns that URL into plain text and the false NAME survives
// verbatim — and in this measured case the URL was a BARE parenthesised URL, so
// it was never an anchor for Layer 1 to refuse in the first place. The only
// thing that can fix a false name is asking the model again, with the catalog.
//
// 🔴 THE DECISION LIVES HERE, NOT IN `App.tsx`, FOR THE SAME REASON THE
// PREDICATE DOES. `eval/run-eval.mjs` must be able to score "would Layer 2 have
// fired on this turn?" with the SHIPPED rule rather than a second copy of it —
// that is the whole argument of this module's header, one layer up. Everything
// below is therefore import-free, erasable-syntax-only, and free of React,
// storage and the wire.
//
// 🔴 THE CAP IS PART OF THE DECISION, NOT PART OF THE CALLER. A bound enforced
// by a `for` loop in `App.tsx` is a bound nobody can unit-test and one refactor
// can lose. `roundsUsed` is an argument, the ceiling is a constant here, and
// "may I correct again?" has exactly one answer with one place to read it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many corrective re-submits ONE turn may spend. Hard, and deliberately 1.
 *
 * 🔴 EACH ROUND COSTS A REAL SUBMIT — 4 Buzz measured at `maxTokens: 2048` —
 * charged to the viewer, who did not ask for it. One is the whole budget: if the
 * corrected reply is still ungrounded we accept it and let Layer 1 gate its
 * links, which is a strictly better position than the one we started in and
 * cannot cost anything further. Raising this number is a SPEND decision, not a
 * quality knob, and it must be argued in Buzz.
 */
export const MAX_CORRECTION_ROUNDS = 1;

/**
 * How many ids the corrective message names before it summarises the rest.
 *
 * The host caps one message at 8,000 chars and `toStepMessages` truncates
 * silently at that bound — mid-sentence, which would cut the instruction off
 * after the id list and leave the model with a complaint and no task. Bounding
 * the list keeps the instruction intact no matter how many ids an answer
 * invented.
 */
const MAX_LISTED_IDS = 12;

/** Why {@link planCorrectionRound} decided the way it did. */
export type CorrectionReason =
  /** The reply cited no model at all. Nothing to correct, nothing to spend. */
  | 'no-citations'
  /** Every id it cited came out of this conversation's tool rounds. */
  | 'grounded'
  /** Ungrounded ids, and a round left to spend on them. THE ONLY FIRING CASE. */
  | 'ungrounded'
  /** Ungrounded ids, but this turn has already spent its correction round. */
  | 'cap-reached';

export interface CorrectionPlan {
  /** Whether the caller should spend a corrective re-submit. */
  readonly correct: boolean;
  readonly reason: CorrectionReason;
  /** The ungrounded ids, unique and in first-cited order. May be non-empty
   *  even when `correct` is false — that is exactly the `cap-reached` case, and
   *  it is what a caller records to say the correction did NOT succeed. */
  readonly ungroundedIds: readonly string[];
  /** The corrective turn's text, or `null` when nothing should be sent. */
  readonly message: string | null;
}

/**
 * The corrective instruction, given the ids that could not be verified.
 *
 * 🔴 IT NAMES NO TOOL. Declarations are FETCHED from the host, never authored
 * by this app (`App.tsx`: "a model must not be shown a contract the route does
 * not enforce"), so hard-coding `search_models` here would put a tool name in
 * the model's instructions that the route is free to rename or withdraw. The
 * model already has the real declarations in the same payload; this only has to
 * tell it to USE them.
 *
 * 🔴 AND IT CONTAINS NO MODEL URL, WHICH IS A GUARD RATHER THAN STYLE. This
 * string is appended to `apiMessages`, and anything appended there is a
 * candidate for being read back by {@link citedModelIds} — by this function's
 * own tests, by the eval, or by a future caller that scans the whole payload.
 * A message that spelled the ids as `civitai.com/models/<id>` would be
 * self-citing: the instruction to stop citing them would itself parse as a
 * citation of them. The ids are listed as bare numbers for that reason.
 */
export function correctionMessage(ungroundedIds: readonly string[]): string {
  const shown = ungroundedIds.slice(0, MAX_LISTED_IDS);
  const extra = ungroundedIds.length - shown.length;
  const list = shown.join(', ') + (extra > 0 ? `, and ${extra} more` : '');
  return (
    `Your previous answer referred to Civitai model ids that no lookup in this ` +
    `conversation returned: ${list}. An unverified id is very often a real model ` +
    `under a completely different name, so the link would send the reader ` +
    `somewhere unrelated with nothing on screen to warn them.\n\n` +
    `Look each of those models up with the model-search tool you have been given, ` +
    `then write the answer again using ONLY ids the tool returned this turn. ` +
    `If the tool cannot find one, say so plainly and name the model with no link ` +
    `and no id rather than guessing.`
  );
}

/**
 * Decide whether a finished reply earns a corrective re-submit, and with what.
 *
 * `text` is the turn's FINAL assistant text — the thing about to be rendered and
 * persisted. `grounded` is the conversation's accumulated tool-returned ids,
 * INCLUDING everything this turn's own rounds added. `roundsUsed` is how many
 * corrective re-submits this turn has already spent.
 *
 * 🔴 THE TWO NO-FIRE CASES ARE DISTINGUISHED, NOT COLLAPSED, AND THE REASON IS
 * COST. `ungroundedModelIds` returns `[]` both for "cited nothing" and for
 * "cited only grounded ids", and a caller only needs the boolean — but a guard
 * that fires on every turn would silently DOUBLE the Buzz cost of the app, and
 * the only way to notice is to be able to count the two silent cases apart in
 * the field. They get their own reasons so the fire-rate is measurable rather
 * than inferred.
 *
 * 🔴 THE CAP IS CHECKED AFTER THE GROUNDING TEST, NOT BEFORE. Checking it first
 * would report `cap-reached` for a corrected reply that came back perfectly
 * grounded — i.e. it would record the SUCCESS case as the failure case, and the
 * observability this exists to provide would be exactly inverted.
 */
export function planCorrectionRound(
  text: string,
  grounded: GroundedModelIds,
  roundsUsed: number,
): CorrectionPlan {
  const ungroundedIds = ungroundedModelIds(text, grounded);
  if (ungroundedIds.length === 0) {
    return {
      correct: false,
      reason: citedModelIds(text).length === 0 ? 'no-citations' : 'grounded',
      ungroundedIds,
      message: null,
    };
  }
  if (roundsUsed >= MAX_CORRECTION_ROUNDS) {
    return { correct: false, reason: 'cap-reached', ungroundedIds, message: null };
  }
  return {
    correct: true,
    reason: 'ungrounded',
    ungroundedIds,
    message: correctionMessage(ungroundedIds),
  };
}
