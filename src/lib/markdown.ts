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
 */

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
 */
export function linkHref(raw: string): string | null {
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
    return ALLOWED_HOSTS.has(u.hostname.toLowerCase()) ? u.toString() : null;
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

/** Parse one line of inline markdown into spans. Never throws. */
export function parseInline(line: string): Inline[] {
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
      const safe = linkHref(href);
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
 */
export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.split('\n');

  let para: string[] = [];
  let ul: Inline[][] = [];
  let ol: Inline[][] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: 'para', spans: parseInline(para.join(' ')) });
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
    if (olM) { flushPara(); if (ul.length) flushLists(); ol.push(parseInline(olM[1])); continue; }

    const ulM = UL_RE.exec(line);
    if (ulM) { flushPara(); if (ol.length) flushLists(); ul.push(parseInline(ulM[1])); continue; }

    flushLists();
    para.push(line.trim());
  }

  flushPara();
  flushLists();
  return blocks;
}
