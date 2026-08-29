// ─────────────────────────────────────────────────────────────────────────────
// THE CATALOG TRANSPORT. Every type and param name below is MIRRORED from
// civitai/civitai `origin/main`:
//
//   src/pages/api/v1/blocks/models.ts        (schema + response envelope)
//   src/pages/api/v1/blocks/images.ts        (schema + response envelope)
//   src/server/services/model-search.service.ts   (item shaping)
//   src/server/services/model.service.ts     (`stats` shape, `getStatsForModel`)
//   src/server/services/image-search.service.ts   (image item shaping)
//
// 🔴 THESE ARE THE BLOCK ENDPOINTS, NOT THE PUBLIC `/api/v1/*`. Three reasons,
// and only the first is convenience:
//
//  1. Maturity is AUTHORITATIVE here, not incidental. `/api/v1/blocks/*` clamps
//     the effective browsing level off the token's signed `maxBrowsingLevel`
//     claim and FAILS CLOSED to SFW when the claim is absent, plus a
//     region-restriction clamp. There is no `nsfw` / `browsingLevel` knob on
//     the schema at all. The public endpoints are safe only by accident of the
//     anonymous default — a fact about today's default, not a guarantee. Sensei
//     declares `contentRating: "pg13"`, so the clamp is the correct posture and
//     it is not something this app can get wrong.
//  2. They are token-gated with NO required scope. Sensei's existing token
//     works unchanged — there is deliberately no `catalog:read` scope (it was
//     added in civitai#2671 and retired the next day), so nothing needs to be
//     added to `block.manifest.json` and no new user consent prompt appears.
//  3. They opt in to `Access-Control-Allow-Origin: null`, which is what an
//     UNVERIFIED block needs: it runs sandboxed without `allow-same-origin`, so
//     its origin is opaque and it sends `Origin: null`. That opt-in is pinned
//     by a CI test upstream (`catalog-cors-wiring.test.ts`).
//
// 🔴 THE RESPONSE ENVELOPE IS `{ items, metadata: { nextCursor, nextPage } }` —
// NOT a top-level `nextCursor`, which is what this file used to declare. And a
// model's `stats` is `{ downloadCount, thumbsUpCount, thumbsDownCount,
// commentCount, tippedAmountCount }` — NOT `{ downloads, rating, favorites }`.
// The old declarations were invented, and the fixtures encoded the same
// invention, so nothing could go red. `downloadCount` and `tippedAmountCount`
// are additionally `number | null` (Creator Controls metric privacy nulls them
// per-owner) — a `.toLocaleString()` on that is a live TypeError.
// ─────────────────────────────────────────────────────────────────────────────

/** Shared by the catalog client above and the tool transport in `./tools.ts`. */
export const BLOCKS_BASE_URL = 'https://civitai.com/api/v1/blocks';

/** Canonical web URL for a model, so an answer can cite a real link. */
export function modelUrl(modelId: number): string {
  return `https://civitai.com/models/${modelId}`;
}

// ── Bounds mirrored from the endpoints' zod schemas ──────────────────────────
/** `blockModelsSchema.limit` is `.min(1).max(100)`. */
export const MODELS_LIMIT_MAX = 100;
/** `blockImagesSchema.limit` is `.min(0).max(200)`. */
export const IMAGES_LIMIT_MAX = 200;

/**
 * `ModelSort` (civitai `src/server/common/enums.ts`). The endpoint parses this
 * with `z.enum(ModelSort)`, so a value outside the set is a 400 for the WHOLE
 * request — a bad sort must be dropped here, never forwarded.
 */
export const MODEL_SORTS = [
  'Highest Rated',
  'Most Downloaded',
  'Most Liked',
  'Most Discussed',
  'Most Collected',
  'Most Images',
  'Newest',
  'Oldest',
] as const;

/** `ImageSort`, same reasoning as `MODEL_SORTS`. */
export const IMAGE_SORTS = [
  'Most Reactions',
  'Most Comments',
  'Most Collected',
  'Newest',
  'Oldest',
  'Random',
] as const;

// ── The real response contract ───────────────────────────────────────────────

/** `getStatsForModel` — every field is present; two can be `null`. */
export interface ModelStats {
  downloadCount: number | null;
  thumbsUpCount: number;
  thumbsDownCount: number;
  commentCount: number;
  tippedAmountCount: number | null;
}

export interface ModelVersionSummary {
  id: number;
  name: string;
  baseModel?: string;
}

export interface ModelSearchItem {
  id: number;
  name: string;
  type: string;
  /** HTML, and nullable — the column is nullable and the API does not coerce. */
  description?: string | null;
  tags?: string[];
  nsfw?: boolean;
  stats: ModelStats;
  modelVersions?: ModelVersionSummary[];
  creator?: { username: string; image: string | null };
}

/** `{ items, metadata, maturity }` — `maturity` is advisory; the clamp is server-side. */
export interface ModelSearchResult {
  items: ModelSearchItem[];
  metadata?: { nextCursor?: string | null; nextPage?: string | null };
  maturity?: { browsingLevel: number; sfwOnly: boolean };
}

export interface ImageSearchItem {
  id: number;
  url: string;
  width: number;
  height: number;
  nsfw: boolean;
  nsfwLevel: string;
  browsingLevel: number;
  type: string;
  postId: number | null;
  username: string;
  baseModel?: string | null;
  stats: {
    cryCount: number;
    laughCount: number;
    likeCount: number;
    dislikeCount: number;
    heartCount: number;
    commentCount: number;
  };
}

export interface ImageSearchResult {
  items: ImageSearchItem[];
  metadata?: { nextCursor?: string | null; nextPage?: string | null };
}

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached<T>(key: string): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Clear the in-memory cache (for tests). */
export function clearCache(): void {
  cache.clear();
}

// ── Transport ────────────────────────────────────────────────────────────────

/**
 * The block token's `raw` JWT — `useBlockToken().raw`.
 *
 * Taken as a PARAMETER rather than imported from a hook so this module stays a
 * plain function library that a unit test can drive without a React tree.
 */
export interface CatalogAuth {
  token: string;
}

async function fetchCatalog(url: string, token: string, retries = 2): Promise<Response> {
  // 🔴 `Authorization` makes this a non-simple request, so it ALWAYS preflights.
  // The endpoint 204s the OPTIONS and echoes `ACAO: null` for opaque origins;
  // credentials are deliberately NOT allowed, which is why the token travels in
  // a header rather than a cookie.
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  // 🔴 429 ONLY — deliberately NOT 503. The endpoint also returns a retryable
  // 503 (Meili brownout, bulkhead shed) with `Retry-After: 2`, and honouring it
  // would add up to 4 s of dead time in front of EVERY answer during a
  // backend flap. Retrieval is optional: an ungrounded answer now beats a
  // grounded one after a visible stall, and the system prompt tells the model
  // to say when nothing was attached. The rate limit is different — it is
  // keyed on this block instance and clears in a known short window.
  if (res.status === 429 && retries > 0) {
    const retryAfter = parseInt(res.headers.get('retry-after') ?? '2', 10);
    await new Promise((r) => setTimeout(r, (Number.isFinite(retryAfter) ? retryAfter : 2) * 1000));
    return fetchCatalog(url, token, retries - 1);
  }
  if (!res.ok) {
    throw new Error(`Civitai catalog error: ${res.status} ${res.statusText}`);
  }
  return res;
}

export interface SearchModelsOptions {
  /** `types` is PLURAL and ARRAY-shaped on the wire (repeat the key). */
  types?: string[];
  sort?: string;
  limit?: number;
  baseModels?: string[];
  cursor?: string;
}

/**
 * `GET /api/v1/blocks/models`.
 *
 * Param names are the endpoint's, not this app's former invention: `types`
 * (plural, repeated) rather than `type`, `sort` validated against `ModelSort`,
 * `limit` clamped to 1..100.
 */
export async function searchModels(
  query: string,
  auth: CatalogAuth,
  opts: SearchModelsOptions = {},
): Promise<ModelSearchResult> {
  const params = new URLSearchParams();
  if (query) params.set('query', query);
  params.set('limit', String(clampInt(opts.limit ?? 10, 1, MODELS_LIMIT_MAX)));
  for (const t of opts.types ?? []) params.append('types', t);
  for (const b of opts.baseModels ?? []) params.append('baseModels', b);
  if (opts.sort && (MODEL_SORTS as readonly string[]).includes(opts.sort)) {
    params.set('sort', opts.sort);
  }
  if (opts.cursor) params.set('cursor', opts.cursor);

  const url = `${BLOCKS_BASE_URL}/models?${params}`;
  const cached = getCached<ModelSearchResult>(url);
  if (cached) return cached;

  const res = await fetchCatalog(url, auth.token);
  const data = (await res.json()) as ModelSearchResult;
  setCache(url, data);
  return data;
}

export interface SearchImagesOptions {
  modelId?: number;
  modelVersionId?: number;
  postId?: number;
  sort?: string;
  limit?: number;
}

/**
 * `GET /api/v1/blocks/images`.
 *
 * 🔴 THERE IS NO FREE-TEXT `query` PARAM on this endpoint — `blockImagesSchema`
 * has none, and an unknown key is not silently dropped by an app that thinks it
 * filtered. Image search is driven by `modelId` / `modelVersionId` / `postId`,
 * which is the useful case anyway ("show me examples from this model").
 */
export async function searchImages(
  auth: CatalogAuth,
  opts: SearchImagesOptions = {},
): Promise<ImageSearchResult> {
  const params = new URLSearchParams();
  params.set('limit', String(clampInt(opts.limit ?? 5, 0, IMAGES_LIMIT_MAX)));
  if (opts.modelId != null) params.set('modelId', String(opts.modelId));
  if (opts.modelVersionId != null) params.set('modelVersionId', String(opts.modelVersionId));
  if (opts.postId != null) params.set('postId', String(opts.postId));
  if (opts.sort && (IMAGE_SORTS as readonly string[]).includes(opts.sort)) {
    params.set('sort', opts.sort);
  }

  const url = `${BLOCKS_BASE_URL}/images?${params}`;
  const cached = getCached<ImageSearchResult>(url);
  if (cached) return cached;

  const res = await fetchCatalog(url, auth.token);
  const data = (await res.json()) as ImageSearchResult;
  setCache(url, data);
  return data;
}

/**
 * Model "details", derived from a search result rather than fetched.
 *
 * 🔴 THIS IS WHY NO NEW SCOPE IS NEEDED. `/api/v1/blocks/models` shares
 * `runModelSearch` with the public endpoint, so each item ALREADY carries
 * `description`, `type`, `tags`, `stats` and `modelVersions[]` — everything the
 * old `getModelDetails` fetched from `/api/v1/models/{id}`. That endpoint is
 * `withBlockScope(..., { requiredScope: 'models:read:self' })`, so calling it
 * would cost a manifest change, a re-review and a user consent prompt for data
 * already in hand. The public `/api/v1/models/{id}` would avoid the scope but
 * bypasses the maturity clamp, which is exactly what we are here to keep.
 */
export function findModelInResults(
  results: ModelSearchResult | null | undefined,
  modelId: number,
): ModelSearchItem | null {
  return results?.items.find((m) => m.id === modelId) ?? null;
}

function clampInt(n: number, min: number, max: number): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return min;
  return Math.min(Math.max(v, min), max);
}

// ── Display helpers (used by the Research panel, not by grounding) ───────────

/**
 * Compact a count for display: 1234 -> "1.2K", 1234567 -> "1.2M".
 *
 * 🔴 SURVIVED THE HEURISTIC DELETION ON PURPOSE. It reads like part of the
 * context-assembly block that went with it, and it is not — `ResearchPanel`
 * renders it for the viewer's own manual searches, which are a different
 * feature from grounding a turn.
 */
export function formatStat(n: number | null | undefined): string {
  if (n == null) return 'hidden';
  return n.toLocaleString('en-US');
}

// ── The old client-side retrieval heuristic lived here and is GONE ──────────
//
// 🔴 DELETED, NOT DISABLED: `shouldRetrieve`, `deriveSearchQuery`,
// `resultsLookRelated`, `narrowQuery`, `retrieveForTurn`, and the context
// assembly (`formatCatalogContext` and its helpers) that injected the results
// as a system message. A stopword stripper decided the query, searched once,
// and had no way to react to what came back.
//
// The model now forms and refines its own query through real tool calling —
// see `./tools.ts`. Leaving both paths live was explicitly not acceptable:
// two grounding mechanisms means the one that is wrong is the one nobody is
// looking at.
//
// What survives above is the CATALOG CLIENT (`searchModels`, `searchImages`,
// `findModelInResults`, `modelUrl`), which the Research panel still uses for
// the viewer's own manual searches. That is a different feature from grounding
// a turn, and it was never part of the heuristic.
