import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  searchModels,
  searchImages,
  findModelInResults,
  formatStat,
  clearCache,
  type ModelSearchResult,
} from './research.js';
import {
  fakeBlockCatalogApi,
  BLOCK_MODELS_RESPONSE,
} from '../test-helpers.js';

const AUTH = { token: 'block-jwt-abc' };

describe('research — transport', () => {
  let api: ReturnType<typeof fakeBlockCatalogApi>;

  beforeEach(() => {
    clearCache();
    api = fakeBlockCatalogApi();
  });

  afterEach(() => {
    api.restore();
  });

  it('searches the BLOCK catalog endpoint, not the public API', async () => {
    await searchModels('anime', AUTH);
    expect(api.calls).toHaveLength(1);
    const url = new URL(api.calls[0].url);
    expect(url.pathname).toBe('/api/v1/blocks/models');
    expect(url.searchParams.get('query')).toBe('anime');
  });

  it('sends the block token as a Bearer Authorization header', async () => {
    await searchModels('anime', AUTH);
    // Without this header the endpoint 401s — the token is required for its
    // signed maxBrowsingLevel claim, which is the whole maturity authority.
    expect(api.calls[0].authorization).toBe('Bearer block-jwt-abc');
  });

  it("sends `types` PLURAL and repeated, never a singular `type`", async () => {
    await searchModels('anime', AUTH, { types: ['Checkpoint', 'LORA'] });
    const url = new URL(api.calls[0].url);
    expect(url.searchParams.getAll('types')).toEqual(['Checkpoint', 'LORA']);
    expect(url.searchParams.get('type')).toBeNull();
  });

  it('forwards a sort that is a real ModelSort member', async () => {
    await searchModels('anime', AUTH, { sort: 'Most Downloaded' });
    expect(new URL(api.calls[0].url).searchParams.get('sort')).toBe('Most Downloaded');
  });

  it('DROPS a sort outside the ModelSort enum rather than 400ing the request', async () => {
    // `z.enum(ModelSort)` rejects the whole request, so a bad sort must never
    // reach the wire — the search would fail entirely, not just sort oddly.
    await searchModels('anime', AUTH, { sort: 'Most Popular' });
    expect(new URL(api.calls[0].url).searchParams.get('sort')).toBeNull();
  });

  it('clamps `limit` to the endpoint maximum of 100', async () => {
    await searchModels('anime', AUTH, { limit: 5000 });
    expect(new URL(api.calls[0].url).searchParams.get('limit')).toBe('100');
  });

  it('parses the REAL envelope: items + metadata.nextCursor, no top-level cursor', async () => {
    const result = await searchModels('anime', AUTH);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].name).toBe('Test Model');
    expect(result.items[0].stats.thumbsUpCount).toBe(42);
    expect(result).toHaveProperty('metadata');
    expect(result).not.toHaveProperty('nextCursor');
  });

  it('caches by URL', async () => {
    await searchModels('anime', AUTH);
    await searchModels('anime', AUTH);
    expect(api.calls).toHaveLength(1);
  });

  it('searches images by modelId and never sends a `query` param', async () => {
    // /api/v1/blocks/images has NO free-text query in its schema.
    await searchImages(AUTH, { modelId: 1234 });
    const url = new URL(api.calls[0].url);
    expect(url.pathname).toBe('/api/v1/blocks/images');
    expect(url.searchParams.get('modelId')).toBe('1234');
    expect(url.searchParams.get('query')).toBeNull();
    expect(api.calls[0].authorization).toBe('Bearer block-jwt-abc');
  });

  it('throws with the status on a non-ok catalog response', async () => {
    api.restore();
    api = fakeBlockCatalogApi({ models: () => new Response('nope', { status: 401 }) });
    await expect(searchModels('anime', AUTH)).rejects.toThrow(/401/);
  });
});

describe('research — details without a new scope', () => {
  it('derives model details from a search result', () => {
    const found = findModelInResults(BLOCK_MODELS_RESPONSE as ModelSearchResult, 1234);
    // Everything the retired /api/v1/models/{id} call fetched — and that
    // endpoint requires the `models:read:self` scope Sensei does not declare.
    expect(found?.description).toBeTruthy();
    expect(found?.type).toBe('Checkpoint');
    expect(found?.modelVersions?.[0].baseModel).toBe('SDXL 1.0');
    expect(found?.stats.thumbsUpCount).toBe(42);
  });

  it('returns null for an id that is not in the results', () => {
    expect(findModelInResults(BLOCK_MODELS_RESPONSE as ModelSearchResult, 1)).toBeNull();
    expect(findModelInResults(null, 1234)).toBeNull();
  });
});

describe('research — formatStat', () => {
  it('renders a number', () => {
    expect(formatStat(1234567)).toBe('1,234,567');
  });

  it('renders NULL as "hidden" instead of throwing', () => {
    // Creator Controls nulls downloadCount/tippedAmountCount per-owner. A bare
    // `.toLocaleString()` on that is a live TypeError.
    expect(formatStat(null)).toBe('hidden');
    expect(formatStat(undefined)).toBe('hidden');
  });
});

// 🔴 THE HEURISTIC'S TESTS WENT WITH THE HEURISTIC. `shouldRetrieve`,
// `deriveSearchQuery`, `resultsLookRelated`, `narrowQuery`, `retrieveForTurn`,
// `stripAirReferences` and `formatCatalogContext` no longer exist, so their
// suites were deleted rather than left importing missing names. What remains
// here is the catalog CLIENT the Research panel still uses.
//
// Tool calling is covered in `./tools.test.ts` and the loop in
// `../tool-calling.e2e.test.tsx`.
