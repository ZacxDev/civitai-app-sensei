import type { Block, Inline } from '../lib/markdown.js';
import { parseMarkdown } from '../lib/markdown.js';
import { token } from '../theme.js';

/**
 * Render the markdown subset the model emits, as REACT ELEMENTS.
 *
 * 🔴 NO `dangerouslySetInnerHTML`. The parser produces a typed node tree and
 * this walks it — there is no HTML string anywhere in the path, so model- and
 * catalog-authored text cannot introduce markup. See `lib/markdown.ts` for why
 * that is the design rather than a sanitiser.
 *
 * 🔴 EVERY LINK IS `rel="noopener noreferrer"` AND `target="_blank"`. The app
 * runs in a sandboxed iframe with an opaque origin; a same-tab navigation would
 * replace the block itself, and `noopener` denies the opened page a handle back.
 * The href has already been allowlisted to a civitai host by `linkHref` — this
 * is the second half, not a substitute for it.
 */

function InlineSpans({ spans }: { spans: Inline[] }) {
  return (
    <>
      {spans.map((s, i) => {
        if (s.kind === 'bold') return <strong key={i}>{s.text}</strong>;
        if (s.kind === 'code') {
          return (
            <code
              key={i}
              style={{
                background: token.surface2,
                borderRadius: 3,
                padding: '1px 4px',
                fontSize: '0.92em',
              }}
            >
              {s.text}
            </code>
          );
        }
        if (s.kind === 'link') {
          return (
            <a
              key={i}
              href={s.href}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: token.primary, textDecoration: 'underline' }}
            >
              {s.text}
            </a>
          );
        }
        return <span key={i}>{s.text}</span>;
      })}
    </>
  );
}

function BlockNode({ block }: { block: Block }) {
  if (block.kind === 'ul' || block.kind === 'ol') {
    const List = block.kind === 'ul' ? 'ul' : 'ol';
    return (
      <List style={{ margin: '6px 0', paddingLeft: 22 }}>
        {block.items.map((spans, i) => (
          <li key={i} style={{ margin: '2px 0' }}>
            <InlineSpans spans={spans} />
          </li>
        ))}
      </List>
    );
  }
  return (
    <p style={{ margin: '6px 0' }}>
      <InlineSpans spans={block.spans} />
    </p>
  );
}

export function MarkdownText({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div data-testid="markdown-text">
      {blocks.map((b, i) => (
        <BlockNode key={i} block={b} />
      ))}
    </div>
  );
}
