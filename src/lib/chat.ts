import type { ToolCall } from './tools.js';
import type { ResolvedResource } from './mentions.js';
import type { CorrectionRecord, Message } from '../types.js';

const ROLE_LABELS: Record<string, string> = {
  system: 'System',
  user: 'You',
  assistant: 'Sensei',
  tool: 'Tool',
};

export function formatRoleLabel(role: Message['role']): string {
  return ROLE_LABELS[role] ?? role;
}

/**
 * Heuristic token estimation (English ~4 chars per token).
 * Good enough for display; not for billing.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export interface ApiMessage {
  role: string;
  content: string;
  /**
   * Present on a `role: 'tool'` message — the id of the call it answers. The
   * host correlates every tool answer against an id a PRECEDING assistant turn
   * declared, and rejects the whole payload if it cannot.
   */
  tool_call_id?: string;
  /**
   * Present on an assistant turn that ASKED for tools. Replayed on the next
   * round so the answers that follow it correlate.
   */
  tool_calls?: ToolCall[];
}

/**
 * Inject the system prompt into a messages array.
 * Strips any existing system message first to avoid duplicates.
 */
export function withSystemPrompt(
  messages: Array<{ role: string; content: string }>,
  systemPrompt: string,
): ApiMessage[] {
  const withoutSystem = messages.filter((m) => m.role !== 'system');
  if (!systemPrompt) return withoutSystem;
  return [{ role: 'system', content: systemPrompt }, ...withoutSystem];
}

// 🔴 `withRetrievalContext` WAS DELETED HERE, not disabled. It spliced a
// heuristic search's results in as a `system` message before the latest user
// turn. Grounding now arrives as `role:'tool'` messages the model asked for by
// name, so there is nothing to inject and no second grounding path to keep in
// step with the first.


export interface StoredMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  withheld?: boolean;
  /**
   * The resources attached to a user turn. Persisted so reopening a conversation
   * shows what the answer was grounded in — an attachment that vanishes on
   * reload makes the transcript a partial record of what the viewer paid for.
   */
  mentions?: ResolvedResource[];
  /**
   * Layer 2's correction record for an assistant turn. Stored so the fire-rate
   * can be read off real transcripts rather than estimated — see
   * `types.ts`'s {@link CorrectionRecord}.
   */
  correction?: CorrectionRecord;
}

/**
 * Serialize messages for KV storage (preserves all fields including id).
 */
export function serializeMessages(messages: Message[]): StoredMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    timestamp: m.timestamp,
    ...(m.withheld ? { withheld: true } : {}),
    // Only when there is something to store — an empty array on every message
    // would grow the stored payload for nothing.
    ...(m.mentions && m.mentions.length > 0 ? { mentions: m.mentions } : {}),
    // 🔴 THE KEY IS OMITTED WHEN NO ROUND FIRED, which is the common case, so
    // the overwhelming majority of stored messages are byte-identical to what
    // they were before Layer 2 existed. `rounds > 0` rather than "the object is
    // present": a `{ rounds: 0 }` reaching here would be a caller bug, and
    // storing it would put "a correction happened" on a turn where none did.
    ...(m.correction && m.correction.rounds > 0 ? { correction: m.correction } : {}),
  }));
}

/**
 * Deserialize messages from KV storage (preserves original IDs).
 *
 * 🔴 TOTAL BY CONSTRUCTION, NOT BECAUSE STORED TOOL MESSAGES ARE KNOWN TO
 * EXIST. This docstring used to assert that "a session written by an earlier
 * build can still hold `role: 'tool'` messages and `toolCalls` fields", which
 * contradicted `types.ts`'s claim that the role is never persisted. Settled
 * from the history rather than by picking a side: **no shipped build has ever
 * written one.**
 *
 *  - 0.1.0 (`8bd14a8`) is the ONLY build that put a `role:'tool'` message into
 *    React state (`setMessages(prev => [...prev, toolMsg])`), and it persisted
 *    through `appendMessage`, which read the array back from STORAGE and
 *    appended one message — it was called for the user turn and the final
 *    assistant reply only, never for a tool message. State-only messages
 *    therefore never reached KV.
 *  - `fbf3f08` removed that `setMessages` and nothing has re-added it: every
 *    later build builds tool messages into `apiMessages`, a local array that is
 *    never written to state and never persisted.
 *  - The whole-array writes that arrived in 0.1.5 (`518c59d`) persist
 *    `messages` state — which is why a stored tool message, once present, would
 *    ROUND-TRIP. There is just no build that could put one there.
 *
 * So the totality below, `ChatArea`'s `role === 'tool'` skip, and
 * `toStepMessages`' drop are defence in depth against a shape nothing is known
 * to produce — worth keeping (the cast on `role` means a stored row decides the
 * value, and a future build could persist one) but NOT evidence that such
 * sessions are out there. `types.ts`'s "never persisted" is the accurate claim;
 * its "lets sessions written by older builds deserialize" repeated this one's
 * error and has been corrected too.
 */
export function deserializeMessages(stored: StoredMessage[]): Message[] {
  return stored.map((m) => ({
    id: m.id,
    role: m.role as Message['role'],
    content: m.content,
    timestamp: m.timestamp,
    ...(m.withheld ? { withheld: true } : {}),
    // 🔴 TOTAL, like the `withheld` clause beside it: a session written by a
    // build that predates mentions simply has no key here, and one written by a
    // future build carrying an unknown extra field still deserializes.
    ...(Array.isArray(m.mentions) && m.mentions.length > 0 ? { mentions: m.mentions } : {}),
    // 🔴 SHAPE-CHECKED, NOT TRUSTED, and total like every clause beside it. A
    // row written before Layer 2 has no key at all; a row written by some future
    // build could carry anything. `typeof rounds === 'number'` is what stops a
    // malformed row from putting a `correction` on the message whose `.rounds`
    // then reads `undefined` at every consumer.
    ...(m.correction &&
    typeof m.correction.rounds === 'number' &&
    m.correction.rounds > 0 &&
    typeof m.correction.resolved === 'boolean'
      ? { correction: { rounds: m.correction.rounds, resolved: m.correction.resolved } }
      : {}),
  }));
}

/**
 * Assemble streaming chunks into a full response string.
 */
export function assembleChunks(chunks: string[]): string {
  return chunks.join('');
}

/**
 * Generate a unique message ID.
 */
export function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
