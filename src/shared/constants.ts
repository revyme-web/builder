// ─── Canvas ────────────────────────────────────────────────────────────────
export const ZOOM_STEP = 0.1;

// ─── Viewports ─────────────────────────────────────────────────────────────

export const VIEWPORT_GAP = 160;

export const DEFAULT_VIEWPORT_WIDTH = 1440;

// ─── Drag ──────────────────────────────────────────────────────────────────

export const MIN_DRAG_DISTANCE = 3;        // px before drag starts (prevents accidental drags from clicks)
export const SNAP_THRESHOLD = 5;           // px within which snap engages
export const SNAP_BREAKOUT_SPEED = 8;      // px/frame — mouse speed to break out of snap
             // px between trigger and relative overlay

// ─── Resize ────────────────────────────────────────────────────────────────

export const RESIZE_HANDLE_SIZE = 8;       // px — visual size of resize handles

// ─── Selection ─────────────────────────────────────────────────────────────

export const DOUBLE_CLICK_THRESHOLD = 400; // ms

// ─── Visual Helpers ────────────────────────────────────────────────────────
 // pink — distinct snap-guide helper
export const MAP_TEMPLATE_COLOR = '#f97316';  // orange — inline .map() template selection

// ── Token-driven canvas overlay colors ─────────────────────────────────────
// These tint the selection box, resize handles, borders, hover outline, drop
// indicators, creators, etc. They're drawn as SVG attributes / canvas strokes
// where CSS `var()` can NOT resolve, so we mirror the editor's live design
// tokens into plain hex here and keep them in sync with the light/dark theme
// via a MutationObserver on <html>.
//
// SELECTION IS NOT THE BRAND ACCENT. Canvas overlays follow `--selection`
// (blue), the chrome follows `--accent` (ayu gold). They were one token until the
// warm rebrand made the difference matter: a selection stroke sits ON TOP of
// the user's artwork, so it has to stay legible against arbitrary colours and
// carry no semantic charge — a warm box around every element reads as a
// warning, and vanishes over warm content. Keep them separate.
// `let` + ES module live-bindings means every importer reads the current value
// on its next render (the selection overlays re-render continuously, so the
// swap is effectively immediate). Falls back to the original blue/purple when
// the tokens aren't readable (tests / SSR). Change the palette in globals.css —
// never here.
let ACCENT_COLOR = '#b8974a';            // mirrors --accent (brand, chrome)
export let SELECTION_COLOR = '#3388ff';         // mirrors --selection (canvas)
export let COMPONENT_COLOR = '#9a66ff';         // mirrors --accent-secondary
let DROP_INDICATOR_COLOR = '#3388ff';    // mirrors --selection
let PARENT_HIGHLIGHT_COLOR = '#3388ff';  // mirrors --selection

/** Exported for unit tests only — production callers are the module-load
 *  sync + the <html> attribute observer below. */
export function refreshAccentColors(): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const rootEl = document.documentElement;
  const cs = getComputedStyle(rootEl);
  // The component-master re-skin (App.tsx) inline-overrides `--accent` to
  // `var(--accent-secondary)` on <html> while a master/template is open.
  // getComputedStyle RESOLVES that override, so syncing the accent mirrors
  // while it's active would bake PURPLE into SELECTION_COLOR — and it then
  // STAYS purple after exiting to a normal page, because the exit removes an
  // inline STYLE that the old class-only observer never saw (the "selection
  // overlay stuck on accent-secondary after leaving the master" bug; the
  // deterministic repro was reloading while deep-linked into a master — the
  // one-frame rAF re-resolve below landed after the re-skin effect). Skip
  // the accent mirrors while the override is active; the style-attribute
  // observer re-syncs the moment the re-skin is lifted.
  const accentOverridden = rootEl.style.getPropertyValue('--accent') !== '';
  const accent = cs.getPropertyValue('--accent').trim();
  const secondary = cs.getPropertyValue('--accent-secondary').trim();
  // `--selection` is never re-skinned, so it needs no override guard — the
  // master re-skin only rewrites `--accent`.
  const selection = cs.getPropertyValue('--selection').trim();
  if (accent && !accentOverridden) ACCENT_COLOR = accent;
  if (selection) {
    SELECTION_COLOR = selection;
    DROP_INDICATOR_COLOR = selection;
    PARENT_HIGHLIGHT_COLOR = selection;
  }
  if (secondary) COMPONENT_COLOR = secondary;
}

if (typeof document !== 'undefined' && document.documentElement) {
  refreshAccentColors();
  // CSS may apply a tick after this module loads — re-resolve next frame.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refreshAccentColors);
  // Re-resolve when the theme flips (BottomToolbar toggles `.dark` on <html>)
  // AND when the master re-skin sets/removes its inline `--accent` override
  // (a `style` mutation — the exit path MUST trigger a refresh so the accent
  // mirrors return to the theme blue).
  try {
    new MutationObserver(refreshAccentColors).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  } catch { /* non-DOM env — keep fallbacks */ }
}

// ─── UI ────────────────────────────────────────────────────────────────────

export const HEADER_HEIGHT = 52;
export const LEFT_MENU_WIDTH = 52;
export const RIGHT_PANEL_WIDTH = 260;
export const BOTTOM_TOOLBAR_HEIGHT = 48;

// ─── Element Type Classification ──────────────────────────────────────────
// In code-source-of-truth, we use real HTML tags. These sets classify them
// for the canvas editor (drag targets, text editing, layers panel icons, etc.)

/** Tags that are "frame" type — containers that can accept children via drag */
export const FRAME_TAGS = new Set([
  'div', 'section', 'article', 'aside', 'main', 'header', 'footer', 'nav',
  'figure', 'figcaption', 'details', 'summary', 'fieldset', 'form',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'dialog', 'menu', 'address', 'blockquote',
  'motion.div', 'motion.section', 'motion.article', 'motion.header', 'motion.footer', 'motion.nav',
  'motion.main', 'motion.aside', 'motion.ul', 'motion.ol', 'motion.li',
  // `motion.create(Link)` wrapper — a link-wrapped frame (renders as a
  // block-level <a>) that can contain children, so it's a frame, not text.
  'MotionLink',
]);

/** Tags that are "text" type — leaf nodes that contain text, not droppable into */
export const TEXT_TAGS = new Set([
  'p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'sub', 'sup',
  'label', 'legend', 'caption', 'abbr', 'cite', 'code', 'pre', 'kbd', 'var',
  'time', 'mark', 'del', 'ins', 'q', 'dfn', 'samp',
  'blockquote',
  'motion.p', 'motion.span', 'motion.h1', 'motion.h2', 'motion.h3', 'motion.h4', 'motion.h5', 'motion.h6',
  'motion.a', 'motion.blockquote',
]);

/** Tags that are "media" type — self-closing or special content */
export const MEDIA_TAGS = new Set([
  'img', 'video', 'audio', 'canvas', 'svg', 'iframe', 'embed', 'object',
  'picture', 'source', 'track',
  'motion.img',
]);

/** Form-control tags. Leaf interactive elements (plus `select` which holds
 *  `<option>`s, managed via the Input tool's Options editor — NOT generic drag).
 *  Used to gate the Input tool and classify these for the layers/selection. */
const INPUT_TAGS = new Set([
  'input', 'textarea', 'select', 'button', 'option', 'optgroup',
]);

/** HTML void elements — self-closing, never receive children. The generator
 *  emits `<input .../>` (not `<input></input>`) for these and refuses to nest
 *  children into them. */
const VOID_TAGS = new Set([
  'input', 'br', 'hr', 'img', 'area', 'base', 'col', 'embed', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/** SVG shape element tags (children of <svg>) */
export const SVG_SHAPE_TAGS = new Set([
  'rect', 'circle', 'ellipse', 'polygon', 'path', 'line', 'polyline', 'g', 'foreignObject',
]);

/** CSS selector string for querySelectorAll on SVG shape children */
export const SVG_SHAPE_SELECTOR = Array.from(SVG_SHAPE_TAGS).join(', ');

/** Check if a tag is an SVG element (wrapper or shape) */
export function isSvgTag(tag: string): boolean {
  return tag === 'svg' || SVG_SHAPE_TAGS.has(tag);
}

/** Check if a tag is a frame (container that can accept children) */
export function isFrameTag(tag: string): boolean {
  return FRAME_TAGS.has(tag);
}

/** Check if a tag is a text element (leaf node, not droppable into) */
export function isTextTag(tag: string): boolean {
  return TEXT_TAGS.has(tag);
}

/** Check if a tag can accept children via drag (only frames) */
export function canAcceptChildren(tag: string): boolean {
  return FRAME_TAGS.has(tag);
}

/** The link tags. `a` is a TEXT tag and `Link` is in neither set, but all
 *  three can WRAP children — see {@link nodeAcceptsChildren}. */
export function isLinkTag(tag: string): boolean {
  return tag === 'a' || tag === 'Link' || tag === 'MotionLink';
}

/**
 * Whether a NODE can take dropped children — the tag test plus the link
 * exception.
 *
 * A link has a dual nature: `<a>click here</a>` is text, but
 * `<Link><div/><h3/></Link>` is a flex container. The CMS row-navigation
 * feature makes exactly that shape — every collection-list row becomes a
 * `<Link data-cms-nav="row">` wrapping the card's image and headings. Tag
 * alone said "not a frame", so the drag system skipped the row entirely and
 * you could only ever drop BESIDE the card in the list, never inside it
 * (user report 2026-07-26). `MotionLink` was already special-cased into
 * FRAME_TAGS for this; the content-aware rule covers all three tags and,
 * unlike adding `Link` to the set, keeps a bare text link a text node.
 *
 * Mirrors `linkIsContainer` in PropertiesPanel — element children mean
 * "container", since a link's own text lives in `textContent`.
 */
export function nodeAcceptsChildren(
  node: { type?: string; children?: unknown[] } | null | undefined,
): boolean {
  if (!node) return false;
  const tag = node.type || 'div';
  if (canAcceptChildren(tag)) return true;
  return isLinkTag(tag) && Array.isArray(node.children) && node.children.length > 0;
}

// ─── "Fit" sizing (auto-size to content) ────────────────────────────────────
// design-tool parity: the editor writes `min-content` for a "Fit" width/height, NOT
// `auto`. `auto` does NOT shrink-to-content on a flex / framer-motion `layout`
// container (every component-master root is one), but `min-content` does — with
// `white-space: nowrap` text it resolves to the full single-line width.
//
// The CSS value written for a Fit dimension.
export const FIT_SIZE = 'min-content';

/** True when a width/height value means "Fit" (auto-size to content). Accepts the
 *  current `min-content`, the legacy `auto`, and `fit-content` — use EVERYWHERE the
 *  editor decides Fit-vs-Fixed (dimension UI, resize handles, selection overlay,
 *  layout math) so all three forms behave identically. NOTE: only for WIDTH/HEIGHT
 *  values — never for `cursor`/`margin`/`overflow`/flex `0 0 auto`. */
export function isFitSize(v: string | undefined | null): boolean {
  if (!v) return false;
  return v === 'min-content' || v === 'auto' || v === 'fit-content' || v === 'max-content';
}

// ─── Grid ──────────────────────────────────────────────────────────────────

// ─── History ───────────────────────────────────────────────────────────────

// ─── Node Defaults ─────────────────────────────────────────────────────────

// ─── Wrapper-only Style Props ──────────────────────────────────────────────
// Style properties that describe how an element sits within its parent —
// positioning (position/inset), stacking (z-index), parent-context layout
// (flex/grid placement, margin, alignSelf/justifySelf), and outer transform.
// They belong on a component's *outer wrapper* and must NOT be re-applied to
// its inner root, or the inner ends up double-positioned (instances) /
// double-transformed (code components). z-index in particular MUST ride the wrapper:
// the wrapper is the positioned box (the instance's placement in its parent),
// so a z-index merged onto the inner root — which is position:static — is
// silently ignored, and the positioned wrapper falls back to auto stacking
// (e.g. a fixed header painting BEHIND the hero on the canvas). Used by:
//   - project-parser.ts when merging instance styles onto component roots
//   - Renderer.ts when patching inline styles on component roots
//   - CodeComponentHost.tsx when forwarding `style` prop to code components
export const WRAPPER_ONLY_STYLE_PROPS: ReadonlySet<string> = new Set([
  'position', 'left', 'top', 'right', 'bottom', 'inset',
  'zIndex',
  'transform', 'transformOrigin', 'transformBox', 'transformStyle',
  'order',
  'flex', 'flexShrink', 'flexGrow', 'flexBasis',
  'alignSelf', 'justifySelf',
  'gridColumn', 'gridRow',
  'gridColumnStart', 'gridColumnEnd', 'gridRowStart', 'gridRowEnd', 'gridArea',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'marginInline', 'marginBlock',
  'marginInlineStart', 'marginInlineEnd', 'marginBlockStart', 'marginBlockEnd',
]);


/**
 * Layout-affecting, NON-tweenable CSS properties. When these differ between a
 * component's variants they must be written as inline `style` ternaries
 * (`flexDirection: variant === 'x' ? 'row' : 'column'`) — applied by React
 * synchronously — NOT into the framer-motion `variants` object. Otherwise
 * motion applies them through its rAF loop AFTER the `layout` (FLIP) prop has
 * measured, so the change snaps and `layout` never animates. (`order` is the
 * same case but has its own drag-reorder path, so it's not listed here.)
 */
export const CONDITIONAL_LAYOUT_PROPS: ReadonlySet<string> = new Set([
  'flexDirection', 'flexWrap',
  'justifyContent', 'alignItems', 'alignContent', 'justifyItems',
  'placeItems', 'placeContent',
  'gap', 'rowGap', 'columnGap',
  'gridTemplateColumns', 'gridTemplateRows', 'gridAutoFlow',
  'gridAutoColumns', 'gridAutoRows',
  // width/height: not "non-tweenable" like the rest, but they belong here for a
  // different reason — when an element RESIZES between variants AND its size
  // change reflows neighbours (or a child enters/exits via AnimatePresence in
  // the same transition), a `variants`-object size VALUE-TWEENS on motion's own
  // clock, OUT of sync with the children's `layout` (FLIP) projection. The
  // result: the resize and the reflow run on two different springs → the
  // entering child SHOVES its siblings on the grow direction (smooth on
  // shrink). Routing size to a `style` ternary makes React apply it
  // synchronously, so the container resize, the child enter, and the sibling
  // reflow are ONE coordinated `layout` pass — exactly how the reference animates its
  // own per-variant sizes (explicit size in the DOM, animated via transform,
  // not a CSS-height tween).
  'width', 'height',
]);

/** CSS initial values for `CONDITIONAL_LAYOUT_PROPS` — used as the ternary's
 *  `default` branch fallback when the element has no prior inline value. */
export const CSS_LAYOUT_DEFAULTS: Readonly<Record<string, string>> = {
  flexDirection: 'row',
  flexWrap: 'nowrap',
  justifyContent: 'flex-start',
  alignItems: 'stretch',
  alignContent: 'stretch',
  justifyItems: 'stretch',
  placeItems: 'stretch',
  placeContent: 'stretch',
  gap: '0px',
  rowGap: '0px',
  columnGap: '0px',
  gridAutoFlow: 'row',
};

/** Invisible character used as placeholder text content when creating new
 *  text elements via the text creator — gives the contenteditable a
 *  non-zero width so the caret has somewhere to land. Stripped on first
 *  real keystroke. Imported by Canvas.tsx + creators/TextCreator.ts. */
export const ZERO_WIDTH_SPACE = '​';

/** True for the PRIMARY (design-source) viewport ids — everything else is a
 *  responsive replica. Pure leaf so canvas/drag/replica-context can use it
 *  without importing node-ops (cycle). node-ops re-exports it. */
export function isPrimaryViewport(vpId: string): boolean {
  return vpId === 'desktop' || vpId === 'default';
}
