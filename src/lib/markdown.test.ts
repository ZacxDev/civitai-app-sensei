import { describe, it, expect } from 'vitest';
import { parseMarkdown, parseInline, linkHref } from './markdown.js';

/**
 * The corpus is taken from REAL model output, not invented. The first case is
 * the exact shape of a reply that shipped to production as literal asterisks
 * and bracket syntax.
 */
describe('markdown — the subset the model actually emits', () => {
  it('🔴 renders a bold link inside an ordered list — the measured real shape', () => {
    // ─────────────────────────────────────────────────────────────────────────
    // 🔴 THIS ASSERTION WAS REPOINTED ON 2026-09-02, AND IT IS WORTH SAYING WHY
    // OUT LOUD RATHER THAN QUIETLY EDITING IT.
    //
    // It used to expect
    //
    //   { kind: 'bold', text: '[Popular Mix](https://civitai.com/models/1510946)' }
    //
    // i.e. the link's raw SOURCE, rendered in bold — with the comment above it
    // reading "the link must survive, not be eaten by the bold rule" and the
    // test's own name calling it "renders a bold link". The name and the comment
    // described the contract; the expectation pinned the DEFECT, verbatim, and
    // therefore froze it. That is not a weakened assertion being repaired — it
    // is a test that read as coverage while providing the opposite, which is
    // worse than no test because it stopped anyone looking. It was the reason
    // the app's headline output shipped unreadable through twelve releases.
    //
    // The expectation below is the one the name always claimed.
    // ─────────────────────────────────────────────────────────────────────────
    const src =
      'Here are some popular models:\n' +
      '1. **[Popular Mix](https://civitai.com/models/1510946)**\n' +
      '2. **[Another](https://civitai.com/models/4384)**';
    const blocks = parseMarkdown(src);

    expect(blocks[0]).toEqual({ kind: 'para', spans: [{ kind: 'text', text: 'Here are some popular models:' }] });
    expect(blocks[1].kind).toBe('ol');

    const items = (blocks[1] as { items: Array<{ spans: unknown[] }> }).items;
    expect(items[0].spans).toEqual([
      {
        kind: 'bold',
        spans: [
          { kind: 'link', text: 'Popular Mix', href: 'https://civitai.com/models/1510946' },
        ],
      },
    ]);
    // Both rows are in ONE list, so the browser numbers them 1. and 2.
    expect(items).toHaveLength(2);
  });

  it('renders a bare link, bold and inline code', () => {
    expect(parseInline('see [DreamShaper](https://civitai.com/models/4384) now')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'DreamShaper', href: 'https://civitai.com/models/4384' },
      { kind: 'text', text: ' now' },
    ]);
    expect(parseInline('**bold** and `code`')).toEqual([
      { kind: 'bold', spans: [{ kind: 'text', text: 'bold' }] },
      { kind: 'text', text: ' and ' },
      { kind: 'code', text: 'code' },
    ]);
  });

  it('unordered lists, and a paragraph after one', () => {
    const blocks = parseMarkdown('- one\n- two\n\ntail');
    expect(blocks[0].kind).toBe('ul');
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
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

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE GROUNDED-CITATION GATE, AT THE PARSER.
//
// Every id below is a REAL one from the 18-turn seam probe
// (`eval/results/seam-baseline-2026-08-31.json`). They are pairwise distinct and
// distinct from every id the cases above already name (1510946, 4384), so a
// mutant that hardcodes any single literal cannot survive.
//
// 🔴 THE THREE ARGUMENTS ARE THREE DIFFERENT QUESTIONS AND THE SUITE ASSERTS ALL
// THREE:  `undefined` = "no grounding context, behave exactly as before";
// `new Set()` = "this conversation grounded nothing, refuse every model link";
// a populated set = "refuse the ones not in it". Collapsing the first two makes
// the guard inert in precisely the case it was built for.
// ─────────────────────────────────────────────────────────────────────────────

const RV = '4201'; // Realistic Vision — real id, correctly named
const DEAD = '4823'; // 404 — no such model
const DEAD2 = '18619'; // 404 — no such model
const EMILIA = '7878'; // real: Emilia (Re:Zero), cited as "Detail Tweaker LoRA"
const CARDOS = '22220'; // real: CarDos Animated, cited as "Face Slider"

describe('🔴 linkHref — the grounded-citation gate', () => {
  it('keeps a link whose id a tool round returned', () => {
    expect(linkHref(`https://civitai.com/models/${RV}`, new Set([RV]))).toBe(
      `https://civitai.com/models/${RV}`,
    );
    // …including through the slug the model actually emitted.
    expect(
      linkHref(`https://civitai.com/models/${RV}/realistic-vision-v50`, new Set([RV])),
    ).toBe(`https://civitai.com/models/${RV}/realistic-vision-v50`);
  });

  it('🔴 REFUSES an id no tool returned, while the grounded one beside it survives', () => {
    const grounded = new Set([RV]);
    expect(linkHref(`https://civitai.com/models/${RV}`, grounded)).toBeTruthy();
    expect(linkHref(`https://civitai.com/models/${DEAD}`, grounded)).toBeNull();
    expect(linkHref(`https://civitai.com/models/${DEAD2}`, grounded)).toBeNull();
  });

  it('🔴 an EMPTY grounded set refuses every model link — the measured no-tool turn', () => {
    expect(linkHref(`https://civitai.com/models/${EMILIA}`, new Set())).toBeNull();
    expect(linkHref(`https://civitai.com/models/${RV}`, new Set())).toBeNull();
  });

  it('🔴 NO grounded set supplied is UNCHANGED legacy behaviour, not an empty set', () => {
    // Every pre-grounding caller must keep working, or the guard retroactively
    // refuses links in contexts that have no tool results to judge them against.
    expect(linkHref(`https://civitai.com/models/${EMILIA}`)).toBe(
      `https://civitai.com/models/${EMILIA}`,
    );
    expect(linkHref(`https://civitai.com/models/${EMILIA}`, undefined)).toBe(
      `https://civitai.com/models/${EMILIA}`,
    );
    expect(linkHref(`https://civitai.com/models/${EMILIA}`, null)).toBe(
      `https://civitai.com/models/${EMILIA}`,
    );
  });

  it('a NON-model civitai link is untouched by grounding, even with an empty set', () => {
    // The grounded set answers "did the model invent this id". A profile page
    // has no id to invent, so the host allowlist remains the whole decision.
    expect(linkHref('https://civitai.com/user/someone', new Set())).toBe(
      'https://civitai.com/user/someone',
    );
    expect(linkHref('https://civitai.com/images/1234567', new Set())).toBe(
      'https://civitai.com/images/1234567',
    );
  });

  it('🔴 an UPPERCASE path cannot walk past the gate', () => {
    // `new URL` lowercases the HOST and leaves the PATH alone, so a
    // case-sensitive id pattern would read this as "not a model link".
    expect(linkHref(`https://civitai.com/MODELS/${DEAD}`, new Set())).toBeNull();
    expect(linkHref(`https://civitai.com/MODELS/${RV}`, new Set([RV]))).toBeTruthy();
  });

  it('🔴 grounding NARROWS the host allowlist and can never widen it', () => {
    // A grounded id does not buy a hostile URL anything: every existing refusal
    // still refuses with the id in the set.
    const grounded = new Set([RV]);
    expect(linkHref(`http://civitai.com/models/${RV}`, grounded)).toBeNull();
    expect(linkHref(`https://evil.com/models/${RV}`, grounded)).toBeNull();
    expect(linkHref(`https://evil.com@civitai.com/models/${RV}`, grounded)).toBeNull();
    expect(linkHref(`javascript:alert(1)//civitai.com/models/${RV}`, grounded)).toBeNull();
    expect(linkHref(`https://civitai.com.evil.com/models/${RV}`, grounded)).toBeNull();
  });

  it('malformed and edge hrefs stay refused with a grounded set in hand', () => {
    expect(linkHref('https://', new Set([RV]))).toBeNull();
    expect(linkHref('', new Set([RV]))).toBeNull();
    expect(linkHref('   ', new Set([RV]))).toBeNull();
    // A model id is digits. `4201abc` is not the same id as `4201`, but the
    // path still starts with one, so it is gated on `4201` rather than waved
    // through — refusing is the safe direction for a URL nobody can resolve.
    expect(linkHref('https://civitai.com/models/4201abc', new Set())).toBeNull();
    expect(linkHref('https://civitai.com/models/abc', new Set())).toBe(
      'https://civitai.com/models/abc',
    );
  });
});

describe('🔴 parseMarkdown — the gate reaches every span, not just paragraphs', () => {
  it('🔴 refuses ONE ungrounded link in a LIST and keeps the grounded ones', () => {
    // The measured shape is a list. A gate threaded only into the paragraph
    // path passes its own unit tests while every real answer goes ungated.
    const src =
      `1. [Realistic Vision](https://civitai.com/models/${RV})\n` +
      `2. [Deliberate](https://civitai.com/models/${DEAD})`;
    const blocks = parseMarkdown(src, new Set([RV]));
    const items = (blocks[0] as { kind: 'ol'; items: Array<{ spans: unknown[] }> }).items;

    expect(items[0].spans).toEqual([
      { kind: 'link', text: 'Realistic Vision', href: `https://civitai.com/models/${RV}` },
    ]);
    // 🔴 THE TEXT SURVIVES, THE HREF DOES NOT. The viewer still reads the name
    // the model wrote; they just cannot be sent to an unrelated model by it.
    expect(items[1].spans).toEqual([{ kind: 'text', text: 'Deliberate' }]);
  });

  it('🔴 the UNORDERED list path is gated too', () => {
    const blocks = parseMarkdown(`- [Deliberate](https://civitai.com/models/${DEAD})`, new Set([RV]));
    expect((blocks[0] as { kind: 'ul'; items: Array<{ spans: unknown[] }> }).items[0].spans).toEqual([
      { kind: 'text', text: 'Deliberate' },
    ]);
  });

  it('🔴 the PARAGRAPH path is gated too', () => {
    const blocks = parseMarkdown(`Try [Deliberate](https://civitai.com/models/${DEAD}) next.`, new Set([RV]));
    expect((blocks[0] as { kind: 'para'; spans: unknown[] }).spans).toEqual([
      { kind: 'text', text: 'Try ' },
      { kind: 'text', text: 'Deliberate' },
      { kind: 'text', text: ' next.' },
    ]);
  });

  it('🔴 THE COVERAGE BOUNDARY: the measured S6 shape has no LINK to refuse', () => {
    // Verbatim from the probe. Bare parenthesised URLs are NOT markdown links,
    // so this renderer never produced an `<a>` for them and the gate has
    // nothing to refuse — the ids arrive as inert text either way. Recorded as
    // an assertion rather than left implicit, because "the gate covers the
    // measured defect" would otherwise read as covering all six ids when it
    // covers the four that were emitted as links (4201, 4384, 4823, 18619).
    // Closing the remaining shape means changing what the answer SAYS, which is
    // a prompt or retry decision, not a render one.
    const src =
      `- **Detail Tweaker LoRA** (https://civitai.com/models/${EMILIA}) improves facial features.\n` +
      `- **Face Slider** (https://civitai.com/models/${CARDOS}) allows fine-tuning facial expressions.`;
    const gated = parseMarkdown(src, new Set());
    const ungated = parseMarkdown(src, undefined);
    expect(gated).toEqual(ungated);
    // Positive control on that equality: it holds because there is no `link`
    // span anywhere, not because the gate is inert.
    const kinds = (gated[0] as { items: Array<{ spans: Array<{ kind: string }> }> }).items
      .flatMap((i) => i.spans)
      .map((s) => s.kind);
    expect(kinds).not.toContain('link');
  });

  it('an id in PROSE but not in a link is left exactly as written', () => {
    const src = `Model ${DEAD2} is often recommended, but I have not looked it up.`;
    expect(parseMarkdown(src, new Set())).toEqual(parseMarkdown(src, undefined));
    expect(parseMarkdown(src, new Set())).toEqual([
      { kind: 'para', spans: [{ kind: 'text', text: src }] },
    ]);
  });

  it('positive control: with the id grounded, the SAME list renders a real link', () => {
    // Without this, every refusal above is satisfied by a parser that never
    // produced a link in the first place.
    const src = `1. [Deliberate](https://civitai.com/models/${DEAD})`;
    const items = (parseMarkdown(src, new Set([DEAD])) as Array<{ items: Array<{ spans: unknown[] }> }>)[0].items;
    expect(items[0].spans).toEqual([
      { kind: 'link', text: 'Deliberate', href: `https://civitai.com/models/${DEAD}` },
    ]);
  });
});
