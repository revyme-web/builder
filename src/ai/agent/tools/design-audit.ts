// src/ai/agent/tools/design-audit.ts
//
// Rendered-layout primitives for the conversational agent. Two layers:
//
//   1. Pure, testable building blocks — WCAG color math (`contrastRatio`,
//      `parseCssColor`, `relativeLuminance`) and the seven hard linter rules
//      (auditOverlaps / auditOverflows / auditContrast / auditFontSizes /
//      auditEmptyNodes / auditTextTruncation / auditViewportOverflow), each a
//      pure function over a flat `AuditNode[]` fixture (no DOM, no store).
//
//   2. `collectLayoutSnapshot` — the shared READER the three observation
//      tools (get_layout / get_visuals / audit_design) all use. It walks the
//      node map and reads the canvas bridge's SYNC caches
//      (rectCache / computedCache — see canvas/canvas-bridge.ts): these are
//      populated by sandbox post-message events, so every lookup is a local
//      map read, no iframe round-trip (AGENTS.md invariant #1).
//
// The linter reflects the RENDERED page (CSS applied, flex resolved,
// responsive rules active), not the declared inline styles — that is the
// whole point of reading rects + computed values instead of node.styles.

import type { CanvasNode } from '@/code/parsing/parser';
import { findNodeComputedStyles, getRectInViewportSpace } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { trace } from '@/shared/debug-trace';

// ─── Rendered-style access ──────────────────────────────────────────────────

/** Computed style props the bridge caches and these tools request. Listed
 *  props are served with one sync call per node; anything the cache does not
 *  yet hold returns '' (cache fills asynchronously after each render). */
export const RENDERED_STYLE_PROPS: string[] = [
  'backgroundColor',
  'borderRadius',
  'borderWidth',
  'color',
  'display',
  'fontSize',
  'fontWeight',
  'height',
  'lineHeight',
  'opacity',
  'overflow',
  'position',
  'textAlign',
  'width',
  'zIndex',
];

/** A cached geom bounding rect in parent screen space (px). */
export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One measured node — the flat shape all rules + tools consume. */
export interface AuditNode {
  id: string;
  parentId: string | null;
  children: string[];
  text: string;
  /** null = no cached rect yet (canvas mid-render / no bridge). */
  rect: LayoutRect | null;
  /** Computed style values; '' = not measured / property absent. */
  computed: Record<string, string>;
}

/** One linter hit — `rule` is the rule's machine name, `message` is the
 *  human line an agent sees (already prefixed with the rule name). */
export interface AuditFinding {
  rule: string;
  message: string;
}

export const RULE_OVERLAP = 'OVERLAP';
export const RULE_OVERFLOW = 'OVERFLOW';
export const RULE_CONTRAST = 'CONTRAST';
export const RULE_FONT_SIZE = 'FONT_SIZE';
export const RULE_EMPTY_NODE = 'EMPTY_NODE';
export const RULE_TRUNCATION = 'TRUNCATION';
export const RULE_VIEWPORT_OVERFLOW = 'SECTION_DEPASSE_VIEWPORT';

/** Linter thresholds — exported so the rules stay tunable without surgery. */
export const OVERLAP_TOLERANCE_PX = 4;
export const OVERFLOW_TOLERANCE_PX = 8;
/** The viewport rule uses the same tolerance as OVERFLOW — a node leaving the
 *  viewport tile by ≤8px is measurement noise, not a layout break. */
export const VIEWPORT_OVERFLOW_TOLERANCE_PX = OVERFLOW_TOLERANCE_PX;
/** When the FRAME node's measured width deviates from the configured viewport
 *  width by more than this ratio, the camera must have zoomed since the last
 *  render (the cache rescales every rect) — fall back to the measured frame
 *  box so relative checks stay zoom-safe. A real "root wider than its tile"
 *  break (e.g. 400 measured vs 375 configured) sits well inside the band. */
export const VIEWPORT_ZOOM_BAND = 0.1;
/** The viewport frame node id — always `root` (ViewportHeaderManager's
 *  getViewportFrameNodeId; the frame element IS the rendered root). */
export const VIEWPORT_FRAME_ID = 'root';
export const MIN_CONTRAST_RATIO = 4.5;
export const MIN_FONT_SIZE_PX = 12;
export const EMPTY_SPOT_MAX_PX = 8;
/** Heuristic: average character width ≈ fontSize × 0.6. Documented — this is
 *  an estimate, not a measure; the rule flag says "likely clipped". */
export const TRUNCATION_CHAR_FACTOR = 0.6;

// ─── WCAG color math (pure) ──────────────────────────────────────────────────

export interface ParsedColor {
  r: number;
  g: number;
  b: number;
  /** 0..1; < 1 means the color is translucent (contrast is unknowable). */
  a: number;
}

/** Parse a CSS color string into sRGB channels. Supports #rgb / #rgba /
 *  #rrggbb / #rrggbbaa, rgb() / rgba() with comma or slash syntax and
 *  percentage channels. Returns null when unparseable (named colors, var()
 *  references, 'transparent', ''. ) */
export function parseCssColor(color: string): ParsedColor | null {
  const c = (color ?? '').trim().toLowerCase();
  if (!c) return null;

  if (c.startsWith('#')) {
    let hex = c.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      hex = hex
        .split('')
        .map((ch) => ch + ch)
        .join('');
    }
    if (hex.length !== 6 && hex.length !== 8) return null;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if ([r, g, b].some((v) => Number.isNaN(v))) return null;
    const alphaParsed = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a: Number.isNaN(alphaParsed) ? 1 : alphaParsed };
  }

  const match = c.match(/^rgba?\(([^)]+)\)$/);
  if (match) {
    const parts = match[1].split(/[\s,/]+/).filter(Boolean);
    const channel = (s: string): number => {
      if (s.endsWith('%')) {
        const v = parseFloat(s);
        return Number.isNaN(v) ? NaN : (v / 100) * 255;
      }
      return parseFloat(s);
    };
    if (parts.length < 3) return null;
    const r = channel(parts[0]);
    const g = channel(parts[1]);
    const b = channel(parts[2]);
    if ([r, g, b].some((v) => Number.isNaN(v))) return null;
    const alphaRaw = parts[3] !== undefined ? parts[3] : '1';
    const alpha = alphaRaw.endsWith('%') ? parseFloat(alphaRaw) / 100 : parseFloat(alphaRaw);
    return {
      r: Math.min(255, Math.max(0, Math.round(r))),
      g: Math.min(255, Math.max(0, Math.round(g))),
      b: Math.min(255, Math.max(0, Math.round(b))),
      a: Number.isNaN(alpha) ? 1 : Math.min(1, Math.max(0, alpha)),
    };
  }
  return null;
}

/** WCAG 2.x relative luminance (0..1). */
export function relativeLuminance(color: ParsedColor): number {
  const linearize = (channel: number): number => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b)
  );
}

/** WCAG contrast ratio (fg vs bg). Returns null when either string is
 *  unparseable or translucent — the real rendered ratio is unknowable then. */
export function contrastRatio(fg: string, bg: string): number | null {
  const a = parseCssColor(fg);
  const b = parseCssColor(bg);
  if (!a || !b) return null;
  if (a.a < 1 || b.a < 1) return null;
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

// ─── Geometry helpers (pure) ────────────────────────────────────────────────

function overlapPx(a: LayoutRect, b: LayoutRect): { x: number; y: number } {
  const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { x, y };
}

function hasVisibleRect(rect: LayoutRect | null): boolean {
  return !!rect && (rect.width > 0 || rect.height > 0);
}

// ─── The six linter rules (pure, one fixture per rule) ─────────────────────

/** 1. OVERLAP — two SIBLINGS whose rects overlap by more than
 *  OVERLAP_TOLERANCE_PX on both axes. Zero-area rects never match. */
export function auditOverlaps(nodes: AuditNode[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const groups = new Map<string, AuditNode[]>();
  for (const n of nodes) {
    if (!hasVisibleRect(n.rect)) continue;
    const key = n.parentId ?? '';
    const list = groups.get(key) ?? [];
    list.push(n);
    groups.set(key, list);
  }
  for (const siblings of groups.values()) {
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        const a = siblings[i];
        const b = siblings[j];
        if (!a.rect || !b.rect) continue;
        const o = overlapPx(a.rect, b.rect);
        if (o.x > OVERLAP_TOLERANCE_PX && o.y > OVERLAP_TOLERANCE_PX) {
          findings.push({
            rule: RULE_OVERLAP,
            message: `${a.id} overlaps ${b.id} (${Math.round(o.x)}px × ${Math.round(o.y)}px)`,
          });
        }
      }
    }
  }
  return findings;
}

/** 2. OVERFLOW — a child whose rect extends beyond its parent's rect by more
 *  than OVERFLOW_TOLERANCE_PX on any side (measured in the same parent
 *  screen space). Deliberate overflowing art (position:absolute deco, marquee
 *  trails) exists — the agent judges; the rule only surfaces the fact.
 *  Parent without a rect, or a zero-area parent box, is skipped. */
export function auditOverflows(nodes: AuditNode[]): AuditFinding[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const findings: AuditFinding[] = [];
  for (const n of nodes) {
    if (!hasVisibleRect(n.rect)) continue;
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    if (!parent || !hasVisibleRect(parent.rect) || !parent.rect || !n.rect) continue;
    const r = n.rect;
    const pr = parent.rect;
    const overflow = Math.max(
      pr.x - r.x,
      r.x + r.width - (pr.x + pr.width),
      pr.y - r.y,
      r.y + r.height - (pr.y + pr.height),
    );
    if (overflow > OVERFLOW_TOLERANCE_PX) {
      findings.push({
        rule: RULE_OVERFLOW,
        message: `${n.id} extends ${Math.round(overflow)}px beyond parent ${parent.id}${parent.computed.overflow && parent.computed.overflow !== 'visible' ? ` (parent overflow:${parent.computed.overflow})` : ''}`,
      });
    }
  }
  return findings;
}

/** 3. CONTRAST — a node with text whose computed color/background contrast
 *  ratio is below WCAG AA (4.5:1). Nodes whose colors are unmeasured or
 *  translucent are skipped (ratio unknown). */
export function auditContrast(nodes: AuditNode[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const n of nodes) {
    if (!n.text.trim()) continue;
    const fg = n.computed.color;
    const bg = n.computed.backgroundColor;
    const ratio = contrastRatio(fg, bg);
    if (ratio !== null && ratio < MIN_CONTRAST_RATIO) {
      findings.push({
        rule: RULE_CONTRAST,
        message: `${n.id} text contrast ${formatContrastRatio(ratio)}:1 below ${MIN_CONTRAST_RATIO}:1 (${fg ?? ''} on ${bg ?? ''})`,
      });
    }
  }
  return findings;
}

/** 4. FONT_SIZE — text set (computed) below MIN_FONT_SIZE_PX. */
export function auditFontSizes(nodes: AuditNode[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const n of nodes) {
    if (!n.text.trim()) continue;
    const px = parseFloat(n.computed.fontSize);
    if (!Number.isFinite(px) || px <= 0) continue;
    if (px < MIN_FONT_SIZE_PX) {
      findings.push({
        rule: RULE_FONT_SIZE,
        message: `${n.id} fontSize ${px}px below ${MIN_FONT_SIZE_PX}px`,
      });
    }
  }
  return findings;
}

/** 5. EMPTY_NODE — a dead spot: no text, no visible children, and a rect
 *  smaller than EMPTY_SPOT_MAX_PX in BOTH dimensions. Deliberate spacers
 *  (≥8px) and zero-area/culled placeholder rects (canvas culls offscreen
 *  elements to a 0×0 swap) are NOT flagged: 1px × 1px is the floor of
 *  "a something", so the rule reads 0 < w < 8 && 0 < h < 8. */
export function auditEmptyNodes(nodes: AuditNode[]): AuditFinding[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const findings: AuditFinding[] = [];
  for (const n of nodes) {
    if (n.text.trim()) continue;
    if (!n.rect) continue;
    const { width: w, height: h } = n.rect;
    if (w < 1 || h < 1 || w >= EMPTY_SPOT_MAX_PX || h >= EMPTY_SPOT_MAX_PX) continue;
    const hasVisibleChild = n.children.some((cid) => {
      const child = byId.get(cid);
      return child !== undefined && hasVisibleRect(child.rect);
    });
    if (hasVisibleChild) continue;
    findings.push({
      rule: RULE_EMPTY_NODE,
      message: `${n.id} is a ${Math.round(w)}×${Math.round(h)}px dead spot (no text, no visible children)`,
    });
  }
  return findings;
}

/** 6. TRUNCATION — text that likely exceeds its box width. HEURISTIC, not a
 *  measure: readable length ≈ box width ÷ (fontSize × TRUNCATION_CHAR_FACTOR);
 *  +1 char of slack so a snugly-fitting line isn't noise. lineHeight/overflow
 *  also gate clipping in real CSS — the agent is told this is an estimate. */
export function auditTextTruncation(nodes: AuditNode[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const n of nodes) {
    const text = n.text.trim();
    if (!text || !n.rect) continue;
    const px = parseFloat(n.computed.fontSize);
    if (!Number.isFinite(px) || px <= 0) continue;
    const estimatedChars = n.rect.width / (px * TRUNCATION_CHAR_FACTOR);
    if (text.length > Math.floor(estimatedChars) + 1) {
      findings.push({
        rule: RULE_TRUNCATION,
        message: `${n.id} ~${text.length} chars may not fit in ${Math.round(n.rect.width)}px at fontSize ${px}px (heuristic)`,
      });
    }
  }
  return findings;
}

/**
 * 7. SECTION_DEPASSE_VIEWPORT — a node whose box leaves the viewport tile by
 * more than VIEWPORT_OVERFLOW_TOLERANCE_PX on any side. The tile is the
 * viewport's FRAME (the rendered `root`), passed in as a plain rect; every
 * node rect is compared against it in the same parent screen space.
 *
 * Covers the gaps of the OVERFLOW rule: the root itself (skipped there — no
 * parent) is compared here, so a root measured WIDER than its configured tile
 * flags; a direct section that overflows the tile horizontally flags; and a
 * section taller than a tile with a configured fixed height flags. This is
 * deliberately a VERDICT the agent judges: tiles without a fixed height grow
 * with the page, deliberate overflowing art (deco, marquee, pinned floats)
 * exists, and a fixed-height tile can scroll.
 *
 * `viewport` null = no tile measurement (frame not rendered / not resolvable)
 * → nothing to compare, no findings: the observation status (pending /
 * unavailable) gates the callers.
 */
export function auditViewportOverflow(nodes: AuditNode[], viewport: LayoutRect | null): AuditFinding[] {
  if (!viewport) return [];
  const tol = VIEWPORT_OVERFLOW_TOLERANCE_PX;
  const findings: AuditFinding[] = [];
  for (const n of nodes) {
    if (!hasVisibleRect(n.rect)) continue;
    const r = n.rect;
    if (!r) continue;
    const overflow = Math.max(
      viewport.x - r.x,
      r.x + r.width - (viewport.x + viewport.width),
      viewport.y - r.y,
      r.y + r.height - (viewport.y + viewport.height),
    );
    if (overflow > tol) {
      // Name the side(s) that leave the tile so the agent can reason fast.
      const sides: string[] = [];
      if (viewport.x - r.x > tol) sides.push(`left by ${Math.round(viewport.x - r.x)}px`);
      if (r.x + r.width - (viewport.x + viewport.width) > tol)
        sides.push(`right by ${Math.round(r.x + r.width - (viewport.x + viewport.width))}px`);
      if (viewport.y - r.y > tol) sides.push(`top by ${Math.round(viewport.y - r.y)}px`);
      if (r.y + r.height - (viewport.y + viewport.height) > tol)
        sides.push(`bottom by ${Math.round(r.y + r.height - (viewport.y + viewport.height))}px`);
      findings.push({
        rule: RULE_VIEWPORT_OVERFLOW,
        message: `${n.id} ${sides.length === 1 ? 'extends' : 'leaves the viewport tile on its'} ${sides.join(', ')} — tile ${Math.round(viewport.width)}×${Math.round(viewport.height)}px (rule is informational; deliberate overflows — deco, marquee, pinned floats — are fine)`,
      });
    }
  }
  return findings;
}

/** Aggregate: run every rule over the fixture, rules in the documented order.
 *  Optional `viewport` is the viewport TILE rect (see buildViewportTile) —
 *  passes it through to the SECTION_DEPASSE_VIEWPORT rule; when omitted (the
 *  audit has no tile measurement) that rule simply contributes nothing. */
export function runDesignAudit(nodes: AuditNode[], viewport: LayoutRect | null = null): AuditFinding[] {
  return [
    ...auditOverlaps(nodes),
    ...auditOverflows(nodes),
    ...auditContrast(nodes),
    ...auditFontSizes(nodes),
    ...auditEmptyNodes(nodes),
    ...auditTextTruncation(nodes),
    ...auditViewportOverflow(nodes, viewport),
  ];
}

/**
 * Build the viewport TILE rect a SECTION_DEPASSE_VIEWPORT check compares
 * against, from the measured snapshot + the viewport's CONFIGURED dimensions.
 * The tile is the frame node's box (the rendered `root`) positioned where the
 * frame actually rendered, so node rects compare in the same space.
 *
 * Width: the CONFIGURED viewport width (the renderer pins the root to it), so
 * a root that rendered WIDER than its tile is caught — the hole the OVERFLOW
 * rule leaves open (it skips parent-less roots). Height: the configured fixed
 * height when the @canvas block declares one (a fixed-height tile that
 * content overflows then flags); 'auto'/unset tiles grow with the page, so the
 * measured frame height is used — nothing inside can leave it.
 *
 * P2.2 VIEWPORT-SPACE NOTE: as of Gate 2, `collectLayoutSnapshot` returns
 * rects already de-zoomed to viewport CONFIG space (via
 * `getRectInViewportSpace` — iframe offset removed, camera translation
 * undone, divided by camera scale). Therefore the tile is ALWAYS built from
 * the CONFIGURED dimensions (`width=config.width`,
 * `height=config.height` or `frame.height` when auto/unset) and
 * `viewport_rect` is always in config space. The former ZOOM GUARD
 * (measured-vs-config ratio band ±VIEWPORT_ZOOM_BAND → fall back to
 * measured frame box) is no longer needed to keep relative checks
 * zoom-safe — de-zooming already normalizes rects — so it no longer
 * mutes the root-too-wide detection. `VIEWPORT_ZOOM_BAND` remains
 * exported as a guard for callers that lack a config/frame (e.g. sans
 * frame → null) but does not alter tile size when rects are
 * viewport-space.
 *
 * Returns null when the frame node has no measured rect — the callers' status
 * (pending/unavailable) gates the audit.
 */
export function buildViewportTile(
  snapshot: AuditNode[],
  width: number,
  height?: number | 'auto' | undefined,
): LayoutRect | null {
  const frame = snapshot.find((n) => n.id === VIEWPORT_FRAME_ID) ?? snapshot.find((n) => n.parentId === null);
  if (!frame || !frame.rect) return null;
  // De-zoomed rects (P2.2): always use the configured viewport size.
  // The zoom band is retained as an exported guard but no longer mutates
  // the tile when rects are in viewport space — see note above.
  const tileWidth = width > 0 ? width : frame.rect.width;
  const tileHeight = typeof height === 'number' && height > 0 ? height : frame.rect.height;
  return {
    x: frame.rect.x,
    y: frame.rect.y,
    width: tileWidth,
    height: tileHeight,
  };
}

// ─── Shared reader (bridge caches, sync) ────────────────────────────────────

/**
 * Walk the node map and measure every node for one viewport id through the
 * bridge caches (sync — no iframe RPC; the sandbox fills rectCache /
 * computedCache via post-message events). A node whose rect is not yet
 * cached gets `rect: null` — it exists in the tree but hasn't rendered (or
 * the bridge is a stub). Never throws: a missing/uninitialized bridge is a
 * best-effort pass of null rects, not an error.
 */
export function collectLayoutSnapshot(
  nodes: Map<string, CanvasNode>,
  vpId: string,
): AuditNode[] {
  const snap: AuditNode[] = [];
  let withRect = 0;
  for (const node of nodes.values()) {
    let rect: LayoutRect | null = null;
    let computed: Record<string, string> = {};
    try {
      // P2.2: all rects are in viewport CONFIG space (de-zoomed, no iframe
      // offset). `getRectInViewportSpace` handles offset removal + camera
      // translation undo + scale division internally via cacheTransform/
      // currentTransform so `buildViewportTile` can always use the configured
      // width/height and `viewport_rect` stays in config space.
      const vpRect = getRectInViewportSpace(node.id, vpId);
      if (vpRect) {
        rect = vpRect;
        withRect++;
      }
      computed = findNodeComputedStyles(node.id, vpId, RENDERED_STYLE_PROPS);
    } catch {
      /* bridge unavailable — keep the node with rect:null */
    }
    snap.push({
      id: node.id,
      parentId: node.parentId,
      children: [...node.children],
      text: node.textContent ?? '',
      rect,
      computed,
    });
  }
  // P2.2 viewport-space normalization trace (Gate 2 contract).
  try {
    const bridge = getCanvasBridge() as unknown as {
      getCurrentTransform?: () => { x: number; y: number; scale: number };
    };
    const scale = typeof bridge.getCurrentTransform === 'function' ? bridge.getCurrentTransform().scale : 1;
    trace.fn('design-audit:viewport-space', { vpId, scale, dezoomed: withRect });
  } catch {
    trace.fn('design-audit:viewport-space', { vpId, scale: 1, dezoomed: withRect });
  }
  trace.fn('design-audit:collectLayoutSnapshot', {
    vpId,
    nodes: snap.length,
    withRect,
  });
  return snap;
}

/** Round a ratio for agent-readable output (e.g. 4.54). */
export function formatContrastRatio(c: number): number {
  return Number(c.toFixed(2));
}