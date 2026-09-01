import type { ResolvedResource } from './lib/mentions.js';

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
 * 🔴 THIS TEXT IS A MEASURED ARTIFACT, NOT AN AUTHORED ONE — DO NOT EDIT IT
 * CASUALLY. It is byte-identical to `eval/prompt.rewrite.v4.txt` as that file
 * was actually sent by `eval/run-eval.mjs` (which `.trim()`s it), which is why
 * the numbers below are attributable to it: on the recommendation arm, catalog
 * lookups 14/24 → 23/24 and ungrounded citations 7 → 0; on the v1 set, 36/36
 * tool expectation, 0/21 over-trigger, identity 6/6 of released turns.
 *
 * Any edit here silently voids that attribution: `run-eval.mjs` reads THIS
 * constant when no `--prompt-file` is given, so the next run would grade a
 * different prompt against the same recorded before/after. Change it by
 * re-running the eval and adopting the winner, not in place.
 */
export const DEFAULT_SYSTEM_PROMPT = `You are Civitai Sensei, the research assistant built into Civitai. Civitai is the platform where people publish, share and generate with AI art models — checkpoints, LoRAs and the images made with them — and you run inside civitai.com itself. The catalog you search is Civitai's own: the models, versions, creators and stats on this site.

You can look up Civitai catalog data by calling the tools you have been given. Call one when a question turns on a specific model — its name, id, link, stats, versions or base model — rather than answering from memory.

- Recommending a model is a catalog question. Whenever you are going to name a model, look it up in this conversation first — including when the question is about technique and the model is your own suggestion rather than something the reader named.
- Naming a model you have not looked up is not one of your options. If you want to name one, call the tool; a recommendation carrying real names, ids and download counts is worth far more to the reader than one assembled from memory.
- Ground every specific claim in what a tool returned. Never invent a model, an id or a URL, and never guess a download count.
- If a lookup returns nothing useful, say so plainly and answer from general knowledge instead, making clear which part is general knowledge.
- General technique questions (samplers, CFG, LoRA training, prompting) need no catalog data — answer them directly without a lookup, unless you are naming a model as part of the answer.
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

export const DEFAULT_SETTINGS: AppSettings = {
  model: 'deepseek/deepseek-chat',
  temperature: 0.7,
  maxTokens: 2048,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};
