import type { ChatCompletionRequest, ChatCompletionResponse } from './completion-types.js';
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

/** The roles the host's `chatMessageSchema` accepts. `'tool'` is NOT one of them. */
const ALLOWED_ROLES = new Set(['system', 'user', 'assistant']);

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
 *  - role must be system/user/assistant. A `'tool'`-role message (the app's
 *    tool-result carrier) has no representation in this step and is DROPPED
 *    here rather than sent to be rejected.
 *  - content is 1..8000 chars. Empty/whitespace-only messages are dropped;
 *    over-long ones are truncated.
 *  - at most 32 messages. The FIRST system message is preserved and the most
 *    recent turns are kept — trimming from the front would silently discard the
 *    app's system prompt, which is the one message that must always survive.
 */
export function toStepMessages(
  messages: ChatCompletionRequest['messages'],
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const usable = messages
    .filter((m) => ALLOWED_ROLES.has(m.role))
    .map((m) => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: (m.content ?? '').slice(0, MAX_MESSAGE_CHARS),
    }))
    .filter((m) => m.content.trim().length > 0);

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

  // 🔴 EXACTLY FOUR KEYS, AND NEVER MORE. The host's `chatCompletionParamsSchema`
  // is `.strict()`, so `tools`, `tool_choice`, `response_format`, `stream`,
  // `max_tokens` (the snake_case spelling) and `modalities` are each a
  // BAD_REQUEST rather than a field that gets dropped. Adding one here breaks
  // every call, not just the feature that wanted it.
  return {
    kind: 'step',
    step: CHAT_COMPLETION_STEP_ID,
    params: {
      model: request.model,
      messages,
      maxTokens: clampMaxTokens(request.max_tokens),
      ...(temperature !== undefined ? { temperature } : {}),
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
 * 🔴 NO TOOL CALLS. The step never exposes `tools` and its `extractText`
 * deliberately does not read `tool_calls`, so a tool call can neither be
 * requested nor returned. Responses always carry `finish_reason: 'stop'`.
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

      if (!content) {
        throw new Error('Chat completion returned empty response');
      }

      if (onChunk) {
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
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
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
