import { describe, it, expect, beforeEach } from 'vitest';
import {
  listSessions,
  saveSessions,
  createSessionRecord,
  withTitle,
  touched,
  without,
  sortSessions,
  getMessages,
  saveMessages,
  deleteMessages,
  generateTitle,
} from './sessions.js';
import { fakeAppStorage, staleReadAppStorage } from '../test-helpers.js';
import type { Message, Session } from '../types.js';

const msg = (id: string, role: Message['role'], content: string, t = 0): Message => ({
  id,
  role,
  content,
  timestamp: t,
});

describe('sessions', () => {
  let storage: ReturnType<typeof fakeAppStorage>;

  beforeEach(() => {
    storage = fakeAppStorage();
  });

  describe('listSessions', () => {
    it('returns empty array when no sessions', async () => {
      expect(await listSessions(storage.appStorage)).toEqual([]);
    });

    it('returns sessions sorted by updatedAt desc', async () => {
      const older: Session = { ...createSessionRecord('model-a'), updatedAt: 1000 };
      const newer: Session = { ...createSessionRecord('model-b'), updatedAt: 2000 };
      await saveSessions(storage.appStorage, [older, newer]);
      const sessions = await listSessions(storage.appStorage);
      expect(sessions.map((s) => s.id)).toEqual([newer.id, older.id]);
    });
  });

  describe('createSessionRecord', () => {
    it('is PURE — it builds a record and touches no storage', () => {
      const session = createSessionRecord('deepseek');
      expect(session.id).toMatch(/^session-/);
      expect(session.title).toBe('New Chat');
      expect(session.model).toBe('deepseek');
      expect(session.createdAt).toBeGreaterThan(0);
      expect(storage.sets).toHaveLength(0);
    });
  });

  describe('the pure list transforms', () => {
    const a: Session = { id: 'a', title: 'New Chat', model: 'm', createdAt: 1, updatedAt: 1 };
    const b: Session = { id: 'b', title: 'Other', model: 'm', createdAt: 2, updatedAt: 2 };

    it('withTitle retitles and touches only the target', () => {
      const out = withTitle([a, b], 'a', 'Titled', 99);
      expect(out[0]).toEqual({ ...a, title: 'Titled', updatedAt: 99 });
      expect(out[1]).toBe(b);
    });

    it('touched bumps only the target', () => {
      const out = touched([a, b], 'b', 42);
      expect(out[0]).toBe(a);
      expect(out[1]).toEqual({ ...b, updatedAt: 42 });
    });

    it('without drops only the target', () => {
      expect(without([a, b], 'a')).toEqual([b]);
    });

    it('sortSessions does not mutate its input', () => {
      const input = [a, b];
      expect(sortSessions(input).map((s) => s.id)).toEqual(['b', 'a']);
      expect(input.map((s) => s.id)).toEqual(['a', 'b']);
    });
  });

  describe('saveMessages / getMessages', () => {
    it('round-trips the whole array', async () => {
      await saveMessages(storage.appStorage, 's1', [msg('m1', 'user', 'hello')]);
      const msgs = await getMessages(storage.appStorage, 's1');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe('hello');
    });

    it('deleteMessages drops the key', async () => {
      await saveMessages(storage.appStorage, 's1', [msg('m1', 'user', 'hello')]);
      await deleteMessages(storage.appStorage, 's1');
      expect(await getMessages(storage.appStorage, 's1')).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 THE REGRESSION GUARD FOR THE LOST-USER-MESSAGE DEFECT.
  //
  // These run against `staleReadAppStorage`, which models the DEPLOYED host: a
  // `get` is served from a per-key cache that a `set` never invalidates. Under
  // that storage the old read-modify-write `appendMessage` computed the second
  // write from a pre-first-write snapshot and dropped the user message — the
  // exact loss read out of `app_sensei.kv` in production.
  //
  // What makes this a REGRESSION test and not an invariant guard: it fails at
  // the pre-fix commit, because the pre-fix module has no way to express "write
  // the array I already hold".
  // ───────────────────────────────────────────────────────────────────────────
  describe('under a host that cannot serve a block its own write', () => {
    it('a two-write interaction keeps BOTH writes', async () => {
      const stale = staleReadAppStorage();
      // Whatever the app does first, populates the cache with the pre-write value.
      expect(await getMessages(stale.appStorage, 's1')).toEqual([]);

      const afterUser = [msg('m1', 'user', 'question')];
      await saveMessages(stale.appStorage, 's1', afterUser);
      // …the read here is STALE, and this is the whole point: the app must not
      // need it. It writes the array it already holds.
      await saveMessages(stale.appStorage, 's1', [...afterUser, msg('m2', 'assistant', 'answer')]);

      expect(stale.committed('sensei:messages:s1')).toEqual([
        expect.objectContaining({ id: 'm1', role: 'user' }),
        expect.objectContaining({ id: 'm2', role: 'assistant' }),
      ]);
    });

    it('the fixture is FAITHFUL: a stale read really does return the pre-write value', async () => {
      // 🔴 POSITIVE CONTROL. Without this, a fixture that quietly behaved like a
      // read-your-writes store would make the test above pass for the wrong
      // reason and prove nothing about the host it claims to model.
      const stale = staleReadAppStorage();
      expect(await getMessages(stale.appStorage, 's1')).toEqual([]);
      await saveMessages(stale.appStorage, 's1', [msg('m1', 'user', 'question')]);
      expect(await getMessages(stale.appStorage, 's1')).toEqual([]);
      expect(stale.committed('sensei:messages:s1')).toHaveLength(1);
    });

    it('a title write is not undone by a later session write', async () => {
      const stale = staleReadAppStorage();
      const s = { ...createSessionRecord('m'), id: 's1', updatedAt: 1 };
      await saveSessions(stale.appStorage, [s]);
      await listSessions(stale.appStorage); // caches the pre-title value

      const titled = withTitle([s], 's1', 'Real title', 10);
      await saveSessions(stale.appStorage, titled);
      // Then a later touch, computed from the SAME in-memory list — not a re-read.
      await saveSessions(stale.appStorage, touched(titled, 's1', 20));

      const committed = stale.committed('sensei:sessions') as { sessions: Session[] };
      expect(committed.sessions[0].title).toBe('Real title');
      expect(committed.sessions[0].updatedAt).toBe(20);
    });
  });

  describe('generateTitle', () => {
    it('generates title from first user message', () => {
      const messages: Message[] = [
        msg('1', 'user', 'What is LoRA?'),
        msg('2', 'assistant', 'LoRA is...'),
      ];
      expect(generateTitle(messages)).toBe('What is LoRA?');
    });

    it('truncates long titles', () => {
      const messages: Message[] = [msg('1', 'user', 'A'.repeat(60))];
      expect(generateTitle(messages)).toHaveLength(41);
      expect(generateTitle(messages)).toContain('…');
    });

    it('returns New Chat when no user messages', () => {
      expect(generateTitle([])).toBe('New Chat');
    });
  });
});
