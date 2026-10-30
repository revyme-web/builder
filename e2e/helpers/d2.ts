// Batch D2 helpers: absolute drag inside a frame, free canvas nodes and root
// sections (E2E_TEST_PLAN.md §2, DND-033..062).
//
// What the shared Editor lacks for these rows:
//   - a camera shortcut onto one frame (Fit Selection) so CSS deltas resolve
//     to whole screen pixels and the snap threshold is wide on screen;
//   - a slow, frame-paced canvas drag by a CSS delta (`dragBy`) with an
//     engagement guard and a mid-drag hook;
//   - parent-frame overlay reads in PAGE coordinates: snap guide lines, the
//     equal-spacing bands, the pin constraint lines;
//   - sandbox reads: painted corners of a (rotated) node, will-change,
//     data-culled, a hit-test of what sits under a screen point.

import type { Page } from '@playwright/test';
import type { Editor } from './editor';
import { CanvasDrag, frames, boxSettled, traceMark, tracesSince, pinch } from './d4';

export { seed, pageSrc, CanvasDrag, frames, boxSettled, traceMark, tracesSince, holdKey, pressMidDrag, MASTER_HEAD, masterModule, masterSeed, openMaster, variantsConst } from './d4';
export { quickBox, boxIn, canvasBox, canvasNodeIds, variantEntry, styleTernary } from './d6';

export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };

export const center = (b: Box): Pt => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
export const px = (v: string | null | undefined): number => (v == null ? NaN : parseFloat(String(v)));
export const near = (a: number, b: number, tol = 2): boolean => Math.abs(a - b) <= tol;

// ─── Camera ───────────────────────────────────────────────────────────

/** Select `id` with a real click, Fit Selection (Shift+2), wait for the
 *  camera to settle, then deselect everything and wait out the double-click
 *  window.
 *  Returns the painted scale (screen px per CSS px) measured off `cssWidth`. */
export async function zoomOnto(editor: Editor, id: string, cssWidth?: number, opts: { keepSelection?: boolean; vpId?: string } = {}): Promise<number> {
  const page = editor.page();
  await outOfDblClickWindow(page);
  await editor.click(id, { vpId: opts.vpId });
  markRelease(page);
  await page.keyboard.press('Shift+2');
  const settledBox = () => opts.vpId ? boxSettledIn(editor, opts.vpId, id) : boxSettled(editor, id);
  await settledBox();
  if (!opts.keepSelection) {
    // Escape walks up one level per press (frame → root → nothing): clear it
    // all, so a later Shift+press can't add to a leftover selection.
    for (let i = 0; i < 4 && (await editor.selection()).length; i++) {
      await page.keyboard.press('Escape');
      await editor.settled();
    }
  }
  await page.waitForTimeout(450);
  await editor.settled();
  const b = await settledBox();
  const loc = opts.vpId ? await editor.nodeIn(opts.vpId, id) : editor.node(id);
  return b.width / (cssWidth ?? await loc.evaluate(el => (el as HTMLElement).offsetWidth));
}

/** Pinch-zoom (ctrl-wheel) on a node until its painted scale reaches
 *  `minScale` (Fit Selection stops at 200%). Returns the settled scale. */
export async function pinchTo(editor: Editor, id: string, minScale: number): Promise<number> {
  const page = editor.page();
  const css = await editor.node(id).evaluate(el => (el as HTMLElement).offsetWidth);
  let s = (await editor.nodeBox(id)).width / css;
  for (let i = 0; i < 40 && s < minScale; i++) {
    const c = center(await editor.nodeBox(id));
    await pinch(page, c, -40, 1);
    s = (await editor.nodeBox(id)).width / css;
  }
  await boxSettled(editor, id);
  await page.waitForTimeout(400);
  return (await boxSettled(editor, id)).width / css;
}

/** boxSettled for a tile copy. */
export async function boxSettledIn(editor: Editor, vpId: string, id: string, timeout = 5_000): Promise<Box> {
  const deadline = Date.now() + timeout;
  let last = await editor.nodeBoxIn(vpId, id);
  let still = 0;
  while (Date.now() < deadline && still < 3) {
    await editor.page().waitForTimeout(80);
    const now = await editor.nodeBoxIn(vpId, id);
    still = Math.abs(now.x - last.x) < 0.5 && Math.abs(now.y - last.y) < 0.5 && Math.abs(now.width - last.width) < 0.5 ? still + 1 : 0;
    last = now;
  }
  return last;
}

/** Pinch out (ctrl-wheel) over the canvas until every id has a painted box. */
export async function zoomOutUntilPainted(editor: Editor, ids: string[]): Promise<void> {
  const page = editor.page();
  const canvas = await page.locator('iframe[src*="5174"]').first().boundingBox();
  const at = canvas ? { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 } : { x: 800, y: 500 };
  for (let i = 0; i < 30; i++) {
    let missing = false;
    for (const id of ids) {
      const loc = editor.node(id);
      const b = (await loc.count()) ? await loc.boundingBox({ timeout: 1_000 }).catch(() => null) : null;
      if (!b || b.width === 0) { missing = true; break; }
    }
    if (!missing) return;
    await pinch(page, at, 120, 2);
    await page.waitForTimeout(120);
  }
}

/** Union of the painted boxes of `ids` (null when any has no box). */
export async function unionBox(editor: Editor, ids: string[]): Promise<Box | null> {
  let u: Box | null = null;
  for (const id of ids) {
    const loc = editor.node(id);
    const b = (await loc.count()) ? await loc.boundingBox({ timeout: 1_000 }).catch(() => null) : null;
    if (!b) return null;
    if (!u) u = { ...b };
    else {
      const x = Math.min(u.x, b.x), y = Math.min(u.y, b.y);
      u = { x, y, width: Math.max(u.x + u.width, b.x + b.width) - x, height: Math.max(u.y + u.height, b.y + b.height) - y };
    }
  }
  return u;
}

/**
 * Camera setup: frame several nodes together. Fit (Shift+1) frames the tiles
 * only, Fit Selection frames ONE node, and canvas nodes that boot off-camera
 * stay culled (no box) until the camera reaches them. So: pinch out until all
 * of them paint, wheel-pan their union to the canvas centre, then pinch in
 * until the union fills ~`fill` of the canvas area.
 */
export async function fitTo(editor: Editor, ids: string[], fill = 0.75): Promise<void> {
  const page = editor.page();
  await zoomOutUntilPainted(editor, ids);
  const canvas = (await page.locator('iframe[src*="5174"]').first().boundingBox())!;
  // The usable canvas: between the side panels (iframe spans the window).
  const left = 320, right = Math.min(canvas.x + canvas.width, (page.viewportSize()?.width ?? 1600) - 270);
  const area = { x: left, y: 140, width: right - left, height: (page.viewportSize()?.height ?? 1000) - 140 - 80 };
  const mid = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  for (let round = 0; round < 80; round++) {
    const u = await unionBox(editor, ids);
    if (!u) { await pinch(page, mid, 120, 1); continue; }
    const uc = center(u);
    if (Math.abs(uc.x - mid.x) > 4 || Math.abs(uc.y - mid.y) > 4) {
      await page.mouse.move(mid.x, mid.y);
      await page.mouse.wheel(uc.x - mid.x, uc.y - mid.y);
      await frames(page, 3);
      continue;
    }
    const k = Math.min(area.width * fill / u.width, area.height * fill / u.height);
    if (k > 0.85 && k < 1.15) break;
    // Small ctrl-wheel steps (a big one overshoots), out again when too big.
    await pinch(page, mid, k > 1 ? -12 : 12, 1);
    await frames(page, 2);
  }
  await page.waitForTimeout(300);
  await boxSettled(editor, ids[0]);
}

/** Screen px per CSS px, read off a node's painted width vs its layout width. */
export async function scaleOf(editor: Editor, id: string): Promise<number> {
  const b = await editor.nodeBox(id);
  return b.width / await editor.node(id).evaluate(el => (el as HTMLElement).offsetWidth);
}

// ─── Drag ─────────────────────────────────────────────────────────────

/** Last mouse release per page, so the next press is never read as the
 *  second half of a double-click (two presses within 400 ms drill in). */
const lastRelease = new WeakMap<Page, number>();
export async function outOfDblClickWindow(page: Page): Promise<void> {
  const t = lastRelease.get(page);
  if (t == null) return;
  const wait = 450 - (Date.now() - t);
  if (wait > 0) await page.waitForTimeout(wait);
}
export function markRelease(page: Page): void { lastRelease.set(page, Date.now()); }

/** A real click on a node (editor.click) that also opens a fresh
 *  double-click window, so the next press is read as a new gesture. */
export async function clickNode(editor: Editor, id: string, opts: Parameters<Editor['click']>[1] = {}): Promise<void> {
  await outOfDblClickWindow(editor.page());
  await editor.click(id, opts);
  markRelease(editor.page());
}

/** Press (out of the double-click window) and return a live drag. */
export async function press(page: Page, at: Pt): Promise<CanvasDrag> {
  await outOfDblClickWindow(page);
  return CanvasDrag.press(page, at);
}

/** Release a live drag, then settle the editor. */
export async function release(editor: Editor, d: CanvasDrag): Promise<void> {
  await d.release();
  markRelease(editor.page());
  await editor.page().waitForTimeout(80);
  await editor.settled();
}

export interface DragByOpts {
  /** Press point (default: the node's centre). */
  from?: Pt;
  /** One-frame hops for the main move (default 24). */
  steps?: number;
  /** Frames to sit still at the end before `during`/release (default 8). */
  hold?: number;
  /** Runs with the button still down, after the hold. */
  during?: (d: CanvasDrag) => Promise<void>;
  /** Runs on every frame of the main move. */
  onFrame?: (d: CanvasDrag) => Promise<void>;
  /** Skip the engagement check (a node that hides mid-drag). */
  noGuard?: boolean;
  vpId?: string;
}

/**
 * Drag a node so its CSS position moves by (dx, dy) canvas px at `scale`,
 * slowly (one rAF per hop) so the snap engine isn't broken out by velocity.
 * Throws when the node never left its start box with the button down.
 */
export async function dragBy(editor: Editor, id: string, dx: number, dy: number, scale: number, opts: DragByOpts = {}): Promise<void> {
  const page = editor.page();
  await outOfDblClickWindow(page);
  const b0 = opts.vpId ? await editor.nodeBoxIn(opts.vpId, id) : await editor.nodeBox(id);
  const from = opts.from ?? center(b0);
  const d = await CanvasDrag.press(page, from);
  try {
    const target = { x: from.x + dx * scale, y: from.y + dy * scale };
    await d.moveTo(target, opts.steps ?? 24, opts.onFrame ? () => opts.onFrame!(d) : undefined);
    await d.hold(opts.hold ?? 8);
    if (!opts.noGuard) {
      const now = await (opts.vpId ? editor.nodeBoxIn(opts.vpId, id) : editor.nodeBox(id)).catch(() => null);
      if (now && Math.abs(now.x - b0.x) < 2 && Math.abs(now.y - b0.y) < 2 && (Math.abs(dx * scale) > 4 || Math.abs(dy * scale) > 4)) {
        throw new Error(`Drag never engaged for "${id}": still at (${b0.x}, ${b0.y}) with the button down.`);
      }
    }
    if (opts.during) await opts.during(d);
  } finally {
    await d.release();
    markRelease(page);
    await page.waitForTimeout(80);
    await editor.settled();
  }
}

// ─── Source pin reads ─────────────────────────────────────────────────

export type Side = 'left' | 'top' | 'right' | 'bottom';
export const SIDES: Side[] = ['left', 'top', 'right', 'bottom'];

/** Wanted inset: `'70px'`, `'53.33%'` (numeric compare within tolerance,
 *  unit must match) or null (the key must be absent). */
export type PinWant = Partial<Record<Side, string | null>>;

/** The four insets as written in a style map (null = absent). */
export function insetsOf(style: Record<string, string>): Record<Side, string | null> {
  return { left: style.left ?? null, top: style.top ?? null, right: style.right ?? null, bottom: style.bottom ?? null };
}

export function unitOf(v: string | null | undefined): 'px' | '%' | 'other' | null {
  if (v == null) return null;
  const t = String(v).trim();
  if (/^-?[\d.]+px$/.test(t)) return 'px';
  if (/^-?[\d.]+%$/.test(t)) return '%';
  return 'other';
}

/** True when `have` satisfies `want` (px within `pxTol`, % within `pctTol`). */
export function pinsMatch(have: Record<Side, string | null>, want: PinWant, pxTol = 1, pctTol = 0.25): boolean {
  for (const side of Object.keys(want) as Side[]) {
    const w = want[side];
    const h = have[side];
    if (w === null) { if (h !== null) return false; continue; }
    if (w === undefined) continue;
    if (h === null) return false;
    const uw = unitOf(w), uh = unitOf(h);
    if (uw !== uh) return false;
    const tol = uw === '%' ? pctTol : pxTol;
    if (Math.abs(parseFloat(w) - parseFloat(h)) > tol) return false;
  }
  return true;
}

/** Poll the source until the node's insets satisfy `want`; returns the last read. */
export async function pollPins(editor: Editor, id: string, want: PinWant, opts: { path?: string; timeout?: number; pxTol?: number; pctTol?: number } = {}): Promise<Record<Side, string | null>> {
  const deadline = Date.now() + (opts.timeout ?? 5_000);
  let have = insetsOf(await editor.style(id, opts.path));
  while (!pinsMatch(have, want, opts.pxTol, opts.pctTol) && Date.now() < deadline) {
    await editor.page().waitForTimeout(100);
    have = insetsOf(await editor.style(id, opts.path));
  }
  return have;
}

/** A node's painted box in its parent's CSS space (both painted on the same tile). */
export async function localBox(editor: Editor, id: string, parentId: string, scale: number, vpId?: string): Promise<Box> {
  const b = vpId ? await editor.nodeBoxIn(vpId, id) : await editor.nodeBox(id);
  const p = vpId ? await editor.nodeBoxIn(vpId, parentId) : await editor.nodeBox(parentId);
  return { x: (b.x - p.x) / scale, y: (b.y - p.y) / scale, width: b.width / scale, height: b.height / scale };
}

// ─── Parent-frame overlays (page coordinates) ─────────────────────────

export interface Guide { vertical: boolean; at: number }

/** Pink snap alignment lines, positions converted to PAGE coordinates
 *  (the overlay svg is offset by the canvas container). */
export async function guides(page: Page): Promise<Guide[]> {
  return page.evaluate(() => [...document.querySelectorAll('line[stroke="#f472b6"]')].map((l) => {
    const svg = (l as SVGLineElement).ownerSVGElement as SVGSVGElement;
    const r = svg.getBoundingClientRect();
    const x1 = Number(l.getAttribute('x1')), x2 = Number(l.getAttribute('x2'));
    const y1 = Number(l.getAttribute('y1'));
    const vertical = Math.abs(x1 - x2) < 0.5;
    return { vertical, at: vertical ? r.left + x1 : r.top + y1 };
  }));
}

/** Equal-spacing bands (pink translucent boxes) and their px labels. */
export async function spacingBands(page: Page): Promise<{ bands: Box[]; labels: string[] }> {
  return page.evaluate(() => {
    const bands: Array<{ x: number; y: number; width: number; height: number }> = [];
    const labels: string[] = [];
    for (const d of document.querySelectorAll('div')) {
      const el = d as HTMLElement;
      const bg = el.style.backgroundColor;
      if (bg === 'rgba(244, 114, 182, 0.12)') {
        const r = el.getBoundingClientRect();
        bands.push({ x: r.x, y: r.y, width: r.width, height: r.height });
      } else if (bg === 'rgba(244, 114, 182, 0.85)') {
        labels.push((el.textContent ?? '').trim());
      }
    }
    return { bands, labels };
  });
}

/** The hover outline (HoverHighlight: a fixed svg path), as a page box, or null. */
export async function hoverOutline(page: Page): Promise<Box | null> {
  return page.evaluate(() => {
    for (const p of document.querySelectorAll('svg > path[fill="none"][stroke-width="1.5"]')) {
      const svg = p.parentElement as unknown as SVGSVGElement;
      if (svg.style.position !== 'fixed' || svg.style.zIndex !== '1') continue;
      const r = p.getBoundingClientRect();
      if (r.width > 0) return { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return null;
  });
}

/** The pin constraint overlay: mounted?, visible?, and its line count. */
export async function pinLines(page: Page): Promise<{ mounted: boolean; visible: boolean; lines: number; texts: string[] }> {
  return page.evaluate(() => {
    const svg = document.querySelector('svg[data-pin-constraint-lines]') as SVGSVGElement | null;
    if (!svg) return { mounted: false, visible: false, lines: 0, texts: [] };
    const cs = getComputedStyle(svg);
    const r = svg.getBoundingClientRect();
    return {
      mounted: true,
      visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0,
      lines: svg.querySelectorAll('line').length,
      texts: [...svg.querySelectorAll('text')].map(t => (t.textContent ?? '').trim()),
    };
  });
}

// ─── Sandbox reads ────────────────────────────────────────────────────

/** Painted corners of a node whose only transform is its own (centre-origin)
 *  rotation/scale, in page coordinates: the layout box (offsetWidth/Height ×
 *  camera `scale`) mapped through the computed matrix around the painted
 *  centre. Read-only — nothing is added to the sandbox DOM. */
export async function paintedCorners(editor: Editor, id: string, scale: number): Promise<{ TL: Pt; TR: Pt; BR: Pt; BL: Pt }> {
  const box = await editor.nodeBox(id);
  const m = await editor.node(id).evaluate((el) => {
    const h = el as HTMLElement;
    const t = getComputedStyle(h).transform;
    const mm = !t || t === 'none' ? new DOMMatrix() : new DOMMatrix(t);
    return { a: mm.a, b: mm.b, c: mm.c, d: mm.d, w: h.offsetWidth, hh: h.offsetHeight };
  });
  const c = center(box);
  const at = (x: number, y: number): Pt => ({ x: c.x + scale * (m.a * x + m.c * y), y: c.y + scale * (m.b * x + m.d * y) });
  const w2 = m.w / 2, h2 = m.hh / 2;
  return { TL: at(-w2, -h2), TR: at(w2, -h2), BR: at(w2, h2), BL: at(-w2, h2) };
}

/** Inline style property straight off the painted element ('' when unset). */
export async function inlineDom(editor: Editor, id: string, prop: string): Promise<string> {
  return editor.node(id).evaluate((el, p) => (el as HTMLElement).style.getPropertyValue(p), prop.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`));
}

/** Computed style off the painted element. */
export async function computed(editor: Editor, id: string, prop: string): Promise<string> {
  return editor.node(id).evaluate((el, p) => getComputedStyle(el as HTMLElement).getPropertyValue(p), prop.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`));
}

/** The canvas sandbox iframe's Frame (for per-frame reads inside it). */
export function sandboxFrame(page: Page) {
  const f = page.frames().find(fr => /:5174\//.test(fr.url()));
  if (!f) throw new Error('canvas sandbox frame not found');
  return f;
}

/**
 * Per-frame rect sampler inside the sandbox: starts recording the painted box
 * of `selector` on every animation frame for `n` frames and returns a reader.
 * Start it, do the gesture step (e.g. mouse.up), then await the reader. Boxes
 * come back in PAGE coordinates.
 */
export async function sampleRects(editor: Editor, selector: string, n = 12): Promise<() => Promise<Array<Box | null>>> {
  const page = editor.page();
  const fr = sandboxFrame(page);
  const key = `__d2s_${Math.random().toString(36).slice(2)}`;
  await fr.evaluate(([sel, k, count]) => {
    const out: Array<{ x: number; y: number; width: number; height: number } | null> = [];
    (window as any)[k] = out;
    const tick = () => {
      const el = document.querySelector(sel as string) as HTMLElement | null;
      if (el) { const r = el.getBoundingClientRect(); out.push({ x: r.x, y: r.y, width: r.width, height: r.height }); } else out.push(null);
      if (out.length < (count as number)) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [selector, key, n] as const);
  return async () => {
    await fr.waitForFunction(([k, count]) => ((window as any)[k as string]?.length ?? 0) >= (count as number), [key, n] as const, { timeout: 10_000 });
    const raw = await fr.evaluate((k) => (window as any)[k], key) as Array<Box | null>;
    const off = await page.locator('iframe[src*="5174"]').first().boundingBox();
    return raw.map(b => (b ? { x: b.x + (off?.x ?? 0), y: b.y + (off?.y ?? 0), width: b.width, height: b.height } : null));
  };
}

/** Trace entries since `mark` whose category matches. */
export async function since(page: Page, mark: number, pattern: string) {
  return tracesSince(page, mark, pattern);
}

/** The strategy the last drag started with (from the drag:start trace). */
export async function lastStrategy(page: Page, mark: number): Promise<string | undefined> {
  return (await tracesSince(page, mark, '^drag:start$')).pop()?.data?.strategy;
}

export { traceMark as mark };
export async function waitFrames(page: Page, n: number): Promise<void> { await frames(page, n); }

// ─── Icon-set master seed ─────────────────────────────────────────────

/** `icons/Glyphs.tsx`, generated by the builder's own `buildIconSetFile`
 *  (src/code/icons/icon-set-template.ts): two 240×240 vector cards — icon-1
 *  at (0, 0) holding `shape-a` (80×80 at 40, 40) and icon-2 at (320, 0)
 *  holding `shape-b` (80×80 at 120, 120). */
export const GLYPHS_PATH = 'icons/Glyphs.tsx';
export const GLYPHS_ICON_SET: string = "'use client';\nimport React from 'react';\nimport { motion } from 'framer-motion';\nimport { withResponsiveProps } from '@revyme/runtime';\n\n/** @name \"Glyphs\" */\n/** @iconSet */\n\nconst iconConfig = [\n  { name: 'icon-1', label: 'Alpha', x: 0, y: 0, width: 240, height: 240, isPrimary: true },\n  { name: 'icon-2', label: 'Beta', x: 320, y: 0, width: 240, height: 240 },\n];\n\nconst SVG_URL_REF = /url\\((['\"]?)#([^)'\"]+)\\1\\)/g;\nfunction svgIdsIn(node, out) {\n  if (!React.isValidElement(node)) return out;\n  const p = node.props || {};\n  if (typeof p.id === 'string') out.add(p.id);\n  React.Children.forEach(p.children, (c) => svgIdsIn(c, out));\n  return out;\n}\nfunction scopeUrlRefs(value, uid, ids) {\n  return value.replace(SVG_URL_REF, (m, q, id) => (ids.has(id) ? 'url(' + q + '#' + id + '-' + uid + q + ')' : m));\n}\nfunction scopeSvgIds(node, uid, ids) {\n  if (!React.isValidElement(node)) return node;\n  const p = node.props || {};\n  const next = {};\n  let changed = false;\n  for (const [k, v] of Object.entries(p)) {\n    if (k === 'children') continue;\n    if (k === 'id' && typeof v === 'string' && ids.has(v)) { next.id = v + '-' + uid; changed = true; continue; }\n    if (k === 'style' && v && typeof v === 'object') {\n      const ns = {}; let sc = false;\n      for (const [sk, sv] of Object.entries(v)) {\n        const nsv = typeof sv === 'string' ? scopeUrlRefs(sv, uid, ids) : sv;\n        if (nsv !== sv) sc = true;\n        ns[sk] = nsv;\n      }\n      if (sc) { next.style = ns; changed = true; }\n      continue;\n    }\n    if (typeof v === 'string') {\n      let nv = scopeUrlRefs(v, uid, ids);\n      if ((k === 'href' || k === 'xlinkHref') && v.charAt(0) === '#' && ids.has(v.slice(1))) nv = v + '-' + uid;\n      if (nv !== v) { next[k] = nv; changed = true; }\n    }\n  }\n  const hasKids = p.children !== undefined;\n  const kids = hasKids ? React.Children.map(p.children, (c) => scopeSvgIds(c, uid, ids)) : undefined;\n  if (!changed && !hasKids) return node;\n  return hasKids ? React.cloneElement(node, next, kids) : React.cloneElement(node, next);\n}\n\nconst Glyphs = React.forwardRef(function Glyphs({ name, style, children, ...rest }, ref) {\n  // Master JSX \u2014 parseJSXToNodes walks this once for the icon-set canvas; the\n  // canvas merges iconConfig positions onto the parsed vector nodes. When `name`\n  // is set this is an INSTANCE: the matching variant renders as a motion.div so\n  // the editor's page-level effects bind (forwarded ref for hover/in-view +\n  // motion-value styles for scale/rotate/opacity), each inner vector scaled to\n  // its share of the card so the in-card layout is preserved.\n  const master = (\n    <div data-id=\"root\" data-name=\"Icons\" style={{ position: 'relative', width: '100%', height: '100%' }}>\n      <div data-id=\"icon-1\" data-name=\"Alpha\" style={{ backgroundColor: '#ffffff' }}><svg data-id=\"shape-a\" data-name=\"Rect\" viewBox=\"0 0 80 80\" preserveAspectRatio=\"none\" style={{ position: 'absolute', left: '40px', top: '40px', width: '80px', height: '80px', overflow: 'visible' }}><rect data-id=\"shape-a-r\" x=\"0\" y=\"0\" width=\"80\" height=\"80\" fill=\"#3b82f6\" /></svg></div>\n      <div data-id=\"icon-2\" data-name=\"Beta\" style={{ backgroundColor: '#ffffff' }}><svg data-id=\"shape-b\" data-name=\"Rect\" viewBox=\"0 0 80 80\" preserveAspectRatio=\"none\" style={{ position: 'absolute', left: '120px', top: '120px', width: '80px', height: '80px', overflow: 'visible' }}><rect data-id=\"shape-b-r\" x=\"0\" y=\"0\" width=\"80\" height=\"80\" fill=\"#ef4444\" /></svg></div>\n    </div>\n  );\n  // Per-mount scope for the svg defs ids of this copy \u2014 see scopeSvgIds.\n  const uid = React.useId().replace(/[^a-zA-Z0-9_-]/g, '');\n  const svgIds = svgIdsIn(master, new Set());\n  const scoped = (n) => (svgIds.size ? scopeSvgIds(n, uid, svgIds) : n);\n  if (!name) return scoped(master);\n  const child = React.Children.toArray(master.props.children).find(\n    (c) => React.isValidElement(c) && c.props['data-id'] === name,\n  );\n  if (!React.isValidElement(child)) return null;\n  const config = iconConfig.find((c) => c.name === name);\n  const userStyle = style ?? {};\n  const cleanedUserStyle = {};\n  for (const [k, v] of Object.entries(userStyle)) {\n    if (v === '' || v == null) continue;\n    cleanedUserStyle[k] = v;\n  }\n  const mergedStyle = {\n    ...(config ? { width: `${config.width}px`, height: `${config.height}px` } : {}),\n    ...cleanedUserStyle,\n  };\n  const filledKids = React.Children.map(child.props.children, (gc) => {\n    if (!React.isValidElement(gc) || gc.type !== 'svg') return gc;\n    const gs = gc.props.style || {};\n    const sw = parseFloat(gs.width), sh = parseFloat(gs.height);\n    const wPct = config && config.width > 0 && sw > 0 ? `${(sw / config.width) * 100}%` : '100%';\n    const hPct = config && config.height > 0 && sh > 0 ? `${(sh / config.height) * 100}%` : '100%';\n    return React.cloneElement(gc, { style: { ...gs, width: wPct, height: hPct } });\n  });\n  // In the canvas, unresolved page bindings arrive as 'var:\u2026' strings \u2014 a\n  // STRING ref crashes motion ref-attach (`ref.current` on a string) and string\n  // motion-value styles are meaningless. Drop them so the canvas renders the\n  // static vector; the live page passes real refs / motion values, untouched.\n  const safeRef = ref && typeof ref !== 'string' ? ref : undefined;\n  // Motion TRANSFORM props (rotate/scale/x/y/skew) ride on `animate`, not inline\n  // style: motion SPRINGS to an `animate` change but applies an inline style\n  // change INSTANTLY, so without this a per-variant rotation jumps on the live\n  // site instead of animating. On the canvas the NO_ANIMATION MotionConfig\n  // wrapper makes them instant. Everything else (position/size) stays inline.\n  const MOTION_ANIM = { rotate: 1, rotateX: 1, rotateY: 1, rotateZ: 1, scale: 1, scaleX: 1, scaleY: 1, skewX: 1, skewY: 1, x: 1, y: 1, z: 1 };\n  const safeStyle = {};\n  const animateProps = {};\n  for (const [k, v] of Object.entries(mergedStyle)) {\n    if (typeof v === 'string' && v.slice(0, 4) === 'var:') continue;\n    if (MOTION_ANIM[k]) {\n      // The canvas resolves a conditional motion prop to a numeric STRING\n      // ('-200.7'); framer-motion won't apply a bare string to `rotate`, so\n      // coerce to a number. On the live site it is already a number (no-op).\n      animateProps[k] = (typeof v === 'string' && /^-?\\d+(\\.\\d+)?$/.test(v)) ? parseFloat(v) : v;\n    } else safeStyle[k] = v;\n  }\n  const { style: _cs, children: _cc, ...childRest } = child.props;\n  const animExtra = Object.keys(animateProps).length > 0 ? { animate: animateProps } : {};\n  // `layout` so position changes FLIP-animate (the inner has absolute left/top),\n  // matching how a normal motion group animates between variants; the tag may\n  // already set it, in which case its value wins.\n  return React.createElement(motion.div, { layout: true, ...childRest, ...rest, ...animExtra, ref: safeRef, style: safeStyle }, React.Children.map(filledKids, scoped));\n});\n\nexport default withResponsiveProps(Glyphs);\n";
