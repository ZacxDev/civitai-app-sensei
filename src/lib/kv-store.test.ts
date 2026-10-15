// 🔴 THE CUTOVER MAPPING, PINNED WITH LITERALS.
//
// A hand-run script copies every viewer's legacy KV rows into the document store
// at cutover, and it writes exactly what `kv-store.ts` reads: collection `kv`,
// document key = the legacy key byte-for-byte, data = `{ value: <legacy value> }`.
// These cases are the contract that script is written against, so they assert
// RAW documents read straight out of the SDK's contract fake (bypassing the
// adapter), and they seed raw documents the way the script will — never through
// the adapter they are testing. A mapping change has to break one of them.
//
// Watched red: with `put(key, { value })` changed to `put(key, value as never)`
// and `doc?.data.value` changed to `doc?.data`, the raw-document assertions and
// the read-side cases fail (see the PR for the red/green pair).
import { describe, expect, it } from 'vitest';
import { createFakeStorage } from '@civitai/sdk/testing';

import manifest from '../../block.manifest.json';
import { createKvStorage, KV_COLLECTION, KV_LIST_LIMIT_MAX } from './kv-store.js';

function setup() {
  const docStore = createFakeStorage({ manifest });
  const raw = docStore.storage.collection(KV_COLLECTION);
  const kv = createKvStorage(() => docStore.storage);
  /** Every raw document in the collection, key order, fully paginated. */
  async function rawDocs(): Promise<Array<{ key: string; data: unknown }>> {
    const out: Array<{ key: string; data: unknown }> = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await raw.list({ limit: 100, ...(cursor ? { cursor } : {}) });
      for (const d of page.items) out.push({ key: d.key, data: d.data });
      if (page.nextCursor === null) return out;
      cursor = page.nextCursor;
    }
  }
  return { docStore, raw, kv, rawDocs };
}

const MESSAGES = [
  { id: 'msg-1', role: 'user', content: 'What is DreamShaper?', timestamp: 1_700_000_000_000 },
  { id: 'msg-2', role: 'assistant', content: 'A checkpoint.', timestamp: 1_700_000_000_500 },
];

describe('the manifest declares the one collection the mapping names', () => {
  it('`storage.collections.kv` is private, and nothing else is declared', () => {
    expect(KV_COLLECTION).toBe('kv');
    expect((manifest as { storage?: unknown }).storage).toEqual({
      collections: { kv: { visibility: 'private' } },
    });
  });

  it('the legacy KV scopes are gone and `apps:storage` replaces them', () => {
    const scopes = (manifest as { scopes: string[] }).scopes;
    expect(scopes).toContain('apps:storage');
    expect(scopes).not.toContain('apps:storage:read');
    expect(scopes).not.toContain('apps:storage:write');
  });
});

describe('write side: legacy key → same document key, data = { value }', () => {
  it('an ARRAY value (sensei:messages:<id>) is stored wrapped, at the same key', async () => {
    const { kv, rawDocs } = setup();
    await kv.set('sensei:messages:abc', MESSAGES);
    expect(await rawDocs()).toEqual([{ key: 'sensei:messages:abc', data: { value: MESSAGES } }]);
  });

  it('an OBJECT value is wrapped too — every key, no "only when needed" branch', async () => {
    const { kv, rawDocs } = setup();
    await kv.set('sensei:sessions', { sessions: [{ id: 'abc' }] });
    await kv.set('sensei:settings', { model: 'm', systemPrompt: '' });
    await kv.set('sensei:turns:session-1:1700000000000:msg-1', { outcome: 'pending' });
    expect(await rawDocs()).toEqual([
      { key: 'sensei:sessions', data: { value: { sessions: [{ id: 'abc' }] } } },
      { key: 'sensei:settings', data: { value: { model: 'm', systemPrompt: '' } } },
      {
        key: 'sensei:turns:session-1:1700000000000:msg-1',
        data: { value: { outcome: 'pending' } },
      },
    ]);
  });

  it('delete removes exactly that document, idempotently', async () => {
    const { kv, raw, rawDocs } = setup();
    await raw.put('sensei:messages:abc', { value: MESSAGES });
    await raw.put('sensei:messages:keep', { value: [] });
    await expect(kv.delete('sensei:messages:abc')).resolves.toEqual({ ok: true, deleted: true });
    await expect(kv.delete('sensei:messages:abc')).resolves.toEqual({ ok: true, deleted: false });
    expect(await rawDocs()).toEqual([{ key: 'sensei:messages:keep', data: { value: [] } }]);
  });
});

describe('read side: a document the copy script wrote reads back as the legacy value', () => {
  it('unwraps `data.value` at the same key', async () => {
    const { kv, raw } = setup();
    await raw.put('sensei:messages:abc', { value: MESSAGES });
    await raw.put('sensei:sessions', { value: { sessions: [{ id: 'abc' }] } });
    await expect(kv.get('sensei:messages:abc')).resolves.toEqual(MESSAGES);
    await expect(kv.get('sensei:sessions')).resolves.toEqual({ sessions: [{ id: 'abc' }] });
  });

  it('a missing key reads as `null`, as the legacy `get` answered', async () => {
    const { kv } = setup();
    await expect(kv.get('sensei:settings')).resolves.toBeNull();
  });
});

describe('list: keyPrefix, one page per call, the page cap respected', () => {
  it('walks every key under a prefix across pages, and nothing outside it', async () => {
    const { kv, raw } = setup();
    // 230 keys: more than two full pages at the cap, so a walker that stops after
    // one page — or a prefix that is ignored — is visible.
    const keys = Array.from(
      { length: 230 },
      (_, i) => `sensei:turns:session-1:${1_700_000_000_000 + i}:msg-${i}`,
    );
    for (const k of keys) await raw.put(k, { value: { outcome: 'saved' } });
    await raw.put('sensei:sessions', { value: { sessions: [] } });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      // Asking for MORE than the cap must not be refused — the legacy KV took 500.
      const page = await kv.list({ prefix: 'sensei:turns:', limit: 500, ...(cursor ? { cursor } : {}) });
      expect(page.keys.length).toBeLessThanOrEqual(KV_LIST_LIMIT_MAX);
      for (const e of page.keys) {
        seen.push(e.key);
        expect(e.updatedAt).toBeInstanceOf(Date);
      }
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual([...keys].sort());
  });
});
