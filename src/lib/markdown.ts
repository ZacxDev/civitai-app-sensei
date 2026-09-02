/**
 * A DELIBERATELY SMALL markdown subset — the set the model actually emits.
 *
 * 🔴 NO LIBRARY, AND NO `dangerouslySetInnerHTML` ANYWHERE. This parses to a
 * typed node tree that `MarkdownText.tsx` renders with ordinary React elements,
 * so there is no HTML string and therefore no injection surface at all. That
 * matters more here than in a normal app: this text is authored by a language
 * model, from catalog rows authored by third parties, inside a sandboxed iframe.
 * A sanitiser you have to configure correctly is a worse position than a parser
 * that cannot emit HTML in the first place.
 *
 * 🔴 THE SUBSET IS CHOSEN FROM MEASURED OUTPUT, not from the CommonMark spec.
 * A real withheld reply looked like:
 *
 *   Here are some popular models based on the search results:
 *   1. **[Popular Mix [NoobAI & Illustrious]](https://civitai.com/models/1510946)**
 *      - Type: LORA   - Base Model: Illustrious   - Creator: vslinx
 *   Let me know if you'd like more details about any of these!
 *
 * So: bold, links, ordered and unordered lists (with one level of indented
 * sub-bullets), inline code, paragraphs. Tables, blockquotes, images, headings
 * and nested emphasis are NOT supported and fall through as literal text —
 * which is the honest failure mode.
 *
 * 🔴 THAT EXACT EXAMPLE DID NOT RENDER UNTIL 2026-09-02, IN THREE INDEPENDENT
 * WAYS, and every one of them was in the renderer rather than the prompt:
 *
 *   1. `**[…](…)**` — bold and link both matched, the winner was chosen by
 *      OFFSET, and bold starts two characters earlier. `bold` carried a flat
 *      `text`, so the link's whole SOURCE was rendered in bold. Every citation
 *      this app emits is bold-wrapped, which is why "links never render" while
 *      bold and lists did.
 *   2. `[Popular Mix [NoobAI & Illustrious]]` — the link pattern's text class
 *      was `[^\]]+`, so a name containing `]` matched nowhere at all.
 *   3. `   - Type: LORA` — an indented sub-bullet CLOSED the enclosing `<ol>`,
 *      so each numbered item became its own one-item list and the browser
 *      numbered all of them "1.".
 *
 * The three are unrelated mechanisms with one appearance, so fixing any one of
 * them alone leaves the screen looking unchanged. Keep all three cases in the
 * test corpus.
 *
 * 🔴 LINK TARGETS ARE ALLOWLISTED, NOT SANITISED. `linkHref` returns null for
 * anything that is not an absolute https URL on a civitai host **carrying no
 * userinfo** — the `user:pw@` form is refused even when the host itself passes,
 * because `URL.toString()` would otherwise hand back an href that still reads
 * `https://evil.com@civitai.com/…`. A model that
 * hallucinates `javascript:` , `data:`, or an off-site tracker produces plain
 * text, not a link. The app's own system prompt tells the model to link
 * `https://civitai.com/models/<id>`, so this allowlist is the same claim
 * enforced rather than trusted.
 *
 * 🔴 AND A SECOND ALLOWLIST ON THE SAME MECHANISM: a `civitai.com/models/<id>`
 * link is refused unless `<id>` came back from a tool round in THIS
 * conversation. The host allowlist answers "could this URL be hostile"; the
 * grounded set answers "did the model make this id up". Measured, the second
 * question is the one that was failing — 4 ungrounded answers in an 18-turn
 * probe, two of them REAL ids under INVENTED names, which resolve 200 and send
 * the viewer somewhere unrelated with nothing on screen to say so. The rule
 * itself lives in `lib/grounding.ts`, because `eval/run-eval.mjs` has to
 * measure the same predicate this renders; see that file's header for why one
 * copy is the whole point.
 */

import type { GroundedModelIds } from './grounding.js';
import { modelIdInHref } from './grounding.js';

export type Inline =
  /**
   * 🔴 `bold` CARRIES SPANS, NOT A STRING, AND THAT IS THE FIX FOR THE HEADLINE
   * DEFECT rather than a refactor. `**[Name](url)**` is what the model emits for
   * every citation, and with a flat `text` the bold rule swallowed the link's
   * whole SOURCE and rendered it as literal `[Name](https://…)` in bold — the
   * app's most valuable output, unreadable and unclickable. Bold is a CONTAINER;
   * whatever is inside it is parsed like any other run.
   *
   * Termination is guaranteed by {@link BOLD_RE}: its body is `[^*]+`, so a bold
   * run cannot contain another `**` and the recursion is exactly one level deep.
   */
  | { kind: 'text'; text: string }
  | { kind: 'bold'; spans: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

/**
 * One list row.
 *
 * `sub` holds an INDENTED bullet run belonging to this row — the measured shape
 * is `1. **[Name](url)**` followed by `   - Type: LORA`. Before it existed those
 * sub-bullets terminated the enclosing `<ol>`, so every ordered item became its
 * own single-item list and all of them rendered as "1.".
 */
export interface ListItem {
  spans: Inline[];
  sub?: Inline[][];
}

export type Block =
  | { kind: 'para'; spans: Inline[] }
  | { kind: 'ul'; items: ListItem[] }
  /** `start` is the number the SOURCE began at; `3. / 4.` must not renumber to 1. */
  | { kind: 'ol'; items: ListItem[]; start: number };

/** Hosts a rendered link may point at. Everything else becomes plain text. */
const ALLOWED_HOSTS = new Set(['civitai.com', 'www.civitai.com', 'civit.ai']);

/**
 * The href to render, or `null` to refuse the link and keep its text.
 *
 * Exported for its own test: this is the security-relevant half of the module
 * and deserves to fail loudly on its own rather than only through a render.
 *
 * `grounded` is the set of model ids this CONVERSATION's tool rounds returned.
 *
 * 🔴 OMITTING IT MUST BE EXACTLY TODAY'S BEHAVIOUR, and that is not a
 * convenience for the existing call sites — it is what stops the guard from
 * retroactively refusing links in contexts that have no tool results to judge
 * them against. A user's own typed link, a fixture, a caller that never runs a
 * tool loop: none of those has a grounded set, and inventing an empty one for
 * them would refuse every model link in the app.
 *
 * 🔴 AN EMPTY SET IS THEREFORE NOT THE SAME ARGUMENT AS `undefined`. A
 * conversation that has grounded nothing supplies `new Set()` and every model
 * link is refused — which is precisely the measured defect case, a turn that
 * called no tool and cited from memory. If those two ever collapse into one
 * value the guard becomes inert in the only case it was built for.
 *
 * 🔴 CHECKED AFTER THE HOST/USERINFO CHECKS, NEVER BEFORE. Grounding can only
 * ever NARROW what the allowlist already accepted; nothing below can make a
 * refused URL renderable.
 */
export function linkHref(raw: string, grounded?: GroundedModelIds | null): string | null {
  const trimmed = raw.trim();
  // A relative or scheme-less URL would resolve against the SANDBOXED iframe's
  // opaque origin, which is never useful and is not obviously safe. Absolute
  // https only.
  if (!/^https:\/\//i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'https:') return null;
    // 🔴 USERINFO IS REFUSED, and the case that motivates it is the one that
    // PASSES the host check rather than the one that fails it. `new URL` puts
    // everything before the `@` into `username`/`password`, so the classic
    // `https://civitai.com@evil.com/x` already refuses on `hostname` =
    // `evil.com`. The one that got through is the MIRROR of it —
    // `https://evil.com@civitai.com/x` — whose hostname genuinely IS civitai
    // and which `u.toString()` then hands back WITH the `evil.com@` still in
    // it. The navigation target was never wrong, so this is not an open
    // redirect; what it leaks is a link whose visible href (status bar,
    // right-click → copy link) reads as though it points at the attacker,
    // authored by a language model out of third-party catalog rows. A real
    // civitai link never carries userinfo, so refusing it costs nothing.
    if (u.username !== '' || u.password !== '') return null;
    if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return null;

    const href = u.toString();
    // No grounding context supplied — the pre-grounding behaviour, unchanged.
    if (grounded == null) return href;
    // Not a model link at all (a profile, an image, an article). The grounded
    // set has nothing to say about it, so the host allowlist above is the whole
    // decision — exactly as it was before this parameter existed.
    const id = modelIdInHref(href);
    if (id === null) return href;
    // 🔴 THE CITATION GATE. Refusing returns `null`, which `parseInline` renders
    // as the link's TEXT with no href — the viewer still reads the model name
    // the model wrote, and cannot be sent to an id nothing in this conversation
    // ever returned.
    return grounded.has(id) ? href : null;
  } catch {
    return null;
  }
}

const BOLD_RE = /\*\*([^*]+)\*\*/;
const CODE_RE = /`([^`]+)`/;

/** A link found by {@link findLink}. */
interface LinkMatch {
  /** Offset of the opening `[`. */
  index: number;
  /** Length of the whole `[text](href)` run. */
  length: number;
  text: string;
  href: string;
}

/**
 * The first `[text](href)` in `s`, scanned with a BRACKET COUNTER.
 *
 * 🔴 THIS REPLACES A REGEX THAT COULD NOT SEE HALF THE LINKS THIS APP RENDERS.
 * The old pattern was `/\[([^\]]+)\]\(([^)\s]+)\)/` — a link text matching
 * `[^\]]+` cannot contain `]`, and Civitai model names routinely do:
 *
 *   [Popular Mix [NoobAI & Illustrious]](https://civitai.com/models/1510946)
 *
 * matched NOWHERE in that string (the inner `]` ends the class, and the char
 * after it is `]`, not `(`), so the whole citation fell through as literal text.
 * That is not an exotic case — bracketed qualifiers are a naming convention on
 * the site, and this app's entire output is model citations.
 *
 * The counter accepts BALANCED nesting to any depth and refuses an unbalanced
 * run, which then survives as literal text exactly as before. `href` keeps the
 * old shape — no whitespace, no `)` — so nothing about what may be LINKED
 * changes here; only what is FOUND. The allowlist in {@link linkHref} is still
 * the only thing that decides whether a found link is rendered.
 */
export function findLink(s: string): LinkMatch | null {
  for (let open = s.indexOf('['); open !== -1; open = s.indexOf('[', open + 1)) {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
      const ch = s[i];
      if (ch === '[') {
        depth++;
      } else if (ch === ']') {
        depth--;
        if (depth > 0) continue;
        // Balanced. The very next character must open the destination.
        if (s[i + 1] !== '(') break; // not a link; try the next `[`
        const close = s.indexOf(')', i + 2);
        if (close === -1) break;
        const href = s.slice(i + 2, close);
        // Same href shape the old pattern accepted: at least one character,
        // no whitespace. A URL containing `)` was not linkable before either.
        if (href.length === 0 || /\s/.test(href)) break;
        const text = s.slice(open + 1, i);
        if (text.length === 0) break;
        return { index: open, length: close + 1 - open, text, href };
      }
    }
  }
  return null;
}

/**
 * Parse one line of inline markdown into spans. Never throws.
 *
 * `grounded` is forwarded verbatim to {@link linkHref} — see there for why
 * `undefined` and an empty set are different arguments.
 */
export function parseInline(line: string, grounded?: GroundedModelIds | null): Inline[] {
  const out: Inline[] = [];
  let rest = line;

  while (rest.length > 0) {
    const link = findLink(rest);
    const bold = BOLD_RE.exec(rest);
    const code = CODE_RE.exec(rest);

    const candidates = [
      link ? { at: link.index, len: link.length, kind: 'link' as const } : null,
      bold ? { at: bold.index, len: bold[0].length, kind: 'bold' as const } : null,
      code ? { at: code.index, len: code[0].length, kind: 'code' as const } : null,
    ].filter((c): c is NonNullable<typeof c> => c !== null);

    if (candidates.length === 0) {
      out.push({ kind: 'text', text: rest });
      break;
    }

    candidates.sort((a, b) => a.at - b.at);
    const win = candidates[0];
    if (win.at > 0) out.push({ kind: 'text', text: rest.slice(0, win.at) });

    if (win.kind === 'link') {
      const { text, href } = link!;
      const safe = linkHref(href, grounded);
      // 🔴 A REFUSED LINK KEEPS ITS TEXT, never the URL. Rendering the raw href
      // as a consolation would put an unvetted string on screen, which is the
      // thing the allowlist exists to prevent.
      out.push(safe ? { kind: 'link', text, href: safe } : { kind: 'text', text });
    } else if (win.kind === 'bold') {
      // 🔴 RECURSE INTO THE BOLD BODY. Sorting by offset means `**[a](u)**`
      // hands the win to BOLD (offset 0) over the link (offset 2), and the old
      // flat `{ kind:'bold', text }` then rendered the link's SOURCE. The body
      // is re-parsed instead, so the link inside survives — including its
      // grounding check, which is why `grounded` is threaded through. `[^*]+`
      // forbids a nested `**`, so this bottoms out after one level.
      out.push({ kind: 'bold', spans: parseInline(bold![1], grounded) });
    } else {
      out.push({ kind: 'code', text: code![1] });
    }

    rest = rest.slice(win.at + win.len);
  }

  return out;
}

const UL_RE = /^(\s*)[-*]\s+(.*)$/;
const OL_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;

/**
 * Indentation at which a bullet belongs to the list ROW above it rather than
 * starting a sibling list. Two columns — the model indents its detail bullets
 * by three (`   - Type: LORA`) and never indents a top-level bullet at all.
 */
const SUB_ITEM_INDENT = 2;

/**
 * Parse a message into blocks. Total: any input produces a valid tree, and
 * unsupported syntax survives as literal text rather than being dropped.
 *
 * 🔴 `grounded` MUST REACH EVERY `parseInline` CALL BELOW, and there are three
 * of them (paragraph, ordered item, unordered item). The measured defect shape
 * is a LIST — `- **Detail Tweaker LoRA** (https://civitai.com/models/7878) …` —
 * so threading it into the paragraph path alone would leave the guard passing
 * its own unit tests while the actual answers went ungated.
 */
export function parseMarkdown(src: string, grounded?: GroundedModelIds | null): Block[] {
  const blocks: Block[] = [];
  const lines = src.split('\n');

  let para: string[] = [];
  /** The list currently being accumulated. `null` = none open. */
  let list: { kind: 'ul' | 'ol'; items: ListItem[]; start: number } | null = null;
  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: 'para', spans: parseInline(para.join(' '), grounded) });
      para = [];
    }
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(
      list.kind === 'ol'
        ? { kind: 'ol', items: list.items, start: list.start }
        : { kind: 'ul', items: list.items },
    );
    list = null;
  };

  for (const line of lines) {
    // 🔴 A BLANK LINE NO LONGER ENDS AN OPEN LIST — the list is closed LAZILY,
    // by whatever comes next. It used to flush on sight, so a model that
    // separated its numbered items with blank lines produced one single-item
    // `<ol>` per item and the browser numbered every one of them "1." — the
    // same visible defect the sub-bullet case produces, by an independent
    // route. A following item of the same kind continues the list; anything
    // else flushes it first, which is what every `flushList()` below is for.
    // (CommonMark calls the result a loose list; this subset renders loose and
    // tight identically, so the distinction is not carried into the tree.)
    if (line.trim().length === 0) {
      flushPara();
      if (!list) flushList();
      continue;
    }

    const olM = OL_RE.exec(line);
    const ulM = olM ? null : UL_RE.exec(line);

    // An INDENTED bullet under an open list belongs to that list's last row.
    // 🔴 Only when a row exists to hang it on: `list.items` is never empty here
    // (a list is only opened by pushing a row), but the guard states it rather
    // than relying on that, because an empty-items list would otherwise index
    // `-1` and throw inside a renderer that must never take the turn down.
    if (ulM && list && list.items.length > 0 && ulM[1].length >= SUB_ITEM_INDENT) {
      flushPara();
      const row = list.items[list.items.length - 1];
      (row.sub ??= []).push(parseInline(ulM[2], grounded));
      continue;
    }

    if (olM || ulM) {
      const kind = olM ? 'ol' : 'ul';
      flushPara();
      // A different list kind always starts a new block, blank line or not.
      if (list && list.kind !== kind) flushList();
      if (!list) {
        list = { kind, items: [], start: olM ? Number(olM[2]) : 1 };
      }
      list.items.push({ spans: parseInline(olM ? olM[3] : ulM![2], grounded) });
      continue;
    }

    // Ordinary prose. Whatever list was open ends here — including one merely
    // armed by a blank line.
    flushList();
    para.push(line.trim());
  }

  flushPara();
  flushList();
  return blocks;
}
