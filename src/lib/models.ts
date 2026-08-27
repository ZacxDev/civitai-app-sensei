export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
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
 * 🔴 `supportsTools` IS `false` FOR EVERY ENTRY, and that is a property of the
 * BRIDGE, not of the models. The step exposes no `tools` param and its
 * `extractText` does not read `tool_calls`, so no model reachable from a block
 * can make a tool call regardless of what it supports natively.
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
    supportsTools: false,
    supportsStreaming: false,
    costPer1kInput: 0.00014,
    costPer1kOutput: 0.00028,
    maxContext: 64000,
  },
  {
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o mini',
    provider: 'OpenAI',
    supportsTools: false,
    supportsStreaming: false,
    costPer1kInput: 0.00015,
    costPer1kOutput: 0.0006,
    maxContext: 128000,
  },
  {
    id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition',
    name: 'Dolphin Mistral 24B (uncensored)',
    provider: 'Cognitive Computations',
    supportsTools: false,
    supportsStreaming: false,
    costPer1kInput: 0.0002,
    costPer1kOutput: 0.0002,
    maxContext: 32000,
  },
];

export function getModelById(id: string): ModelConfig | undefined {
  return AVAILABLE_MODELS.find((m) => m.id === id);
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
