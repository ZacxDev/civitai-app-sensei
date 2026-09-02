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

/** The title a session carries until its first message names it. */
export const UNTITLED = 'New Chat';

/** Longest auto-title, in characters, before the word-boundary cut below. */
const TITLE_MAX = 48;

/**
 * Auto-generate a title from the first user message.
 *
 * 🔴 IT CUTS ON A WORD BOUNDARY, WHICH IS NOT COSMETIC HERE. The old rule was
 * `slice(0, 40) + '…'`, so a sidebar of questions about the same subject
 * produced rows that were identical for 40 characters and then stopped
 * mid-word — indistinguishable at a glance AND unreadable. The multi-line
 * source of a pasted question made it worse: newlines survived the slice, so
 * one row's title carried a fragment of line two.
 */
export function generateTitle(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return UNTITLED;
  // Any run of whitespace — newlines included — becomes one space, so a pasted
  // multi-line question titles as a single readable line.
  const text = firstUser.content.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return UNTITLED;
  if (text.length <= TITLE_MAX) return text;

  const head = text.slice(0, TITLE_MAX);
  const lastSpace = head.lastIndexOf(' ');
  // Only honour the boundary if it leaves a useful amount of title; a question
  // whose first "word" is longer than the budget still has to be cut somewhere.
  const cut = lastSpace >= TITLE_MAX / 2 ? head.slice(0, lastSpace) : head;
  return cut.replace(/[\s,;:.!-]+$/, '') + '…';
}

/**
 * A session that has been created and never used.
 *
 * 🔴 THIS PREDICATE IS WHY THE SIDEBAR STOPS FILLING WITH "New Chat" ROWS.
 * `createSession` persists a session the moment "+ New" is pressed, so every
 * press that is not followed by a question leaves a permanent, identical,
 * contentless row. A live sidebar carried FIVE of them alongside six rows with
 * the same auto-title.
 *
 * 🔴 IT IS DERIVED FROM THE SESSION RECORD ALONE, DELIBERATELY. Messages live
 * under a different storage key and are only loaded for the OPEN session, so a
 * "does it have messages" test would need a read per row — on a host that
 * cannot serve a block its own writes (see this file's header). `updatedAt` is
 * bumped by the first send, and by nothing else that leaves the title alone, so
 * `createdAt === updatedAt && title === UNTITLED` identifies exactly the
 * never-used rows. A renamed-but-empty session is deliberately NOT matched:
 * naming it is a statement that the viewer wants it.
 */
export function isUnusedSession(session: Session): boolean {
  return session.title === UNTITLED && session.createdAt === session.updatedAt;
}

/** Recency buckets, in the order the sidebar renders them. */
export type RecencyLabel = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';

export interface SessionGroup {
  label: RecencyLabel;
  sessions: Session[];
}

const DAY_MS = 86_400_000;

/** Local midnight at the start of the day containing `ts`. */
function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Bucket sessions by recency, newest bucket first and newest row first inside
 * each. Empty buckets are omitted, so the sidebar never shows a bare heading.
 *
 * 🔴 THE BOUNDARIES ARE CALENDAR DAYS, NOT ELAPSED HOURS. "Yesterday" has to
 * mean the previous calendar day or the heading is a lie for anyone reading it
 * at 00:30. `now` is injected so the tests are not clock-dependent.
 */
export function groupSessionsByRecency(
  sessions: Session[],
  now: number = Date.now(),
): SessionGroup[] {
  const today = startOfDay(now);
  const yesterday = today - DAY_MS;
  const weekAgo = today - 6 * DAY_MS;

  const buckets: Record<RecencyLabel, Session[]> = {
    Today: [],
    Yesterday: [],
    'Previous 7 days': [],
    Older: [],
  };

  for (const s of sortSessions(sessions)) {
    // A clock skew or a bad stored timestamp must not vanish a row: anything at
    // or after today's midnight — including the future — reads as Today.
    if (s.updatedAt >= today) buckets.Today.push(s);
    else if (s.updatedAt >= yesterday) buckets.Yesterday.push(s);
    else if (s.updatedAt >= weekAgo) buckets['Previous 7 days'].push(s);
    else buckets.Older.push(s);
  }

  return (Object.keys(buckets) as RecencyLabel[])
    .filter((label) => buckets[label].length > 0)
    .map((label) => ({ label, sessions: buckets[label] }));
}

/**
 * A compact "when" for a session row — the field that REPLACED the model name.
 *
 * The old subtitle was `session.model.split('/').pop()`, i.e. `deepseek-chat`
 * on every row, because every session uses the app's one selected model. A
 * column with the same value in every cell carries no information and costs a
 * line of height per row; the time actually separates two rows that share an
 * auto-title, which is the case the live sidebar was full of.
 */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < DAY_MS) return `${Math.floor(diff / 3_600_000)}h`;
  const days = Math.floor(diff / DAY_MS);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
