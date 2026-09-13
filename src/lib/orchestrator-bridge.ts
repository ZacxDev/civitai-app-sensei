import type { ChatCompletionRequest, ChatCompletionResult } from './completion-types.js';
import type { ToolCall } from './tools.js';
import type { OrchestratorAdapter } from './orchestrator.js';
import { simulateStreaming } from './streaming.js';
import type { WorkflowBody, WorkflowBodyStep, BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';
// 🔴 VALUE IMPORTS, AND `instanceof` IS THE DOCUMENTED BRANCH. Both classes are
// re-exported from the package root (`dist/index.js`), and neither pulls in a DOM
// — the module they live in imports only `useCallback`/`useState`, so this file
// stays importable from the `node` vitest project.
//
// 🔴 `instanceof` IS ONLY SOUND WHILE THERE IS ONE COPY OF `@civitai/blocks-react`
// IN THE TREE. Two copies give two distinct class identities and every `instanceof`
// below silently returns false — the rejection would then fall through to the
// generic rethrow and the viewer would be shown the developer-facing constant
// again. `blocks-react` exact-pins `@civitai/theme` and `@civitai/components`, so
// leaving a sibling `@civitai/components-react` behind on a bump is how a second
// copy of those arrives; see the ledger entry `sdk-pair-bump` in `taste.json`.
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
  // `'no-cost'` rejection arm rather than on its resolved gate. Both spell the same
  // sentence, so what the viewer would have seen is unchanged; the route is not.
  //
  // The exact accepted key set is pinned in `orchestrator-bridge.test.ts`, so a
  // future rename fails here rather than in production.
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
            ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
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
 * What to say when the snapshot carries no server words at all.
 *
 * Deliberately says the SERVER gave no reason rather than inventing one, and
 * deliberately says nothing about money — see `submitRejectionMessage`.
 */
const NO_SERVER_REASON = 'the server gave no reason';

/**
 * The pre-0.43 fallback for an estimate that came back unpriced, kept VERBATIM.
 *
 * It is asserted by `does not claim a reason it was not given` in
 * `orchestrator-bridge.contract.test.ts`, which is the negative control proving the
 * unpriced message does not fabricate a reason. That test drives the adapter with a
 * RESOLVED unpriced snapshot — a shape the real hook no longer produces but any
 * `WorkflowHelpers` implementation still can — so the string is reachable from both
 * the resolved gate below and the `'no-cost'` rejection arm, and it must read the
 * same way on either.
 */
const UNPRICED_REASON = 'the request was rejected before it could be priced';

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
    ? `Workflow estimate returned no cost — ${snapshotFailureMessage(err.snapshot, UNPRICED_REASON)}`
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
        // identically, and they do because both call one function.
        throw new Error(
          `Workflow estimate returned no cost — ${snapshotFailureMessage(estimateSnap, UNPRICED_REASON)}`,
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
      // 🔴 `'failed'` ONLY, NOT EVERY TERMINAL STATUS. A `succeeded` submit must
      // still poll — the submit reply structurally cannot carry `textOutputs`
      // (see below) — and that case is pinned by `polls at least once even when
      // submit already reports a terminal status`. Widening this to
      // `TERMINAL_STATUSES` would skip the output-moderation scan on the happy
      // path, which is the opposite of a fix.
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
