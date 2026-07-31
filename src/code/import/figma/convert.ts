// convert.ts — Figma plugin payload → paste-engine ClipboardData.
//
// The transformation layer is written AGAINST THE DIALECT RULEBOOK (the same
// morals the oracle's check-file verifies — kept separate by design; this
// module never calls the checker, it EMBEDS the rules):
//   • every node: explicit position + width + height, unique id, human name
//   • flex/grid parent → children position:'relative' + flex '0 0 auto'
//     (or '1 0 0px' fill) + QUOTED sequential order
//   • no-layout parent → children position:'absolute' + data-pinned +
//     explicit left/top px (freeform frames free-drag on the canvas)
//   • padded frame must declare a layout (display:flex)
//   • alignItems only flex-start/center/flex-end — stretch/baseline dropped
//   • rotation = transform: 'rotate(Ndeg)' (RotateManager's form; internal
//     unitless `rotate` is converted at emission — bare `rotate: 'N'` is invalid CSS)
//   • no 'transparent' keyword — rgba(0, 0, 0, 0)
//   • images are FRAME divs with backgroundImage, never <img>
//   • vectors are dialect SVG shapes: wrapper svg (1:1 viewBox,
//     preserveAspectRatio="none", overflow visible) + <path> children with
//     ids `<wrapper>-g<i>`; non-path SVG content falls back to a
//     backgroundImage div so nothing is lost
//
// Output feeds the EXISTING paste engine (overrideClipboard), so target
// resolution, id re-allocation, placement, replica routing and undo all come
// from the same machinery as internal copy/paste.

import type { ClipboardData, ClipboardNode } from '@/code/features/paste-engine/types';
import type { FigmaPayload, FigmaPayloadNode } from './payload-types';
import { elementToD } from '@/shared/svg-path/svg-path-parser';
import { SvgPath } from '@/shared/svg-path/svg-path-model';
import { trace } from '@/shared/debug-trace';

const LAYOUT_DISPLAYS = ['flex', 'inline-flex', 'grid', 'inline-grid'];

/** Style keys we refuse to forward (unsupported / dialect-hostile). */
const DROPPED_KEYS = new Set([
  'transform',          // handled → rotate
  'boxSizing',
  'flexShrink',         // folded into flex
  'flexGrow',           // folded into flex
  'flexBasis',          // folded into flex
  'alignSelf',          // stretch default breaks the Align control; sizes are explicit px anyway
  'fontFeatureSettings',
  'fontVariantNumeric',
  'textUnderlinePosition',
]);

function parseRotateDeg(transform: string): string | null {
  const m = transform.match(/rotate\(\s*(-?[\d.]+)deg\s*\)/);
  return m ? m[1] : null;
}

/** Premium (non-Google) families mapped to a metric-close Google twin.
 *  Figma designs routinely use licensed fonts the builder can't load — the
 *  browser then falls back to a generic sans whose metrics REWRAP fixed-
 *  width text (the Aeonik title overlapping its description). The alias
 *  slots between the original and sans-serif, so a locally-installed
 *  original still wins. Keys are lowercased family names. */
const FONT_ALIASES: Record<string, string> = {
  'aeonik': 'Inter',
  'neue haas grotesk display pro': 'Inter',
  'helvetica now display': 'Inter',
  'sf pro display': 'Inter',
  'sf pro text': 'Inter',
  'circular std': 'Rubik',
  'gt walsheim': 'Poppins',
  'graphik': 'Inter',
  'söhne': 'Inter',
  'sohne': 'Inter',
  'general sans': 'Inter',
  'clash display': 'Space Grotesk',
  'clash grotesk': 'Space Grotesk',
  'satoshi': 'Inter',
  'cabinet grotesk': 'Archivo',
};

/** A single CSS color token? (hex, rgb(a), hsl(a), named — no shorthand debris). */
function isPlainColor(v: string): boolean {
  const t = v.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(t)) return true;
  if (/^(rgb|rgba|hsl|hsla)\([^)]*\)$/.test(t)) return true;
  return /^[a-zA-Z]+$/.test(t); // named color, single word
}

/** Split Figma's `background` shorthand into the dialect's
 *  backgroundColor / backgroundImage pair. The plugin strips unusable
 *  url(<placeholder>) layers, which can leave shorthand DEBRIS like
 *  "lightgray 50% / cover no-repeat, #D9D9D9" — extract the real color
 *  layer, never forward junk as a paint. */
function splitBackground(styles: Record<string, string>): void {
  const bg = styles.background;
  if (!bg) return;
  delete styles.background;
  const isGradient = /gradient\(/.test(bg);
  if (isGradient) {
    if (!styles.backgroundImage) styles.backgroundImage = bg;
    return;
  }
  if (styles.backgroundColor) return;
  if (isPlainColor(bg)) {
    styles.backgroundColor = bg.trim();
    return;
  }
  // Shorthand debris — scan comma-separated layers (last wins in CSS
  // background stacking for the color layer), then space tokens.
  const layers = bg.split(',').map((l) => l.trim());
  for (let i = layers.length - 1; i >= 0; i--) {
    if (isPlainColor(layers[i])) { styles.backgroundColor = layers[i]; return; }
    for (const tok of layers[i].split(/\s+/)) {
      if (/^#[0-9a-fA-F]{3,8}$/.test(tok) || /^(rgb|rgba|hsl|hsla)\(/.test(tok)) {
        styles.backgroundColor = tok;
        return;
      }
    }
  }
}

/** Replace every `var(--name, fallback)` with its FALLBACK. Figma emits
 *  variable-bound paints this way ("var(--goled-10, #FEDC98)") and the
 *  builder has no figma variable definitions — unresolved, the whole paint
 *  parsed as junk and the yellow CTA backdrop vanished. Paren-matching
 *  handles nested parens (rgba fallbacks); loops until no var() remains. */
export function resolveCssVars(val: string): string {
  let out = val;
  for (let guard = 0; guard < 5 && out.includes('var('); guard++) {
    let next = '';
    let i = 0;
    while (i < out.length) {
      const at = out.indexOf('var(', i);
      if (at === -1) { next += out.slice(i); break; }
      next += out.slice(i, at);
      let depth = 0;
      let j = at + 3;
      for (; j < out.length; j++) {
        if (out[j] === '(') depth++;
        else if (out[j] === ')') { depth--; if (depth === 0) break; }
      }
      const inner = out.slice(at + 4, j);
      const comma = inner.indexOf(',');
      if (comma !== -1) next += inner.slice(comma + 1).trim();
      i = j + 1;
    }
    out = next;
  }
  return out;
}

/** Dialect-sanitize one node's styles IN PLACE (parent-independent pass). */

/** Font size in px for line-height ratio math. A fluid `clamp(min, pref, max)`
 *  resolves to its MAX — the size the layout was designed at, and the one a
 *  fixed px leading was eyeballed against. */
function fontSizePx(v: string | undefined): number {
  if (!v) return NaN;
  const clamp = v.match(/^clamp\(([^)]*)\)$/);
  if (clamp) {
    const parts = clamp[1].split(',').map((x) => parseFloat(x)).filter(Number.isFinite);
    return parts.length ? parts[parts.length - 1] : NaN;
  }
  return parseFloat(v);
}
function sanitizeStyles(styles: Record<string, string>): void {
  for (const key of Object.keys(styles)) {
    let val = styles[key];
    if (val == null) { delete styles[key]; continue; }
    val = String(val).trim();
    if (val.includes('/*')) val = val.replace(/\/\*[^]*?\*\//g, '').trim();
    if (val.includes('var(')) val = resolveCssVars(val).trim();
    if (val === '' || DROPPED_KEYS.has(key)) {
      if (key === 'transform') {
        const deg = parseRotateDeg(val);
        if (deg && deg !== '0') styles.rotate = deg;
      }
      delete styles[key];
      continue;
    }
    if (val === 'transparent') val = 'rgba(0, 0, 0, 0)';
    styles[key] = val;
  }
  splitBackground(styles);
  // figma emits lineHeight as a percentage ('110%', often with a baked
  // comment) — the Line Height control only holds unitless/px/'normal'.
  if (styles.lineHeight && styles.lineHeight.endsWith('%')) {
    const pct = parseFloat(styles.lineHeight);
    if (Number.isFinite(pct)) styles.lineHeight = String(Math.round((pct / 100) * 1000) / 1000);
  } else if (styles.lineHeight && styles.lineHeight.endsWith('px')) {
    // …and figma also emits it in PX, which the % branch above never covered:
    // 17 px line-heights rode an import straight into a live page and bounced
    // LINE_HEIGHT_FORMAT (user report 2026-07-26). A px leading is FROZEN — it
    // cannot follow the font down a responsive tier, so the lines overlap at
    // small sizes. Convert to the unitless ratio the control holds.
    //
    // A FLUID `clamp(min, pref, max)` font resolves to its MAX: that is the
    // size the layout was designed at and the one the px leading was eyeballed
    // against, so the ratio reproduces the intended look and every smaller step
    // scales with it. Without a readable font size there is nothing to divide
    // by — leave the px value for the checker to report rather than guess.
    const px = parseFloat(styles.lineHeight);
    const fs = fontSizePx(styles.fontSize);
    if (Number.isFinite(px) && Number.isFinite(fs) && fs > 0) {
      styles.lineHeight = String(Math.round((px / fs) * 1000) / 1000);
    }
  }
  if (styles.fontFamily && !styles.fontFamily.includes(',')) {
    const alias = FONT_ALIASES[styles.fontFamily.trim().toLowerCase()];
    styles.fontFamily = alias
      ? `${styles.fontFamily}, ${alias}, sans-serif`
      : `${styles.fontFamily}, sans-serif`;
  }
  if (styles.display === 'inline-flex') styles.display = 'flex';
  if (styles.display === 'inline-grid') styles.display = 'grid';
  // Align control has no stretch/baseline — stretch behaviour = omit.
  if (styles.alignItems === 'stretch' || styles.alignItems === 'baseline') delete styles.alignItems;
  if (styles.justifyContent === 'stretch') delete styles.justifyContent;
  // Figma's flex column reverse variants are rare; normalize unknowns away.
  if (styles.flexDirection && !['row', 'column', 'row-reverse', 'column-reverse'].includes(styles.flexDirection)) {
    delete styles.flexDirection;
  }
}

/** Figma rotates around the node's TOP-LEFT (its transform matrix origin);
 *  the builder's rotate spins around the CENTER. For a rotated absolute node
 *  shift left/top so the center-rotation lands pixel-identical:
 *  L' = L + R(θ)·c − c, with c = (w/2, h/2), θ the CSS angle. */
function adjustRotatedPosition(styles: Record<string, string>): void {
  const deg = parseFloat(styles.rotate ?? '');
  if (!Number.isFinite(deg) || deg === 0) return;
  const px = (v?: string) => (v && v.endsWith('px') ? parseFloat(v) : NaN);
  const w = px(styles.width);
  const h = px(styles.height);
  const left = px(styles.left);
  const top = px(styles.top);
  if ([w, h, left, top].some((n) => !Number.isFinite(n))) return;
  const th = (deg * Math.PI) / 180;
  const cx = w / 2;
  const cy = h / 2;
  const dx = (Math.cos(th) * cx - Math.sin(th) * cy) - cx;
  const dy = (Math.sin(th) * cx + Math.cos(th) * cy) - cy;
  styles.left = `${(left + dx).toFixed(2)}px`;
  styles.top = `${(top + dy).toFixed(2)}px`;
}

/** Paint an image fill per its Figma scale mode. backgroundColor (a solid
 *  layered under the image in Figma) is left intact — CSS stacks them. */
function applyImageFill(styles: Record<string, string>, url: string, scaleMode?: string, tileSize?: string): void {
  styles.backgroundImage = `url(${url})`;
  const mode = (scaleMode || 'FILL').toUpperCase();
  if (mode === 'TILE') {
    styles.backgroundRepeat = 'repeat';
    styles.backgroundSize = tileSize ?? styles.backgroundSize ?? 'auto';
    styles.backgroundPosition = styles.backgroundPosition ?? '0px 0px';
  } else {
    styles.backgroundRepeat = 'no-repeat';
    styles.backgroundSize = mode === 'FIT' ? 'contain' : 'cover';
    styles.backgroundPosition = styles.backgroundPosition ?? 'center';
  }
}

/** Figma → CSS mix-blend-mode (unknown modes are omitted). */
const CSS_BLEND: Record<string, string> = {
  MULTIPLY: 'multiply', SCREEN: 'screen', OVERLAY: 'overlay',
  DARKEN: 'darken', LIGHTEN: 'lighten', COLOR_DODGE: 'color-dodge',
  COLOR_BURN: 'color-burn', HARD_LIGHT: 'hard-light', SOFT_LIGHT: 'soft-light',
  DIFFERENCE: 'difference', EXCLUSION: 'exclusion', HUE: 'hue',
  SATURATION: 'saturation', COLOR: 'color', LUMINOSITY: 'luminosity',
};

/** Does this image fill need its own overlay layer? CSS background layers
 *  can't carry per-layer opacity or blend — a 4%-opacity noise paint would
 *  import at FULL strength (the grainy-background find). */
function fillNeedsOverlay(src: FigmaPayloadNode): boolean {
  if (typeof src.srcOpacity === 'number' && src.srcOpacity < 0.999) return true;
  return !!src.srcBlendMode && src.srcBlendMode !== 'NORMAL' && !!CSS_BLEND[src.srcBlendMode];
}

const hasRealPadding = (s: Record<string, string>): boolean =>
  ['padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']
    .some((k) => s[k] != null && /[1-9]/.test(s[k]));

const isLayoutParent = (s: Record<string, string>): boolean =>
  s.display != null && LAYOUT_DISPLAYS.includes(s.display);

/** Normalize a figma flex value to the dialect's two legal forms. */
function dialectFlex(raw: string | undefined): string {
  if (!raw) return '0 0 auto';
  const grow = parseFloat(raw.split(/\s+/)[0]);
  return Number.isFinite(grow) && grow > 0 ? '1 0 0px' : '0 0 auto';
}

// ─── SVG → dialect shape ─────────────────────────────────────────────────────
//
// Best-effort resolution into the builder's shape grammar (mirrors what the
// icon-set paste does): primitives (rect/circle/ellipse/polygon/polyline/
// line) convert to path `d` strings, pure-translate <g> wrappers are BAKED
// into the path coordinates, and multi-shape svgs emit the GROUP grammar
// (outer group svg + nested single-path shape svgs). Only genuinely
// unexpressible content falls back to a pixel-perfect background image:
// masks, clip paths, embedded images/text, filters, non-translate
// transforms, and gradient/pattern paint (url(#…) refs — the Fill panel
// binds solid paint on paths, not defs).

interface ParsedShape {
  d: string;
  paint: Record<string, string>;
}

interface ParsedSvg {
  viewBox: { w: number; h: number };
  shapes: ParsedShape[];
  /** true when the markup contains anything the dialect shape can't express */
  complex: boolean;
}

const PATH_PAINT_ATTRS = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'fill-rule', 'clip-rule', 'fill-opacity', 'stroke-opacity', 'opacity'];
const DRAWABLE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line']);
const COMPLEX_TAGS = new Set(['mask', 'clippath', 'image', 'text', 'foreignobject', 'use', 'pattern', 'filter']);

/** Parse a transform attr that is a PURE translation — translate(x[,y]) or
 *  matrix(1,0,0,1,tx,ty) — into its offset. null = not a pure translation. */
function pureTranslate(transform: string | null): { x: number; y: number } | null {
  if (!transform || !transform.trim()) return { x: 0, y: 0 };
  const t = transform.trim();
  const tr = t.match(/^translate\(\s*(-?[\d.]+)[\s,]*(-?[\d.]+)?\s*\)$/);
  if (tr) return { x: parseFloat(tr[1]), y: tr[2] != null ? parseFloat(tr[2]) : 0 };
  const mx = t.match(/^matrix\(\s*1[\s,]+0[\s,]+0[\s,]+1[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)$/);
  if (mx) return { x: parseFloat(mx[1]), y: parseFloat(mx[2]) };
  return null;
}

/** DOM-walk a Figma svg export into flat dialect shapes. Returns null when
 *  the markup is unreadable or has no drawable geometry. */
export function parseFigmaSvg(svg: string): ParsedSvg | null {
  if (typeof DOMParser === 'undefined') return null;
  let root: Element;
  try {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    root = doc.documentElement;
    if (root.tagName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return null;
  } catch {
    return null;
  }

  const vbAttr = root.getAttribute('viewBox');
  let w = 0;
  let h = 0;
  if (vbAttr) {
    const parts = vbAttr.trim().split(/[\s,]+/).map(parseFloat);
    if (parts.length === 4) { w = parts[2]; h = parts[3]; }
  }
  if (!(w > 0 && h > 0)) {
    w = parseFloat(root.getAttribute('width') || '0');
    h = parseFloat(root.getAttribute('height') || '0');
  }
  if (!(w > 0 && h > 0)) return null;

  const shapes: ParsedShape[] = [];
  let complex = false;

  const walk = (el: Element, dx: number, dy: number, inherited: Record<string, string>): void => {
    for (const child of Array.from(el.children)) {
      if (complex) return;
      const tag = child.tagName.toLowerCase();
      if (tag === 'defs' || tag === 'title' || tag === 'desc') continue;
      if (COMPLEX_TAGS.has(tag)) { complex = true; return; }

      const own: Record<string, string> = { ...inherited };
      for (const k of PATH_PAINT_ATTRS) {
        const v = child.getAttribute(k);
        if (v != null) own[k] = v;
      }

      if (tag === 'g' || tag === 'svg') {
        const t = pureTranslate(child.getAttribute('transform'));
        if (!t) { complex = true; return; }
        walk(child, dx + t.x, dy + t.y, own);
        continue;
      }
      if (!DRAWABLE_TAGS.has(tag)) continue;

      const t = pureTranslate(child.getAttribute('transform'));
      if (!t) { complex = true; return; }
      if (Object.values(own).some((v) => typeof v === 'string' && v.includes('url('))) {
        complex = true; // gradient/pattern paint — not bindable on a path
        return;
      }
      let d = '';
      try { d = elementToD(child); } catch { d = ''; }
      if (!d) continue;
      const ox = dx + t.x;
      const oy = dy + t.y;
      if (ox !== 0 || oy !== 0) {
        try {
          const p = new SvgPath(d);
          p.translate(ox, oy);
          d = p.asString(2);
        } catch {
          complex = true;
          return;
        }
      }
      shapes.push({ d, paint: own });
    }
  };

  walk(root, 0, 0, {});
  if (complex) return { viewBox: { w, h }, shapes, complex: true };
  if (shapes.length === 0) return null;
  return { viewBox: { w, h }, shapes, complex: false };
}

/** URI-encode an SVG string for a CSS backgroundImage data URL. */
function svgToDataUrl(svg: string): string {
  const cleaned = svg.replace(/\s+/g, ' ');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cleaned)}`;
}

// ─── Conversion ──────────────────────────────────────────────────────────────

export interface ConvertOptions {
  /** Swap a data-URL asset for a hosted URL. Defaults to identity (the
   *  browser paste path uploads BEFORE convert; tests pass identity). */
  resolveAssetUrl?: (dataUrl: string) => string;
}

/** Convert the plugin payload into paste-engine clipboard data. Pure and
 *  synchronous — asset uploads happen before this (see canvas/figma-paste). */
export function convertFigmaPayload(payload: FigmaPayload, opts: ConvertOptions = {}): ClipboardData {
  const resolveAsset = opts.resolveAssetUrl ?? ((u: string) => u);
  const byId = new Map<string, FigmaPayloadNode>();
  for (const n of payload.nodes) byId.set(n.id, n);

  const out: ClipboardNode[] = [];
  const usedIds = new Set<string>();

  const uniqueId = (raw: string): string => {
    let id = raw.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() || 'node';
    if (/^[^a-z]/.test(id)) id = `fig-${id}`;
    let candidate = id;
    let i = 2;
    while (usedIds.has(candidate)) candidate = `${id}-${i++}`;
    usedIds.add(candidate);
    return candidate;
  };

  /** Texture fill with paint-level opacity/blend → its own absolute overlay
   *  child (inset 0), painted FIRST so real children stack above it. */
  const emitFillOverlay = (node: ClipboardNode, src: FigmaPayloadNode): void => {
    const oid = uniqueId(`${src.id}-fill`);
    const oStyles: Record<string, string> = {
      position: 'absolute', left: '0px', top: '0px', width: '100%', height: '100%',
    };
    applyImageFill(oStyles, resolveAsset(src.src as string), src.srcScaleMode, src.srcTileSize);
    if (typeof src.srcOpacity === 'number' && src.srcOpacity < 0.999) {
      oStyles.opacity = String(src.srcOpacity);
      // figma BACKGROUND BLUR renders through the layer's fill alpha — with
      // a faint texture fill it's imperceptible there, while CSS
      // backdrop-filter applies at FULL strength and smears the section's
      // edges into black gradients (the re-paste black-edges find).
      if (src.srcOpacity < 0.3 && node.styles.backdropFilter) {
        delete node.styles.backdropFilter;
      }
    }
    const blend = src.srcBlendMode ? CSS_BLEND[src.srcBlendMode] : undefined;
    if (blend) oStyles.mixBlendMode = blend;
    const overlay: ClipboardNode = {
      id: oid, type: 'div', parentId: node.id, children: [], order: 0,
      styles: oStyles, attrs: { 'data-pinned': 'true' }, name: `${src.name || 'Fill'} texture`,
    };
    node.children.push(overlay.id);
    out.push(overlay);
    trace.action('figma-import:fill-overlay', { id: node.id, opacity: src.srcOpacity, blend: src.srcBlendMode });
  };

  const emit = (
    figmaId: string,
    parent: ClipboardNode | null,
    parentIsLayout: boolean,
    flowIndex: number,
    isRoot: boolean,
  ): ClipboardNode | null => {
    const src = byId.get(figmaId);
    if (!src) return null;

    const styles: Record<string, string> = { ...src.styles };
    sanitizeStyles(styles);

    // Figma emits shape paint as `fill` — meaningless CSS on a div/p (the
    // invisible-orange-circle find). Map it onto the dialect's paint props;
    // svg kinds keep it (an svg wrapper's fill legitimately inherits into
    // paths). Applied before kind shaping so image fills can layer on top.
    if (styles.fill && src.kind !== 'svg') {
      if (src.kind === 'text') {
        if (!styles.color) styles.color = styles.fill;
      } else if (/gradient\(/.test(styles.fill)) {
        if (!styles.backgroundImage) styles.backgroundImage = styles.fill;
      } else if (!styles.backgroundColor) {
        styles.backgroundColor = styles.fill;
      }
      delete styles.fill;
    }

    const id = uniqueId(src.id);
    const node: ClipboardNode = {
      id,
      type: 'div',
      parentId: parent ? parent.id : null,
      children: [],
      order: flowIndex,
      styles,
      attrs: {},
      name: src.name || undefined,
      textContent: undefined,
    };

    // ── kind-specific shaping ──
    if (src.kind === 'text') {
      const raw = src.text ?? '';
      // Figma positions words with SPACE RUNS (gaps for inline badges) and
      // authored newlines. JSX text semantics collapse both when the page
      // renders (the one-line hero title find) — so runs of spaces become
      // NBSP (JSX can't touch those) and short-lined multi-line text splits
      // into ONE <p> PER LINE, which no fallback font can ever re-wrap.
      const nbspify = (t: string) => t
        .replace(/^ +/, (m) => '\u00A0'.repeat(m.length))
        .replace(/ {2,}/g, (m) => '\u00A0'.repeat(m.length));
      const lines = raw.split('\n');
      const headingStyle = lines.length > 1 && lines.every((l) => l.trim().length <= 40);
      if (headingStyle) {
        node.type = 'div';
        node.textContent = undefined;
        styles.display = 'flex';
        styles.flexDirection = 'column';
        styles.alignItems = 'flex-start';
        if (!styles.width) styles.width = 'max-content';
        if (!styles.height) styles.height = 'auto';
        lines.forEach((line, li) => {
          const lid = uniqueId(`${src.id}-l${li}`);
          const lineNode: ClipboardNode = {
            id: lid,
            type: 'p',
            parentId: id,
            children: [],
            order: li,
            styles: {
              margin: '0px', width: '100%', height: 'auto', whiteSpace: 'nowrap',
              position: 'relative', flex: '0 0 auto', order: String(li),
            },
            attrs: {},
            name: `Line ${li + 1}`,
            textContent: nbspify(line),
          };
          node.children.push(lineNode.id);
          out.push(lineNode);
        });
      } else {
        node.type = 'p';
        node.textContent = nbspify(raw);
        styles.margin = styles.margin ?? '0px';
        if (!styles.width) styles.width = 'max-content';
        if (!styles.height) styles.height = 'auto';
        if (raw.includes('\n') && !styles.whiteSpace) styles.whiteSpace = 'pre-wrap';
      }
    } else if (src.kind === 'img') {
      node.type = 'div';
      if (src.src) {
        if (fillNeedsOverlay(src)) emitFillOverlay(node, src);
        else applyImageFill(styles, resolveAsset(src.src), src.srcScaleMode, src.srcTileSize);
      }
      delete styles.background;
    } else if (src.kind === 'div' && src.src) {
      if (fillNeedsOverlay(src)) emitFillOverlay(node, src);
      else applyImageFill(styles, resolveAsset(src.src), src.srcScaleMode, src.srcTileSize);
    } else if (src.kind === 'svg') {
      const parsed = src.svg ? parseFigmaSvg(src.svg) : null;
      if (parsed && !parsed.complex) {
        const { w, h } = parsed.viewBox;
        node.type = 'svg';
        node.attrs = {
          viewBox: `0 0 ${w} ${h}`,
          preserveAspectRatio: 'none',
        };
        // Wrapper is 1:1 — style px equal viewBox units.
        styles.width = `${w}px`;
        styles.height = `${h}px`;
        styles.overflow = 'visible';
        node.children = [];
        const pathNode = (pid: string, parentId: string, shape: ParsedShape, order: number): ClipboardNode => {
          const pathAttrs: Record<string, string> = { d: shape.d };
          for (const k of PATH_PAINT_ATTRS) if (shape.paint[k] != null) pathAttrs[k] = shape.paint[k];
          if (pathAttrs.fill == null && pathAttrs.stroke == null) pathAttrs.fill = '#000000';
          return { id: pid, type: 'path', parentId, children: [], order, styles: {}, attrs: pathAttrs };
        };
        if (parsed.shapes.length === 1) {
          const child = pathNode(`${id}-g0`, id, parsed.shapes[0], 0);
          usedIds.add(child.id);
          node.children.push(child.id);
          out.push(child);
        } else {
          parsed.shapes.forEach((shape, i) => {
            const shapeId = `${id}-s${i}`;
            const nested: ClipboardNode = {
              id: shapeId,
              type: 'svg',
              parentId: id,
              children: [],
              order: i,
              styles: {},
              attrs: {
                x: '0', y: '0', width: String(w), height: String(h),
                viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', overflow: 'visible',
              },
              name: `${src.name || 'Shape'} ${i + 1}`,
            };
            const p = pathNode(`${shapeId}-g0`, shapeId, shape, 0);
            usedIds.add(nested.id);
            usedIds.add(p.id);
            nested.children.push(p.id);
            out.push(nested, p);
            node.children.push(nested.id);
          });
        }
      } else if (src.svg) {
        // Complex vector — keep it pixel-perfect as an image frame. The
        // EXPORT already bakes the node's own rotation into the markup, so
        // the CSS rotate must be dropped or the shape rotates TWICE (the
        // "beige card flies off the page" bug). The export's bounds are the
        // rotated AABB — size/offset the frame to match.
        node.type = 'div';
        const deg = parseFloat(styles.rotate ?? '');
        if (Number.isFinite(deg) && deg !== 0) {
          delete styles.rotate;
          const px = (v?: string) => (v && v.endsWith('px') ? parseFloat(v) : NaN);
          const w = px(styles.width);
          const h = px(styles.height);
          if (Number.isFinite(w) && Number.isFinite(h)) {
            const th = (deg * Math.PI) / 180;
            const c = Math.cos(th);
            const sn = Math.sin(th);
            const xs = [0, w * c, -h * sn, w * c - h * sn];
            const ys = [0, w * sn, h * c, w * sn + h * c];
            const minX = Math.min(...xs);
            const minY = Math.min(...ys);
            styles.width = `${(Math.max(...xs) - minX).toFixed(2)}px`;
            styles.height = `${(Math.max(...ys) - minY).toFixed(2)}px`;
            const left = px(styles.left);
            const top = px(styles.top);
            if (Number.isFinite(left)) styles.left = `${(left + minX).toFixed(2)}px`;
            if (Number.isFinite(top)) styles.top = `${(top + minY).toFixed(2)}px`;
          }
        }
        styles.backgroundImage = `url(${svgToDataUrl(src.svg)})`;
        styles.backgroundSize = 'contain';
        styles.backgroundPosition = 'center';
        styles.backgroundRepeat = 'no-repeat';
        trace.action('figma-import:svg-fallback', { id, name: src.name });
      }
    }

    // ── placement rules (the layout-frame ⁄ freeform-frame dichotomy) ──
    if (isRoot) {
      // Roots go to the paste engine's target resolver; give them concrete
      // px + absolute so canvas placement has real geometry.
      styles.position = 'absolute';
      node.computedDimensions = { width: styles.width, height: styles.height };
    } else if (parentIsLayout && styles.position !== 'absolute') {
      styles.position = 'relative';
      delete styles.left;
      delete styles.top;
      delete styles.right;
      delete styles.bottom;
      styles.flex = dialectFlex(styles.flex);
      styles.order = String(flowIndex);
    } else {
      // No-layout parent, OR a figma "absolute position" child excluded from
      // its auto-layout parent's flow (arrives with position:'absolute') —
      // both stay out of flow. Default a pin only on an axis that has NONE:
      // a constraints-derived right/bottom must not fight a synthesized 0px.
      styles.position = 'absolute';
      if (!styles.left && !styles.right) styles.left = '0px';
      if (!styles.top && !styles.bottom) styles.top = '0px';
      adjustRotatedPosition(styles);
      node.attrs = { ...node.attrs, 'data-pinned': 'true' };
    }

    // ── universal dialect guarantees ──
    // Internal `rotate` (unitless, from the figma matrix) → the builder's
    // REAL rotation form: `transform: 'rotate(Ndeg)'` (what RotateManager
    // writes/reads). A bare `rotate: '-45'` is INVALID CSS — browsers drop
    // the declaration, so imports silently lost their rotations on the live
    // site while the position math (adjustRotatedPosition) still assumed
    // them. Center origin is identical for both forms, so the position
    // adjustment stays correct.
    if (styles.rotate) {
      const deg = parseFloat(styles.rotate);
      delete styles.rotate;
      if (Number.isFinite(deg) && deg !== 0) styles.transform = `rotate(${deg}deg)`;
    }
    if (!styles.width) styles.width = 'auto';
    if (!styles.height) styles.height = 'auto';
    if (node.type === 'div' && hasRealPadding(styles) && !isLayoutParent(styles)) {
      styles.display = 'flex';
      styles.flexDirection = styles.flexDirection ?? 'column';
    }

    out.push(node);

    if (src.kind === 'div' && Array.isArray(src.children)) {
      const childIsFlow = isLayoutParent(styles);
      let idx = 0;
      for (const childId of src.children) {
        const child = emit(childId, node, childIsFlow, idx, false);
        if (child) {
          node.children.push(child.id);
          // Out-of-flow children don't consume a flow slot — orders on the
          // remaining flow siblings must stay sequential.
          if (child.styles.position !== 'absolute') idx++;
        }
      }
    }
    return node;
  };

  const roots: string[] = [];
  for (const rootId of payload.rootNodeIds) {
    const root = emit(rootId, null, false, 0, true);
    if (root) roots.push(root.id);
  }

  trace.action('figma-import:converted', {
    figmaNodes: payload.nodes.length,
    emitted: out.length,
    roots: roots.length,
  });

  return { version: 1, timestamp: Date.now(), nodes: out };
}
