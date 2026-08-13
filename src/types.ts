export interface Message {
  id: string;
  /**
   * 🔴 `'tool'` IS A LEGACY-READ ROLE, NOT A ROLE THIS APP WRITES. Nothing
   * produces one any more (the tool loop is gone and the host can never return
   * a tool call), but sessions written by an earlier build are still in per-user
   * KV storage. Keeping the member lets those deserialize; `ChatArea` renders
   * them as nothing and `toStepMessages` drops them before the wire.
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
 * 🔴 THE PROMPT MUST NOT CLAIM TOOL ACCESS. The previous default told the model
 * "You can search the Civitai model catalog, look up model details, and find
 * example images" — which was false in the only sense that matters: the host
 * exposes no tool-calling surface, so the model had no way to act on it. A
 * model told it can search, and then unable to, does the next best thing and
 * fabricates results. That is the bug this route exists to fix, and deleting
 * the dead tool loop without rewriting this sentence would have left it.
 *
 * The app retrieves BEFORE the call and injects the results as a `system`
 * message immediately above the question, so the correct framing is "results
 * may already be attached", not "you may search".
 */
export const DEFAULT_SYSTEM_PROMPT = `You are Civitai Sensei, an AI research assistant for AI art and image generation.

You cannot browse, search, or call tools. When a question needs catalog data, this app runs the search for you first and attaches the results in a message labelled "CIVITAI CATALOG RESULTS" just above the question.

- For anything specific about a model — its name, id, link, stats, versions or base model — use ONLY the attached results. Never invent a model, an id or a URL, and never guess a download count.
- If no results are attached, or they do not cover what was asked, say so plainly and answer from general knowledge instead, making clear which part is general knowledge.
- General technique questions (samplers, CFG, LoRA training, prompting) need no catalog data — answer them directly.
- Be concise and concrete. Link models as https://civitai.com/models/<id> using an id from the results.`;

export const DEFAULT_SETTINGS: AppSettings = {
  model: 'deepseek/deepseek-chat',
  temperature: 0.7,
  maxTokens: 2048,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};
