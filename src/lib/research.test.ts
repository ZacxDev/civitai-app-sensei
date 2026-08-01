import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  searchModels,
  getModelDetails,
  searchImages,
  clearCache,
} from './research.js';
import { fakePublicApi } from '../test-helpers.js';

describe('research', () => {
  let api: ReturnType<typeof fakePublicApi>;

  beforeEach(() => {
    clearCache();
    api = fakePublicApi();
  });

  afterEach(() => {
    api.restore();
  });

  describe('searchModels', () => {
    it('fetches from civitai API', async () => {
      const result = await searchModels('anime');
      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('Test Model');
    });

    it('caches results', async () => {
      await searchModels('anime');
      await searchModels('anime');
      expect(api.calls).toHaveLength(1);
    });
  });

  describe('getModelDetails', () => {
    it('fetches model by id', async () => {
      const result = await getModelDetails(1234);
      expect(result.id).toBe(1234);
      expect(result.name).toBe('Test Model');
    });

    it('caches results', async () => {
      await getModelDetails(1234);
      await getModelDetails(1234);
      expect(api.calls).toHaveLength(1);
    });
  });

  describe('searchImages', () => {
    it('fetches images', async () => {
      const result = await searchImages({ modelId: 1234 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(9999);
    });
  });
});
