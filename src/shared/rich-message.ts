// rich-message.ts — the RICH translation message format.
//
// A text node with inline marks (bold / colour / size / link …) is translated
// as ONE message per node whose value is sanitized inline HTML, e.g.
//   "<strong>bonjour</strong> mon <span style=\"color: red\">ami</span>"
// The JSX for such a node is `<p … dangerouslySetInnerHTML={{ __html: t.raw('id') }} />`
// (see i18n-gen `transformRichTextToTranslation`), the canvas paints the
// message through the locale `innerJsx` override, and the translation panel
// edits it with the same TipTap editor the canvas uses. This module owns the
// allow-list that makes `dangerouslySetInnerHTML` safe: everything a message
// can contain is produced by that editor, and anything else is stripped on
// write. Shared (no DOM assumption): browser + jsdom use DOMParser, Node
// falls back to a conservative regex strip.
import { jsxStyleToHTML } from './css-utils';

/** Inline tags the canvas text editor emits (StarterKit + text-style marks). */
export const RICH_MESSAGE_TAGS: ReadonlySet<string> = new Set([
  'strong', 'b', 'em', 'i', 'u', 's', 'span', 'a', 'br', 'code', 'mark', 'sub', 'sup',
]);
/** Style properties allowed on a <span>/<a>/<mark> inside a message. */
export const RICH_MESSAGE_STYLE_PROPS: ReadonlySet<string> = new Set([
  'color', 'font-size', 'font-weight', 'font-style', 'font-family', 'text-decoration',
  'text-decoration-line', 'letter-spacing', 'line-height', 'background', 'background-color',
  'background-image', 'background-clip', '-webkit-background-clip', '-webkit-text-fill-color',
  'text-transform', 'opacity',
]);

/** True when the value carries inline markup (needs the rich paint path). */
export function isRichHtml(value: string | null | undefined): boolean {
  return typeof value === 'string' && /<[a-z][^>]*>/i.test(value);
}

/** Strip TipTap's block wrapper: `<p>a</p><p>b</p>` → `a<br>b`; a single
 *  paragraph unwraps to its inner HTML. Anything else is returned as is. */
export function unwrapParagraphs(html: string): string {
  const trimmed = html.trim();
  const paras = [...trimmed.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)].map((m) => m[1]!);
  if (paras.length === 0) return trimmed;
  const rest = trimmed.replace(/<p(?:\s[^>]*)?>[\s\S]*?<\/p>/gi, '').trim();
  if (rest) return trimmed; // mixed block content — leave for the sanitizer
  return paras.join('<br>');
}

function filterStyle(style: string): string {
  return style
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(':');
      if (i === -1) return '';
      const prop = s.slice(0, i).trim().toLowerCase();
      const val = s.slice(i + 1).trim();
      if (!RICH_MESSAGE_STYLE_PROPS.has(prop)) return '';
      if (/expression\s*\(|javascript:|url\s*\(/i.test(val)) return '';
      return `${prop}: ${val}`;
    })
    .filter(Boolean)
    .join('; ');
}

/** Allow-list sanitizer for a rich message. Unknown tags are UNWRAPPED (their
 *  text survives), unknown attributes dropped, style filtered to the allowed
 *  properties, links limited to http(s)/mailto/tel/relative. Idempotent. */
export function sanitizeRichMessage(html: string): string {
  const input = unwrapParagraphs(html);
  if (!input) return '';
  if (typeof DOMParser === 'undefined') return sanitizeRichMessageFallback(input);
  const doc = new DOMParser().parseFromString(`<body>${input}</body>`, 'text/html');
  const walk = (el: Element): void => {
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 8) { child.remove(); continue; } // comments
      if (child.nodeType !== 1) continue;
      const node = child as Element;
      const tag = node.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'embed' || tag === 'template') {
        node.remove();
        continue;
      }
      if (!RICH_MESSAGE_TAGS.has(tag)) {
        // Unwrap: keep children in place.
        walk(node);
        const frag = doc.createDocumentFragment();
        while (node.firstChild) frag.appendChild(node.firstChild);
        node.replaceWith(frag);
        continue;
      }
      for (const attr of Array.from(node.attributes)) {
        const name = attr.name.toLowerCase();
        if (name === 'style') {
          const filtered = filterStyle(attr.value);
          if (filtered) node.setAttribute('style', filtered); else node.removeAttribute('style');
        } else if (tag === 'a' && (name === 'href' || name === 'target' || name === 'rel')) {
          if (name === 'href' && !/^(https?:|mailto:|tel:|\/|#|\.)/i.test(attr.value.trim())) node.removeAttribute('href');
        } else {
          node.removeAttribute(attr.name);
        }
      }
      if (tag === 'a' && node.getAttribute('target') === '_blank' && !node.getAttribute('rel')) node.setAttribute('rel', 'noopener noreferrer');
      walk(node);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML.trim();
}

/** No-DOM fallback (server tools): drops dangerous blocks, event handlers and
 *  javascript: URLs; keeps the allow-listed inline tags textually. */
function sanitizeRichMessageFallback(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed|template)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\shref\s*=\s*"\s*javascript:[^"]*"/gi, '')
    .replace(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi, (m, tag: string) => (RICH_MESSAGE_TAGS.has(tag.toLowerCase()) ? m : ''))
    .trim();
}

/** A node's INNER JSX (`<span style={{color: 'red'}}>x</span> y`) → the rich
 *  message HTML. Reuses the canvas serializer (style objects → attributes,
 *  motion tags normalised) then sanitizes. Source indentation collapses to
 *  single spaces the way the canvas paints it. */
export function innerJsxToRichMessage(innerJsx: string): string {
  const html = jsxStyleToHTML(innerJsx)
    .replace(/<br\s*\/>/g, '<br>')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    .trim();
  return sanitizeRichMessage(html);
}

/** The style attribute of every styled <span> in a message, in document order —
 *  the "style runs" a translation inherits from the default locale. */
export function richMessageRunStyles(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<span\b[^>]*\sstyle="([^"]*)"[^>]*>/gi)) out.push(m[1]!);
  return out;
}

/** reference parity: the DEFAULT locale owns the styling (font size / colour /
 *  family of each styled run); a translation only rearranges text and the
 *  structural marks (bold / italic / underline / strike / link). Re-bake the
 *  translation's styled spans from the default, by ordinal: the i-th styled
 *  span in the translation takes the i-th run style of the default. Spans the
 *  default no longer has are unwrapped (text kept). Idempotent. */
export function syncRunStyles(defaultHtml: string, translationHtml: string): string {
  const runs = richMessageRunStyles(defaultHtml);
  let i = 0;
  const out = translationHtml.replace(/<span\b([^>]*)>/gi, (m, attrs: string) => {
    if (!/\sstyle="/.test(attrs)) return m;
    const style = runs[i++];
    if (style === undefined) return '<span data-run-dropped="">';
    return `<span${attrs.replace(/\sstyle="[^"]*"/, ` style="${style}"`)}>`;
  });
  // Unwrap spans whose run vanished from the default.
  return out.replace(/<span data-run-dropped="">([\s\S]*?)<\/span>/g, '$1');
}

// ─── Paste flattening ────────────────────────────────────────────────────────
//
// A builder text node is ONE paragraph. Pasting from Google Docs / Word / a web
// page brings block HTML (`<h1>`, `<h2>`, `<p>`, lists) plus document
// typography (`22pt`, Arial, Noto). Written verbatim inside the node's `<p>`
// that is invalid nesting — the browser auto-closes the outer paragraph and the
// node's own font is overridden (live find 2026-09-07, a Google Doc paste).
// The reference builder flattens: blocks become inline runs separated by line breaks, and only
// the structural marks (bold / italic / underline / strike / link / colour)
// survive; size and family come from the node.

const PASTE_BLOCK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'article', 'header', 'footer', 'blockquote', 'pre', 'li', 'ul', 'ol', 'table', 'tbody', 'thead', 'tr', 'td', 'th', 'figure', 'figcaption', 'main', 'aside', 'nav']);
const PASTE_INLINE_TAGS = new Set(['strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'a', 'span', 'br', 'code', 'sub', 'sup', 'mark']);

function pasteStyleFilter(style: string): string {
  const out: string[] = [];
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i === -1) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (prop === 'color' && val && !/^(rgb\(0,\s*0,\s*0\)|#000000|#000|black|inherit|initial)$/i.test(val)) out.push(`color: ${val}`);
    else if (prop === 'font-weight' && (/^(bold|bolder)$/i.test(val) || (parseInt(val, 10) || 0) >= 600)) out.push('font-weight: 700');
    else if (prop === 'font-style' && /italic|oblique/i.test(val)) out.push('font-style: italic');
    else if (prop === 'text-decoration' || prop === 'text-decoration-line') {
      const parts = val.split(/\s+/).filter((v) => v === 'underline' || v === 'line-through');
      if (parts.length) out.push(`text-decoration: ${parts.join(' ')}`);
    }
    // font-size / font-family / line-height / letter-spacing / background: the node's typography wins.
  }
  return out.join('; ');
}

/** Flatten pasted rich HTML into the node's single-paragraph dialect: block
 *  elements become inline content separated by `<br>`, unknown tags unwrap,
 *  styles reduce to the structural marks. Idempotent; safe on plain text. */
export function flattenPastedRichHtml(html: string): string {
  if (!html || !/<[a-z][^>]*>/i.test(html)) return html;
  if (typeof DOMParser === 'undefined') return flattenPastedRichHtmlFallback(html);
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const text = (n: Node) => {
    const raw = (n.textContent ?? '').replace(/\u00a0/g, ' ');
    // Whitespace-only runs: source formatting (contains a newline) is dropped,
    // a real space between inline siblings is kept as one space.
    if (!raw.trim()) return /\n/.test(raw) ? '' : (raw ? ' ' : '');
    return esc(raw);
  };
  const hasBlockInside = (el: Element) => Array.from(el.querySelectorAll('*')).some((k) => PASTE_BLOCK_TAGS.has(k.tagName.toLowerCase()));
  const serializeInline = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') return '<br>';
    let inner = '';
    for (const c of Array.from(el.childNodes)) {
      if (c.nodeType === 3) inner += text(c);
      else if (c.nodeType === 1) inner += serializeInline(c as Element);
    }
    if (!PASTE_INLINE_TAGS.has(tag)) return inner;
    if (tag === 'b' || tag === 'strong') {
      // Google Docs wraps the whole paste in <b style="font-weight:normal">.
      if (/font-weight:\s*(normal|400)/i.test(el.getAttribute('style') ?? '')) return inner;
      return inner ? `<strong>${inner}</strong>` : '';
    }
    if (tag === 'i' || tag === 'em') return inner ? `<em>${inner}</em>` : '';
    if (tag === 'u') return inner ? `<u>${inner}</u>` : '';
    if (tag === 's' || tag === 'strike' || tag === 'del') return inner ? `<s>${inner}</s>` : '';
    if (tag === 'a') {
      const href = (el.getAttribute('href') ?? '').trim();
      return /^(https?:|mailto:|tel:|\/|#)/i.test(href) && inner ? `<a href="${href.replace(/"/g, '&quot;')}">${inner}</a>` : inner;
    }
    if (tag === 'span' || tag === 'mark') {
      const style = pasteStyleFilter(el.getAttribute('style') ?? '');
      return style && inner ? `<span style="${style}">${inner}</span>` : inner;
    }
    if (tag === 'code' || tag === 'sub' || tag === 'sup') return inner ? `<${tag}>${inner}</${tag}>` : '';
    return inner;
  };
  // Block model: every block element becomes one entry (an empty paragraph an
  // empty entry); loose inline content between blocks accumulates into its own
  // entry. Entries join with <br>, so an empty paragraph yields a blank line.
  const blocks: string[] = [];
  let buf = '';
  const flush = () => { blocks.push(buf); buf = ''; };
  const walk = (el: Element): void => {
    for (const c of Array.from(el.childNodes)) {
      if (c.nodeType === 3) { buf += text(c); continue; }
      if (c.nodeType !== 1) continue;
      const ce = c as Element; const tag = ce.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'meta' || tag === 'title') continue;
      if (PASTE_BLOCK_TAGS.has(tag)) {
        if (buf.trim()) flush(); else buf = '';
        if (hasBlockInside(ce)) { walk(ce); if (buf.trim()) flush(); else buf = ''; }
        else blocks.push(serializeInline(ce).replace(/^(<br>)+|(<br>)+$/g, '').trim());
        continue;
      }
      if (tag === 'br') { buf += '<br>'; continue; }
      // Inline wrapper holding blocks (Google's <b>): descend so the blocks split.
      if (hasBlockInside(ce)) { walk(ce); continue; }
      buf += serializeInline(ce);
    }
  };
  walk(doc.body);
  if (buf.trim()) flush();
  while (blocks.length && !blocks[0]!.trim()) blocks.shift();
  while (blocks.length && !blocks[blocks.length - 1]!.trim()) blocks.pop();
  return blocks.map((b) => b.trim()).join('<br>').replace(/(<br>){3,}/g, '<br><br>');
}

function flattenPastedRichHtmlFallback(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(h[1-6]|p|div|li|blockquote|pre|tr|section|article)>\s*<\1\b[^>]*>/gi, '<br>')
    .replace(/<\/?(h[1-6]|p|div|li|ul|ol|blockquote|pre|table|tbody|thead|tr|td|th|section|article|header|footer|figure)\b[^>]*>/gi, '')
    .replace(/\s(?:font-size|font-family|line-height|letter-spacing)\s*:[^;"]*;?/gi, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/^(<br\s*\/?>)+|(<br\s*\/?>)+$/gi, '')
    .trim();
}
