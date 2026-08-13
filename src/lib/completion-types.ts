/**
 * The request this app can express.
 *
 * 🔴 THE ABSENT FIELDS ARE THE FEATURE. The host's `chatCompletionParamsSchema`
 * is `.strict()` over exactly `{ model, messages, maxTokens, temperature }`, so
 * `tools`, `tool_choice`, `stream`, `response_format`, `n`, `stop`, `seed`,
 * `topP` and friends are each a `BAD_REQUEST` for the WHOLE request rather than
 * a field the host politely ignores. This type used to declare four of them,
 * which made "send a payload the host rejects" a runtime discovery. Now it is a
 * compile error.
 *
 * `max_tokens` (snake_case) survives here because it is this app's own field
 * name; `buildChatCompletionBody` maps it to the host's `maxTokens` and clamps
 * it. Sending the snake_case spelling on the wire would itself be a reject.
 *
 * `role` stays a bare `string` on purpose: `toStepMessages` DROPS any role the
 * host does not accept, and legacy stored sessions can still contain
 * `role: 'tool'` messages. Narrowing the type here would delete that guard's
 * only reachable input.
 */
export interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
}

/**
 * The response this app can receive.
 *
 * 🔴 NO `tool_calls`. The step's `extractText` reads only
 * `choices[].message.{content,refusal}`, and a `'textOutput'` posture entry may
 * not declare an `extractOutput` — so there is no channel on which a tool call
 * could arrive. A declared-but-never-populated field is not a capability; it is
 * a dead branch that reads like one.
 */
export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}
