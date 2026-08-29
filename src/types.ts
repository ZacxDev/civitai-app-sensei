export interface Message {
  id: string;
  /**
   * 🔴 `'tool'` IS A TRANSCRIPT ROLE, NOT A STORED ONE. The tool loop builds
   * `role:'tool'` messages for the wire (see `App.tsx`'s loop and
   * `toStepMessages`), but they live only inside one send's `apiMessages` array
   * and are never persisted — what goes to storage is the user turn and the
   * final assistant reply. The member also lets sessions written by older builds
   * deserialize; `ChatArea` renders such a message as nothing.
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
