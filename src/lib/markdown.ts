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
 * So: bold, links, ordered and unordered lists, inline code, paragraphs. Tables,
 * blockquotes, images, headings and nested emphasis are NOT supported and fall
 * through as literal text — which is the honest failure mode, and the same thing
 * the viewer sees today.
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
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

export type Block =
  | { kind: 'para'; spans: Inline[] }
  | { kind: 'ul'; items: Inline[][] }
  | { kind: 'ol'; items: Inline[][] };

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

// Ordered by precedence; the first match at a position wins. `link` precedes
// `bold` so `**[text](url)**` renders as a bold-wrapped link rather than
// swallowing the brackets.
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/;
const BOLD_RE = /\*\*([^*]+)\*\*/;
const CODE_RE = /`([^`]+)`/;

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
    const link = LINK_RE.exec(rest);
    const bold = BOLD_RE.exec(rest);
    const code = CODE_RE.exec(rest);

    const candidates = [
      link ? { at: link.index, m: link, kind: 'link' as const } : null,
      bold ? { at: bold.index, m: bold, kind: 'bold' as const } : null,
      code ? { at: code.index, m: code, kind: 'code' as const } : null,
    ].filter((c): c is NonNullable<typeof c> => c !== null);

    if (candidates.length === 0) {
      out.push({ kind: 'text', text: rest });
      break;
    }

    candidates.sort((a, b) => a.at - b.at);
    const win = candidates[0];
    if (win.at > 0) out.push({ kind: 'text', text: rest.slice(0, win.at) });

    if (win.kind === 'link') {
      const [, text, href] = win.m;
      const safe = linkHref(href, grounded);
      // 🔴 A REFUSED LINK KEEPS ITS TEXT, never the URL. Rendering the raw href
      // as a consolation would put an unvetted string on screen, which is the
      // thing the allowlist exists to prevent.
      out.push(safe ? { kind: 'link', text, href: safe } : { kind: 'text', text });
    } else if (win.kind === 'bold') {
      out.push({ kind: 'bold', text: win.m[1] });
    } else {
      out.push({ kind: 'code', text: win.m[1] });
    }

    rest = rest.slice(win.at + win.m[0].length);
  }

  return out;
}

const UL_RE = /^\s*[-*]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;

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
  let ul: Inline[][] = [];
  let ol: Inline[][] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: 'para', spans: parseInline(para.join(' '), grounded) });
      para = [];
    }
  };
  const flushLists = () => {
    if (ul.length) { blocks.push({ kind: 'ul', items: ul }); ul = []; }
    if (ol.length) { blocks.push({ kind: 'ol', items: ol }); ol = []; }
  };

  for (const line of lines) {
    if (line.trim().length === 0) { flushPara(); flushLists(); continue; }

    const olM = OL_RE.exec(line);
    if (olM) { flushPara(); if (ul.length) flushLists(); ol.push(parseInline(olM[1], grounded)); continue; }

    const ulM = UL_RE.exec(line);
    if (ulM) { flushPara(); if (ol.length) flushLists(); ul.push(parseInline(ulM[1], grounded)); continue; }

    flushLists();
    para.push(line.trim());
  }

  flushPara();
  flushLists();
  return blocks;
}
