import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  searchModels,
  searchImages,
  findModelInResults,
  formatCatalogContext,
  stripAirReferences,
  formatStat,
  shouldRetrieve,
  clearCache,
  modelUrl,
  MAX_CONTEXT_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_CONTEXT_MODELS,
  type ModelSearchResult,
  type ModelSearchItem,
} from './research.js';
import {
  fakeBlockCatalogApi,
  BLOCK_MODEL_ITEM,
  BLOCK_MODEL_ITEM_HIDDEN_STATS,
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

describe('research — shouldRetrieve', () => {
  it('retrieves for a catalog-shaped question', () => {
    expect(shouldRetrieve('best anime lora for illustrious')).toBe(true);
  });

  it('skips a bare pleasantry', () => {
    expect(shouldRetrieve('thanks')).toBe(false);
    expect(shouldRetrieve('Thanks!')).toBe(false);
    expect(shouldRetrieve('  hi  ')).toBe(false);
  });

  it('skips an empty turn', () => {
    expect(shouldRetrieve('   ')).toBe(false);
  });

  it('FAILS OPEN — an unlisted turn is retrieved for', () => {
    // The cost asymmetry: a false skip loses the grounding, a false retrieve
    // costs one HTTP request and no Buzz.
    expect(shouldRetrieve('what is CFG scale')).toBe(true);
    expect(shouldRetrieve('explain samplers')).toBe(true);
  });
});

describe('research — stripAirReferences', () => {
  it('neutralises the literal in any case', () => {
    expect(stripAirReferences('see urn:air:sdxl:checkpoint')).toBe('see urn-air-sdxl:checkpoint');
    expect(stripAirReferences('URN:AIR:x')).toBe('urn-air-x');
    expect(stripAirReferences('Urn:Air:x')).toBe('urn-air-x');
  });

  it('leaves unrelated text alone', () => {
    expect(stripAirReferences('an urn in the air')).toBe('an urn in the air');
  });
});

describe('research — formatCatalogContext', () => {
  const results = BLOCK_MODELS_RESPONSE as ModelSearchResult;

  it('emits id, type, canonical url and stats', () => {
    const ctx = formatCatalogContext(results, 'anime');
    expect(ctx).toContain('Test Model');
    expect(ctx).toContain('[id 1234]');
    expect(ctx).toContain('Checkpoint');
    expect(ctx).toContain(modelUrl(1234));
    expect(ctx).toContain('👍 42');
  });

  it('renders a nulled downloadCount without throwing', () => {
    const ctx = formatCatalogContext(results);
    expect(ctx).toContain('Private Stats Model');
    expect(ctx).toContain('downloads: hidden');
  });

  it('flattens HTML descriptions', () => {
    const ctx = formatCatalogContext(results);
    expect(ctx).toContain('A test model.');
    expect(ctx).not.toContain('<strong>');
  });

  it('returns EMPTY STRING for no results, so no empty system message is sent', () => {
    // `chatMessageSchema.content` is `.min(1)` — an empty message is a
    // BAD_REQUEST for the whole request, not a message the host drops.
    expect(formatCatalogContext({ items: [] })).toBe('');
    expect(formatCatalogContext(null)).toBe('');
  });

  it('strips `urn:air:` out of a retrieved description', () => {
    const poisoned: ModelSearchResult = {
      items: [{ ...BLOCK_MODEL_ITEM, description: 'use urn:air:sdxl:checkpoint:civitai' }],
    };
    const ctx = formatCatalogContext(poisoned);
    // Positive control: the literal IS present in the un-stripped assembly, so
    // a passing assertion below means the strip fired rather than that the
    // fixture never contained it.
    expect(poisoned.items[0].description).toContain('urn:air:');
    expect(ctx.toLowerCase()).not.toContain('urn:air:');
    expect(ctx).toContain('urn-air-');
  });

  it('truncates a long description to the per-record cap', () => {
    const long: ModelSearchResult = {
      items: [{ ...BLOCK_MODEL_ITEM, description: 'x'.repeat(5000) }],
    };
    const ctx = formatCatalogContext(long);
    expect(ctx).not.toContain('x'.repeat(MAX_DESCRIPTION_CHARS + 1));
    expect(ctx).toContain('…');
  });

  // 🔴 TWO BUDGET REGIMES, MEASURED AT BOTH. `MAX_CONTEXT_MODELS` (a COUNT cap)
  // and `MAX_CONTEXT_CHARS` (a SIZE cap) are different guards, and whichever
  // binds first hides the other. With modest records the count cap binds and the
  // size cap never executes — a mutation sweep proved that, surviving the
  // deletion of the size check entirely. Only records fat enough to blow the
  // budget within 8 items reach it.
  function richModel(i: number, descChars: number): ModelSearchItem {
    return {
      ...BLOCK_MODEL_ITEM,
      id: 1000 + i,
      name: `Ultra Detailed Photorealistic Portrait Mix v${i} — SDXL Edition`,
      description: 'y'.repeat(descChars),
      tags: Array.from({ length: 8 }, (_, t) => `descriptive-tag-number-${t}`),
      modelVersions: Array.from({ length: 3 }, (_, v) => ({
        id: v,
        name: `version-${v}-pruned-fp16`,
        baseModel: 'SDXL 1.0',
      })),
    };
  }

  it('keeps every record when the count cap binds first', () => {
    const modest: ModelSearchResult = {
      items: Array.from({ length: 40 }, (_, i) => richModel(i, 60)),
    };
    const ctx = formatCatalogContext(modest);
    expect(ctx.split('\n\n').slice(1)).toHaveLength(MAX_CONTEXT_MODELS);
    expect(ctx.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
  });

  it('DROPS records once the char budget binds, and never truncates one', () => {
    // Full-length descriptions push 8 rich records past 6,000 chars, so the
    // size guard is the one that fires here.
    const fat: ModelSearchResult = {
      items: Array.from({ length: 40 }, (_, i) => richModel(i, MAX_DESCRIPTION_CHARS + 200)),
    };
    const ctx = formatCatalogContext(fat);
    const records = ctx.split('\n\n').slice(1);

    expect(ctx.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    // And well under the host's hard 8,000-char per-message reject.
    expect(ctx.length).toBeLessThan(8_000);
    // The size guard actually bound: fewer records than the count cap allows.
    expect(records.length).toBeGreaterThan(0);
    expect(records.length).toBeLessThan(MAX_CONTEXT_MODELS);

    // 🔴 EVERY RECORD PRESENT IS COMPLETE — this is what distinguishes a
    // per-record budget from "assemble everything, slice the tail". A trailing
    // slice yields the same LENGTH while leaving the last record cut mid-field,
    // so a length assertion alone cannot tell the two apart.
    for (const r of records) {
      expect(r).toMatch(/^- .+ \[id \d+] — /);
      expect(r).toContain('url: https://civitai.com/models/');
      expect(r).toContain('downloads: ');
    }
  });

  it('emits no context at all when not even one record fits', () => {
    // Exercises the `out === head` guard on its own: an empty result set has no
    // record to add, so the assembly never grows past the header.
    expect(formatCatalogContext({ items: [] }, 'anything')).toBe('');
  });

  it('never returns a header-only body', () => {
    const oversized: ModelSearchResult = {
      items: [{ ...BLOCK_MODEL_ITEM, description: 'z'.repeat(20_000) }],
    };
    const ctx = formatCatalogContext(oversized);
    // One record fits (descriptions are capped), so we get real content.
    expect(ctx).toContain('[id 1234]');
  });

  it('includes hidden-stat models alongside normal ones', () => {
    const ctx = formatCatalogContext({ items: [BLOCK_MODEL_ITEM_HIDDEN_STATS] });
    expect(ctx).toContain('[id 4321]');
    expect(ctx).toContain('LORA');
  });
});
