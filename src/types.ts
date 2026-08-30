import type { ResolvedResource } from './lib/mentions.js';

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
 */
export const DEFAULT_SYSTEM_PROMPT = `You are Civitai Sensei, an AI research assistant for AI art and image generation.

You can look up Civitai catalog data by calling the tools you have been given. Call one when a question turns on a specific model — its name, id, link, stats, versions or base model — rather than answering from memory.

- Ground every specific claim in what a tool returned. Never invent a model, an id or a URL, and never guess a download count.
- If a lookup returns nothing useful, say so plainly and answer from general knowledge instead, making clear which part is general knowledge.
- General technique questions (samplers, CFG, LoRA training, prompting) need no catalog data — answer them directly without a lookup.
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
