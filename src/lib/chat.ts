import type { ToolCall } from './tools.js';
import type { Message } from '../types.js';

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
  }));
}

/**
 * Deserialize messages from KV storage (preserves original IDs).
 *
 * 🔴 STORED SESSIONS PREDATE THE TOOL-LOOP REMOVAL. A session written by an
 * earlier build can still hold `role: 'tool'` messages and `toolCalls` fields.
 * The role stays in `Message`'s union so those deserialize rather than throw;
 * `ChatArea` renders them as nothing and `toStepMessages` drops them off the
 * wire. Any `toolCalls` field is simply not read.
 */
export function deserializeMessages(stored: StoredMessage[]): Message[] {
  return stored.map((m) => ({
    id: m.id,
    role: m.role as Message['role'],
    content: m.content,
    timestamp: m.timestamp,
    ...(m.withheld ? { withheld: true } : {}),
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
