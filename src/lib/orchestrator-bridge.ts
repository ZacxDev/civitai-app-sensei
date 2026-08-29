import type { ChatCompletionRequest, ChatCompletionResponse } from './completion-types.js';
import type { ToolCall } from './tools.js';
import type { OrchestratorAdapter } from './orchestrator.js';
import { simulateStreaming } from './streaming.js';
import type { WorkflowBody, WorkflowBodyStep, BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

export type { ChatCompletionRequest, ChatCompletionResponse } from './completion-types.js';

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

/** The registered step id. Wire value, not the orchestrator `$type`. */
export const CHAT_COMPLETION_STEP_ID = 'chat-completion';

/**
 * The host's model allowlist (`CHAT_COMPLETION_MODELS`).
 *
 * 🔴 A NON-MEMBER IS REJECTED AT PARSE by the entry's `z.enum` — it does not
 * fall back to a default and it does not reach the orchestrator. There is also
 * NO orchestrator-side model validation behind it: the host's own header records
 * that a fabricated model name is quoted the declared floor, CHARGED it, and
 * then fails at execution with no output and no refund. The enum is what stops an app typo
 * from burning a viewer's Buzz.
 */
export const CHAT_COMPLETION_MODELS = [
  'deepseek/deepseek-chat',
  'cognitivecomputations/dolphin-mistral-24b-venice-edition',
  'openai/gpt-4o-mini',
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

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 60_000;

/**
 * The poll snapshot, widened with the two fields the host attaches for a
 * `'textOutput'` posture step.
 *
 * 🔴 NOT IN `@civitai/app-sdk` 0.31.0 — verified against the published dist,
 * which mentions neither field. The host DOES send them (`blocks.router`'s poll
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
export function buildChatCompletionBody(request: ChatCompletionRequest): WorkflowBodyStep {
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
  // 🔴 THE WIRE SPELLING IS `tool_choice`, SNAKE_CASE — taken from the
  // orchestrator's own `[JsonPropertyName("tool_choice")]`, not from this app's
  // camelCase field name. Getting it backwards does not error: the orchestrator
  // would ignore an unknown key and the feature would be silently inert, which
  // is why the two spellings are mapped in exactly one place — here.
  return {
    kind: 'step',
    step: CHAT_COMPLETION_STEP_ID,
    params: {
      model: request.model,
      messages,
      maxTokens: clampMaxTokens(request.max_tokens),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools,
            ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
          }
        : {}),
    },
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
  return texts.filter((t) => typeof t === 'string' && t.trim().length > 0).join('\n\n');
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
 * Create a bridge adapter that uses the host-mediated useBuzzWorkflow helpers to
 * reach the orchestrator's `chat-completion` step over postMessage.
 *
 * 🔴 NON-STREAMING BY CONSTRUCTION. The step exposes no `stream` param and the
 * scan runs at the READ boundary — text cannot be released incrementally,
 * because a partial reply has not been scanned. `onChunk` is honoured by
 * replaying the completed, released text through `simulateStreaming`; the
 * `stream` field on the request is ignored.
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
    ): Promise<ChatCompletionResponse> {
      const body = buildChatCompletionBody(request);

      const estimateSnap = await workflow.estimate(body);
      const cost = estimateSnap.cost?.total ?? 0;

      if (cost <= 0) {
        throw new Error('Workflow estimate returned zero or missing cost');
      }

      const submitSnap = await workflow.submit(body);
      const workflowId = submitSnap.workflowId;

      if (!workflowId) {
        throw new Error('Workflow submit did not return a workflowId');
      }

      lastWorkflowId = workflowId;

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
        if (
          snap.status === 'succeeded' ||
          snap.status === 'failed' ||
          snap.status === 'expired' ||
          snap.status === 'canceled'
        ) {
          break;
        }
        await delay(POLL_INTERVAL_MS);
      }

      if (!polled) {
        throw new Error('Chat completion timed out before the first poll');
      }

      const finalStatus = snap.status;
      if (finalStatus !== 'succeeded') {
        const errorMsg = typeof snap.error === 'string' ? snap.error : `Workflow ${finalStatus}`;
        throw new Error(errorMsg);
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

      // Only stream real prose. A tool round has nothing to show the viewer yet.
      if (onChunk && content) {
        await simulateStreaming(content, onChunk);
      }

      const promptTokens = request.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
      const completionTokens = estimateTokens(content);

      return {
        id: workflowId,
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
