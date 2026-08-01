import { describe, it, expect, beforeEach } from 'vitest';
import {
  listSessions,
  createSession,
  deleteSession,
  renameSession,
  getMessages,
  appendMessage,
  updateMessage,
  generateTitle,
} from './sessions.js';
import { fakeAppStorage } from '../test-helpers.js';
import type { Message } from '../types.js';

describe('sessions', () => {
  let storage: ReturnType<typeof fakeAppStorage>;

  beforeEach(() => {
    storage = fakeAppStorage();
  });

  describe('listSessions', () => {
    it('returns empty array when no sessions', async () => {
      const sessions = await listSessions(storage.appStorage);
      expect(sessions).toEqual([]);
    });

    it('returns sessions sorted by updatedAt desc', async () => {
      const s1 = await createSession(storage.appStorage, 'model-a');
      await new Promise((r) => setTimeout(r, 10));
      const s2 = await createSession(storage.appStorage, 'model-b');
      const sessions = await listSessions(storage.appStorage);
      expect(sessions[0].id).toBe(s2.id);
      expect(sessions[1].id).toBe(s1.id);
    });
  });

  describe('createSession', () => {
    it('creates a session with default title', async () => {
      const session = await createSession(storage.appStorage, 'deepseek');
      expect(session.id).toMatch(/^session-/);
      expect(session.title).toBe('New Chat');
      expect(session.model).toBe('deepseek');
      expect(session.createdAt).toBeGreaterThan(0);
    });
  });

  describe('deleteSession', () => {
    it('removes the session', async () => {
      const s = await createSession(storage.appStorage, 'model');
      await deleteSession(storage.appStorage, s.id);
      const sessions = await listSessions(storage.appStorage);
      expect(sessions).toHaveLength(0);
    });
  });

  describe('renameSession', () => {
    it('updates the title', async () => {
      const s = await createSession(storage.appStorage, 'model');
      await renameSession(storage.appStorage, s.id, 'My Chat');
      const sessions = await listSessions(storage.appStorage);
      expect(sessions[0].title).toBe('My Chat');
    });
  });

  describe('getMessages', () => {
    it('returns empty array for new session', async () => {
      const s = await createSession(storage.appStorage, 'model');
      const msgs = await getMessages(storage.appStorage, s.id);
      expect(msgs).toEqual([]);
    });
  });

  describe('appendMessage', () => {
    it('stores messages', async () => {
      const s = await createSession(storage.appStorage, 'model');
      const msg: Message = {
        id: 'msg-1',
        role: 'user',
        content: 'hello',
        timestamp: Date.now(),
      };
      await appendMessage(storage.appStorage, s.id, msg);
      const msgs = await getMessages(storage.appStorage, s.id);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe('hello');
    });
  });

  describe('updateMessage', () => {
    it('updates content of a specific message', async () => {
      const s = await createSession(storage.appStorage, 'model');
      const msg: Message = {
        id: 'msg-1',
        role: 'assistant',
        content: 'original',
        timestamp: Date.now(),
      };
      await appendMessage(storage.appStorage, s.id, msg);
      await updateMessage(storage.appStorage, s.id, 'msg-1', 'updated');
      const msgs = await getMessages(storage.appStorage, s.id);
      expect(msgs[0].content).toBe('updated');
    });
  });

  describe('generateTitle', () => {
    it('generates title from first user message', () => {
      const messages: Message[] = [
        { id: '1', role: 'user', content: 'What is LoRA?', timestamp: 0 },
        { id: '2', role: 'assistant', content: 'LoRA is...', timestamp: 0 },
      ];
      expect(generateTitle(messages)).toBe('What is LoRA?');
    });

    it('truncates long titles', () => {
      const messages: Message[] = [
        { id: '1', role: 'user', content: 'A'.repeat(60), timestamp: 0 },
      ];
      expect(generateTitle(messages)).toHaveLength(41);
      expect(generateTitle(messages)).toContain('…');
    });

    it('returns New Chat when no user messages', () => {
      expect(generateTitle([])).toBe('New Chat');
    });
  });
});
