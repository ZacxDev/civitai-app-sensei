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

const BLOCKS_BASE_URL = 'https://civitai.com/api/v1/blocks';

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

// ── Retrieval policy ─────────────────────────────────────────────────────────

/**
 * Turns that are obviously not catalog lookups. Deliberately a CLOSED,
 * enumerated set rather than a fuzzy classifier: this predicate FAILS OPEN, so
 * anything not listed here is retrieved for. A false skip is the only expensive
 * mistake (the answer loses its grounding); a false retrieve costs one wasted
 * HTTP request and never any Buzz.
 */
const NON_CATALOG_TURNS = new Set([
  'hi',
  'hello',
  'hey',
  'yo',
  'thanks',
  'thank you',
  'ty',
  'ok',
  'okay',
  'k',
  'cool',
  'nice',
  'got it',
  'sure',
  'yes',
  'no',
  'yep',
  'nope',
  'bye',
  'goodbye',
  'stop',
  'continue',
  'go on',
  'more',
  'why',
  'how',
  'what',
]);

/** True when a turn should trigger a catalog search. */
export function shouldRetrieve(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[!?.,]+$/g, '')
    .replace(/\s+/g, ' ');
  if (normalized.length === 0) return false;
  if (NON_CATALOG_TURNS.has(normalized)) return false;
  return true;
}

// ── Query derivation ─────────────────────────────────────────────────────────
//
// 🔴 THE USER'S SENTENCE IS NOT A SEARCH QUERY, AND SENDING IT WAS A REAL BUG.
// `/api/v1/blocks/models` is a KEYWORD search, so an interrogative phrasing
// matches on the interrogative. Measured against the live endpoint with a
// minted block token, both HTTP 200:
//
//   "What is DreamShaper?" → 10 items, top hit "He is Unaware of What is…"
//   "DreamShaper"          → 10 items, top hit DreamShaper (1.67M downloads)
//
// The first set was then injected as authoritative catalog context, which is why
// the reply read "The search results did not include DreamShaper." The model was
// telling the truth about the garbage it was given.
//
// This is deliberately a CLOSED, enumerated stopword list rather than a
// classifier, for the same reason `NON_CATALOG_TURNS` is: it must fail toward
// searching for MORE, not less. Anything not listed survives into the query.

/**
 * Function words, interrogatives and asking-verbs. Content words a catalog
 * search can actually use — `model`, `lora`, `checkpoint`, `anime`, a name —
 * are deliberately ABSENT, so they are never stripped.
 */
const QUERY_STOPWORDS = new Set([
  // interrogatives
  'what', 'whats', "what's", 'which', 'who', 'whos', "who's", 'where', 'when',
  'why', 'how', 'whose', 'whom',
  // copulas / auxiliaries
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'doing', 'done',
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
  'have', 'has', 'had',
  // asking verbs — the user is addressing the assistant, not the catalog
  'tell', 'show', 'find', 'explain', 'describe', 'know', 'give', 'get',
  'recommend', 'suggest', 'search', 'look', 'looking', 'help',
  // pronouns / determiners / prepositions
  'i', 'me', 'my', 'mine', 'you', 'your', 'yours', 'we', 'us', 'our', 'it',
  'its', 'they', 'them', 'their', 'there', 'this', 'that', 'these', 'those',
  'a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from',
  'about', 'into', 'over', 'under', 'up', 'out', 'any', 'some', 'more', 'most',
  'and', 'or', 'but', 'if', 'so', 'than', 'then', 'as',
  // politeness / filler
  'please', 'thanks', 'thank', 'hey', 'hi', 'hello', 'ok', 'okay', 'just',
  // evaluative filler — "best anime lora" wants ANIME LORA, and leaving "best"
  // in makes the search match model NAMES containing the word "Best". Measured
  // against the live endpoint: "best anime lora" → "Best Studio Ghibli LoRA
  // Style"; "anime lora" → "Anime LoRA - Makoto Shinkai Anime Style".
  // 'top' is deliberately NOT here — it is a real tag on this catalog.
  'best', 'better', 'good', 'great', 'nice', 'cool', 'favourite', 'favorite',
  'popular',
]);

/**
 * How many terms survive into the query. A keyword search degrades as terms are
 * added — every extra token is another way to match something irrelevant — and
 * a user sentence long enough to exceed this is one whose subject is in the
 * first few content words anyway.
 */
export const MAX_QUERY_TERMS = 8;

/** Split into comparable lowercase terms. Shared by derivation and scoring. */
function toTerms(text: string): string[] {
  return text
    .replace(/[?!.,;:()[\]{}"“”'’`]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Turn a conversational turn into a keyword query.
 *
 * A QUOTED PHRASE WINS OUTRIGHT — someone who writes `"Pony Diffusion"` has told
 * us the exact string they mean, and no amount of stopword logic beats that.
 *
 * FAILS BACK TO THE ORIGINAL TEXT rather than to an empty query: an empty
 * `query` param makes the endpoint return an unfiltered listing, which is worse
 * than an over-broad search because it looks like a result set.
 */
export function deriveSearchQuery(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  if (!cleaned) return '';

  const quoted = cleaned.match(/["“'’]([^"“”'’]{2,80})["”'’]/);
  if (quoted?.[1]?.trim()) return quoted[1].trim();

  const kept = toTerms(cleaned).filter((t) => !QUERY_STOPWORDS.has(t.toLowerCase()));
  if (kept.length === 0) return cleaned.replace(/[?!.,;:]+$/g, '').trim();
  return kept.slice(0, MAX_QUERY_TERMS).join(' ');
}

/**
 * Does this result set plausibly answer this query?
 *
 * Deliberately a WEAK, deterministic test — one result whose NAME contains one
 * query term — not a relevance model. It exists to catch the one failure that
 * actually happened (a query whose terms appear nowhere in any hit) and must not
 * reject a legitimately fuzzy match.
 *
 * Returns `true` for an empty query or an empty term set, because "unrelated" is
 * not a claim we can make there.
 */
export function resultsLookRelated(
  results: ModelSearchResult | null | undefined,
  query: string,
): boolean {
  const terms = toTerms(query)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3);
  if (terms.length === 0) return true;
  const items = results?.items ?? [];
  if (items.length === 0) return false;
  return items.some((m) => {
    const name = m.name.toLowerCase();
    return terms.some((t) => name.includes(t));
  });
}

/**
 * The narrower retry: the single most distinctive term.
 *
 * Longest-token is a crude proxy for distinctiveness and that is on purpose —
 * it needs no corpus, no scoring and no network, and the case it exists for is
 * a multi-word query where one word is a model name. Returns `null` when there
 * is nothing to narrow, so the caller keeps the first result rather than
 * re-running the same search.
 */
export function narrowQuery(query: string): string | null {
  const terms = toTerms(query).filter((t) => t.length >= 3);
  if (terms.length < 2) return null;
  const longest = terms.reduce((a, b) => (b.length > a.length ? b : a));
  return longest === query.trim() ? null : longest;
}

/** What actually grounded a turn: the query used, and what it returned. */
export interface TurnRetrieval {
  /** The query SENT to the endpoint — not the user's sentence. */
  query: string;
  results: ModelSearchResult | null;
  /** True when the first query looked unrelated and the narrow retry was used. */
  narrowed: boolean;
}

/**
 * Retrieve catalog context for one conversational turn: derive the query, search,
 * and retry once narrowed if the hits look unrelated to what was asked.
 *
 * At most TWO requests, and never any Buzz — retrieval is plain HTTP.
 */
export async function retrieveForTurn(
  text: string,
  auth: CatalogAuth,
  opts: SearchModelsOptions = {},
): Promise<TurnRetrieval> {
  const query = deriveSearchQuery(text);
  const results = await searchModels(query, auth, opts);
  if (resultsLookRelated(results, query)) return { query, results, narrowed: false };

  const narrow = narrowQuery(query);
  if (!narrow) return { query, results, narrowed: false };

  const retried = await searchModels(narrow, auth, opts);
  // Keep the retry ONLY if it is actually better. A narrow query that also
  // misses leaves the viewer with a query string in the panel that explains
  // nothing about the (broader) results they can see.
  if (resultsLookRelated(retried, narrow)) return { query: narrow, results: retried, narrowed: true };
  return { query, results, narrowed: false };
}

// ── Context assembly ─────────────────────────────────────────────────────────

/**
 * The injection budget.
 *
 * 🔴 THE BUDGET IS NOT `maxTokens`. `maxTokens` bounds GENERATED tokens only
 * ("Maximum number of tokens to generate" — `ChatCompletionInput.maxTokens`),
 * so injected context does not compete with answer length at all. What DOES
 * bound this is the host's per-message cap, `MAX_MESSAGE_CHARS = 8_000`
 * (`chatMessageSchema.content` is `.min(1).max(8000)`), which is a hard REJECT
 * of the whole request rather than a truncation.
 *
 * 6,000 sits deliberately below that with ~2,000 chars of headroom, so the
 * grounding preamble plus an unusually verbose result set can never turn a
 * question into a `BAD_REQUEST`. Per-record caps keep one long description from
 * eating the whole budget. The remaining lever is attention cost, not capacity.
 */
export const MAX_CONTEXT_CHARS = 6_000;
export const MAX_DESCRIPTION_CHARS = 300;
export const MAX_CONTEXT_MODELS = 8;

/**
 * 🔴 THE `urn:air:` STRIP IS MANDATORY, NOT COSMETIC.
 *
 * The host runs `containsAirReference` over the ENTIRE built input — every
 * string, array element, object value and object key — and a hit is a hard
 * `FORBIDDEN` before the Buzz quote. It is a case-insensitive SUBSTRING scan,
 * so it does not care that the literal arrived inside a model description we
 * merely quoted. One retrieved description carrying that literal would bounce
 * the user's whole question with an error that names nothing they typed.
 *
 * The step's own header names this as the app's job: "`messages[].content` is
 * assembled by the block, which can strip or escape the literal before
 * submitting."
 */
export function stripAirReferences(text: string): string {
  return text.replace(/urn:air:/gi, 'urn-air-');
}

/** Civitai model descriptions are HTML. Flatten for a text prompt. */
function toPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** `downloadCount` / `tippedAmountCount` are nullable — render the absence. */
export function formatStat(n: number | null | undefined): string {
  if (n == null) return 'hidden';
  return n.toLocaleString('en-US');
}

function formatModelRecord(model: ModelSearchItem): string {
  const versions = (model.modelVersions ?? [])
    .slice(0, 3)
    .map((v) => (v.baseModel ? `${v.name} (${v.baseModel})` : v.name))
    .join(', ');
  const description = model.description
    ? truncate(toPlainText(model.description), MAX_DESCRIPTION_CHARS)
    : '';

  const lines = [
    `- ${model.name} [id ${model.id}] — ${model.type}`,
    `  url: ${modelUrl(model.id)}`,
    `  downloads: ${formatStat(model.stats?.downloadCount)} · 👍 ${formatStat(
      model.stats?.thumbsUpCount,
    )} · 👎 ${formatStat(model.stats?.thumbsDownCount)}`,
  ];
  if (versions) lines.push(`  versions: ${versions}`);
  if (model.tags?.length) lines.push(`  tags: ${model.tags.slice(0, 8).join(', ')}`);
  if (description) lines.push(`  about: ${description}`);
  return lines.join('\n');
}

/**
 * The first line of an injected catalog message.
 *
 * 🔴 A MARKER IS NOT A GUARD. The system prompt has to NAME this label so the
 * model knows what it is looking at, which means the phrase appears in two
 * messages — so "some message contains the marker" is satisfied by the prompt
 * alone and would pass with retrieval completely broken. Tests must identify
 * the catalog message STRUCTURALLY (a `system` message that is not the leading
 * app prompt) and use this constant only as a secondary check.
 */
export const CATALOG_CONTEXT_MARKER = 'CIVITAI CATALOG RESULTS';

const CONTEXT_HEADER =
  CATALOG_CONTEXT_MARKER +
  ' (retrieved live for this turn, already filtered to the ' +
  'browsing level this app is allowed to show). Use ONLY these records for claims ' +
  'about specific models, their ids, stats or links. If they do not answer the ' +
  "question, say the search did not turn it up — do not invent a model, an id or a URL.";

/**
 * Compact a search result into one bounded `system` message body.
 *
 * Returns `''` when there is nothing to inject, so the caller can skip the
 * message entirely — an empty `content` is `.min(1)` on the host and would be
 * a `BAD_REQUEST`.
 */
export function formatCatalogContext(
  results: ModelSearchResult | null | undefined,
  query?: string,
): string {
  const head = query ? `${CONTEXT_HEADER}\nQuery: ${query}` : CONTEXT_HEADER;
  let out = head;

  // 🔴 THE BUDGET IS ENFORCED PER WHOLE RECORD, AND A TRAILING SLICE WOULD NOT
  // BE THE SAME THING. Dropping a record that does not fit keeps every record
  // that IS present complete — id, url and stats intact. Assembling everything
  // and slicing the tail to the same length would instead hand the model a
  // record cut mid-field: a truncated URL, or a name with no id, presented in
  // the same authoritative frame as the real ones. That is worse than omitting
  // it. (A mutation sweep found this: with a trailing `.slice()` also in place,
  // deleting this `break` changed nothing any test could see, because the slice
  // silently did the bounding. The slice is gone; this is the only bound.)
  for (const model of (results?.items ?? []).slice(0, MAX_CONTEXT_MODELS)) {
    const record = `\n\n${formatModelRecord(model)}`;
    if (out.length + record.length > MAX_CONTEXT_CHARS) break;
    out += record;
  }

  // No records — nothing was returned, or nothing fitted. Either way there is
  // no grounding to offer, and an empty `content` is a `.min(1)` BAD_REQUEST.
  if (out === head) return '';

  return stripAirReferences(out);
}
