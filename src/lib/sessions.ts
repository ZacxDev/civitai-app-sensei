import type { UseAppStorage } from '@civitai/blocks-react';
import type { Message, Session } from '../types.js';
import { serializeMessages, deserializeMessages } from './chat.js';

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THIS MODULE IS WRITE-ONLY EXCEPT AT LOAD, AND THAT IS THE WHOLE POINT.
//
// Every mutation here used to be a READ-MODIFY-WRITE: `appendMessage` read the
// message array back, appended, and wrote the whole thing; `renameSession` and
// `deleteSession` did the same to the session list. That is only correct if a
// `get` reflects a `set` from moments earlier, and ON THE DEPLOYED HOST IT DOES
// NOT.
//
// MEASURED, not theorised (2026-08-27). civitai's QueryClient sets
// `staleTime: Infinity` globally and `IframeHost`'s `APP_STORAGE_GET` resolves
// through `trpcUtils.apps.storage.get.fetch`. On the branch prod deploys from,
// that call passes no staleTime override and `APP_STORAGE_SET` performs no
// invalidation, so an entry cached once is never stale and never dropped: a
// block cannot see its own write. The host-side fix is civitai #4456, merged to
// `main` an hour AFTER the image prod is running and absent from the release
// branch.
//
// The damage that produced, read out of `app_sensei.kv` on the live App Blocks
// KV cluster: the stored message array for a two-exchange session held exactly
// two elements, BOTH `role:"assistant"` — each assistant write was computed from
// a cached snapshot that predated the user message beside it. Every session was
// still titled "New Chat" for the same reason: `renameSession` landed and was
// then overwritten by a later read-modify-write off a stale read.
//
// So the persistence layer no longer reads during a mutation. `App` already
// holds the authoritative `messages` and `sessions` arrays in React state; it
// passes the whole array and this module writes it. That is correct on the host
// running today AND on the fixed one, and it makes the behaviour independent of
// cache timing rather than merely likely.
//
// 🔴 IF YOU ADD A MUTATION HERE, IT TAKES THE FULL ARRAY. A helper that reads
// first would reintroduce the defect for that one path, silently, and no test
// using a read-your-writes fake could see it — see `staleReadAppStorage` in
// `src/test-helpers.tsx` for the fixture that models the real host.
// ─────────────────────────────────────────────────────────────────────────────

const SESSIONS_KEY = 'sensei:sessions';
const MESSAGES_PREFIX = 'sensei:messages:';

interface SessionsData {
  sessions: Session[];
}

/** Newest-first, the order the sidebar renders. */
export function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * LOAD. The only read of the session list, run once on mount.
 *
 * A read is legitimate here because there is no preceding write to be stale
 * against — this is what seeds the authoritative in-memory copy.
 */
export async function listSessions(appStorage: UseAppStorage): Promise<Session[]> {
  const data = await appStorage.get<SessionsData>(SESSIONS_KEY);
  return sortSessions(data?.sessions ?? []);
}

/** WRITE. Persists the caller's authoritative list verbatim. Never reads. */
export async function saveSessions(
  appStorage: UseAppStorage,
  sessions: Session[],
): Promise<void> {
  await appStorage.set(SESSIONS_KEY, { sessions });
}

/**
 * A new session record. PURE — it touches no storage, so the caller can build
 * the next list, write it once, and update state from the same value.
 */
export function createSessionRecord(model: string): Session {
  const now = Date.now();
  return {
    id: `session-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: 'New Chat',
    model,
    createdAt: now,
    updatedAt: now,
  };
}

/** PURE. The list with `sessionId` retitled and touched. */
export function withTitle(
  sessions: Session[],
  sessionId: string,
  title: string,
  now: number = Date.now(),
): Session[] {
  return sessions.map((s) => (s.id === sessionId ? { ...s, title, updatedAt: now } : s));
}

/** PURE. The list with `sessionId`'s `updatedAt` bumped. */
export function touched(
  sessions: Session[],
  sessionId: string,
  now: number = Date.now(),
): Session[] {
  return sessions.map((s) => (s.id === sessionId ? { ...s, updatedAt: now } : s));
}

/** PURE. The list without `sessionId`. */
export function without(sessions: Session[], sessionId: string): Session[] {
  return sessions.filter((s) => s.id !== sessionId);
}

/** LOAD. The only read of a message array — run when a session is opened. */
export async function getMessages(
  appStorage: UseAppStorage,
  sessionId: string,
): Promise<Message[]> {
  const stored = await appStorage.get<import('./chat.js').StoredMessage[]>(
    `${MESSAGES_PREFIX}${sessionId}`,
  );
  return stored ? deserializeMessages(stored) : [];
}

/** WRITE. Persists the caller's authoritative array verbatim. Never reads. */
export async function saveMessages(
  appStorage: UseAppStorage,
  sessionId: string,
  messages: Message[],
): Promise<void> {
  await appStorage.set(`${MESSAGES_PREFIX}${sessionId}`, serializeMessages(messages));
}

/** WRITE. Drops a session's message array. Idempotent host-side. */
export async function deleteMessages(
  appStorage: UseAppStorage,
  sessionId: string,
): Promise<void> {
  await appStorage.delete(`${MESSAGES_PREFIX}${sessionId}`);
}

/**
 * Auto-generate a title from the first user message (truncated).
 */
export function generateTitle(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return 'New Chat';
  const text = firstUser.content.trim();
  return text.length > 40 ? text.slice(0, 40) + '…' : text;
}
