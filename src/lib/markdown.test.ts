import { describe, it, expect } from 'vitest';
import { parseMarkdown, parseInline, linkHref } from './markdown.js';

/**
 * The corpus is taken from REAL model output, not invented. The first case is
 * the exact shape of a reply that shipped to production as literal asterisks
 * and bracket syntax.
 */
describe('markdown — the subset the model actually emits', () => {
  it('🔴 renders a bold link inside an ordered list — the measured real shape', () => {
    const src =
      'Here are some popular models:\n' +
      '1. **[Popular Mix](https://civitai.com/models/1510946)**\n' +
      '2. **[Another](https://civitai.com/models/4384)**';
    const blocks = parseMarkdown(src);

    expect(blocks[0]).toEqual({ kind: 'para', spans: [{ kind: 'text', text: 'Here are some popular models:' }] });
    expect(blocks[1].kind).toBe('ol');

    const first = (blocks[1] as { items: unknown[][] }).items[0];
    // `**[text](url)**` — the link must survive, not be eaten by the bold rule.
    expect(first).toEqual([
      { kind: 'bold', text: '[Popular Mix](https://civitai.com/models/1510946)' },
    ]);
  });

  it('renders a bare link, bold and inline code', () => {
    expect(parseInline('see [DreamShaper](https://civitai.com/models/4384) now')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'DreamShaper', href: 'https://civitai.com/models/4384' },
      { kind: 'text', text: ' now' },
    ]);
    expect(parseInline('**bold** and `code`')).toEqual([
      { kind: 'bold', text: 'bold' },
      { kind: 'text', text: ' and ' },
      { kind: 'code', text: 'code' },
    ]);
  });

  it('unordered lists, and a paragraph after one', () => {
    const blocks = parseMarkdown('- one\n- two\n\ntail');
    expect(blocks[0].kind).toBe('ul');
    expect((blocks[0] as { items: unknown[][] }).items).toHaveLength(2);
    expect(blocks[1]).toEqual({ kind: 'para', spans: [{ kind: 'text', text: 'tail' }] });
  });

  it('positive control: plain prose survives verbatim, unchanged', () => {
    // Without this, a parser that dropped everything would satisfy the
    // assertions above by emitting nothing.
    const blocks = parseMarkdown('Just a sentence with no markup at all.');
    expect(blocks).toEqual([
      { kind: 'para', spans: [{ kind: 'text', text: 'Just a sentence with no markup at all.' }] },
    ]);
  });
});

describe('🔴 linkHref — the allowlist is the security boundary', () => {
  it('accepts civitai https URLs', () => {
    expect(linkHref('https://civitai.com/models/4384')).toBe('https://civitai.com/models/4384');
    expect(linkHref('https://civit.ai/x')).toBe('https://civit.ai/x');
  });

  it('🔴 REFUSES every dangerous or off-site scheme and host', () => {
    // A model can emit any of these; none may become an href.
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'http://civitai.com/models/1', // http, not https
      'https://evil.com/x',
      'https://civitai.com.evil.com/x', // suffix attack on the hostname
      '/relative',
      '',
    ]) {
      expect(linkHref(bad), `${bad} must be refused`).toBeNull();
    }
  });

  // 🔴 REGRESSION COVERAGE. Every case here was ALLOWED before the userinfo
  // check was added — watched red on `a1311bf`, where the first two came back
  // as their own input string rather than null. Do not fold these into the
  // invariant block below; that block never went red.
  it('🔴 REFUSES userinfo even when the HOST is genuinely civitai', () => {
    for (const bad of [
      'https://evil.com@civitai.com/x',
      'https://user:pw@civitai.com/x',
      'https://civitai.com:pw@civit.ai/x',
      // 🔴 EMPTY username WITH a password — the only shape that kills the
      // `u.password !== ''` half on its own. Without it that clause is
      // redundant: every other case above has a non-empty username, so the
      // mutant that drops the password check still dies to the username check
      // and the sweep reads green for the wrong reason.
      'https://:pw@civitai.com/x',
    ]) {
      expect(linkHref(bad), `${bad} must be refused`).toBeNull();
    }
  });

  // 🔴 INVARIANT GUARDS, NOT REGRESSION COVERAGE — labelled so nobody reads
  // them as evidence a bug was fixed here. Measured 2026-08-30: the shipped
  // code already refused all of these, because `new URL` normalises the host
  // BEFORE the allowlist compares it. They are pinned because the property is
  // load-bearing and invisible: it lives in the URL parser, not in this file,
  // so a future refactor that hand-rolls host extraction would silently lose it
  // and nothing else would notice.
  it('the host allowlist is compared AFTER URL normalisation', () => {
    for (const bad of [
      'https://civitaі.com/x', // Cyrillic U+0456 -> xn--civita-uvf.com
      'https://xn--civita-a0f.com/x', // explicit punycode lookalike
      'https://evil.com\\.civitai.com', // backslash is a `/` in special schemes
      'https://evil.com\\/civitai.com',
      'https:/\\civitai.com/x', // not an absolute https:// prefix
    ]) {
      expect(linkHref(bad), `${bad} must be refused`).toBeNull();
    }
  });

  // 🔴 THE OTHER HALF OF THE SAME PROPERTY, and it is the half that makes the
  // block above meaningful: normalisation must not over-refuse a link that
  // really is civitai. Without these, `linkHref = () => null` would satisfy
  // every refusal assertion in this file.
  it('still accepts a civitai URL that only NORMALISES to the allowlist', () => {
    // Fullwidth 'ｃ' IDNA-maps to ASCII 'c', so this genuinely IS civitai.com.
    expect(linkHref('https://ｃivitai.com/x')).toBe('https://civitai.com/x');
    expect(linkHref('https://CIVITAI.COM/x')).toBe('https://civitai.com/x');
    // A backslash after the host is a path separator, not an authority break.
    expect(linkHref('https://civitai.com\\@evil.com')).toBe('https://civitai.com/@evil.com');
  });

  it('🔴 a refused link keeps its TEXT and never shows the url', () => {
    // 🔴 ASSERTS THE PROPERTY, NOT AN EXACT SPAN LIST. An earlier version of
    // this test used `[click me](javascript:alert(1))` and demanded exact
    // equality with a single text span — but the URL rule stops at the first
    // `)`, so a nested-paren href leaves a stray `)` as its own span. That is
    // cosmetic and correct; the security claim is that NO link element is
    // produced and the href never reaches the output. Pin that.
    for (const src of [
      '[click me](javascript:alert§1§)',
      '[x](https://evil.com/pwn)',
      '[y](data:text/html,hi)',
    ]) {
      const spans = parseInline(src);
      expect(spans.some((s) => s.kind === 'link'), `${src} must not become a link`).toBe(false);
      const flat = JSON.stringify(spans);
      expect(flat).not.toContain('evil.com');
      expect(flat).not.toContain('javascript:');
      expect(flat).not.toContain('data:text');
    }
    // …and the visible text is preserved.
    expect(JSON.stringify(parseInline('[x](https://evil.com/pwn)'))).toContain('"x"');
  });
});
