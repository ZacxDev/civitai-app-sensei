import { createFakeStorage, type FakeStorage } from '@civitai/sdk/testing';

import manifest from '../block.manifest.json';
import { createKvStorage, KV_COLLECTION, KV_LIST_LIMIT_MAX, type AppStorage } from './lib/kv-store.js';

/** A stored document, as the document store holds it — what a cutover copy must produce. */
export interface RawKvDocument {
  key: string;
  data: unknown;
}

/**
 * A storage fake that IS the production adapter over the SDK's document-store fake.
 *
 * 🔴 NOT A HAND-ROLLED MAP. `appStorage` is `createKvStorage` — the module the
 * app ships — over `createFakeStorage` from `@civitai/sdk/testing`, i.e. the
 * SDK's real document-store client talking to an in-memory server that enforces
 * the platform contract against THIS repo's `block.manifest.json`: the `kv`
 * collection must be declared, the token must carry `apps:storage`, keys must be
 * legal, a document is capped, a list page is capped at 100. So every test that
 * uses this exercises the `{ value }` mapping and the manifest declaration, and a
 * manifest that stopped declaring `kv` fails every one of them.
 *
 * WHAT THE OTHER FIELDS ARE — instruments, not the store:
 *  - `store` is a synchronous MIRROR of what has COMMITTED through `appStorage`
 *    (updated only after the document store accepted the write or delete), so the
 *    existing assertions can read it without awaiting. Writing to it from a test
 *    (`store.set`, `store.delete`, `store.clear`) is FORWARDED to the document
 *    store, and every `appStorage` call waits for those forwards to land first —
 *    so a test that seeds through `store` is seeding the real store the app reads.
 *  - `sets` records committed writes in landing order; `attempts` records every
 *    `set` CALL, including ones that reject (see below).
 *  - `rawDocs()` reads the document store DIRECTLY, bypassing the adapter — the
 *    instrument for "what would the copy script / a reload see".
 *
 * 🔴 IT IS READ-YOUR-WRITES, WHICH THE DEPLOYED HOST HISTORICALLY WAS NOT. Use it
 * for anything that does not depend on read-after-write ordering; use
 * `staleReadAppStorage` below for anything that does.
 */
export function fakeAppStorage(seed: Record<string, unknown> = {}) {
  const docStore: FakeStorage = createFakeStorage({ manifest });
  const kv = createKvStorage(() => docStore.storage);

  /**
   * Test-side seeding and clearing, chained so they land in issue order. Every
   * adapter call awaits it first. A forward that FAILS (an illegal key, say)
   * rejects every later call with that error — loud, rather than a test running
   * against a store it did not seed.
   */
  let pending: Promise<unknown> = Promise.resolve();
  const forward = (op: () => Promise<unknown>) => {
    pending = pending.then(op);
  };

  class StoreMirror extends Map<string, unknown> {
    override set(key: string, value: unknown): this {
      super.set(key, value);
      forward(() => kv.set(key, value));
      return this;
    }
    override delete(key: string): boolean {
      const had = super.delete(key);
      forward(() => kv.delete(key));
      return had;
    }
    override clear(): void {
      super.clear();
      // Clear what the STORE holds, not what the mirror happens to know about.
      forward(async () => {
        for (const doc of await rawDocs()) await kv.delete(doc.key);
      });
    }
    /** Mirror-only updates, after the store accepted the operation. */
    commitSet(key: string, value: unknown): void {
      super.set(key, value);
    }
    commitDelete(key: string): void {
      super.delete(key);
    }
  }
  const store = new StoreMirror();
  for (const [key, value] of Object.entries(seed)) store.set(key, value);

  const sets: Array<{ key: string; value: unknown }> = [];
  /**
   * Every `set` CALL, including the ones that reject.
   *
   * `sets` records only what COMMITTED, so it cannot distinguish a write that
   * was never issued from one that was issued and refused — and that is exactly
   * the pair a test driving `setFailSet` has to tell apart.
   */
  const attempts: Array<{ key: string; value: unknown }> = [];
  /**
   * Per-(key, value) injected write failure. OFF by default; a test opts in with
   * `setFailSet`. Checked on the caller's own stack, before anything is sent, as
   * the previous fake did.
   */
  let failSet: (key: string, value: unknown) => boolean = () => false;

  /** Every document in the store, read directly (full pagination), key order. */
  async function rawDocs(): Promise<RawKvDocument[]> {
    const out: RawKvDocument[] = [];
    const coll = docStore.storage.collection(KV_COLLECTION);
    let cursor: string | undefined;
    for (;;) {
      const page = await coll.list({ limit: KV_LIST_LIMIT_MAX, ...(cursor ? { cursor } : {}) });
      for (const d of page.items) out.push({ key: d.key, data: d.data });
      if (page.nextCursor === null) return out;
      cursor = page.nextCursor;
    }
  }

  const appStorage: AppStorage = {
    async get<T = unknown>(key: string) {
      await pending;
      return kv.get<T>(key);
    },
    async set<T = unknown>(key: string, value: T) {
      attempts.push({ key, value });
      if (failSet(key, value)) throw new Error('kv rejected');
      await pending;
      const result = await kv.set(key, value);
      store.commitSet(key, value);
      sets.push({ key, value });
      return result;
    },
    async delete(key: string) {
      await pending;
      const result = await kv.delete(key);
      store.commitDelete(key);
      return result;
    },
    async list(opts) {
      await pending;
      return kv.list(opts);
    },
  };

  return {
    appStorage,
    sets,
    store,
    attempts,
    /** The SDK fake itself, e.g. to read `calls` or act as another caller. */
    docStore,
    rawDocs,
    /** Resolves once every test-side forward (`store.set/delete/clear`) has landed. */
    settled: () => pending.then(() => undefined),
    setFailSet(f: (key: string, value: unknown) => boolean) {
      failSet = f;
    },
  };
}

/**
 * A storage fake that MODELS THE HOST AS IT WAS DEPLOYED: a block could not see
 * its own write.
 *
 * 🔴 COPIED FROM THE HOST'S BEHAVIOUR, NOT INVENTED TO MAKE A TEST FAIL.
 * civitai's QueryClient sets `staleTime: Infinity` globally (`~/utils/trpc`) and
 * `IframeHost`'s `APP_STORAGE_GET` resolved through
 * `trpcUtils.apps.storage.get.fetch` — React Query's `fetchQuery`, which serves
 * from cache while the entry is not stale. On the branch prod deployed from, that
 * call passed NO staleTime override and `APP_STORAGE_SET` performed NO
 * invalidation, so the first read of a key was cached forever. (Fixed on `main`
 * by civitai #4456 — `blockStorageCache.ts`.) The document store is a REST route
 * with no such cache, but the persistence layer's "never read during a mutation"
 * rule (`lib/sessions.ts`) is kept, and this fixture is what keeps it honest.
 *
 * Built ON `fakeAppStorage` — the same adapter over the same SDK fake — with a
 * read cache in front of `get`:
 *  - `set` commits to the document store and does NOT touch the read cache.
 *  - `get` returns the cached value if this key has been read before; otherwise
 *    it reads the store and caches that value.
 *  - `expireReads()` models a token re-mint changing the query key.
 *
 * `committed(key)` reads the commit mirror, bypassing the cache: it is what a
 * page reload would load.
 */
export function staleReadAppStorage(seed: Record<string, unknown> = {}) {
  const base = fakeAppStorage(seed);
  const readCache = new Map<string, Promise<unknown>>();

  const appStorage: AppStorage = {
    async get<T = unknown>(key: string) {
      if (!readCache.has(key)) readCache.set(key, base.appStorage.get(key));
      return ((await readCache.get(key)) ?? null) as T | null;
    },
    set: base.appStorage.set,
    async delete(key: string) {
      readCache.delete(key);
      return base.appStorage.delete(key);
    },
    list: base.appStorage.list,
  };

  return {
    appStorage,
    sets: base.sets,
    store: base.store,
    rawDocs: base.rawDocs,
    /** What a reload would see. Bypasses the read cache on purpose. */
    committed: (key: string) => base.store.get(key) ?? null,
    /** Model a token re-mint: the query key changes, so the cache misses. */
    expireReads: () => readCache.clear(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THESE FIXTURES ARE COPIED FROM THE ENDPOINT, NOT FROM THE APP'S BELIEFS.
//
// The previous `fakePublicApi` returned `stats: { downloads, rating, favorites }`
// and a top-level `nextCursor`. The real `/api/v1/blocks/models` returns
// `stats: { downloadCount, thumbsUpCount, thumbsDownCount, commentCount,
// tippedAmountCount }` inside `{ items, metadata: { nextCursor, nextPage },
// maturity }`. Both shapes were invented, and the app read them, so a green
// suite proved only that two inventions agreed with each other — the panel that
// rendered them threw on the first real response.
//
// Sources, at civitai `origin/main`:
//   items[]         src/server/services/model-search.service.ts (`shaped`)
//   items[].stats   src/server/services/model.service.ts (`getStatsForModel`)
//   envelope        src/pages/api/v1/blocks/models.ts (`res.status(200).json`)
//   image items     src/server/services/image-search.service.ts (`shaped`)
//   image envelope  src/pages/api/v1/blocks/images.ts
//
// `downloadCount` is nullable because `getStatsForModel` writes
// `hidden.downloads ? null : …` — the SECOND fixture model exercises that.
// ─────────────────────────────────────────────────────────────────────────────

/** One item from `/api/v1/blocks/models`, trimmed to the keys this app reads. */
export const BLOCK_MODEL_ITEM = {
  id: 1234,
  name: 'Test Model',
  description: '<p>A <strong>test</strong> model.</p>',
  type: 'Checkpoint',
  nsfw: false,
  tags: ['anime', 'style'],
  creator: { username: 'tester', image: null },
  stats: {
    downloadCount: 1000,
    thumbsUpCount: 42,
    thumbsDownCount: 3,
    commentCount: 7,
    tippedAmountCount: 0,
  },
  modelVersions: [{ id: 5678, name: 'v1.0', baseModel: 'SDXL 1.0' }],
};

/** A model whose owner hid download metrics — `downloadCount` is `null`. */
export const BLOCK_MODEL_ITEM_HIDDEN_STATS = {
  id: 4321,
  name: 'Private Stats Model',
  description: null,
  type: 'LORA',
  nsfw: false,
  tags: [],
  creator: { username: 'shy', image: null },
  stats: {
    downloadCount: null,
    thumbsUpCount: 9,
    thumbsDownCount: 0,
    commentCount: 0,
    tippedAmountCount: null,
  },
  modelVersions: [{ id: 8765, name: 'v2', baseModel: 'Illustrious' }],
};

export const BLOCK_MODELS_RESPONSE = {
  items: [BLOCK_MODEL_ITEM, BLOCK_MODEL_ITEM_HIDDEN_STATS],
  metadata: { nextCursor: undefined, nextPage: undefined },
  maturity: { browsingLevel: 1, sfwOnly: true },
};

export const BLOCK_IMAGES_RESPONSE = {
  items: [
    {
      id: 9999,
      url: 'https://image.civitai.com/test.jpeg',
      hash: 'UABsxg~q00xu',
      width: 1024,
      height: 1024,
      nsfwLevel: 'None',
      type: 'image',
      nsfw: false,
      browsingLevel: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      postId: 555,
      stats: {
        cryCount: 0,
        laughCount: 1,
        likeCount: 12,
        dislikeCount: 0,
        heartCount: 4,
        commentCount: 2,
      },
      meta: null,
      username: 'tester',
      baseModel: 'SDXL 1.0',
      modelVersionIds: [5678],
    },
  ],
  metadata: { nextCursor: undefined },
};

export interface CatalogCall {
  url: string;
  authorization: string | null;
}

/**
 * Stand in for the two block catalog endpoints, recording the URL AND the
 * `Authorization` header — the header is half the contract (these routes 401
 * without a block token) so a fixture that ignored it could not tell a
 * correctly-authenticated call from an anonymous one.
 */
/**
 * The tool declarations the host serves at `GET /api/v1/blocks/tools`.
 *
 * 🔴 SERVED BY DEFAULT, because the alternative was silently wrong. Before this
 * branch existed the fake had no `/tools` case, so `fetchToolDeclarations` hit
 * the "unexpected fetch" throw, `App.tsx` swallowed it (a failed fetch degrades
 * to a tool-less conversation by design), and every suite using this helper
 * exercised the DEGRADED path while its own comment said the failure path was
 * "not silently exercised". Verified by execution: the throw fired twice per
 * run and nothing reported it.
 */
export const BLOCK_TOOLS_RESPONSE = {
  tools: [
    {
      type: 'function',
      function: {
        name: 'search_models',
        description: 'Search the Civitai model catalog.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'integer' } },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
  ],
};

/**
 * One item from `GET /api/v1/blocks/generation-resources`.
 *
 * 🔴 COPIED FROM `projectSafeGenerationResource`, NOT FROM WHAT THIS APP WANTS.
 * Source at civitai `origin/main`:
 * `src/server/schema/blocks/generation-resource-projection.ts`. That ONE
 * function builds both this endpoint's `items[]` and the host's
 * `RESOURCE_PICKER_RESULT.selected`, which is why the app models a picked and a
 * resolved resource with a single type. The field set is exact: inventing a
 * `downloadCount` or a `description` here would be the `stats.downloads` defect
 * again — a fixture agreeing with an app that agrees with nothing real.
 */
export const BLOCK_GENERATION_RESOURCE = {
  versionId: 5678,
  modelId: 1234,
  modelName: 'Test Model',
  versionName: 'v1.0',
  baseModel: 'SDXL 1.0',
  modelType: 'Checkpoint',
  strength: 1,
  minStrength: -1,
  maxStrength: 2,
  trainedWords: ['testword'],
  clipSkip: null,
};

/** A second, LoRA-family resource — the types criterion 2 widened the picker to. */
export const BLOCK_GENERATION_RESOURCE_LOCON = {
  versionId: 8765,
  modelId: 4321,
  modelName: 'Private Stats Model',
  versionName: 'v2',
  baseModel: 'Illustrious',
  modelType: 'LoCon',
  strength: 0.8,
  minStrength: -1,
  maxStrength: 2,
  trainedWords: [],
  clipSkip: 2,
};

export const BLOCK_GENERATION_RESOURCES_RESPONSE = {
  items: [BLOCK_GENERATION_RESOURCE],
  maturity: { browsingLevel: 1, sfwOnly: true },
};

export function fakeBlockCatalogApi(
  overrides: {
    models?: () => Response;
    images?: () => Response;
    tools?: () => Response;
    generationResources?: (url: string) => Response;
  } = {},
) {
  const calls: CatalogCall[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get('authorization') });

    // 🔴 MATCHED BEFORE `/blocks/models`, and the order is load-bearing rather
    // than incidental: `includes('/api/v1/blocks/models')` is a SUBSTRING test
    // and this path does not contain it — but the reverse mistake (a future
    // `/blocks/models/…` route) is the shape that silently mis-routes, so the
    // more specific path is matched first as a matter of course.
    if (url.includes('/api/v1/blocks/generation-resources')) {
      return (
        overrides.generationResources?.(url) ??
        new Response(JSON.stringify(BLOCK_GENERATION_RESOURCES_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }

    if (url.includes('/api/v1/blocks/models')) {
      return (
        overrides.models?.() ??
        new Response(JSON.stringify(BLOCK_MODELS_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }

    // Matched BEFORE `/blocks/models` would be, and kept distinct from it: a
    // tool CALL is a POST to this same path, so both verbs land here.
    if (url.includes('/api/v1/blocks/tools')) {
      return (
        overrides.tools?.() ??
        new Response(JSON.stringify(BLOCK_TOOLS_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }

    if (url.includes('/api/v1/blocks/images')) {
      return (
        overrides.images?.() ??
        new Response(JSON.stringify(BLOCK_IMAGES_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }

    // 🔴 THE PUBLIC ENDPOINTS ARE SERVED, NOT REFUSED — ON PURPOSE. A fixture
    // that 404s or falls through to the network here would make "the app
    // regressed to the public API" fail as a NETWORK ERROR, which is
    // indistinguishable from a flaky run and attributes to nothing. Serving the
    // same body leaves the URL assertion as the only discriminator, so the
    // guard that catches the regression is the one that fires.
    if (url.includes('/api/v1/models') || url.includes('/api/v1/images')) {
      return new Response(JSON.stringify(BLOCK_MODELS_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 🔴 NEVER FALL THROUGH TO THE REAL NETWORK. A unit suite that can reach
    // civitai.com is a suite whose verdict depends on civitai.com being up, and
    // an unexpected call would otherwise pass silently.
    throw new Error(`fakeBlockCatalogApi: unexpected fetch to ${url}`);
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}
