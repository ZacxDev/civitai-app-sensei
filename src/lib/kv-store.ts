// The app's key/value surface, over ONE private collection of the App Blocks
// document store.
//
// Sensei was written against the legacy per-viewer KV (`app.storage.get/set/
// delete/list`, scopes `apps:storage:read` + `apps:storage:write`). That store is
// deprecated; the document store (`app.storage.collection(name)`, scope
// `apps:storage`) replaces it. This module is the whole port: every call site
// keeps the get/set/delete/list shape it already had, and only this file knows
// documents exist.
//
// 🔴 THE MAPPING IS FIXED, AND SOMETHING OUTSIDE THIS REPO DEPENDS ON IT EXACTLY.
// Existing viewers' data is copied from the legacy KV into the document store by
// a separate, hand-run script at cutover. That script writes what this module
// reads, so changing any of the three rules below strands every copied row:
//
//   1. ONE collection, named `kv`, declared `private` in `block.manifest.json`.
//   2. Document key = the legacy KV key, byte-for-byte (`sensei:sessions`,
//      `sensei:settings`, `sensei:messages:<sessionId>`,
//      `sensei:turns:<sessionId>:<submittedAt>:<messageId>`).
//   3. Document data = `{ value: <the legacy value> }` — ALWAYS wrapped, for every
//      key. Not an optimisation target: a document's data must be an object and a
//      legacy `sensei:messages:*` value is a JSON ARRAY, so "wrap only when needed"
//      would make the shape depend on the value and the copy script would have to
//      reproduce that rule. One rule, no branch.
//
// `src/lib/kv-store.test.ts` pins all three with literal values against
// `createFakeStorage` (the SDK's own client over an in-memory server that enforces
// the manifest), and was watched failing with the wrapping removed.

import type { DocumentStorage, StorageCollection } from '@civitai/sdk';

/** The one collection. Must match `block.manifest.json` → `storage.collections`. */
export const KV_COLLECTION = 'kv';

/**
 * The largest page `list` may ask for.
 *
 * 🔴 A LARGER `limit` IS REFUSED, NOT CLAMPED: the document store answers
 * `invalid_request` ("limit must be 1–100"). The sweeps in `turn-records.ts`
 * swallow every rejection by design, so an unclamped request is a SILENT no-op —
 * which is exactly what happened on the legacy KV: its list route has capped
 * `limit` at 200 since 2026-06-13, sensei asked for 500, and pruning/purging
 * never ran there. `info().limits
 * .listLimitMax` is the server's live figure; 100 is the contract's, and asking
 * for at most that is correct whatever the live figure is above it.
 */
export const KV_LIST_LIMIT_MAX = 100;

/** The stored document's data. See rule 3 above. */
export interface KvDocument {
  value: unknown;
}

/** One row of a key listing. `updatedAt` is the document's, revived to a `Date`. */
export interface AppStorageKeyEntry {
  key: string;
  updatedAt: Date;
}

export interface AppStorageListResult {
  keys: AppStorageKeyEntry[];
  /** Absent exactly when this was the last page. */
  nextCursor?: string;
}

/**
 * The key/value surface this app consumes — the shape it was written against.
 *
 * Every failure REJECTS (the document store's `StorageError`), exactly as the
 * legacy client did; nothing here turns a refusal into an empty result. That is
 * what lets `App.tsx`'s `persist` and boot loader tell "nothing stored" from
 * "could not read", and what `src/anon-boot-storage.e2e.test.tsx` pins.
 */
export interface AppStorage {
  /** The stored value, or `null` when the key has never been written (or was deleted). */
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<{ ok: true }>;
  delete(key: string): Promise<{ ok: true; deleted: boolean }>;
  /** ONE page of keys under `prefix`. Follow `nextCursor` for the next. */
  list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<AppStorageListResult>;
}

/**
 * Build the app's KV surface over a document store.
 *
 * `docs` is called per operation rather than once, so the production caller can
 * hand in "await the AppClient" and the façade stays a stable object that exists
 * before the handshake lands — the property `useKvStore` documents and
 * `App.tsx`'s dependency arrays rely on.
 */
export function createKvStorage(
  docs: () => DocumentStorage | Promise<DocumentStorage>,
): AppStorage {
  const kv = async (): Promise<StorageCollection<KvDocument>> =>
    (await docs()).collection<KvDocument>(KV_COLLECTION);

  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const doc = await (await kv()).get(key);
      // Missing → `null`, which is what the legacy `get` answered for a key never
      // written. A document whose data somehow lacks `value` reads as missing
      // too, rather than handing the caller `undefined` it never had to handle.
      return (doc?.data.value ?? null) as T | null;
    },
    async set<T = unknown>(key: string, value: T): Promise<{ ok: true }> {
      await (await kv()).put(key, { value });
      return { ok: true };
    },
    async delete(key: string): Promise<{ ok: true; deleted: boolean }> {
      const { deleted } = await (await kv()).delete(key);
      return { ok: true, deleted };
    },
    async list(opts = {}): Promise<AppStorageListResult> {
      const limit = Math.min(Math.max(1, opts.limit ?? KV_LIST_LIMIT_MAX), KV_LIST_LIMIT_MAX);
      const page = await (await kv()).list({
        ...(opts.prefix !== undefined ? { keyPrefix: opts.prefix } : {}),
        limit,
        ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
      });
      return {
        keys: page.items.map((doc) => ({ key: doc.key, updatedAt: doc.updatedAt })),
        ...(page.nextCursor !== null ? { nextCursor: page.nextCursor } : {}),
      };
    },
  };
}
