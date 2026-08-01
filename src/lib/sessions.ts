import type { UseAppStorage } from '@civitai/blocks-react';
import type { Message, Session } from '../types.js';
import { serializeMessages, deserializeMessages } from './chat.js';

const SESSIONS_KEY = 'sensei:sessions';
const MESSAGES_PREFIX = 'sensei:messages:';

interface SessionsData {
  sessions: Session[];
}

export async function listSessions(appStorage: UseAppStorage): Promise<Session[]> {
  const data = await appStorage.get<SessionsData>(SESSIONS_KEY);
  const sessions = data?.sessions ?? [];
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createSession(
  appStorage: UseAppStorage,
  model: string,
): Promise<Session> {
  const session: Session = {
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: 'New Chat',
    model,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const existing = await listSessions(appStorage);
  await appStorage.set(SESSIONS_KEY, { sessions: [session, ...existing] });
  return session;
}

export async function deleteSession(
  appStorage: UseAppStorage,
  sessionId: string,
): Promise<void> {
  const existing = await listSessions(appStorage);
  const filtered = existing.filter((s) => s.id !== sessionId);
  await appStorage.set(SESSIONS_KEY, { sessions: filtered });
  await appStorage.delete(`${MESSAGES_PREFIX}${sessionId}`);
}

export async function renameSession(
  appStorage: UseAppStorage,
  sessionId: string,
  title: string,
): Promise<void> {
  const existing = await listSessions(appStorage);
  const updated = existing.map((s) =>
    s.id === sessionId ? { ...s, title, updatedAt: Date.now() } : s,
  );
  await appStorage.set(SESSIONS_KEY, { sessions: updated });
}

export async function getMessages(
  appStorage: UseAppStorage,
  sessionId: string,
): Promise<Message[]> {
  const stored = await appStorage.get<import('./chat.js').StoredMessage[]>(
    `${MESSAGES_PREFIX}${sessionId}`,
  );
  return stored ? deserializeMessages(stored) : [];
}

export async function appendMessage(
  appStorage: UseAppStorage,
  sessionId: string,
  message: Message,
): Promise<void> {
  const existing = await getMessages(appStorage, sessionId);
  await appStorage.set(`${MESSAGES_PREFIX}${sessionId}`, serializeMessages([...existing, message]));

  // Update session timestamp
  const sessions = await listSessions(appStorage);
  const updated = sessions.map((s) =>
    s.id === sessionId ? { ...s, updatedAt: Date.now() } : s,
  );
  await appStorage.set(SESSIONS_KEY, { sessions: updated });
}

export async function updateMessage(
  appStorage: UseAppStorage,
  sessionId: string,
  messageId: string,
  content: string,
): Promise<void> {
  const messages = await getMessages(appStorage, sessionId);
  const updated = messages.map((m) =>
    m.id === messageId ? { ...m, content } : m,
  );
  await appStorage.set(`${MESSAGES_PREFIX}${sessionId}`, serializeMessages(updated));
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
