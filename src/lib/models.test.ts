import { describe, it, expect } from 'vitest';
import {
  AVAILABLE_MODELS,
  getModelById,
  modelSupportsTools,
  NSFW_MODEL_ID,
  SFW_MODEL_ID,
} from './models.js';

describe('models', () => {
  describe('AVAILABLE_MODELS', () => {
    it('has models defined', () => {
      expect(AVAILABLE_MODELS.length).toBeGreaterThan(0);
    });

    it('each model has required fields', () => {
      // 🔴 THE THREE `costPer1k*`/`maxContext` ASSERTIONS THAT WERE HERE ARE
      // GONE WITH THE FIELDS. They pinned the TYPES of values nothing read —
      // `typeof === 'number'` and `> 0` — which is a test that can only ever
      // fail if someone types a string into a field with no consumer. Reading
      // as coverage while providing none is worse than none: it stops anyone
      // looking. See the note above `AVAILABLE_MODELS` in `models.ts`.
      for (const model of AVAILABLE_MODELS) {
        expect(model.id).toBeTruthy();
        expect(model.name).toBeTruthy();
        expect(model.provider).toBeTruthy();
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

  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 THE TWO ARMS THE NSFW TOGGLE SWITCHES BETWEEN.
  // ───────────────────────────────────────────────────────────────────────────
  describe('🔴 the SFW and NSFW arms', () => {
    it('both arms are MEMBERS of this list, so both are on the host enum', () => {
      // A typo in either constant is otherwise a BAD_REQUEST on every send — and
      // the host's own header records that a fabricated model name is quoted the
      // declared floor, CHARGED it, then fails at execution with no output and no
      // refund. The enum is what stops an app typo burning a viewer's Buzz, and
      // this is what stops the app naming something outside it.
      const ids = AVAILABLE_MODELS.map((m) => m.id);
      expect(ids).toContain(SFW_MODEL_ID);
      expect(ids).toContain(NSFW_MODEL_ID);
    });

    it('the SFW arm is the newly registered flash model, appended LAST', () => {
      // Appended, never inserted — the host asserts its own list as a whole
      // ORDERED array. Pinning the position is what makes an "insert" visible.
      expect(SFW_MODEL_ID).toBe('deepseek/deepseek-v4-flash-0731');
      expect(AVAILABLE_MODELS[AVAILABLE_MODELS.length - 1].id).toBe(SFW_MODEL_ID);
      expect(AVAILABLE_MODELS).toHaveLength(4);
    });

    it('🔴 the SFW arm CAN call tools and the NSFW arm CANNOT', () => {
      // This is the fact the toggle's copy is a disclosure ABOUT. Dolphin's only
      // OpenRouter endpoint (Venice) does not expose tools, and OpenRouter treats
      // `tools` as a SOFT preference — so declarations sent for it are silently
      // dropped and the viewer is charged anyway.
      //
      // ⚠️ WHAT THIS PINS IS THE TABLE, NOT THE WORLD. The NSFW arm's `false` is
      // measured (that endpoint listing); the SFW arm's `true` is INFERRED from
      // the step's parameter schema and DeepSeek's documented function calling —
      // see the per-value premises in `models.ts`. Nothing local can measure a
      // released `toolCalls` verdict, so read this as "the app branches on these
      // values", never as "these values were observed".
      expect(modelSupportsTools(SFW_MODEL_ID)).toBe(true);
      expect(modelSupportsTools(NSFW_MODEL_ID)).toBe(false);
    });

    it('🔴 `supportsTools` is no longer false for every entry', () => {
      // It WAS, on the (then-true, now-stale) argument that the step exposed no
      // `tools` param. The step accepts `tools`/`toolChoice` and publishes
      // `toolCalls`, which is the whole loop this app runs. Exactly one entry is
      // tool-less, and it is the uncensored one.
      const toolLess = AVAILABLE_MODELS.filter((m) => !m.supportsTools).map((m) => m.id);
      expect(toolLess).toEqual([NSFW_MODEL_ID]);
    });

    it('🔴 `modelSupportsTools` FAILS CLOSED on an unknown id', () => {
      // The system prompt is a CLAIM ABOUT THE WIRE, so "I could not confirm this
      // model can look things up" must not become "tell it that it can". The branch
      // is unreachable in practice — `buildChatCompletionBody` refuses a non-enum
      // id before any quote — so the direction is chosen rather than inherited.
      expect(modelSupportsTools('deepseek/deepseek-r1')).toBe(false);
      expect(modelSupportsTools('')).toBe(false);
    });
  });
});
