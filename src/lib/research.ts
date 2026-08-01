const BASE_URL = 'https://civitai.com/api/v1';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCacheKey(url: string): string {
  return url;
}

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

async function fetchWithBackoff(url: string, retries = 2): Promise<Response> {
  const res = await fetch(url);
  if (res.status === 429 && retries > 0) {
    const retryAfter = parseInt(res.headers.get('retry-after') ?? '2', 10);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return fetchWithBackoff(url, retries - 1);
  }
  if (!res.ok) {
    throw new Error(`Civitai API error: ${res.status} ${res.statusText}`);
  }
  return res;
}

export interface ModelSearchResult {
  items: Array<{
    id: number;
    name: string;
    type: string;
    description?: string;
    stats: { downloads: number; rating: number; favorites?: number };
    modelVersions?: Array<{ id: number; name: string; baseModel: string }>;
  }>;
  nextCursor?: string | null;
}

export interface ModelDetail {
  id: number;
  name: string;
  description: string;
  type: string;
  tags: string[];
  stats: { downloads: number; rating: number; favorites: number };
  modelVersions: Array<{ id: number; name: string; baseModel: string }>;
}

export interface ImageSearchResult {
  items: Array<{
    id: number;
    url: string;
    width: number;
    height: number;
    stats?: { reactionCount: number; commentCount: number };
  }>;
  nextCursor?: string | null;
}

export async function searchModels(
  query: string,
  opts: { type?: string; sort?: string; limit?: number } = {},
): Promise<ModelSearchResult> {
  const params = new URLSearchParams({ query, limit: String(opts.limit ?? 10) });
  if (opts.type) params.set('types', opts.type);
  if (opts.sort) params.set('sort', opts.sort);

  const url = `${BASE_URL}/models?${params}`;
  const key = getCacheKey(url);
  const cached = getCached<ModelSearchResult>(key);
  if (cached) return cached;

  const res = await fetchWithBackoff(url);
  const data = (await res.json()) as ModelSearchResult;
  setCache(key, data);
  return data;
}

export async function getModelDetails(modelId: number): Promise<ModelDetail> {
  const url = `${BASE_URL}/models/${modelId}`;
  const key = getCacheKey(url);
  const cached = getCached<ModelDetail>(key);
  if (cached) return cached;

  const res = await fetchWithBackoff(url);
  const data = (await res.json()) as ModelDetail;
  setCache(key, data);
  return data;
}

export async function searchImages(
  opts: { modelId?: number; query?: string; sort?: string; limit?: number } = {},
): Promise<ImageSearchResult> {
  const params = new URLSearchParams({ limit: String(opts.limit ?? 5) });
  if (opts.modelId) params.set('modelId', String(opts.modelId));
  if (opts.query) params.set('query', opts.query);
  if (opts.sort) params.set('sort', opts.sort);

  const url = `${BASE_URL}/images?${params}`;
  const key = getCacheKey(url);
  const cached = getCached<ImageSearchResult>(key);
  if (cached) return cached;

  const res = await fetchWithBackoff(url);
  const data = (await res.json()) as ImageSearchResult;
  setCache(key, data);
  return data;
}

/** Clear the in-memory cache (for tests). */
export function clearCache(): void {
  cache.clear();
}
