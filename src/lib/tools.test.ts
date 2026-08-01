import { describe, it, expect } from 'vitest';
import { CIVITAI_TOOLS, parseToolArguments, findTool, toolNames } from './tools.js';

describe('tools', () => {
  describe('CIVITAI_TOOLS', () => {
    it('has 4 tools defined', () => {
      expect(CIVITAI_TOOLS).toHaveLength(4);
    });

    it('each tool has correct structure', () => {
      for (const tool of CIVITAI_TOOLS) {
        expect(tool.type).toBe('function');
        expect(tool.function.name).toBeTruthy();
        expect(tool.function.description).toBeTruthy();
        expect(tool.function.parameters).toBeTruthy();
        expect(tool.function.parameters.type).toBe('object');
      }
    });

    it('includes expected tool names', () => {
      const names = toolNames();
      expect(names).toContain('search_models');
      expect(names).toContain('get_model_details');
      expect(names).toContain('search_images');
      expect(names).toContain('delegate_to_nsfw_agent');
    });
  });

  describe('parseToolArguments', () => {
    it('parses valid JSON', () => {
      const args = parseToolArguments('{"query": "anime", "limit": 5}');
      expect(args).toEqual({ query: 'anime', limit: 5 });
    });

    it('returns empty object for invalid JSON', () => {
      expect(parseToolArguments('not json')).toEqual({});
    });
  });

  describe('findTool', () => {
    it('finds existing tool', () => {
      const tool = findTool('search_models');
      expect(tool).toBeTruthy();
      expect(tool?.function.name).toBe('search_models');
    });

    it('returns undefined for unknown tool', () => {
      expect(findTool('nonexistent')).toBeUndefined();
    });
  });

  describe('toolNames', () => {
    it('returns all tool names', () => {
      const names = toolNames();
      expect(names).toHaveLength(4);
      expect(names.every((n) => typeof n === 'string')).toBe(true);
    });
  });
});
