import { describe, it, expect } from 'vitest';
import {
  AVAILABLE_MODELS,
  getModelById,
  estimateCost,
  formatCost,
} from './models.js';

describe('models', () => {
  describe('AVAILABLE_MODELS', () => {
    it('has models defined', () => {
      expect(AVAILABLE_MODELS.length).toBeGreaterThan(0);
    });

    it('each model has required fields', () => {
      for (const model of AVAILABLE_MODELS) {
        expect(model.id).toBeTruthy();
        expect(model.name).toBeTruthy();
        expect(model.provider).toBeTruthy();
        expect(typeof model.costPer1kInput).toBe('number');
        expect(typeof model.costPer1kOutput).toBe('number');
        expect(model.maxContext).toBeGreaterThan(0);
      }
    });
  });

  describe('getModelById', () => {
    it('finds existing model', () => {
      const model = getModelById('deepseek/deepseek-chat');
      expect(model).toBeTruthy();
      expect(model?.name).toBe('DeepSeek V3');
    });

    it('returns undefined for unknown', () => {
      expect(getModelById('nonexistent')).toBeUndefined();
    });
  });

  describe('estimateCost', () => {
    it('calculates cost correctly', () => {
      const model = getModelById('deepseek/deepseek-chat')!;
      const cost = estimateCost(model, 1000, 500);
      // 1000 * 0.00014 + 500 * 0.00028 = 0.00014 + 0.00014 = 0.00028
      expect(cost).toBeCloseTo(0.00028, 6);
    });
  });

  describe('formatCost', () => {
    it('formats very small amounts', () => {
      expect(formatCost(0.0001)).toBe('<$0.001');
    });

    it('formats small amounts', () => {
      expect(formatCost(0.005)).toBe('$0.005');
    });

    it('formats larger amounts', () => {
      expect(formatCost(0.15)).toBe('$0.15');
    });
  });
});
