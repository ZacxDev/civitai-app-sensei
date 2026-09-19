import type { ChatCompletionRequest, ChatCompletionResult } from './completion-types.js';
import type { ToolCall } from './tools.js';
import type { OrchestratorAdapter } from './orchestrator.js';
import { simulateStreaming } from './streaming.js';
import type {
  WorkflowBody,
  WorkflowBodyPassThroughStep,
  BlockWorkflowSnapshot,
} from '@civitai/app-sdk/blocks';
import type { WorkflowStepInputFor } from '@civitai/app-sdk/orchestrator/steps';
// 🔴 VALUE IMPORTS, AND `instanceof` IS THE DOCUMENTED BRANCH. Both classes are
// re-exported from the package root (`dist/index.js`), and neither pulls in a DOM
// — the module they live in imports only `useCallback`/`useState`, so this file
// stays importable from the `node` vitest project.
//
// 🔴 RETRACTED, DO NOT RE-DERIVE: THIS COMMENT USED TO WARN THAT A SECOND COPY OF
// `@civitai/blocks-react` WOULD GIVE TWO CLASS IDENTITIES AND SILENTLY FALSIFY
// EVERY `instanceof` BELOW. The hazard is real for a package that CAN be installed
// twice; `blocks-react` cannot be. Measured: no `@civitai` package declares a
// dependency on `@civitai/blocks-react` at all — `app-sdk` declares no dependencies,
// `blocks-react` and `components-react` each depend on `{theme, components}`,
// `components` on `{theme}`, `theme` on nothing — so `blocks-react` reaches the tree
// only as this app's DIRECT dependency and no transitive path can duplicate it.
// `app-sdk`'s only in-tree declarer is `blocks-react`, as a PEER, which resolves to
// the app's own copy. It is `theme` and `components` that duplicate on a partial
// bump, and neither exports a class this file branches on. Confirmed behaviourally:
// with the tree deliberately skewed (blocks-react 0.49.0 against components-react
// 0.3.1 / theme 0.2.1) all 71 tests in `orchestrator-bridge.test.ts` pass, these
// `instanceof` branches included.
//
// The skew is still worth refusing, for a different and smaller reason, and
// `src/civitai-dependency-lockstep.test.ts` is the guard that refuses it — see its
// header, and the `sdk-pair-bump` entry in `taste.json`.
import { WorkflowEstimateError, WorkflowSubmitError } from '@civitai/blocks-react';

export type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionResult,
} from './completion-types.js';

/** The subset of useBuzzWorkflow's return we need. */
export interface WorkflowHelpers {
  estimate: (body: WorkflowBody) => Promise<BlockWorkflowSnapshot>;
  submit: (body: WorkflowBody) => Promise<BlockWorkflowSnapshot>;
  poll: (workflowId: string) => Promise<BlockWorkflowSnapshot>;
  cancel: (workflowId: string) => Promise<BlockWorkflowSnapshot>;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE HOST CONTRACT. Every constant below is MIRRORED from civitai/civitai at
// `src/server/services/blocks/steps/chat-completion.step.ts`, which is the
// authority — its `paramSchema` is `.strict()`, so a field this file invents is
// a BAD_REQUEST at parse rather than a field the host ignores.
//
// 🔴 THE STEP ID IS `'chat-completion'`, NOT `'chatCompletion'`. The kebab id is
// the registry KEY (`REGISTERED_STEP_IDS`, which the wire `z.enum` is derived
// from); `'chatCompletion'` is the entry's `orchestratorType`, an internal
// detail that never appears on the wire. Sending the camelCase one is rejected
// fail-closed at the schema, before any handler runs.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The registered step id. Wire value, not the orchestrator `$type`.
 *
 * 🔴 NO LONGER SENT. Kept exported because `mentions.ts` and two test files
 * still name it, and because the registry arm is the documented rollback: put
 * this back as `step` and drop `$type`/`maxBuzz` and the old body returns.
 */
export const CHAT_COMPLETION_STEP_ID = 'chat-completion';

/**
 * The ORCHESTRATOR `$type` this app now submits, replacing the registry id
 * above. Not a Civitai step-registry id and not resolved against any allowlist
 * — see `buildChatCompletionBody` for what that costs.
 */
export const CHAT_COMPLETION_STEP_TYPE = 'chatCompletion';

/**
 * The per-job Buzz ceiling this app declares on the pass-through arm.
 *
 * 🔴 IT IS ALSO THE STEP TIMEOUT, IN SECONDS. The host stamps
 * `stepTimeoutSeconds = maxBuzz` — one number, not two — so this is not a
 * "price" to be minimised: `maxBuzz: 10` does not buy a cheap completion, it
 * buys one KILLED after 10 seconds that comes back `expired`. Billing is
 * post-paid against measured GPU seconds with the unused remainder refunded,
 * so a generous ceiling costs nothing extra on a job that finishes early.
 *
 * **120 chosen to match the SDK's existing 120 s workflow bound**, so the step
 * timeout is not a new and different deadline from the one the transport
 * already imposes. Operator decision, 2026-09-19; bound is 1…250
 * (`PASS_THROUGH_MAX_BUZZ`). The host also requires `maxBuzz <= token.buzzBudget`.
 *
 * ⚠️ `estimate` echoes this back as `cost.total`. That is an UPPER BOUND, not a
 * price — surface it as "up to 120 Buzz", never as the cost.
 */
export const CHAT_COMPLETION_MAX_BUZZ = 120;

/**
 * The host's model allowlist (`CHAT_COMPLETION_MODELS`).
 *
 * 🔴 A NON-MEMBER IS REJECTED AT PARSE by the entry's `z.enum` — it does not
 * fall back to a default and it does not reach the orchestrator. There is also
 * NO orchestrator-side model validation behind it: the host's own header records
 * that a fabricated model name is quoted the declared floor, CHARGED it, and
 * then fails at execution with no output and no refund. The enum is what stops an app typo
 * from burning a viewer's Buzz.
 *
 * 🔴 APPENDED, NEVER INSERTED. The host asserts its own `CHAT_COMPLETION_MODELS`
 * as a whole ORDERED array, so this mirror follows the same discipline: a new
 * registration goes on the END. Re-ordering the first three would turn the other
 * side of the wire red for no reason. `deepseek/deepseek-v4-flash-0731` is the
 * fourth, registered by civitai#4803.
 */
export const CHAT_COMPLETION_MODELS = [
  'deepseek/deepseek-chat',
  'cognitivecomputations/dolphin-mistral-24b-venice-edition',
  'openai/gpt-4o-mini',
  'deepseek/deepseek-v4-flash-0731',
] as const;

export type ChatCompletionModel = (typeof CHAT_COMPLETION_MODELS)[number];

/**
 * `maxTokens` ceiling. Derived host-side from the 50,000-char output scan cap:
 * above the cap the reply is WITHHELD rather than truncated, so a larger ceiling
 * designs a guaranteed withhold into the capability.
 */
export const MAX_OUTPUT_TOKENS = 4_000;
/** Conversation bounds — `messages` is `.min(1).max(32)`, content `.min(1).max(8000)`. */
export const MAX_MESSAGES = 32;
export const MAX_MESSAGE_CHARS = 8_000;
/** `temperature` bounds, from `ChatCompletionInput.temperature`'s documented range. */
export const TEMPERATURE_MIN = 0;
export const TEMPERATURE_MAX = 2;

/**
 * 🔴 `'tool'` IS NOW A FIRST-CLASS ROLE, not a dropped one. The host's
 * `chatMessageSchema` became a discriminated union over the role, so a tool
 * result is representable and a tool round can be fed back. Before this it was
 * DROPPED here — silently, which meant a tool result simply never reached the
 * model and the loop could not close.
 */
const ALLOWED_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * How long the poll loop waits between ticks.
 *
 * 🔴 EXPORTED SO A TEST CAN DERIVE ITS WAIT FROM IT RATHER THAN MIRROR IT.
 * `stop-stream.e2e.test.tsx` needs a bound long enough for a second write to
 * land; a hand-copied number there fails OPEN — raise this interval and the
 * test's window silently becomes too short, so it stops observing the overwrite
 * it exists to forbid and goes green for the wrong reason. Same shape as the
 * round cap that mirrored the host's quantity without being tied to it.
 */
export const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 60_000;

/**
 * The poll snapshot, widened with the two fields the host attaches for a
 * `'textOutput'` posture step.
 *
 * 🔴 STILL NOT IN `@civitai/app-sdk` — re-verified against the installed 0.39.0
 * dist, whose `BlockWorkflowSnapshot` (`dist/blocks/types.d.ts`) mentions none of
 * the three. It said "0.31.0" before the pair bump; the version moved and the
 * gap did not. The host DOES send them (`blocks.router`'s poll
 * wraps every snapshot in `attachModeratedStepTextOutputs`) and the SDK
 * transport resolves the raw postMessage payload verbatim with no validation or
 * key-stripping, so they arrive at runtime; only the TYPE is missing. Widening
 * locally is therefore correct rather than a workaround — delete this when the
 * SDK type catches up.
 */
type TextOutputSnapshot = BlockWorkflowSnapshot & {
  textOutputs?: string[];
  textOutputWithheld?: { reason: string };
  /**
   * Structured tool calls, published by the host ONLY on a released verdict —
   * the same gate as `textOutputs`, and every `arguments` string is scanned as
   * text before publication. Widened locally for the same reason as the two
   * above: the field arrives at runtime and only the TYPE is missing.
   */
  toolCalls?: ToolCall[];
};

/**
 * Thrown when the host scanned the generated text and refused to release it.
 *
 * Distinct from a transport/workflow error on purpose: this is a NORMAL,
 * expected outcome of a moderated capability, the Buzz was spent, and the UI
 * should render the host's reason rather than an error banner. `reason` is the
 * host's user-facing string — deliberately generic, and it never names the
 * labels that triggered.
 */
export class TextOutputWithheldError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'TextOutputWithheldError';
    this.reason = reason;
  }
}

/** True when `model` is on the host allowlist. */
export function isAllowedModel(model: string): model is ChatCompletionModel {
  return (CHAT_COMPLETION_MODELS as readonly string[]).includes(model);
}

function clampMaxTokens(requested: number | undefined): number {
  const n = Math.floor(requested ?? 1024);
  if (!Number.isFinite(n)) return 1024;
  return Math.min(Math.max(n, 1), MAX_OUTPUT_TOKENS);
}

function clampTemperature(t: number | undefined): number | undefined {
  if (t === undefined) return undefined;
  if (!Number.isFinite(t)) return undefined;
  return Math.min(Math.max(t, TEMPERATURE_MIN), TEMPERATURE_MAX);
}

/**
 * Coerce the app's conversation into the host's `chatMessageSchema` array.
 *
 * Three bounds, each of which is a hard reject server-side rather than a
 * truncation:
 *  - role must be system/user/assistant/tool. A `'tool'` message IS sent — the
 *    host's schema is a discriminated union over the role and accepts it with a
 *    `tool_call_id`. (It used to be dropped here, which is why a tool result
 *    never reached the model and the loop could not close.)
 *  - content is 1..8000 chars. Empty/whitespace-only messages are dropped;
 *    over-long ones are truncated.
 *  - at most 32 messages. The FIRST system message is preserved and the most
 *    recent turns are kept — trimming from the front would silently discard the
 *    app's system prompt, which is the one message that must always survive.
 */
export type StepMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /**
   * OPTIONAL, and only for the one shape that legitimately has none: an
   * assistant turn whose entire content IS its `tool_calls`. The host requires
   * at least one of the two and rejects a present-but-empty string (`.min(1)`),
   * so such a message omits the key rather than sending `''`.
   */
  content?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

export function toStepMessages(messages: ChatCompletionRequest['messages']): StepMessage[] {
  const usable = messages
    .filter((m) => ALLOWED_ROLES.has(m.role))
    // 🔴 A `'tool'` MESSAGE WITHOUT ITS `tool_call_id` IS DROPPED, not sent.
    // The host correlates every tool answer against an id some PRECEDING
    // assistant turn declared, and an uncorrelated one is a BAD_REQUEST for the
    // whole payload — which would lose the entire conversation, not just the
    // orphan. A stored session from before tool calling can contain exactly
    // this shape.
    //
    // 🔴 BE EXACT ABOUT WHAT THIS CHECKS: PRESENCE, NOT CORRELATION. It requires
    // a non-empty `tool_call_id` string; it does NOT verify that any preceding
    // assistant turn declared that id. A `[system, user, tool(id=stale)]` array
    // passes here and is rejected by the host. That is not reachable through
    // `App` today — the send path drops the id when mapping stored messages —
    // but the guard is narrower than the sentence above, and the sentence is
    // what a reader would act on.
    .filter((m) => m.role !== 'tool' || (typeof m.tool_call_id === 'string' && m.tool_call_id.length > 0))
    .map((m) => ({
      role: m.role as StepMessage['role'],
      content: (m.content ?? '').slice(0, MAX_MESSAGE_CHARS),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      // Replayed so the host can correlate the answer that follows it. Only an
      // assistant turn carries these.
      ...(m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0
        ? { tool_calls: m.tool_calls }
        : {}),
    }))
    // 🔴 AN ASSISTANT TURN WHOSE CONTENT IS ITS TOOL CALLS MUST SURVIVE THIS.
    // When the model asks for a tool it returns `content: null`, so the
    // empty-content drop below would delete the very message that DECLARES the
    // call ids — and the host then rejects the tool answers that follow it as
    // uncorrelated, failing the whole payload rather than the orphan. That is
    // the loop silently never closing.
    .filter((m) => (m.content ?? '').trim().length > 0 || (m.tool_calls?.length ?? 0) > 0)
    // Now drop the key ENTIRELY where it is empty, because the host's `content`
    // is `.min(1)` when present. 🔴 `{ ...m, content: undefined }` would NOT do
    // this: the SDK transport is postMessage, which uses structured clone, and
    // structured clone PRESERVES an explicit `undefined` value rather than
    // dropping the key the way `JSON.stringify` would. The key has to be
    // omitted at construction.
    .map((m) => {
      if ((m.content ?? '').trim().length > 0) return m;
      const { content: _dropped, ...rest } = m;
      return rest;
    });

  if (usable.length <= MAX_MESSAGES) return usable;

  const firstSystemIdx = usable.findIndex((m) => m.role === 'system');
  if (firstSystemIdx === -1) return usable.slice(-MAX_MESSAGES);

  const system = usable[firstSystemIdx];
  const rest = usable.filter((_, i) => i !== firstSystemIdx);
  return [system, ...rest.slice(-(MAX_MESSAGES - 1))];
}

/** Build the `kind: 'step'` body. Exported so a test can pin the exact key set. */
export function buildChatCompletionBody(request: ChatCompletionRequest): WorkflowBodyPassThroughStep {
  if (!isAllowedModel(request.model)) {
    throw new Error(
      `Model "${request.model}" is not available. Choose one of: ${CHAT_COMPLETION_MODELS.join(', ')}`,
    );
  }

  const messages = toStepMessages(request.messages);
  if (messages.length === 0) {
    throw new Error('Cannot submit an empty conversation');
  }

  const temperature = clampTemperature(request.temperature);

  // 🔴 ONLY KEYS THE HOST'S `.strict()` SCHEMA ACCEPTS. `response_format`,
  // `stream`, `max_tokens` (the snake_case spelling), `n`, `seed` and
  // `modalities` are each a BAD_REQUEST for the WHOLE request rather than a
  // field that gets dropped — adding one breaks every call, not just the
  // feature that wanted it.
  //
  // ⚠️ `tools`/`tool_choice` WERE ON THAT FORBIDDEN LIST AND ARE NOT ANY MORE.
  // The host widened its schema to accept them; this comment used to say they
  // were rejected, which was true when written.
  //
  // 🔴 THE KEY IS `toolChoice`, camelCase — AND THE PREVIOUS COMMENT HERE WAS
  // WRONG ABOUT BOTH THE SPELLING AND THE CONSEQUENCE. It said the wire spelling
  // is `tool_choice`, "taken from the orchestrator's own
  // `[JsonPropertyName("tool_choice")]`", and that getting it backwards "does not
  // error … the feature would be silently inert".
  //
  // 🔴 THIS APP DOES NOT TALK TO THE ORCHESTRATOR. It talks to the civitai HOST,
  // one layer above, and the HOST owns that camel→snake mapping: its params
  // schema takes `toolChoice` and its `buildStep` emits `tool_choice` to the
  // orchestrator (`chat-completion.step.ts`). Reading the orchestrator's wire
  // name and sending it to the host skips a layer.
  //
  // 🔴 AND IT IS A HARD ERROR, NOT INERTNESS. The host's params schema is
  // `.strict()`, so an unknown key is a BAD_REQUEST for the WHOLE request:
  //   invalid params for step 'chat-completion':
  //     [{ "code": "unrecognized_keys", "keys": ["tool_choice"] }]
  // Shipped in 0.1.6 and it broke EVERY send, not just tool-calling ones —
  // `tools`+`toolChoice` are attached whenever declarations are available, which
  // is always once the route is live. The estimate 400s, and at the time the app
  // reported that as a PRICE failure, which is why it read as a billing fault.
  //
  // 🔴 HISTORICAL — THAT STRING IS NO LONGER THROWN (it survives only in comments
  // like this one, so a grep still finds it; nothing emits it). The message
  // was "Workflow estimate returned zero or missing cost" and the guard it tripped
  // was the price check; both were changed by the estimate-attribution split in
  // `createBridgeAdapter` below, so an unpriced estimate now reports itself as one.
  // The CAUSAL half above — that a 400 is what lands there — is NOT verified: the
  // SDK's `estimate` rethrows a transport rejection (`useBuzzWorkflow.js`), so a
  // 400 surfacing as a resolved-but-unpriced snapshot depends on the host replying
  // with an ESTIMATE_RESULT rather than an error. Left as the 0.1.6 narrative.
  //
  // ⚠️ AND THE RESOLVED-BUT-UNPRICED SHAPE NO LONGER ARRIVES FROM THE HOOK AT ALL.
  // `blocks-react` ≥ 0.43.0 rejects it with `WorkflowEstimateError` instead, so on
  // the real path the 0.1.6 narrative would land on `createBridgeAdapter`'s
  // `'no-cost'` rejection arm rather than on its resolved gate. Both still spell the
  // same sentence, so the two routes remain indistinguishable on screen; only the
  // route differs. (What that sentence SAYS changed this round — see
  // `NO_SERVER_REASON`.)
  //
  // The exact accepted key set is pinned in `orchestrator-bridge.test.ts`, so a
  // future rename fails here rather than in production.
  // 🔴 THE ARM CHANGED, AND WITH IT EVERY SPELLING RULE ABOVE. Everything from
  // "ONLY KEYS THE HOST'S `.strict()` SCHEMA ACCEPTS" down describes the
  // REGISTRY arm, where the host owned a camel→snake mapping and rejected
  // unknown keys. On THIS arm the host does not read, rewrite, merge or default
  // any field in `input` — it is forwarded BYTE-IDENTICALLY to the orchestrator
  // — so the orchestrator's `ChatCompletionInput` is the only authority and
  // there is no host-side reject to discover a bad key with.
  //
  // 🔴 CONSEQUENCE, AND IT INVERTS THIS FILE'S OLDEST SCAR: the wire key is
  // `tool_choice`, snake_case — the EXACT spelling whose 0.1.6 appearance broke
  // every send. It was wrong then because it was sent to the HOST; it is right
  // now because it is sent THROUGH the host to the orchestrator. Do not "fix"
  // it back to `toolChoice` on the strength of the comment above.
  //
  // ⚠️ The orchestrator's own input is MIXED-CASE and that is not a typo:
  // `maxTokens`, `topP`, `presencePenalty`, `responseFormat` are camel while
  // `tool_choice` and `image_config` are snake. Read the spec per field.
  const typedInput: WorkflowStepInputFor<'chatCompletion'> = {
    model: request.model,
    messages,
    maxTokens: clampMaxTokens(request.max_tokens),
    ...(temperature !== undefined ? { temperature } : {}),
  };

  // 🔴 `tools` AND `tool_choice` ARE CARRIED OUTSIDE THE GENERATED TYPE, AND
  // THAT IS A DEFECT IN `@civitai/client@0.2.0-beta.98`, NOT A SHORTCUT.
  // Wherever the orchestrator's OpenAPI spec declares a field with no schema
  // type, codegen renders it `null`, so the generated type admits ONLY `null`:
  //
  //   - `tool_choice?: null`                 → `'auto'` is inexpressible
  //   - `ChatCompletionFunction.parameters?: null | undefined`
  //                                          → a real JSON-schema object is
  //                                            inexpressible, which takes the
  //                                            whole `tools` array with it
  //
  // The block body's `input` is `Record<string, unknown>`, so the honest move
  // is to type-check everything the generated type CAN express and add these
  // explicitly — rather than cast the whole object and lose the checking on
  // all of it, which is the version that looks typed and is not.
  //
  // 🔴 AND THE THIRD ONE, WHICH IS WHY THIS ARM BUYS MUCH LESS TYPE SAFETY THAN
  // ITS NAME SUGGESTS: `ChatCompletionMessage` is a DISCRIMINATED UNION on
  // `role` in the spec (user/system/assistant/tool, carrying `content`,
  // `tool_calls`, `refusal`, …), but codegen flattened it to the bare base
  // `{ role: string }`. `messages` therefore satisfies `typedInput` while the
  // type cannot see `content` AT ALL — a message with a misspelled or missing
  // `content` type-checks clean. So of the four fields this app sends, THREE
  // are unchecked and one (`model`, `maxTokens`, `temperature`) is real.
  //
  // Sibling of `civitai-client-javascript#5`. 🔴 WHEN THE CLIENT IS
  // REGENERATED, re-check whether this block collapses into `typedInput` — and
  // if it does, that is the point at which this migration starts paying for
  // itself. Until then see the PR body: the costs land, the benefit does not.
  const input: Record<string, unknown> = {
    ...typedInput,
    ...(request.tools && request.tools.length > 0
      ? {
          tools: request.tools,
          ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
        }
      : {}),
  };

  return {
    kind: 'step',
    // 🔴 `step` IS OMITTED, NOT SET TO undefined. Its ABSENCE is the arm
    // discriminator, and the SDK transport is postMessage/structured clone,
    // which PRESERVES an explicit `undefined` rather than dropping the key the
    // way `JSON.stringify` would — so `step: undefined` would ship a `step` key
    // and land on the registry arm. Same trap `toStepMessages` documents for
    // `content`.
    $type: CHAT_COMPLETION_STEP_TYPE,
    input,
    maxBuzz: CHAT_COMPLETION_MAX_BUZZ,
  };
}

/**
 * Read the released text off a poll snapshot.
 *
 * 🔴 `textOutputs` IS THE ONLY CHANNEL. A `'textOutput'` posture entry may not
 * declare an `extractOutput`, so the generated reply reaches no other snapshot
 * field — not `imageUrls`, not `steps[].output`. An earlier revision of this
 * adapter read `steps[0].output.text` / `snap.content` / `snap.text`; none of
 * those are ever populated for this step, so it would have thrown "empty
 * response" on every successful generation.
 *
 * Multiple entries are joined because a workflow may carry more than one text
 * step and the host releases them per-step.
 */
export function extractReleasedText(snap: TextOutputSnapshot): string {
  const texts = snap.textOutputs;
  if (!Array.isArray(texts) || texts.length === 0) return '';

  // 🔴 `textOutputs` IS NOT "THE REPLY" — IT ALSO CARRIES EVERY TOOL CALL'S RAW
  // `arguments` JSON, AND RENDERING THAT VERBATIM WAS A USER-VISIBLE DEFECT.
  //
  // The host puts them there ON PURPOSE: `extractText` pushes
  // `call.function.arguments` alongside `message.content` so the arguments go
  // through the SAME content scan before anything is published
  // (`chat-completion.step.ts`). That is a moderation guarantee, not a hint
  // about what to display — and this function treated the union as prose, so a
  // viewer who asked a catalog question saw `{"query":"popular","limit":5}`
  // printed in the chat above the answer.
  //
  // 🔴 FILTERING BY THE RETURNED CALLS IS COMPLETE BY CONSTRUCTION, which is
  // why this is exact rather than a heuristic. The host documents that
  // `extractText` publishes "exactly the `arguments` of the calls
  // [`extractToolCalls`] returns" — both go through one shared predicate, so no
  // argument string can be in `textOutputs` without its call being in
  // `toolCalls`. A blanket "looks like JSON" filter would instead eat a
  // legitimate reply that happened to quote JSON.
  const argumentStrings = new Set(extractToolCalls(snap).map((c) => c.function.arguments));

  return texts
    .filter((t) => typeof t === 'string' && t.trim().length > 0)
    .filter((t) => !argumentStrings.has(t))
    .join('\n\n');
}

/**
 * Read the structured tool calls off a poll snapshot.
 *
 * 🔴 THE HOST PUBLISHES THESE ONLY ON A RELEASED VERDICT — the same gate as
 * `textOutputs` — and every `arguments` string is ALSO returned by the step's
 * text extractor, so it passes the content scan before it is published. That is
 * what makes reading them here safe; it is not a property of this function.
 *
 * Shape-checked rather than trusted: this value crosses the postMessage boundary
 * with no validation, and a malformed entry handed to `JSON.parse` downstream
 * would surface as an unrelated crash.
 */
export function extractToolCalls(snap: TextOutputSnapshot): ToolCall[] {
  const raw = snap.toolCalls;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is ToolCall =>
      typeof c?.id === 'string' &&
      c.id.length > 0 &&
      // `ToolCall` DECLARES `type: 'function'`; without checking it the
      // predicate narrows to a type the value does not satisfy, and a call of
      // some future kind would be replayed verbatim as if it were a function
      // call. A type declaration is not a runtime check.
      c?.type === 'function' &&
      typeof c?.function?.name === 'string' &&
      typeof c?.function?.arguments === 'string',
  );
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The viewer-facing reason a snapshot did not succeed.
 *
 * 🔴 ONE DERIVATION FOR BOTH REFUSAL POINTS, and that is the point rather than
 * tidiness. A turn can be refused at SUBMIT (a budget / spend-cap rejection,
 * which resolves) or after a POLL (an orchestrator failure). Both had to answer
 * the same question — "do the server's own words survive?" — and only the second
 * one did, so a viewer whose per-app Buzz limit refused the turn was shown a
 * message about something else entirely. Deriving both here means the two
 * cannot drift apart again.
 *
 * `error` is server-authored prose and is used VERBATIM when it says anything:
 * on the refusal path it is the consent-budget rejection, which names the amount
 * already spent and the viewer's own limit. It is deliberately number-bearing —
 * the server's comment on it says hiding the number "would make the rejection
 * unactionable" — so summarising or replacing it defeats its purpose.
 *
 * A blank or non-string `error` falls back to the status, because `new
 * Error('')` renders as a bare `Error:` and names nothing at all.
 *
 * 🔴 THE `fallback` PARAMETER IS WHAT KEPT THE TWO REJECTION PATHS ON THIS ONE
 * DERIVATION. `blocks-react@0.43.0` added two more refusal points (`estimate` and
 * `submit` now REJECT rather than resolving an unusable reply), and each wants a
 * different sentence when the server said nothing at all — `Workflow failed` reads
 * as a non-answer inside "…returned no cost — Workflow failed". Passing the
 * fallback in beats copying the `error`-extraction rule into four call sites, which
 * is the drift this function was created to end. Omitted → the status, unchanged.
 */
function snapshotFailureMessage(
  snap: { status?: string; error?: unknown },
  fallback?: string,
): string {
  if (typeof snap.error === 'string' && snap.error.trim() !== '') return snap.error.trim();
  return fallback ?? `Workflow ${snap.status ?? 'failed'}`;
}

/**
 * The only `BlockWorkflowSnapshot.status` values a workflow can still MOVE OFF.
 *
 * Spelled as the IN-FLIGHT set rather than as the terminal one, and that choice is
 * the whole reason `isTerminalWithoutSuccess` below is fail-closed. `status` is a
 * closed union in the `.d.ts` (`pending | processing | succeeded | failed | expired
 * | canceled`) but it is a HOST-MAINTAINED MAPPING at runtime: the type's own docs
 * say "if the orchestrator gains a status the host doesn't recognize, the host is
 * responsible for mapping it to one of the values here". A set of the states that
 * are NOT yet decided therefore treats a value nobody here has heard of as decided
 * — which on the estimate path means "not a quote you may spend against" — whereas
 * enumerating the terminal states would wave it through.
 */
const IN_FLIGHT_STATUSES = new Set<string>(['pending', 'processing']);

/**
 * The workflow has STOPPED, and not on success.
 *
 * 🔴 ONE PREDICATE FOR TWO CALL SITES THAT HAD DRIFTED APART, which is the same
 * argument `snapshotFailureMessage` is built on. Until this round the estimate gate
 * tested `status === 'failed'` while the poll loop open-coded `succeeded || failed
 * || expired || canceled` fifty lines below, so the file held two spellings of one
 * idea and they disagreed — and the disagreement was on the money path. Measured at
 * `7de41a8` by injecting a `WorkflowHelpers` whose `estimate` resolves
 * `{workflowId:'failed', status:<s>, error:…, cost:{total:500}}`: `s='failed'`
 * refused with 0 submits, while `'canceled'`, `'expired'` and an unrecognised
 * status each SUBMITTED — the turn completed and the viewer's Buzz was spent
 * against a price the server had stopped standing behind.
 *
 * 🔴 IT WAS REACHABLE THROUGH THE INSTALLED HOOK, not only through an injected
 * fake. `useBuzzWorkflow.estimate`'s guard is `status === 'failed'` OR "no numeric
 * `cost.total`", so `{status:'canceled', cost:{total:500}}` satisfies neither
 * clause and RESOLVES out of the hook straight into this adapter. Upstream's
 * comment says `canceled`/`expired` "are covered by the same clause (they carry no
 * cost)" — but that is an assertion about what the server sends, not an invariant
 * anything enforces, and it says nothing at all about a status upstream adds later.
 *
 * 🔴 `undefined` IS ADMITTED, DELIBERATELY AND UNCHANGED. A priced whatIf reply is
 * routinely `{cost:{total:n}}` with no `status` field at all — that is the happy
 * path every test in this repo and the mock host both produce — so a snapshot that
 * says nothing about its status is not evidence it stopped. Both call sites treated
 * it that way before this consolidation and both still do; the poll loop stays
 * fail-closed on it anyway, because a status-less snapshot never satisfies its
 * `=== 'succeeded'` exit.
 *
 * 🔴 NOT FOR THE SUBMIT REPLY. `submitSnap.status === 'failed'` below is
 * deliberately narrower and must stay that way — see the comment there.
 */
function isTerminalWithoutSuccess(status: string | undefined): boolean {
  return status !== undefined && status !== 'succeeded' && !IN_FLIGHT_STATUSES.has(status);
}

/**
 * What to say when the snapshot carries no server words at all.
 *
 * Deliberately says the SERVER gave no reason rather than inventing one, and
 * deliberately says nothing about money — see `submitRejectionMessage`.
 *
 * 🔴 THIS IS NOW THE FALLBACK ON THE UNPRICED ROUTES TOO, AND THAT REPLACED A
 * SENTENCE THAT WAS FALSE ON THE CASE IT FIRED MOST OFTEN. Until this round the
 * unpriced gate below and the `'no-cost'` rejection arm shared a separate constant,
 * `UNPRICED_REASON = 'the request was rejected before it could be priced'`. Per
 * `WorkflowEstimateError.code`'s docs `'no-cost'` is *a NON-FAILED reply with no
 * numeric `cost.total`* — the usual producer is `{status:'pending'}` with no `error`
 * at all — so **nothing was rejected**, and because that arm usually carries no
 * `snapshot.error` the inaccurate sentence was the one the viewer actually got.
 * Meanwhile `'failed'`, the code that genuinely IS a refusal, got this one.
 *
 * 🔴 THE ROUTING WAS RIGHT AND IS UNCHANGED — ONLY THE SENTENCE MOVED. `'no-cost'`
 * still gets the "returned no cost" prefix and `'failed'` still gets "failed": that
 * prefix IS the estimate-attribution split, and it is what distinguishes the two.
 * What the shared tail was for — the resolved gate and the `'no-cost'` arm reading
 * IDENTICALLY, so two routes to one state cannot drift into two messages — is
 * preserved by them sharing THIS constant instead. The claim about a rejection is
 * simply gone, because on those routes there was not one.
 */
const NO_SERVER_REASON = 'the server gave no reason';

/**
 * Viewer-facing text for an `estimate` REJECTION (`blocks-react` ≥ 0.43.0).
 *
 * 🔴 THE REASON COMES OFF `err.snapshot`, NEVER OFF `err.message`. `err.message` is
 * a developer-facing CONSTANT with only `code` interpolated —
 * `estimate did not return a usable price (no-cost) — reason on .snapshot.error` —
 * and upstream records two apps piping exactly that into rendered UI on their
 * 0.43.0 migration (civitai/civitai-app-starters#253). Its wording is explicitly
 * not a contract, so a UI built on it rots silently. `err.code` is the only stable
 * branch target, and `err.snapshot.error` is where the server's own words live.
 *
 * 🔴 THE TWO ARMS ARE THE ESTIMATE-ATTRIBUTION SPLIT, ONE LAYER UP. The split that
 * already separates "never priced" from "priced at nothing" in the gate below is
 * the same distinction the hook's `code` now carries, so it is preserved rather
 * than collapsed: `'no-cost'` is a reply that did not carry a price, `'failed'` is
 * an estimate that did not SUCCEED — and per the class docs a `'failed'` reply CAN
 * carry a numeric cost, so calling it "no cost" would be false.
 *
 * An unrecognised future code falls to the `'failed'` arm, which claims less.
 */
function estimateRejectionMessage(err: WorkflowEstimateError): string {
  return err.code === 'no-cost'
    ? `Workflow estimate returned no cost — ${snapshotFailureMessage(err.snapshot, NO_SERVER_REASON)}`
    : `Workflow estimate failed — ${snapshotFailureMessage(err.snapshot, NO_SERVER_REASON)}`;
}

/**
 * Viewer-facing text for a `submit` REJECTION (`blocks-react` ≥ 0.43.0).
 *
 * Same three-audience rule as `estimateRejectionMessage`: the reason comes off
 * `err.snapshot`, the branch comes off `err.code`, and `err.message` is never shown.
 *
 * 🔴 NEITHER ARM SAYS THE TURN WAS FREE, AND THAT IS THE LOAD-BEARING PART. Every
 * reply here spends Buzz, and upstream is explicit that NEITHER code guarantees
 * nothing was charged:
 *   - `'exception'` — the host had no workflow to report. USUALLY nothing was
 *     queued, but a lost response or an in-progress idempotency conflict lands on
 *     the same shape, so this arm reports what is actually known (no workflow came
 *     back) and stays silent about money rather than reassuring.
 *   - `'workflow-failed'` — a real-ish id came back already failed and unpriced.
 *     The host treats ANY resolved submit as money-COMMITTED and does not refund on
 *     a non-throwing failed snapshot, so the spend may already have happened. This
 *     arm says so.
 *
 * An unrecognised future code falls to the `'workflow-failed'` arm — the cautious
 * one — mirroring how the hook itself routes an unknown workflow id.
 *
 * 🔴 NO RETRY IS ATTEMPTED ON EITHER ARM. `submit()` mints a fresh
 * `idempotencyKey` per call, so an automatic retry would be a SECOND reservation
 * rather than a second attempt at the first one.
 */
function submitRejectionMessage(err: WorkflowSubmitError): string {
  const reason = snapshotFailureMessage(err.snapshot, NO_SERVER_REASON);
  return err.code === 'exception'
    ? `Workflow submit returned no workflow — ${reason}`
    : `Workflow submit failed, and this turn may already have been charged — ${reason}`;
}

/**
 * Create a bridge adapter that uses the host-mediated useBuzzWorkflow helpers to
 * reach the orchestrator's `chat-completion` step over postMessage.
 *
 * 🔴 NON-STREAMING BY CONSTRUCTION. The step exposes no `stream` param and the
 * scan runs at the READ boundary — text cannot be released incrementally,
 * because a partial reply has not been scanned. `onChunk` is honoured by
 * replaying the completed, released text through `simulateStreaming`; the
 * `stream` field on the request is ignored.
 *
 * 🔴 THAT REPLAY IS COSMETIC AND IS NOT AWAITED BEFORE RESOLVING. It is handed
 * back as `result.replay` instead, so a caller can persist the reply and then
 * await the animation. See the block at the `replay` assignment for the
 * measurement that forced it.
 *
 * 🔴 TOOL CALLS ARE CARRIED, and the finish reason distinguishes them. The
 * step accepts `tools`/`tool_choice` and the host publishes a `tool_calls`
 * reply on a verdict-gated `toolCalls` snapshot field — released only when the
 * output scan releases. A response carrying calls reports
 * `finish_reason: 'tool_calls'`; one carrying prose reports `'stop'`. This
 * block previously asserted the opposite while the code below already set
 * `'tool_calls'`.
 */
export function createBridgeAdapter(workflow: WorkflowHelpers): OrchestratorAdapter {
  let lastWorkflowId: string | undefined;

  return {
    async submitChatCompletion(
      request: ChatCompletionRequest,
      onChunk?: (chunk: string) => void,
      signal?: AbortSignal,
      onWorkflow?: (workflowId: string) => void,
    ): Promise<ChatCompletionResult> {
      const body = buildChatCompletionBody(request);

      // 🔴 `estimate` REJECTS AS OF `blocks-react@0.43.0`, AND THE REASON IS ON THE
      // ERROR RATHER THAN ON A SNAPSHOT. Before that it RESOLVED an unusable reply
      // and the gate below read the reason off `estimateSnap.error`; now the hook
      // throws `WorkflowEstimateError` and that snapshot never reaches this scope.
      // Without this catch the rejection propagates as the developer-facing
      // constant on `err.message` and the server's own words are lost — the exact
      // shape PR #69 fixed at the submit refusal, arriving at the estimate.
      let estimateSnap: BlockWorkflowSnapshot;
      try {
        estimateSnap = await workflow.estimate(body);
      } catch (e) {
        if (e instanceof WorkflowEstimateError) throw new Error(estimateRejectionMessage(e));
        throw e;
      }

      // 🔴 TWO DIFFERENT FAILURES USED TO SHARE ONE MESSAGE, AND ONLY ONE OF THEM
      // IS ABOUT MONEY. `cost` ABSENT means the host never priced the request;
      // `cost.total <= 0` means it priced it at nothing. Both were reported as
      // "zero or missing cost", so an unpriced request was indistinguishable on
      // screen from a free one — and the first reads as "you have no Buzz". The
      // 0.1.6 note on `buildChatCompletionBody` above records that shape sending
      // a diagnosis after billing.
      //
      // 🔴 AND THE SNAPSHOT ALREADY CARRIED THE REAL REASON: `error` is an
      // optional field on a workflow snapshot, and the old guard discarded it in
      // favour of a message it invented. Prefer the host's own words.
      //
      // 🔴 THE GATE IS STRICTLY TIGHTER, NOT UNCHANGED — an earlier version of
      // this comment claimed unchanged and that was measurably false. The old
      // gate was, verbatim:
      //
      //     const cost = estimateSnap.cost?.total ?? 0;
      //     if (cost <= 0) { throw … }
      //
      // so it ADMITTED everything for which `cost <= 0` is false — and that is
      // three classes which are not prices. `NaN` admits because EVERY NaN
      // comparison is false, so `NaN <= 0` is false; `Infinity` admits; the
      // string `"5"` admits by coercion. All three SUBMITTED, spending Buzz on a
      // request that had never been priced. (Quoting the old gate as `> 0` — as
      // this comment briefly did — gets NaN backwards, because `NaN > 0` is also
      // false and would have REJECTED it. The `<= 0` spelling is what makes the
      // leak follow with no exception clause.) The new test is "a finite number,
      // greater than zero", a strict subset, so the direction is fail-closed:
      // every input the old gate refused, this one still refuses.
      // `estimate-gate-rejects-every-value-that-is-not-a-finite-number` below
      // pins the rejections; the `total <= 0` branch is pinned separately.
      //
      // 🔴 THIS GATE IS NOT REDUNDANT AFTER THE 0.43 REJECTION ABOVE, and the reason
      // is the `Number.isFinite` half. The hook's own test is `typeof
      // snapshot.cost?.total === 'number'` — which ADMITS `NaN` and `±Infinity`,
      // because both are numbers by `typeof`. So the hook resolves them and this
      // line is the only thing that refuses them. The `typeof total !== 'number'`
      // half is no longer reachable through `useBuzzWorkflow` (the hook rejects it
      // first), but it IS reachable through any other `WorkflowHelpers`
      // implementation — every test in this repo injects one — and removing it would
      // make the adapter's contract narrower than its interface. Fail-closed, kept.
      const total = estimateSnap.cost?.total;

      if (typeof total !== 'number' || !Number.isFinite(total)) {
        // Same derivation, same fallback string as the `'no-cost'` rejection arm
        // above — the resolved and rejected routes to "no usable price" must read
        // identically, and they do because both call one function with one constant.
        // That constant used to CLAIM A REJECTION that had not happened; see
        // `NO_SERVER_REASON` for why it no longer does.
        throw new Error(
          `Workflow estimate returned no cost — ${snapshotFailureMessage(estimateSnap, NO_SERVER_REASON)}`,
        );
      }

      // 🔴 A FAILED ESTIMATE IS NOT A QUOTE YOU MAY SPEND AGAINST, AND A NUMBER
      // ARRIVING WITH IT DOES NOT MAKE IT ONE. Per `WorkflowEstimateError.code`'s
      // own docs, `'failed'` is not only "the host threw": a whatIf the orchestrator
      // itself reports as failed maps to `'failed'` through the server's
      // `ORCH_STATUS_MAP`, and **such a reply CAN carry a numeric `cost`** —
      // upstream's words for why it is rejected anyway are "a failed estimate is not
      // a quote you may spend against, whether or not a number came back with it".
      //
      // 🔴 THIS GATE WAS MISSING, AND THE ONLY THING STOPPING THE SPEND WAS THE
      // INSTALLED HOOK. Measured on the PR that bumped to `blocks-react@0.49.0`: an
      // `estimate` resolving `{workflowId:'failed', status:'failed',
      // error:'orchestrator whatIf failed', cost:{total:500}}` walked both gates
      // above — `500` is a finite number greater than zero — and the adapter
      // SUBMITTED, spending Buzz against a price the server had already disowned. In
      // production `useBuzzWorkflow` rejects that shape first, so it was unreachable
      // through the hook; every test in this repo injects its own `WorkflowHelpers`,
      // and so may any other consumer. That is the same argument the `typeof total
      // !== 'number'` half above is kept on, applied to the dimension that can
      // actually spend money instead of the one that cannot.
      //
      // 🔴 AND ITS FIRST VERSION WAS ONE STATUS WIDE, WHICH LEFT THREE SIBLINGS
      // SPENDING. `status === 'failed'` was the whole test; re-measured with the
      // same fixture at `status` of `'canceled'`, `'expired'` and an unrecognised
      // value, each one SUBMITTED. Those are reachable THROUGH THE HOOK, not just
      // through an injected fake — `useBuzzWorkflow.estimate` rejects on
      // `status === 'failed'` or on a missing numeric cost, and a canceled reply
      // carrying `cost.total` satisfies neither. `isTerminalWithoutSuccess` is now
      // the single spelling of that idea, shared with the poll loop below, which had
      // the full terminal set open-coded all along.
      //
      // 🔴 ORDER IS LOAD-BEARING: THIS SITS AFTER THE UNPRICED GATE, NOT BEFORE IT.
      // A failed estimate with NO usable number is already refused above, and its
      // wording is pinned as a whole string by `does not claim a reason it was not
      // given, nor a rejection that did not happen` — whose fixture is exactly
      // `{status:'failed'}`. Hoisting this check would relabel that case from
      // "returned no cost" to "failed" and break that pin. Measured by actually
      // hoisting it: exactly 1 of the 106 cases across this module's two test files
      // fails, and it is that one. (An earlier version of this line also claimed the
      // `'no-cost'`-arm pin would break with it. That is false — that pin exercises
      // `estimateRejectionMessage`, a path no ordering of the gates in this function
      // can reach, and per the hook's docs a `'no-cost'` error can never carry
      // `status:'failed'` anyway, so the identity requirement does not apply to its
      // fixture. A comment claiming coverage it does not have is what stops the next
      // reader from checking.) What was unguarded is a non-successful estimate that
      // DID carry a finite positive number, so that is where the check goes — by this
      // line `total` is known to be one.
      //
      // 🔴 ESTIMATE ONLY. The `status === 'failed'` guard on the SUBMIT reply below
      // is a different exit with a different rule: a budget / spend-cap refusal
      // RESOLVES there carrying the price it refused to charge, and #69's fix is
      // that it must keep resolving so the viewer sees the server's own reason and
      // can top up. It is therefore the ONE call site the shared predicate must not
      // reach. Do not merge the two.
      //
      // Same derivation as `estimateRejectionMessage`'s `'failed'` arm, so the
      // resolved and rejected routes to "the estimate did not succeed" read
      // identically — the same reason every route here shares `NO_SERVER_REASON`.
      // One sentence covers all four rejected statuses because that arm's own docs
      // gloss code `'failed'` as exactly this: "the estimate did not succeed".
      if (isTerminalWithoutSuccess(estimateSnap.status)) {
        throw new Error(
          `Workflow estimate failed — ${snapshotFailureMessage(estimateSnap, NO_SERVER_REASON)}`,
        );
      }

      if (total <= 0) {
        throw new Error(`Workflow estimate priced this request at ${total} — nothing to submit`);
      }

      // 🔴 `submit` ALSO REJECTS AS OF `blocks-react@0.43.0` — but ONLY on a
      // failure-shaped reply with NO price. The budget / spend-cap refusal still
      // RESOLVES and is handled at the `status === 'failed'` guard below; see there.
      // These two exits are therefore complements, not alternatives: this catch
      // owns the unpriced rejections, that guard owns the priced refusal, and both
      // derive their text from `snapshotFailureMessage` so they cannot drift.
      let submitSnap: BlockWorkflowSnapshot;
      try {
        submitSnap = await workflow.submit(body);
      } catch (e) {
        if (e instanceof WorkflowSubmitError) throw new Error(submitRejectionMessage(e));
        throw e;
      }

      // 🔴 A REFUSAL RESOLVES — IT DOES NOT REJECT — AND THE ID IT CARRIES IS NOT
      // POLLABLE. THIS IS NOW LITERALLY TRUE OF THE INSTALLED HOOK, not just of the
      // contract: the sentence below described `blocks-react` ≥ 0.43's guard while
      // this app was pinned at 0.39.0, where `submit` resolved EVERY reply and the
      // rejection arm did not exist. The pair bump to 0.49.0 is what made the
      // comment describe the code that runs. `useBuzzWorkflow.submit`'s guard, read
      // off the installed dist, is verbatim:
      //
      //     if (snapshot.status === 'failed' && typeof snapshot.cost?.total !== 'number')
      //
      // — so it rejects a failure-shaped reply only
      // when it has NO numeric cost; a budget / spend-cap rejection quotes the
      // price it refused to charge, so it carries one and is handed back here as
      // an ordinary resolved snapshot with `status: 'failed'`. Its `workflowId` is
      // the host contract's failure sentinel (`'failed'`), which names no
      // workflow: polling it 404s, and the resulting `Not Found` REPLACES the
      // server's own reason on its way to the viewer.
      //
      // Measured in production 2026-09-12: a viewer who set a per-app Buzz limit
      // of 1 was shown `Error: Not Found` instead of `app Buzz limit reached: …
      // your limit for this app is 1`. The one `blocks.pollWorkflow` NOT_FOUND in
      // three days of server logs carried `workflowId: 'failed'` — i.e. the poll
      // below threw the reason away while it was already in hand at this line.
      //
      // 🔴 `'failed'` ONLY, NOT EVERY TERMINAL STATUS — AND SPECIFICALLY NOT
      // `isTerminalWithoutSuccess`, which the estimate gate above and the poll loop
      // below now share. THE REASON IS THE `onWorkflow` REPORT BELOW, WHICH THIS
      // EXIT SITS IN FRONT OF. Widening the gate to the shared predicate would make
      // a submit reply of `expired`, `canceled` or a status nobody here recognises
      // throw at THIS line and never reach `onWorkflow?.(workflowId)` — losing the
      // charge-bookkeeping id on exactly the turns where a charge may already have
      // landed and no answer is ever going to arrive. That block's own header is the
      // other half of the argument: a caller recording what the viewer paid for "has
      // to learn the id at this line", because the returned response only reaches it
      // on the turns that succeeded.
      //
      // 🔴 THE PREVIOUS WORDING HERE NAMED A HARM THIS PREDICATE CANNOT DO, WHICH IS
      // WORSE THAN NAMING NONE — a reader can disprove it in thirty seconds and then
      // reasonably conclude the whole prohibition is bogus. It said reaching for the
      // shared predicate "would skip the output-moderation scan on the happy path"
      // and cited `polls at least once even when submit already reports a terminal
      // status` as the pin. Both are false of `isTerminalWithoutSuccess`:
      // `isTerminalWithoutSuccess('succeeded')` is `false` by construction, so it
      // cannot touch the happy path at all, and that test's fixture is submit →
      // `{status:'succeeded'}`, the one case the predicate already excludes — so it
      // stays green under the widening. Measured by actually applying the forbidden
      // edit: `tsc --noEmit` is clean and the FULL suite comes back
      // `1 failed | 683 passed (684)` — the one red being the guard named below,
      // which is what this round added. Before it existed the same edit was wholly
      // green. The moderation argument is true of upstream's `TERMINAL_STATUSES`
      // (`useBuzzWorkflow.js`), which DOES contain `succeeded`, and that set is what
      // this comment was about before the shared predicate existed; the delta that
      // introduced the predicate carried the old justification across onto it.
      //
      // What makes this prohibition enforced rather than advisory is
      // `reports the workflowId for a terminal submit reply that is not failed` in
      // `orchestrator-bridge.test.ts` — a `canceled` submit whose message is
      // identical either way, so the only assertion that can kill it is the one
      // naming `onWorkflow`. The consolidation deliberately stops short of this
      // line.
      if (submitSnap.status === 'failed') {
        throw new Error(snapshotFailureMessage(submitSnap));
      }

      const workflowId = submitSnap.workflowId;

      if (!workflowId) {
        throw new Error('Workflow submit did not return a workflowId');
      }

      lastWorkflowId = workflowId;

      // 🔴 REPORTED HERE — AT THE CHARGE, NOT AT THE RESOLUTION. The submit
      // above is the moment Buzz is spent; everything below it is polling that
      // may never finish for this client. A caller recording what the viewer
      // paid for has to learn the id at this line, because the returned
      // response only reaches it on the turns that succeeded.
      //
      // 🔴 ITS FAILURE IS SWALLOWED, AND ON THIS PATH THAT IS NOT DEFENSIVE
      // BOILERPLATE. This is the money path with a charge already made: a
      // diagnostic callback that threw here would abandon a workflow the viewer
      // has been billed for, converting a bookkeeping bug into a lost paid
      // answer — the precise failure the callback was added to measure.
      try {
        onWorkflow?.(workflowId);
      } catch {
        // Nothing to report to: the caller IS the reporter.
      }

      // 🔴 THE SUBMIT REPLY NEVER CARRIES `textOutputs` — the step submit passes
      // no `wait`, so it is a freshly-queued workflow, and only the POLL is
      // wrapped in `attachModeratedStepTextOutputs`. At least one poll is
      // mandatory even if submit already reported a terminal status.
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let snap: TextOutputSnapshot = submitSnap;
      let polled = false;

      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error('Aborted');
        snap = await workflow.poll(workflowId);
        polled = true;
        // The terminal set, spelled as "succeeded, or stopped without succeeding"
        // rather than as a second enumeration of the four statuses. It used to be
        // that enumeration, and the estimate gate above used to be a one-status
        // subset of it — two spellings of one idea, in one file, disagreeing.
        //
        // 🔴 THIS DOES CHANGE ONE CASE, IN THE FAIL-CLOSED DIRECTION, AND WHAT IT
        // COSTS IS NOT ONLY A SENTENCE. An unrecognised status now stops the loop and
        // is reported through `snapshotFailureMessage` below; before, it read as
        // in-flight and the turn ran to the 60 s deadline to report a timeout instead
        // of the server's own words. Measured with a poll queue of
        // `{status:'unassigned'}` → `{status:'succeeded', textOutputs:['a late
        // answer']}`: the pre-consolidation loop resolved WITH that answer, this one
        // rejects on the first reply. So a reply the viewer has already been charged
        // for can be thrown away here — not just relabelled.
        //
        // 🔴 THE TWO CALL SITES GENUINELY WANT OPPOSITE ANSWERS ON AN UNKNOWN STATUS
        // THAT IS STILL IN FLIGHT, AND ONE PREDICATE CANNOT GIVE BOTH. The estimate
        // gate should refuse — the money is not spent yet, so stopping costs nothing.
        // This loop should keep polling — the money IS spent, so stopping forfeits
        // it. Sharing the predicate makes both stop.
        //
        // Accepted anyway, for three reasons and not because the trade is free.
        // Reaching it requires the host to break its own documented mapping
        // contract: per `BlockWorkflowSnapshot.status`'s docs in
        // `@civitai/app-sdk/dist/blocks/types.d.ts`, an orchestrator status the host
        // does not recognise is the HOST's to map onto this union, "typically
        // `processing` or `failed`" — so no such value should arrive, and `unassigned`
        // is named there as exactly the kind of internal state the union omits. The
        // loss is bounded by the same 60 s deadline the old behaviour spent before
        // reporting nothing. And on a path that has already spent the viewer's Buzz,
        // fail-closed is the direction to be wrong in. `stops on a status it does not
        // recognise, rather than polling to the deadline` in
        // `orchestrator-bridge.contract.test.ts` pins the behaviour, and its fixture
        // is that two-reply queue, so the discarded answer is on the record rather
        // than in a footnote.
        if (snap.status === 'succeeded' || isTerminalWithoutSuccess(snap.status)) {
          break;
        }
        await delay(POLL_INTERVAL_MS);
      }

      if (!polled) {
        throw new Error('Chat completion timed out before the first poll');
      }

      if (snap.status !== 'succeeded') {
        throw new Error(snapshotFailureMessage(snap));
      }

      // 🔴 CHECKED BEFORE THE RELEASED TEXT. A withhold is not an error and not
      // an empty response — the Buzz was spent, the host scanned the reply and
      // refused it. Surfacing it as "empty response" would report a bug where
      // the policy worked.
      if (snap.textOutputWithheld) {
        throw new TextOutputWithheldError(snap.textOutputWithheld.reason);
      }

      const content = extractReleasedText(snap);
      const toolCalls = extractToolCalls(snap);

      // 🔴 A TOOL-CALL REPLY HAS NO CONTENT, AND THAT IS NOT AN EMPTY RESPONSE.
      // When the model decides to call a tool it returns `finishReason:
      // 'tool_calls'` with `content: null` — the step's text extractor then
      // yields nothing but the structured calls are present. Throwing here (as
      // this did before tool calling existed) would turn every successful tool
      // round into "Chat completion returned empty response", i.e. the feature
      // would appear broken precisely when it worked.
      if (!content && toolCalls.length === 0) {
        throw new Error('Chat completion returned empty response');
      }

      // ── THE COSMETIC REPLAY: STARTED HERE, DELIBERATELY NOT AWAITED. ───────
      //
      // 🔴 AWAITING IT PUT DURABILITY BEHIND AN ANIMATION, AND IN A HIDDEN TAB
      // THAT IS MINUTES. `simulateStreaming` is one `setTimeout(20 ms)` per
      // word and Chrome throttles `setTimeout` in a background tab, so this
      // call did not resolve — and the caller's continuation, which is where
      // the reply is WRITTEN TO STORAGE, did not run — until the typewriter
      // finished. Measured against the deployed build on 2026-09-04: a reply
      // sent at 23:10:44 was persisted at 23:14:14, 3 m 30 s later, with the
      // finished text on screen and zero assistant messages in storage at the
      // same instant. A short one still took 45 s. An agent-driven send runs in
      // a hidden tab by construction, which is what both production lost
      // answers had in common.
      //
      // 🔴 NOTHING ABOUT MODERATION MOVES. `content` is the released text from
      // `extractReleasedText`, reached only past the withhold check above — the
      // step is non-streaming precisely so the scan can run on the whole reply,
      // and this line neither changes what is scanned nor when. It changes only
      // whether the CALLER has to wait for a typewriter to learn the reply
      // exists.
      //
      // 🔴 THE HANDLE NEVER REJECTS. A chunk sink that throws used to reject
      // this whole call, so a rendering fault destroyed a paid-for reply the
      // caller had not been given yet. Swallowing ends the replay early and
      // leaves the resolved reply intact; a caller awaiting `replay` after it
      // has already persisted cannot be thrown back into an error path that
      // overwrites its own write. Both halves are pinned in
      // `orchestrator-bridge.test.ts`.
      const replay =
        onChunk && content
          ? simulateStreaming(content, onChunk).catch(() => {})
          : Promise.resolve();

      const promptTokens = request.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
      const completionTokens = estimateTokens(content);

      return {
        id: workflowId,
        replay,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    },

    async cancel(workflowId?: string): Promise<void> {
      const id = workflowId || lastWorkflowId;
      if (id) {
        await workflow.cancel(id);
        lastWorkflowId = undefined;
      }
    },
  };
}
