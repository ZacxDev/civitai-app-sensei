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

/**
 * Splice retrieved catalog context in as a `system` message IMMEDIATELY BEFORE
 * the latest user turn.
 *
 * Position is the whole point. Placed at the head it competes with the app's
 * own system prompt and is separated from the question by the entire history;
 * placed after the user turn it reads as an answer. Directly before the
 * question it reads as "here is what the search returned, now answer this".
 *
 * Returns the input unchanged when `context` is empty — an empty `content` is
 * `.min(1)` on the host, i.e. a `BAD_REQUEST` for the whole request, not a
 * message that gets dropped.
 */
export function withRetrievalContext(messages: ApiMessage[], context: string): ApiMessage[] {
  if (!context.trim()) return messages;

  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
  const injected: ApiMessage = { role: 'system', content: context };
  if (lastUserIdx === -1) return [...messages, injected];
  return [...messages.slice(0, lastUserIdx), injected, ...messages.slice(lastUserIdx)];
}

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
