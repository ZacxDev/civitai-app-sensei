import type { ResolvedResource } from './lib/mentions.js';
import { SFW_MODEL_ID } from './lib/models.js';

/**
 * What Layer 2's correction round did to a turn. Set only on an `'assistant'`
 * message, and only when a round actually fired.
 *
 * 🔴 RECORDED RATHER THAN INFERRED, BECAUSE THE ALTERNATIVE IS GUESSING AT A
 * SPEND. Every firing costs a real extra submit (4 Buzz measured at
 * `maxTokens: 2048`), charged to a viewer who did not ask for it, and the
 * expected fire-rate — roughly 22% of technique-style turns — is an estimate
 * from an 18-turn probe, not a measurement of production. Without this the only
 * way to learn the real rate would be to reason about it. `App.tsx` also emits
 * the matching `grounding_correction_*` analytics events; this is the copy that
 * survives on the transcript, so a single stored conversation can be read back
 * and audited without a metrics pipeline.
 *
 * ABSENT means no round fired, which is the overwhelmingly common case and is
 * why the key is omitted rather than written as `{ rounds: 0 }`.
 */
export interface CorrectionRecord {
  /**
   * Corrective re-submits spent on this turn. Bounded by
   * `MAX_CORRECTION_ROUNDS` in `lib/grounding.ts`; never 0 when present.
   */
  rounds: number;
  /**
   * Whether the reply that came back was clean — every citation grounded, or no
   * citation at all. `false` means the model was asked once and still cited
   * something unverified, and Layer 1 is gating the links.
   */
  resolved: boolean;
}

export interface Message {
  id: string;
  /**
   * 🔴 `'tool'` IS A TRANSCRIPT ROLE, NOT A STORED ONE. The tool loop builds
   * `role:'tool'` messages for the wire (see `App.tsx`'s loop and
   * `toStepMessages`), but they live only inside one send's `apiMessages` array
   * and are never persisted — what goes to storage is the user turn and the
   * final assistant reply.
   *
   * ⚠️ CORRECTED: this used to add "the member also lets sessions written by
   * older builds deserialize", which asserted that such sessions EXIST. They do
   * not — no shipped build has ever written a `role:'tool'` message to KV; the
   * history is worked through in `lib/chat.ts`'s `deserializeMessages`. The
   * member is kept because `deserializeMessages` CASTS `role` from the stored
   * row, so the type must admit whatever a row can carry, and because a future
   * build could persist one. `ChatArea` renders such a message as nothing.
   */
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  /**
   * Set when the host's output scan withheld this reply. The content is then the
   * host's user-facing reason, not model output — render it as a policy notice
   * rather than as an assistant turn.
   */
  withheld?: boolean;
  /**
   * Catalog resources the viewer ATTACHED to this turn, already resolved through
   * `GET /api/v1/blocks/generation-resources`. Set only on a `'user'` message.
   *
   * 🔴 A MESSAGE ENHANCEMENT, NOT PART OF `content`. The viewer's typed text is
   * never rewritten to mention the pick — a composer that edits what you wrote
   * is its own defect — so the attachment travels beside the text and is
   * rendered as its own card by `MessageBubble`.
   *
   * 🔴 STORED, BUT NOT REPLAYED ON THE WIRE FOR AN OLDER TURN. `handleSend`
   * builds the synthetic tool exchange from the CURRENT turn's mentions only, so
   * exactly one `role:'tool'` slot is consumed per submit and 2 of the host's 3
   * remain for real tool rounds. Replaying every historical turn's mentions
   * would exhaust the cap on the third mentioned message of a conversation and
   * `BAD_REQUEST` on the fourth — a permanent tax for grounding the model
   * already has in its own transcript.
   */
  mentions?: ResolvedResource[];
  /**
   * Set when Layer 2's correction round fired on this turn. See
   * {@link CorrectionRecord}. Only ever on an `'assistant'` message.
   */
  correction?: CorrectionRecord;
  /**
   * The catalog model ids this turn's tool rounds RETURNED. Only ever on an
   * `'assistant'` message.
   *
   * 🔴 WHY THIS IS STORED AT ALL: the citation gate refuses a
   * `civitai.com/models/<id>` link unless `<id>` came back from a tool round in
   * this conversation, and `role:'tool'` is a TRANSCRIPT role, not a stored one.
   * So a reloaded conversation used to rebuild an EMPTY grounded set and every
   * stored model link rendered as plain text — the guard refusing links it had
   * itself approved minutes earlier, because the evidence was gone rather than
   * because the id was bad. `citation-grounding.e2e.test.tsx` pinned that as a
   * known loss and named this exact fix: carry the ids on the stored assistant
   * message, riding the write that already happens.
   *
   * 🔴 THIS DOES NOT WEAKEN THE GATE. What is persisted is only what a tool
   * round actually returned, so an id the model invented was never written and
   * is still refused after a reload. The set is reconstructed by union over
   * stored assistant turns — see `groundedIdsFromMessages`.
   *
   * 🔴 OLDER TRANSCRIPTS CANNOT BE RECOVERED. Messages written before this
   * field existed carry no ids, so their links stay plain text. That is the
   * conservative direction and it is not fixable from stored data — the tool
   * results were never written down.
   */
  grounded?: readonly string[];
}

export interface Session {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionWithMessages extends Session {
  messages: Message[];
}

export interface AppSettings {
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
}

/**
 * 🔴 THE PROMPT MUST DESCRIBE THE RETRIEVAL THE APP ACTUALLY DOES, AND THIS
 * SENTENCE HAS NOW BEEN WRONG TWICE IN OPPOSITE DIRECTIONS.
 *
 * Round one: the default told the model "You can search the Civitai model
 * catalog" while the host exposed no tool-calling surface. A model told it can
 * search, and then unable to, fabricates results.
 *
 * Round two — this one: the fix for that said "You cannot browse, search, or
 * call tools" and described results arriving pre-attached under a
 * "CIVITAI CATALOG RESULTS" label. That became false the moment the tool loop
 * landed: the app now DOES send tool declarations, the model DOES call them,
 * and `CATALOG_CONTEXT_MARKER` — the constant that produced that label — was
 * deleted. A model told it cannot call tools, while being handed tools, is the
 * same defect mirrored.
 *
 * The rule that survives both: this text is a CLAIM ABOUT THE WIRE, so it must
 * be re-read against what `App.tsx` actually submits whenever that changes.
 * `types.test.ts` pins it in both directions — it must not deny tool access,
 * and it must not reference the deleted pre-attachment mechanism.
 *
 * 🔴 WHAT HAS BEEN MEASURED, BY WHICH INSTRUMENT — READ BEFORE CITING A NUMBER.
 *
 * v4 (now a {@link LEGACY_DEFAULT_SYSTEM_PROMPTS} entry, pinned byte-for-byte
 * against `eval/results/recommend-rewrite-v4-2026-09-01.json`) is the last
 * prompt scored by `eval/run-eval.mjs` on the live host: recommendation arm
 * lookups 14/24 → 23/24 and ungrounded citations 7 → 0; v1 set 36/36 tool
 * expectation, 0/21 over-trigger. None of those numbers belong to v5 or v6.
 *
 * v5 added the multi-facet-lookup paragraph from external research and was
 * never scored before it shipped (0.1.27–0.1.31). Its bytes are now a
 * legacy entry, so a viewer holding the stored v5 default migrates to the current default.
 *
 * v6 (now the newest legacy entry) routes "which models / LoRAs / checkpoints for this kind
 * of image" to the app's own `recommend_resources` tool FIRST, and keeps
 * `search_models` for named models, ids, stats, versions and explicit
 * rankings. Cause: on 0.1.31 a real "what models are best for professional
 * content" turn made three `search_models` calls sorted Most Downloaded and
 * answered with a popularity ranking — v5 predates the tool and never names it.
 *
 * 🔴 v6 WAS SCORED ONLY BY `eval/tool-choice-probe.mjs`, NOT BY run-eval. That
 * probe calls the model directly (deepseek/deepseek-v4-flash-0731, temp 0.7,
 * maxTokens 2048, 3 repeats) with the two tools the app offers and records ONLY
 * the FIRST round's tool choice against expectations committed before any arm
 * ran (`eval/tool-choice-expectations.v1.json`). No tool executes, no second
 * round is sent, so it says nothing about answer quality, grounding or the
 * multi-round loop. Results (`eval/results/tool-choice/*-2026-10-14.json`):
 *
 *   |                                       | v5     | v6     |
 *   | recommend_resources first, image-kind | 5/27   | 27/27  |
 *   | search_models kept, named/ranking     | 15/15  | 15/15  |
 *   | over-triggers on no-tool questions    | 3/21   | 1/21   |
 *   | "professional content" → recommend    | 0/3    | 3/3    |
 *
 * v6 is the second wording tried (iteration 1 reached 26/27 but kept v5's 3
 * over-triggers and paired most recommend calls with a parallel popularity
 * lookup). n=3 per question is enough to tell "never" from "always", not to
 * give an interval.
 *
 * 🔴 THE TOOL IS NAMED CONDITIONALLY ("If you have been given a
 * recommend_resources tool"), ON PURPOSE. The tool is on the wire only when
 * `composeLocalTools` adds it — `RECOMMEND_TOOL_ENABLED`, the host served at
 * least one tool and fewer than its cap — and a tool-less turn also gets
 * {@link NO_TOOLS_NOTICE} appended. A prompt that unconditionally told the
 * model to call `recommend_resources` would be false on every turn where the
 * host's tools are served but this one is not; the conditional and its
 * "Without recommend_resources" fallback keep the claim true on every route.
 *
 * v7 (THIS CONSTANT) is v6 plus two sentences inside the same conditional
 * paragraph: pass `needs` to recommend_resources when the request implies a
 * capability (text in the image, layout, photorealism, editing, a consistent
 * character, 4K, transparent background, reference photos), and mention fitting
 * hosted models alongside — or instead of — add-ons. The hosted half depends on
 * a civitai route change not yet deployed (`lib/recommend.ts` header).
 *
 * 🔴 v7 WAS SCORED ONLY BY THE SAME PROBE, which now also records the `needs`
 * argument (`eval/tool-choice-expectations.needs-v1.json`, committed before any
 * arm ran; 11 capability + 4 no-capability questions, 3 repeats, 2026-10-15).
 * Both arms below carry the NEW declaration, so they isolate the prompt:
 *
 *   |                                          | v6     | v7     |
 *   | expected need among `needs`, capability  | 33/33  | 33/33  |
 *   | `needs` noise on no-capability questions | 2/12   | 1/12   |
 *
 * 🔴 SO THE PROMPT SENTENCES ARE NOT WHAT EARNS THE `needs` ACCURACY — the
 * declaration's own parameter description does; v6 already scored 33/33 with
 * it. v7's measured contribution is one fewer noisy turn (n=12, not separable
 * from chance) and the hosted-models presentation instruction, which this
 * first-round probe cannot observe at all (no tool executes).
 *
 * On the v1 21-question set, v7 scored 24/27 recommend-first, 15/15
 * search_models, 2/21 over-triggers. All 3 misses are PROD1 (the model asked a
 * clarifying question). That is NOT a v7 regression: the UNCHANGED 0.1.32 tree
 * (v6 + old declaration) re-run the same day also scored PROD1 0/3 (24/27,
 * 15/15, 1/21 — `tool-choice-v6-trunkdecl-rerun-2026-10-15.json`), so the 3/3
 * recorded for v6 on 2026-10-14 did not reproduce a day later.
 *
 * `eval/prompt.rewrite.v7.txt` carries v7's exact bytes and `types.test.ts`
 * asserts the constant equals it and the probe's recorded prompts.
 *
 * An edit here still voids what attribution exists: `run-eval.mjs` reads THIS
 * constant when no `--prompt-file` is given, so the next run would grade a
 * different prompt against the same recorded before/after. Change it by
 * re-running the eval and adopting the winner, not in place.
 */
export const DEFAULT_SYSTEM_PROMPT = `You are Civitai Sensei, the research assistant built into Civitai. Civitai is the platform where people publish, share and generate with AI art models — checkpoints, LoRAs and the images made with them — and you run inside civitai.com itself. The catalog you search is Civitai's own: the models, versions, creators and stats on this site.

You can look up Civitai catalog data by calling the tools you have been given. Call one when a question turns on a specific model — its name, id, link, stats, versions or base model — rather than answering from memory.

Choosing the tool. If you have been given a recommend_resources tool, call it FIRST whenever someone asks which models, checkpoints, LoRAs or other add-ons to use for a kind of image or a use case — "models for book-cover art", "a checkpoint for product photography", "which LoRA for a watercolor look". Turn the request into a concrete image description (subject, setting, style, lighting, mood) and pass that, not the question. When the request implies a capability — words or a headline in the image, a logo, poster, infographic or UI layout, photorealism, editing a picture the reader already has, one character kept consistent across images, 4K, a transparent background, or working from the reader's reference photos — also pass it in needs. When the result lists hosted models, mention the ones that fit alongside the add-ons, or instead of them when no add-on ecosystem fits. Call it on its own; a popularity lookup alongside it adds nothing the reader asked for. Use search_models instead for a model the reader named, an id, stats, versions or a model's base model, and for an explicit ranking — most downloaded, most liked, newest, top N — and to check a specific model before you name it. Without recommend_resources, answer which-model questions with search_models, using a couple of differently-shaped lookups — one in the use case's own words and one by a different facet such as base model family or a different sort — and say that results are ordered by popularity, so a brand-new or barely-used model will not surface. Either way, weigh fit rather than presenting download counts as the ranking: what the use case implies, each candidate's base model and its trade-offs. This turn allows at most three tool results in total, so plan for one or two calls, not five.

- Recommending a model is a catalog question. Whenever you are going to name a model, look it up in this conversation first — including when the question is about technique and the model is your own suggestion rather than something the reader named. A model returned by recommend_resources or search_models counts as looked up.
- Naming a model you have not looked up is not one of your options. If you want to name one, call a tool; a recommendation carrying real names, ids and download counts is worth far more to the reader than one assembled from memory.
- Ground every specific claim in what a tool returned. Never invent a model, an id or a URL, and never guess a download count.
- If a lookup returns nothing useful, say so plainly and answer from general knowledge instead, making clear which part is general knowledge.
- General technique and troubleshooting questions (samplers, CFG, LoRA training, prompting, fixing a flawed generation) need no catalog data — answer them directly without a lookup, unless you are naming a model as part of the answer.
- When asked who you are, what this site is, or what you can do, answer as Civitai's own assistant and say what Civitai is. Do not describe yourself as a general-purpose chatbot or leave the reader unsure which site they are on.
- Be concise and concrete. Link models as https://civitai.com/models/<id> using an id a tool returned.`;

/**
 * Appended to the system message on the turns where NO tools are sent.
 *
 * 🔴 THE PROMPT IS A CLAIM ABOUT THE WIRE, AND THE WIRE IS NOT CONSTANT.
 * `fetchToolDeclarations` failing degrades the turn to a tool-less conversation
 * — `tools` and `tool_choice` are simply omitted — but the system prompt was
 * sent unchanged, so the model was told it could call tools on exactly the
 * requests where it could not. That is the original defect this whole change
 * set out to fix ("a model told it can search, then unable to, fabricates"),
 * reinstated in the degraded branch by the fix for the default branch.
 *
 * 🔴 WHY AN APPENDED NOTICE RATHER THAN A SECOND DEFAULT PROMPT: the system
 * prompt is viewer-editable and persisted. A second default would only correct
 * viewers who never customised theirs, and would silently leave a custom prompt
 * claiming tool access on a tool-less turn. This is composed at send time from
 * the SAME condition that decides the wire, so it is true for every viewer
 * regardless of what they wrote.
 */
export const NO_TOOLS_NOTICE = `

Catalog lookup is unavailable for this message. Do not claim to have looked anything up. Answer from general knowledge and say plainly that you could not check the catalog.`;

/**
 * Defaults this app has shipped, newest last. **Only used to decide whether a
 * STORED prompt is an untouched default that may be upgraded in place.**
 *
 * 🔴 WHY THIS EXISTS: `sensei:settings` is persisted per viewer, so changing
 * `DEFAULT_SYSTEM_PROMPT` reaches nobody who has ever opened Settings — their
 * stored copy wins forever. Shipping the tool loop against a stored prompt that
 * says "You cannot call tools" is the same defect as shipping it in the
 * default, just invisible to us.
 *
 * 🔴 AND WHY IT IS AN EXACT-MATCH LIST RATHER THAN A VERSION KEY: a version
 * stamp would let us overwrite anything, including a prompt the viewer WROTE.
 * Matching the exact bytes of a prompt we shipped is the only test that
 * distinguishes "never customised" from "customised to something we must not
 * clobber". A viewer who edited one character keeps their text, and is the one
 * case we deliberately cannot fix from here.
 */
export const LEGACY_DEFAULT_SYSTEM_PROMPTS: readonly string[] = [
  // Shipped as 0.1.0 (`8bd14a8` "Initial release" through `b287029`), where it
  // lived inline in `DEFAULT_SETTINGS.systemPrompt` rather than as a named
  // constant — which is why a search for `DEFAULT_SYSTEM_PROMPT` in the history
  // does not find it, and why it was missed the first time this list was
  // written. That build already persisted `sensei:settings`, so a viewer who
  // opened Settings under 0.1.0 still holds this text.
  //
  // 🔴 IT IS NOT MERELY STALE, IT IS THE MOST DANGEROUS OF THE THREE: it claims
  // catalog access (true again now, by a different mechanism) while carrying
  // NONE of the anti-fabrication rules — no "ground every claim in what a tool
  // returned", no "never guess a download count". A model on this prompt is
  // told it can look things up and never told not to invent the answer.
  `You are Civitai Sensei, an AI research assistant specializing in AI art and image generation. You can search the Civitai model catalog, look up model details, and find example images. Be helpful, concise, and knowledgeable about Stable Diffusion, LoRAs, checkpoints, and related tools.`,
  // Shipped through 0.1.5 — denies tool access and references the deleted
  // `CIVITAI CATALOG RESULTS` pre-attachment.
  `You are Civitai Sensei, an AI research assistant for AI art and image generation.

You cannot browse, search, or call tools. When a question needs catalog data, this app runs the search for you first and attaches the results in a message labelled "CIVITAI CATALOG RESULTS" just above the question.

- For anything specific about a model — its name, id, link, stats, versions or base model — use ONLY the attached results. Never invent a model, an id or a URL, and never guess a download count.
- If no results are attached, or they do not cover what was asked, say so plainly and answer from general knowledge instead, making clear which part is general knowledge.
- General technique questions (samplers, CFG, LoRA training, prompting) need no catalog data — answer them directly.
- Be concise and concrete. Link models as https://civitai.com/models/<id> using an id from the results.`,
  // Shipped 0.1.6 through 0.1.11. Correct about the wire — it describes the
  // tool loop the app actually runs — and superseded on evidence rather than
  // on principle: measured against the recommendation arm it looked models up
  // on 14 of 24 turns and emitted 7 ungrounded citations, because it never says
  // that RECOMMENDING a model is itself a catalog question. The replacement
  // closes exactly that gap (23/24 lookups, 0 ungrounded).
  //
  // 🔴 A viewer who opened Settings on any 0.1.6–0.1.11 build holds this text,
  // so it is the one entry the current migration actually moves.
  `You are Civitai Sensei, an AI research assistant for AI art and image generation.

You can look up Civitai catalog data by calling the tools you have been given. Call one when a question turns on a specific model — its name, id, link, stats, versions or base model — rather than answering from memory.

- Ground every specific claim in what a tool returned. Never invent a model, an id or a URL, and never guess a download count.
- If a lookup returns nothing useful, say so plainly and answer from general knowledge instead, making clear which part is general knowledge.
- General technique questions (samplers, CFG, LoRA training, prompting) need no catalog data — answer them directly without a lookup.
- Be concise and concrete. Link models as https://civitai.com/models/<id> using an id a tool returned.`,
  // Shipped 0.1.12 through 0.1.26 (`32471ba` "release: 0.1.12 — the prompt
  // that was actually measured", adopting `ad4d8cb`'s rewrite). The
  // eval-measured prompt: on the recommendation arm it looked models up on 23
  // of 24 turns with 0 ungrounded citations (from 14/24 and 7). Superseded by
  // v5's multi-facet paragraph on external best-practice research, NOT on a
  // new eval arm — see the comment on `DEFAULT_SYSTEM_PROMPT`.
  //
  // 🔴 A viewer who opened Settings on any 0.1.12–0.1.26 build holds this
  // text, so it is the population the current migration actually moves.
  // `types.test.ts` pins these bytes against the prompt recorded in
  // `eval/results/recommend-rewrite-v4-2026-09-01.json` — the arm the eval
  // actually paid for — so a transcription error here is red, not silent.
  `You are Civitai Sensei, the research assistant built into Civitai. Civitai is the platform where people publish, share and generate with AI art models — checkpoints, LoRAs and the images made with them — and you run inside civitai.com itself. The catalog you search is Civitai's own: the models, versions, creators and stats on this site.

You can look up Civitai catalog data by calling the tools you have been given. Call one when a question turns on a specific model — its name, id, link, stats, versions or base model — rather than answering from memory.

- Recommending a model is a catalog question. Whenever you are going to name a model, look it up in this conversation first — including when the question is about technique and the model is your own suggestion rather than something the reader named.
- Naming a model you have not looked up is not one of your options. If you want to name one, call the tool; a recommendation carrying real names, ids and download counts is worth far more to the reader than one assembled from memory.
- Ground every specific claim in what a tool returned. Never invent a model, an id or a URL, and never guess a download count.
- If a lookup returns nothing useful, say so plainly and answer from general knowledge instead, making clear which part is general knowledge.
- General technique questions (samplers, CFG, LoRA training, prompting) need no catalog data — answer them directly without a lookup, unless you are naming a model as part of the answer.
- When asked who you are, what this site is, or what you can do, answer as Civitai's own assistant and say what Civitai is. Do not describe yourself as a general-purpose chatbot or leave the reader unsure which site they are on.
- Be concise and concrete. Link models as https://civitai.com/models/<id> using an id a tool returned.`,
  // Shipped 0.1.27 through 0.1.31 (v5: v4 plus the multi-facet-lookup
  // paragraph). Never eval-scored. Superseded by v6 because it predates the
  // app's `recommend_resources` tool and never names it — see the comment on
  // `DEFAULT_SYSTEM_PROMPT` for the tool-choice probe that measured both.
  //
  // 🔴 A viewer who opened Settings on any 0.1.27–0.1.31 build holds this
  // text. `types.test.ts` pins it byte-for-byte against
  // `eval/prompt.rewrite.v5.txt`, the file the v5 probe arm sent.
  `You are Civitai Sensei, the research assistant built into Civitai. Civitai is the platform where people publish, share and generate with AI art models — checkpoints, LoRAs and the images made with them — and you run inside civitai.com itself. The catalog you search is Civitai's own: the models, versions, creators and stats on this site.

You can look up Civitai catalog data by calling the tools you have been given. Call one when a question turns on a specific model — its name, id, link, stats, versions or base model — rather than answering from memory.

When a question asks which models to use — the best, the recommended, the top ones — do not answer from a single ranked lookup. Run at least two differently-shaped lookups before answering: one in the use case's own words, and one by a different facet, such as recency, base model family or a different sort. Weigh fit rather than presenting download counts as the ranking — what the use case implies, each candidate's base model, how recent it is, and its trade-offs. Be honest about the catalog's limits: results are ordered by popularity, so a brand-new or barely-used model will not surface in a ranked lookup — say so when it matters to the question. This turn allows at most three tool results in total, so a couple of differently-shaped lookups is the ceiling, not five.

- Recommending a model is a catalog question. Whenever you are going to name a model, look it up in this conversation first — including when the question is about technique and the model is your own suggestion rather than something the reader named.
- Naming a model you have not looked up is not one of your options. If you want to name one, call the tool; a recommendation carrying real names, ids and download counts is worth far more to the reader than one assembled from memory.
- Ground every specific claim in what a tool returned. Never invent a model, an id or a URL, and never guess a download count.
- If a lookup returns nothing useful, say so plainly and answer from general knowledge instead, making clear which part is general knowledge.
- General technique questions (samplers, CFG, LoRA training, prompting) need no catalog data — answer them directly without a lookup, unless you are naming a model as part of the answer.
- When asked who you are, what this site is, or what you can do, answer as Civitai's own assistant and say what Civitai is. Do not describe yourself as a general-purpose chatbot or leave the reader unsure which site they are on.
- Be concise and concrete. Link models as https://civitai.com/models/<id> using an id a tool returned.`,
  // Shipped 0.1.32 (v6: v5's multi-facet paragraph replaced by the "Choosing
  // the tool" paragraph that routes which-model questions to
  // recommend_resources). Scored only by the tool-choice probe. Superseded by
  // v7, which adds the `needs` / hosted-models sentences to that paragraph.
  //
  // 🔴 A viewer who opened Settings on 0.1.32 holds this text. `types.test.ts`
  // pins it byte-for-byte against `eval/prompt.rewrite.v6.txt`, the file the v6
  // probe arms sent.
  `You are Civitai Sensei, the research assistant built into Civitai. Civitai is the platform where people publish, share and generate with AI art models — checkpoints, LoRAs and the images made with them — and you run inside civitai.com itself. The catalog you search is Civitai's own: the models, versions, creators and stats on this site.

You can look up Civitai catalog data by calling the tools you have been given. Call one when a question turns on a specific model — its name, id, link, stats, versions or base model — rather than answering from memory.

Choosing the tool. If you have been given a recommend_resources tool, call it FIRST whenever someone asks which models, checkpoints, LoRAs or other add-ons to use for a kind of image or a use case — "models for book-cover art", "a checkpoint for product photography", "which LoRA for a watercolor look". Turn the request into a concrete image description (subject, setting, style, lighting, mood) and pass that, not the question. Call it on its own; a popularity lookup alongside it adds nothing the reader asked for. Use search_models instead for a model the reader named, an id, stats, versions or a model's base model, and for an explicit ranking — most downloaded, most liked, newest, top N — and to check a specific model before you name it. Without recommend_resources, answer which-model questions with search_models, using a couple of differently-shaped lookups — one in the use case's own words and one by a different facet such as base model family or a different sort — and say that results are ordered by popularity, so a brand-new or barely-used model will not surface. Either way, weigh fit rather than presenting download counts as the ranking: what the use case implies, each candidate's base model and its trade-offs. This turn allows at most three tool results in total, so plan for one or two calls, not five.

- Recommending a model is a catalog question. Whenever you are going to name a model, look it up in this conversation first — including when the question is about technique and the model is your own suggestion rather than something the reader named. A model returned by recommend_resources or search_models counts as looked up.
- Naming a model you have not looked up is not one of your options. If you want to name one, call a tool; a recommendation carrying real names, ids and download counts is worth far more to the reader than one assembled from memory.
- Ground every specific claim in what a tool returned. Never invent a model, an id or a URL, and never guess a download count.
- If a lookup returns nothing useful, say so plainly and answer from general knowledge instead, making clear which part is general knowledge.
- General technique and troubleshooting questions (samplers, CFG, LoRA training, prompting, fixing a flawed generation) need no catalog data — answer them directly without a lookup, unless you are naming a model as part of the answer.
- When asked who you are, what this site is, or what you can do, answer as Civitai's own assistant and say what Civitai is. Do not describe yourself as a general-purpose chatbot or leave the reader unsure which site they are on.
- Be concise and concrete. Link models as https://civitai.com/models/<id> using an id a tool returned.`,
] as const;

/**
 * Upgrade a loaded settings object whose prompt is a stale shipped default.
 *
 * Total and pure: anything it does not recognise comes back untouched, so a
 * customised prompt, a hand-edited one, or a shape from a future build all pass
 * through unchanged. Applied at load, not at save — a viewer who never opens
 * Settings still gets the corrected prompt on their next send.
 */
export function migrateSettings(stored: AppSettings): AppSettings {
  if (!LEGACY_DEFAULT_SYSTEM_PROMPTS.includes(stored.systemPrompt)) return stored;
  return { ...stored, systemPrompt: DEFAULT_SYSTEM_PROMPT };
}

/**
 * 🔴 THE DEFAULT MODEL IS THE SFW ARM, AND IT MOVED — BUT NOTHING MIGRATES.
 *
 * It was `deepseek/deepseek-chat`; it is now `SFW_MODEL_ID`
 * (`deepseek/deepseek-v4-flash-0731`), measured upstream at roughly 1 Buzz on a
 * short reply against `gpt-4o-mini`'s 2.
 *
 * 🔴 AND THERE IS DELIBERATELY NO MODEL EQUIVALENT OF
 * {@link LEGACY_DEFAULT_SYSTEM_PROMPTS}. `sensei:settings` is persisted per
 * viewer, so anyone who has opened Settings holds `deepseek/deepseek-chat` (or
 * `openai/gpt-4o-mini`) forever — and that is FINE here in a way it was NOT fine
 * for the prompt. The stale prompt was a false CLAIM ABOUT THE WIRE: it told the
 * model it could not call tools while the app handed it tools, which makes a model
 * fabricate. A stale model id is just an older model — still on the host's enum,
 * still tool-capable, still charged at its own rate. Nothing is wrong, so nothing
 * is rewritten, and a migration would be us overwriting a choice a viewer may have
 * made on purpose.
 *
 * The one stored value that MUST NOT stand is the NSFW arm held by a viewer who
 * may no longer be shown NSFW output, and that is not a migration either — it is
 * `clampModelToMaturity`, applied at send time on every render, because the
 * viewer's ceiling can change without their settings changing.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  model: SFW_MODEL_ID,
  temperature: 0.7,
  maxTokens: 2048,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};
