export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  /**
   * Whether a tool round can actually happen on this model.
   *
   * 🔴 THIS FIELD IS READ NOW, AND IT WAS NOT BEFORE. Until this change it was
   * `false` on every entry and NOTHING in `src/` branched on it — a DTO field
   * whose value could be corrected without changing one pixel, which is the
   * shape an audit flags as "reads as a guard, provides nothing". `App.tsx`'s
   * send now ANDs it into `toolsAvailable`, which is the single value that
   * decides both the `tools` key on the wire and whether the system prompt
   * carries `NO_TOOLS_NOTICE`. So a `false` here withholds the declarations AND
   * stops the prompt claiming a capability the request does not carry.
   *
   * 🔴 AND IT IS PER-MODEL, NOT PER-BRIDGE. The old blanket `false` was
   * justified as "a property of the BRIDGE, not of the models — the step exposes
   * no `tools` param". That stopped being true: the step accepts `tools` /
   * `toolChoice` and publishes `toolCalls` on a released verdict, which is the
   * whole tool loop this app runs. What remains true for exactly ONE entry is
   * narrower and lives at its own site below.
   */
  supportsTools: boolean;
  supportsStreaming: boolean;
  costPer1kInput: number;
  costPer1kOutput: number;
  maxContext: number;
}

/**
 * The models this block may reach.
 *
 * 🔴 THIS LIST IS THE HOST'S ALLOWLIST, NOT A PREFERENCE. `chat-completion`'s
 * `paramSchema` bounds `model` with a `z.enum` over `CHAT_COMPLETION_MODELS`, so
 * anything not below is rejected at parse. It previously carried
 * `deepseek/deepseek-r1`, `google/gemini-2.0-flash` and
 * `anthropic/claude-3.5-sonnet` — none of which are registered; picking one
 * would have produced a BAD_REQUEST on every send.
 *
 * Keep in lockstep with `CHAT_COMPLETION_MODELS` in `./orchestrator-bridge.ts`,
 * which the tests pin against this list.
 *
 * 🔴 APPEND, NEVER INSERT. The host's own `CHAT_COMPLETION_MODELS` is asserted
 * upstream as a whole ORDERED array, and this list's mirror is compared against
 * it. A new entry goes on the end; re-ordering the existing three is a
 * gratuitous way to turn a green suite red on the other side of the wire.
 *
 * 🔴 THE "FLAT 1 BUZZ" CLAIM THAT USED TO BE HERE WAS FALSE, AND THE COSTS
 * BELOW ARE NOT WHAT YOU PAY. The step is registered `prepaidFixed`, but the
 * platform reprices these models from the PROVIDER'S LIVE per-token rate against
 * the real conversation, floored at 1 Buzz — so the charge moves with the model,
 * the conversation length and `maxTokens`.
 *
 * Measured 2026-08-27 by `whatif` quote on one identical 4,680-char conversation
 * at `maxTokens: 2048` — free, no Buzz spent:
 *
 *   deepseek/deepseek-chat                        4 Buzz
 *   cognitivecomputations/dolphin-mistral-24b…    3 Buzz
 *   openai/gpt-4o-mini                            2 Buzz
 *
 * and it moves with `maxTokens` on the same model: 1 at 256, 4 at 2048, 6 at
 * 4096 (`MAX_OUTPUT_TOKENS`), 86 at 64000. So it depends on BOTH the model and
 * the token budget, and the platform's own declared `CHAT_COMPLETION_PRICE_BUZZ
 * = 1` is that floor, not the price (clawgate #386).
 *
 * `costPer1kInput`/`costPer1kOutput` below are indicative USD figures for
 * display and are not re-measured; do not compute a Buzz charge from them.
 */
export const AVAILABLE_MODELS: ModelConfig[] = [
  {
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek V3',
    provider: 'DeepSeek',
    supportsTools: true,
    supportsStreaming: false,
    costPer1kInput: 0.00014,
    costPer1kOutput: 0.00028,
    maxContext: 64000,
  },
  {
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o mini',
    provider: 'OpenAI',
    supportsTools: true,
    supportsStreaming: false,
    costPer1kInput: 0.00015,
    costPer1kOutput: 0.0006,
    maxContext: 128000,
  },
  {
    id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition',
    name: 'Dolphin Mistral 24B (uncensored)',
    provider: 'Cognitive Computations',
    /**
     * 🔴 THE ONE `false`, AND IT IS A PROPERTY OF THE ENDPOINT RATHER THAN OF
     * THE WEIGHTS. This model's own weights implement Mistral tool calling; its
     * only OpenRouter endpoint (Venice) does not EXPOSE tools. OpenRouter treats
     * `tools` as a SOFT preference, so declarations sent for this model are
     * silently dropped — no error, no refusal, and the viewer is CHARGED for the
     * round anyway. Sending them would therefore buy nothing and still cost
     * Buzz, and the system prompt would claim a lookup capability the request
     * does not carry: the exact "a model told it can search, then unable to,
     * fabricates results" defect `types.ts`'s prompt header is about, reached
     * through the model rather than through a failed declarations fetch.
     */
    supportsTools: false,
    supportsStreaming: false,
    costPer1kInput: 0.0002,
    costPer1kOutput: 0.0002,
    maxContext: 32000,
  },
  {
    /**
     * The SFW arm's model. Registered host-side by civitai#4803.
     *
     * ⚠️ ITS THREE NUMBERS BELOW ARE INDICATIVE AND UNMEASURED, unlike the Buzz
     * figures in this list's header — which were taken by `whatif` quote on one
     * identical conversation and do not cover this entry. What IS reported
     * upstream is roughly 1 Buzz on a short reply against `gpt-4o-mini`'s 2.
     * `costPer1k*` and `maxContext` are read by nothing in `src/` (only by
     * `models.test.ts`), so an indicative value here misleads a reader and
     * nothing else; do not compute a charge from them.
     *
     * ⚠️ AND NOTHING LOCAL PROVES IT EXECUTES. It has never been driven to
     * `succeeded` against the live step — disclosed as such in the upstream PR —
     * so a green suite here says only that the app will SEND this id.
     */
    id: 'deepseek/deepseek-v4-flash-0731',
    name: 'DeepSeek V4 Flash',
    provider: 'DeepSeek',
    supportsTools: true,
    supportsStreaming: false,
    costPer1kInput: 0.00007,
    costPer1kOutput: 0.00014,
    maxContext: 64000,
  },
];

/**
 * THE TWO ARMS THE NSFW TOGGLE SWITCHES BETWEEN.
 *
 * 🔴 NAMED CONSTANTS RATHER THAN TWO LITERALS AT THE TOGGLE, because three
 * places have to agree about them — the control, the model the app SENDS, and
 * the fail-closed clamp in `lib/maturity.ts` that overrides a stored NSFW
 * selection for a viewer no longer allowed one. A literal repeated at those
 * three sites is the "one rule, one place" failure with a spend attached.
 *
 * Both are asserted to be members of {@link AVAILABLE_MODELS} — and therefore of
 * the host's wire enum — by `models.test.ts`. A typo here is otherwise a
 * `BAD_REQUEST` on every send, which is what the enum exists to prevent.
 */
export const SFW_MODEL_ID = 'deepseek/deepseek-v4-flash-0731';
export const NSFW_MODEL_ID = 'cognitivecomputations/dolphin-mistral-24b-venice-edition';

export function getModelById(id: string): ModelConfig | undefined {
  return AVAILABLE_MODELS.find((m) => m.id === id);
}

/**
 * Whether a tool round can happen on this model. The ONE reader of
 * {@link ModelConfig.supportsTools} outside this module's own test.
 *
 * 🔴 FAILS CLOSED ON AN UNKNOWN ID, and the direction is deliberate: the system
 * prompt is a CLAIM ABOUT THE WIRE, so "I could not confirm this model can look
 * things up" must not become "tell it that it can". The branch is also
 * unreachable in practice — `buildChatCompletionBody` refuses an id outside the
 * host's enum before any quote or charge — so the choice costs nothing and is
 * made on the safe side rather than left to whichever reading came first.
 */
export function modelSupportsTools(id: string): boolean {
  return getModelById(id)?.supportsTools === true;
}

export function estimateCost(
  model: ModelConfig,
  promptTokens: number,
  completionTokens: number,
): number {
  return (
    (promptTokens / 1000) * model.costPer1kInput +
    (completionTokens / 1000) * model.costPer1kOutput
  );
}

export function formatCost(usd: number): string {
  if (usd < 0.001) return '<$0.001';
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
