import type { UseAppStorage } from '@civitai/blocks-react';

export function fakeAppStorage(seed: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed));
  const sets: Array<{ key: string; value: unknown }> = [];
  const appStorage: UseAppStorage = {
    async get<T = unknown>(key: string) {
      return (store.has(key) ? (store.get(key) as T) : null) as T | null;
    },
    async set<T = unknown>(key: string, value: T) {
      store.set(key, value);
      sets.push({ key, value });
      return { ok: true as const };
    },
    async delete(key: string) {
      const deleted = store.delete(key);
      return { ok: true as const, deleted };
    },
    async list(opts?: { prefix?: string; limit?: number; cursor?: string }) {
      const prefix = opts?.prefix;
      const keys = [...store.keys()].filter((k) => !prefix || k.startsWith(prefix));
      return { keys: keys.map((key) => ({ key, updatedAt: new Date() })) };
    },
    async getQuota() {
      return { usedBytes: 0, rowCount: store.size, limitBytes: 50_000_000, limitRows: 1_000_000 };
    },
  };
  return { appStorage, sets, store };
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
export function fakeBlockCatalogApi(
  overrides: { models?: () => Response; images?: () => Response } = {},
) {
  const calls: CatalogCall[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get('authorization') });

    if (url.includes('/api/v1/blocks/models')) {
      return (
        overrides.models?.() ??
        new Response(JSON.stringify(BLOCK_MODELS_RESPONSE), {
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
