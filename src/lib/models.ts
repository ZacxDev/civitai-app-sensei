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
   *
   * ─────────────────────────────────────────────────────────────────────────
   * 🔴 EXACTLY ONE OF THE FOUR VALUES BELOW IS MEASURED. THE OTHER THREE ARE
   * INFERRED, AND EACH CARRIES ITS OWN PREMISE AT ITS OWN SITE.
   * ─────────────────────────────────────────────────────────────────────────
   *
   * This is worth naming because the field READS as a measured capability
   * table and is not one, and because the two directions of error are not
   * symmetric now that something branches on it:
   *
   *   • A `true` that should be `false` is the FABRICATION defect, not a
   *     no-op. Declarations go on the wire for a model that cannot use them
   *     (OpenRouter treats `tools` as a SOFT preference and drops them
   *     silently, no error, no refusal) AND the system prompt tells the model
   *     it can look things up. The model then answers from its own knowledge
   *     while believing it searched, and the viewer is charged for the round.
   *     That is precisely the defect `types.ts`'s prompt header exists for,
   *     reached through the model instead of through a failed declarations
   *     fetch.
   *
   *   • A `false` that should be `true` costs the grounded arm on that model
   *     and nothing else: no tools sent, `NO_TOOLS_NOTICE` appended, the reply
   *     is honest about what it could not do.
   *
   * So the fail-closed direction is `false`, and any `true` here is a claim
   * that needs its premise stated. `modelSupportsTools` already fails closed on
   * an UNKNOWN id; it cannot fail closed on a WRONG value.
   *
   * ⚠️ None of the three inferred values is locally measurable. Proving one
   * needs a released `toolCalls` verdict from a real charged submit on that
   * model, in a real host — Turnstile + auth gated, so a green suite here is
   * only evidence about what the app SENDS.
   */
  supportsTools: boolean;
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 FIVE FIELDS AND TWO FUNCTIONS WERE REMOVED FROM HERE. DO NOT PUT THEM BACK
 * WITHOUT A CONSUMER.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `supportsStreaming`, `costPer1kInput`, `costPer1kOutput`, `maxContext`,
 * `estimateCost` and `formatCost` are gone. Every one of them had ZERO readers
 * outside `models.test.ts` — the exact shape an audit round had already flagged
 * for `supportsTools`, whose verdict was "branch on it or remove it". That
 * verdict was applied to `supportsTools` (`App.tsx` ANDs
 * `modelSupportsTools(activeModel)` into `toolsAvailable`); disclosing the
 * siblings in a PR body while leaving them in place is not the same thing.
 *
 * 🔴 AND THE COST FIELDS WERE ACTIVELY MISLEADING, WHICH IS WHY THEY GO RATHER
 * THAN GET A COMMENT. They were indicative, unmeasured USD figures sitting in a
 * type called `ModelConfig` next to a function called `estimateCost` — on a
 * block where every reply spends real Buzz. The list header already records
 * what a reply ACTUALLY costs (measured by `whatif` quote: 2-4 Buzz for one
 * identical conversation, moving with the model AND `maxTokens`), and the
 * platform reprices from the provider's live per-token rate floored at 1 Buzz.
 * A USD-per-1k table cannot produce that number, so the only thing it could do
 * was be believed. Four more instances of it were added by this PR's own new
 * entry, whose comment had to say "do not compute a charge from them" — a field
 * that needs that warning is a field to delete.
 *
 * `formatCost` was traced separately, because the D2 finding did not cover it:
 * it is a pure `number → '$0.00'` formatter with no callers at all, and its only
 * plausible caller was `estimateCost`'s output. It goes with it.
 *
 * If a real cost display is ever wanted, the input is the platform's own quote
 * (`whatif`) in Buzz, not a USD table maintained here by hand.
 */

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
 * Those Buzz figures are the ONLY cost numbers this module carries, and it
 * carries them as prose rather than as fields for the reason above the type.
 */
export const AVAILABLE_MODELS: ModelConfig[] = [
  {
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek V3',
    provider: 'DeepSeek',
    /**
     * INFERRED, not measured. Premise: the `chat-completion` step accepts
     * `tools`/`toolChoice` and publishes `toolCalls` on a released verdict, and
     * DeepSeek V3 advertises OpenAI-compatible function calling on its
     * OpenRouter endpoints. No released `toolCalls` verdict has been observed
     * from this block on this id.
     *
     * ⚠️ IT FLIPPED `false` → `true` HERE, and the flip is the risky direction.
     * A viewer whose persisted `settings.model` is still this id — reachable
     * from settings written by any older build — now gets declarations sent AND
     * a prompt claiming lookup capability, on the premise above rather than on
     * an observation. See the field's own doc for why that direction is the
     * fabricate-then-charge defect and not a no-op.
     */
    supportsTools: true,
  },
  {
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o mini',
    provider: 'OpenAI',
    /**
     * INFERRED, not measured — same premise and same flip as the entry above:
     * the step accepts `tools`/`toolChoice`, and function calling is a
     * first-party OpenAI feature this model documents. No released `toolCalls`
     * verdict has been observed from this block on this id either.
     */
    supportsTools: true,
  },
  {
    id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition',
    name: 'Dolphin Mistral 24B (uncensored)',
    provider: 'Cognitive Computations',
    /**
     * 🔴 THE ONE `false` — AND THE ONE MEASURED VALUE IN THIS LIST. It is a
     * property of the ENDPOINT rather than of the weights: the model's sole
     * OpenRouter endpoint (Venice) exposes no tools, read off the endpoint
     * listing rather than argued from the step's parameter schema, which is what
     * the other three values rest on.
     *
     * This model's own weights implement Mistral tool calling; its
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
  },
  {
    /**
     * The SFW arm's model. Registered host-side by civitai#4803.
     *
     * ⚠️ NO COST FIGURE IS RECORDED FOR THIS ENTRY, deliberately. The Buzz
     * figures in this list's header were taken by `whatif` quote on one
     * identical conversation and DO NOT cover this model; what is reported
     * upstream is roughly 1 Buzz on a short reply against `gpt-4o-mini`'s 2, and
     * that is hearsay, not a quote. The three indicative USD numbers that used to
     * sit here are gone with the fields — see the note above `AVAILABLE_MODELS`.
     *
     * ⚠️ AND NOTHING LOCAL PROVES IT EXECUTES. It has never been driven to
     * `succeeded` against the live step — disclosed as such in the upstream PR —
     * so a green suite here says only that the app will SEND this id.
     */
    id: 'deepseek/deepseek-v4-flash-0731',
    name: 'DeepSeek V4 Flash',
    provider: 'DeepSeek',
    /**
     * INFERRED, and the WEAKEST of the three — which matters because this is the
     * SFW arm, i.e. the default every viewer lands on. The premise is the same
     * step-accepts-`tools` argument as the two entries above, plus the DeepSeek
     * family's documented function calling. But per the `⚠️` note above this id
     * has never been driven to `succeeded` against the live step AT ALL, so
     * nothing has exercised ANY path on this model, tools included — there is no
     * observation to weaken, because there is no observation.
     */
    supportsTools: true,
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

