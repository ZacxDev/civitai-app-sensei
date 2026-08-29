import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_PROMPT,
  LEGACY_DEFAULT_SYSTEM_PROMPTS,
  migrateSettings,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE SYSTEM PROMPT IS A CLAIM ABOUT THE WIRE, AND IT HAS BEEN WRONG TWICE
// IN OPPOSITE DIRECTIONS.
//
// Round one: it told the model it could search while the host exposed no
// tool-calling surface — so the model, told it could search and unable to,
// fabricated results.
//
// Round two: the fix for that said "You cannot browse, search, or call tools"
// and described results arriving pre-attached under a "CIVITAI CATALOG RESULTS"
// label. Landing the tool loop made that false in both halves — the app now
// sends tool declarations, and `CATALOG_CONTEXT_MARKER` was deleted — but the
// guard that had pinned the text was deleted along with the retrieval suite it
// lived in, so nothing caught it.
//
// This suite is that guard, restored in BOTH directions: the prompt must not
// deny tool access, and it must not reference the pre-attachment mechanism that
// no longer exists.
// ─────────────────────────────────────────────────────────────────────────────

describe('DEFAULT_SYSTEM_PROMPT — must describe the retrieval the app actually does', () => {
  it('🔴 does NOT deny tool access', () => {
    // The exact sentence that shipped through 0.1.5, plus the general shape.
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain('You cannot browse, search, or call tools');
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/cannot\s+(browse|search|call tools)/i);
  });

  it('🔴 does NOT reference the deleted pre-attachment mechanism', () => {
    // `CATALOG_CONTEXT_MARKER` produced this label and was deleted with the
    // heuristic. A prompt still promising it describes a message the app will
    // never send.
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain('CIVITAI CATALOG RESULTS');
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/attaches the results|already attached/i);
  });

  it('tells the model it can call tools, which is what the app now does', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/call(ing)? the tools|tools you have been given/i);
  });

  it('still forbids inventing catalog facts — the reason the prompt exists at all', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/never invent/i);
  });

  it('POSITIVE CONTROL — the legacy prompt this replaces DOES trip both guards', () => {
    // Without this, the two `not.toContain` assertions above would pass on any
    // string that merely omits the phrases — including an empty prompt. This
    // pins that they are testing the thing they name.
    const legacy = LEGACY_DEFAULT_SYSTEM_PROMPTS[0];
    expect(legacy).toContain('You cannot browse, search, or call tools');
    expect(legacy).toContain('CIVITAI CATALOG RESULTS');
  });

  it('the shipped default is the current prompt, not a legacy one', () => {
    expect(DEFAULT_SETTINGS.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(LEGACY_DEFAULT_SYSTEM_PROMPTS).not.toContain(DEFAULT_SYSTEM_PROMPT);
  });
});

describe('migrateSettings — a stored prompt is not reached by changing the default', () => {
  const base = { model: 'm', temperature: 0.7, maxTokens: 2048 };

  it('🔴 upgrades a stored prompt that is an untouched legacy default', () => {
    // The whole point: `sensei:settings` is persisted, so a viewer who has ever
    // opened Settings keeps a prompt telling the model it cannot call tools —
    // while being handed tools. Fixing only the default reaches none of them.
    const stored = { ...base, systemPrompt: LEGACY_DEFAULT_SYSTEM_PROMPTS[0] };
    expect(migrateSettings(stored).systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it('🔴 leaves a CUSTOMISED prompt alone, even one character off a legacy default', () => {
    // This is why the test is exact-match rather than a version stamp: a stamp
    // would license overwriting a prompt the viewer wrote.
    const edited = `${LEGACY_DEFAULT_SYSTEM_PROMPTS[0]} And be brief.`;
    const stored = { ...base, systemPrompt: edited };
    expect(migrateSettings(stored).systemPrompt).toBe(edited);
  });

  it('leaves an already-current prompt alone', () => {
    const stored = { ...base, systemPrompt: DEFAULT_SYSTEM_PROMPT };
    expect(migrateSettings(stored)).toEqual(stored);
  });

  it('preserves every other setting while migrating', () => {
    const stored = {
      model: 'custom/model',
      temperature: 0.1,
      maxTokens: 99,
      systemPrompt: LEGACY_DEFAULT_SYSTEM_PROMPTS[0],
    };
    const out = migrateSettings(stored);
    expect(out.model).toBe('custom/model');
    expect(out.temperature).toBe(0.1);
    expect(out.maxTokens).toBe(99);
  });
});
