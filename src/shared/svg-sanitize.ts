// svg-sanitize.ts — make arbitrary SVG markup JSX-SAFE for inner-markup embeds.
//
// Real-world SVGs (Inkscape/Illustrator exports, svgl.app wordmarks) carry
// syntax that is valid XML but CRASHES a JSX parse the moment the markup is
// written into a page as an element's inner content:
//   • `<!-- Created with Inkscape -->`  — JSX has no XML comments.
//   • `<style>.st0{fill:#E43225;}</style>` — a `{` in element TEXT starts a
//     JSX expression; the whole file stops parsing (live find 2026-07-28: a
//     dragged wordmark's add-mutation silently vanished).
//   • `xmlns:xlink="…"` / `xml:space="…"` / `xlink:href="…"` — namespaced JSX
//     attributes throw in babel by default.
// The canvas pipeline is JSX-first (code IS the source of truth), so the
// markup must be sanitized at the boundary — colors from class rules are
// preserved by INLINING them as SVG presentation attributes.
//
// Pure string transforms — shared by the layout-drag normalizer and the
// plugin SDK's assets.addSvg handler, and safe for any future embed path.

/** CSS properties that are legal SVG presentation ATTRIBUTES — the subset a
 *  vector-editor `<style>` block realistically uses for fills/strokes. */
const SVG_PRESENTATION_ATTRS = new Set([
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
  'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'clip-rule',
  'stop-color', 'stop-opacity', 'color', 'display',
]);

/** Remove what makes an SVG ACTIVE rather than a drawing: `<script>`,
 *  `<foreignObject>` (embedded HTML), `on*` event handlers and `javascript:`
 *  links. Uploaded SVGs land inline in the user's page, which ships as server-
 *  rendered HTML — a `<script>` there runs for every visitor (Media panel SVG
 *  drop, 2026-10-15). Drawings never need any of it. */
export function stripActiveSvgContent(markup: string): string {
  return markup
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/<foreignObject\b[^>]*\/>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:xlink:)?href\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '');
}

const DRAWABLE_SVG_RE = /<(?:path|rect|circle|ellipse|line|polyline|polygon|text|image|use)\b/i;

/** Is anything left to DRAW once the active content is stripped? An
 *  html-to-image style export — one <foreignObject> holding HTML, which is how
 *  "Export as SVG" used to write every selection — has nothing, and importing
 *  it as vectors produced an empty <svg> (2026-10-19). */
export function svgHasDrawableContent(markup: string): boolean {
  return DRAWABLE_SVG_RE.test(stripActiveSvgContent(markup));
}

/** An SVG whose only content is embedded HTML (<foreignObject>) — an
 *  html-to-image snapshot. Importers must unwrap it (vectorize-html-svg.ts),
 *  never sanitize it straight to an empty <svg>. */
export function isHtmlOnlySvg(markup: string): boolean {
  return /<foreignObject\b/i.test(markup) && !svgHasDrawableContent(markup);
}

export function sanitizeSvgMarkupForJsx(markup: string): string {
  let s = stripActiveSvgContent(markup);

  // 1) XML comments are not JSX.
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  // 2) <style> blocks: harvest simple single-class rules (`.st0{fill:#e43225;}`)
  //    into a class → presentation-attribute map, then DROP the element — its
  //    text braces are what break the parse.
  const classAttrs = new Map<string, string[]>();
  s = s.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_m, css) => {
    const body = String(css).replace(/<!\[CDATA\[|\]\]>/g, '');
    const ruleRe = /\.([A-Za-z_][\w-]*)\s*\{([^}]*)\}/g;
    let r: RegExpExecArray | null;
    while ((r = ruleRe.exec(body)) !== null) {
      const attrs: string[] = [];
      for (const decl of r[2].split(';')) {
        const ci = decl.indexOf(':');
        if (ci === -1) continue;
        const prop = decl.slice(0, ci).trim().toLowerCase();
        const val = decl.slice(ci + 1).trim();
        if (prop && val && SVG_PRESENTATION_ATTRS.has(prop)) {
          attrs.push(`${prop}="${val.replace(/"/g, '&quot;')}"`);
        }
      }
      if (attrs.length) classAttrs.set(r[1], attrs);
    }
    return '';
  });

  // 3) Swap `class="st0 st1"` for the harvested inline attributes (colors
  //    survive without the stylesheet); unmatched classes just drop.
  s = s.replace(/\s+class="([^"]*)"/g, (_m, cls) => {
    const out: string[] = [];
    for (const c of String(cls).split(/\s+/).filter(Boolean)) {
      for (const a of classAttrs.get(c) ?? []) out.push(a);
    }
    return out.length ? ' ' + out.join(' ') : '';
  });

  // 4) Namespaced attributes throw in babel: `xlink:href` survives as SVG2
  //    `href`; every other `xmlns:* / xml:* / xlink:*` is dropped.
  s = s.replace(/\s+xlink:href=/g, ' href=');
  s = s.replace(/\s+(?:xmlns|xml|xlink):[\w-]+="[^"]*"/g, '');

  // 5) Stray braces in element TEXT (a `<title>` or leftover CSS fragment)
  //    would still start a JSX expression — entity-escape them. Attribute
  //    values are inside tags, so this only touches between-tag text.
  s = s.replace(/>([^<]*)</g, (_m, text: string) =>
    '>' + text.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;') + '<');

  return s.trim();
}
