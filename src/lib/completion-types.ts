import type { ToolCall, ToolDeclaration } from './tools.js';

/**
 * The request this app can express.
 *
 * 🔴 THE ABSENT FIELDS ARE STILL THE FEATURE — the LIST just got shorter. The
 * host's `chatCompletionParamsSchema` is `.strict()`, so `stream`,
 * `response_format`, `n`, `stop`, `seed`, `topP`, `modalities` and friends are
 * each a `BAD_REQUEST` for the WHOLE request rather than a field the host
 * politely ignores. Declaring one here would make "send a payload the host
 * rejects" a runtime discovery instead of a compile error.
 *
 * ⚠️ `tools` AND `toolChoice` USED TO BE ON THAT LIST AND ARE NOT ANY MORE.
 * The host's schema now accepts both — the comment that forbade them described
 * a schema that has since widened, which is exactly the shape of stale comment
 * that gets believed. They are camelCase HERE and on the wire `toolChoice` is
 * sent as `tool_choice`; see `buildChatCompletionBody`, which owns that mapping
 * and is the only place that spelling appears.
 *
 * `max_tokens` (snake_case) survives here because it is this app's own field
 * name; `buildChatCompletionBody` maps it to the host's `maxTokens` and clamps
 * it. Sending the snake_case spelling on the wire would itself be a reject.
 *
 * `role` stays a bare `string` on purpose: `toStepMessages` validates roles and
 * drops what the host will not take, and that guard needs a reachable input.
 */
export interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: string;
    content: string;
    /** Required on a `role: 'tool'` message — the id of the call it answers. */
    tool_call_id?: string;
    /** Present on an assistant turn that ASKED for tools; replayed so the answer correlates. */
    tool_calls?: ToolCall[];
  }>;
  max_tokens?: number;
  temperature?: number;
  /**
   * Tool declarations, fetched from the host rather than authored here — see
   * `fetchToolDeclarations`. Omitted entirely when there are none; an empty
   * array is a different thing and the host bounds the count.
   */
  tools?: ToolDeclaration[];
  /** `'auto'` lets the model decide. Omitted when no tools are declared. */
  toolChoice?: 'auto' | 'none' | 'required';
}

/**
 * The response this app can receive.
 *
 * ⚠️ `tool_calls` USED TO BE ABSENT HERE, JUSTIFIED BY "there is no channel on
 * which a tool call could arrive". That justification was true and is now not:
 * the host publishes structured calls on a `toolCalls` snapshot field which is
 * released only when the output scan releases, and every `arguments` string is
 * scanned as text before it is published. So the channel exists, is moderated,
 * and this type carries it.
 */
export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /**
   * Structured tool calls the model emitted, or `undefined` when it emitted
   * none. 🔴 ABSENT IS NOT THE SAME AS EMPTY: the host withholds this field
   * along with the text when the scan refuses the output, so `undefined` can
   * mean "none asked for" OR "withheld" — and the withhold arrives as a
   * `TextOutputWithheldError` before this value is ever read.
   */
  toolCalls?: ToolCall[];
}
