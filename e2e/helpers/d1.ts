// Batch D1 helpers: flow reorder + drop line / placeholder (E2E_TEST_PLAN.md §2).
//
// What the shared Editor lacks for these rows:
//   - a drag SESSION (press → move → pump → inspect → move again → release) so
//     one gesture can cross several boundaries and be inspected at each stop;
//   - parent-frame overlay reads (drop line, parent highlight, selection fade);
//   - sandbox reads (placeholder, painted styles, painted order of any parent);
//   - trace reads filtered by category.

import type { Page } from '@playwright/test';
import type { Editor } from './editor';

export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };

export const frame = (page: Page) => page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));

export const center = (b: Box): Pt => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** A live drag. `press` puts the button down; nothing is released until
 *  `release()` (always call it, or use `drag()` which does it in a finally). */
export class DragSession {
  cur: Pt;
  constructor(private readonly page: Page, readonly start: Pt) { this.cur = start; }

  static async press(page: Page, from: Pt): Promise<DragSession> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    return new DragSession(page, from);
  }

  /** Move to `to` in `steps` one-frame hops (strategies count frames). */
  async moveTo(to: Pt, steps = 12, onFrame?: () => Promise<void>): Promise<void> {
    const from = this.cur;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, { steps: 1 });
      await frame(this.page);
      if (onFrame) await onFrame();
    }
    this.cur = to;
  }

  /** ±1px wiggle so per-frame grace counters advance at the current spot.
   *  `axis` wiggles one axis only: a reorder reads the cursor delta along the
   *  flow axis as the drag DIRECTION, so a column reorder should be pumped on
   *  'x' (and a row on 'y') to keep the direction it arrived with. */
  async pump(frames = 8, opts: { axis?: 'x' | 'y' | 'both'; onFrame?: () => Promise<void> } = {}): Promise<void> {
    const axis = opts.axis ?? 'both';
    for (let i = 0; i < frames; i++) {
      const odd = i % 2 === 1;
      const dx = axis === 'x' ? (odd ? 1 : 0) : axis === 'y' ? 0 : (odd ? 1 : 0);
      const dy = axis === 'y' ? (odd ? 1 : 0) : axis === 'x' ? 0 : (odd ? 0 : 1);
      await this.page.mouse.move(this.cur.x + dx, this.cur.y + dy, { steps: 1 });
      await frame(this.page);
      if (opts.onFrame) await opts.onFrame();
    }
    await this.page.mouse.move(this.cur.x, this.cur.y, { steps: 1 });
    await frame(this.page);
  }

  released = false;
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.page.mouse.up();
  }
}

/** Press on a node (center, or a fraction of its box), run `body`, always release, settle. */
export async function drag(
  editor: Editor, id: string,
  body: (s: DragSession, startBox: Box) => Promise<void>,
  opts: { vpId?: string; fx?: number; fy?: number; from?: Pt } = {},
): Promise<Box> {
  const page = editor.page();
  const box = opts.vpId ? await editor.nodeBoxIn(opts.vpId, id) : await editor.nodeBox(id);
  const from = opts.from ?? { x: box.x + box.width * (opts.fx ?? 0.5), y: box.y + box.height * (opts.fy ?? 0.5) };
  const s = await DragSession.press(page, from);
  try {
    await body(s, box);
  } finally {
    await s.release();
    await page.waitForTimeout(80);
    await editor.settled();
  }
  return box;
}

/** Throws unless the node left its start box (the gesture engaged). */
export async function assertEngaged(editor: Editor, id: string, start: Box, vpId?: string): Promise<void> {
  const now = await (vpId ? editor.nodeBoxIn(vpId, id) : editor.nodeBox(id)).catch(() => null);
  if (now && Math.abs(now.x - start.x) < 2 && Math.abs(now.y - start.y) < 2) {
    throw new Error(`Drag never engaged for "${id}": still at (${start.x}, ${start.y}) with the button down.`);
  }
}

// ─── Parent-frame overlays ──────────────────────────────────────────────

export interface DropLine { parentId: string | null; insertIndex: number | null; rect: Box; orientation: 'horizontal' | 'vertical' }

/** The drop line (parent frame, position:fixed), or null when none shows. */
export async function dropLine(page: Page): Promise<DropLine | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-drop-line-indicator]') as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const idx = el.getAttribute('data-insert-index');
    return {
      parentId: el.getAttribute('data-parent-id'),
      insertIndex: idx == null ? null : Number(idx),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      orientation: r.height > r.width ? 'vertical' as const : 'horizontal' as const,
    };
  });
}

export interface ParentOutline { parentId: string | null; source: string | null; stroke: string | null; dashed: boolean; rect: Box }

/** The parent-highlight outline (svg polygon), or null. `stroke` is the
 *  resolved colour (the attribute is a CSS var). */
export async function parentOutline(page: Page): Promise<ParentOutline | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-parent-highlight]') as SVGElement | null;
    if (!el) return null;
    const poly = el.querySelector('polygon') as SVGPolygonElement | null;
    const r = (poly ?? el).getBoundingClientRect();
    return {
      parentId: el.getAttribute('data-parent-id'),
      source: el.getAttribute('data-source'),
      stroke: poly ? getComputedStyle(poly).stroke : null,
      dashed: !!poly?.getAttribute('stroke-dasharray'),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    };
  });
}

/** Resolve a CSS colour expression (e.g. `var(--selection)`) in the editor frame. */
export async function cssColor(page: Page, expr: string): Promise<string> {
  return page.evaluate((e) => {
    const d = document.createElement('div');
    d.style.color = e;
    document.body.appendChild(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  }, expr);
}

/** The single-selection border box (lines inside [data-selection-fade]) and
 *  the fade wrapper's painted opacity, or null when no selection overlay. */
export async function selectionOverlay(page: Page): Promise<{ opacity: number; rect: Box | null; stroke: string | null } | null> {
  return page.evaluate(() => {
    const fade = document.querySelector('[data-selection-fade]') as HTMLElement | null;
    if (!fade) return null;
    const svg = [...fade.querySelectorAll(':scope > svg')].find(s => s.querySelectorAll(':scope > line').length === 4);
    let rect: { x: number; y: number; width: number; height: number } | null = null;
    const first = svg?.querySelector('line') as SVGLineElement | null;
    const stroke = first ? getComputedStyle(first).stroke : null;
    if (svg) {
      const xs: number[] = []; const ys: number[] = [];
      for (const l of svg.querySelectorAll('line')) {
        xs.push(Number(l.getAttribute('x1')), Number(l.getAttribute('x2')));
        ys.push(Number(l.getAttribute('y1')), Number(l.getAttribute('y2')));
      }
      rect = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    }
    return { opacity: Number(getComputedStyle(fade).opacity), rect, stroke };
  });
}

// ─── Sandbox reads ──────────────────────────────────────────────────────

/** Placeholder boxes currently in the canvas (LayoutLifted's hole holder). */
export async function placeholders(editor: Editor): Promise<Box[]> {
  const loc = editor.sandbox().locator('[data-placeholder-id]');
  const n = await loc.count();
  const out: Box[] = [];
  for (let i = 0; i < n; i++) {
    const b = await loc.nth(i).boundingBox();
    if (b) out.push(b);
  }
  return out;
}

/** Painted (computed) style of a node in a tile ('' when the node is missing). */
export async function painted(editor: Editor, id: string, prop: string, vpId?: string): Promise<string> {
  const loc = vpId ? await editor.nodeIn(vpId, id) : editor.node(id);
  return loc.evaluate((el, p) => getComputedStyle(el as HTMLElement).getPropertyValue(p), prop.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`));
}

/** Children of `parentId` (source ids) sorted by their painted box in reading
 *  order: top first, left as tie-break within a 2px band. Missing/boxless
 *  children are left out. */
export async function visualOrder(editor: Editor, parentId: string, opts: { vpId?: string; path?: string; axis?: 'row' | 'column' } = {}): Promise<string[]> {
  const ids = await editor.childIds(parentId, opts.path);
  const measured: Array<{ id: string; top: number; left: number }> = [];
  for (const id of ids) {
    const loc = opts.vpId ? await editor.nodeIn(opts.vpId, id) : editor.node(id);
    const b = await loc.boundingBox().catch(() => null);
    if (b && b.width > 0 && b.height > 0) measured.push({ id, top: b.y, left: b.x });
  }
  measured.sort((a, b) => (Math.abs(a.top - b.top) > 2 ? a.top - b.top : a.left - b.left));
  return measured.map(m => m.id);
}

/** Inline `order` of each id in the source, as numbers (NaN when absent). */
export async function orders(editor: Editor, ids: string[], path?: string): Promise<Record<string, number>> {
  const src = await editor.source(path);
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = Number(src.byId.get(id)?.style.order ?? NaN);
  return out;
}

// ─── Traces ─────────────────────────────────────────────────────────────

export interface TraceEntry { ts: number; c: string; data: any }

export async function traces(page: Page, pattern?: string): Promise<TraceEntry[]> {
  return page.evaluate((p) => (window as any).__e2e.traceEntries(p), pattern);
}

/** Timestamp to slice later trace reads from (entries after this moment). */
export async function traceMark(page: Page): Promise<number> {
  const all = await traces(page);
  return all.length ? all[all.length - 1].ts : 0;
}

export async function tracesSince(page: Page, since: number, pattern?: string): Promise<TraceEntry[]> {
  return (await traces(page, pattern)).filter(e => e.ts > since);
}

// ─── Per-frame overlay sampler ──────────────────────────────────────────

export interface OverlayFrame {
  /** Snap alignment guide lines (pink) on screen. */
  snapGuides: number;
  /** Pin-constraint line marks (-1 when the overlay isn't mounted). */
  pinMarks: number;
  outline: { parentId: string | null; source: string | null } | null;
  line: { parentId: string | null; insertIndex: number | null } | null;
}

/** One synchronous read of every drag overlay in the editor frame. */
export async function overlayFrame(page: Page): Promise<OverlayFrame> {
  return page.evaluate(() => {
    const pinSvg = document.querySelector('svg[data-pin-constraint-lines]');
    const hl = document.querySelector('[data-parent-highlight]');
    const line = document.querySelector('[data-drop-line-indicator]');
    return {
      snapGuides: document.querySelectorAll('line[stroke="#f472b6"]').length,
      pinMarks: pinSvg ? pinSvg.querySelectorAll('line, path, text').length : -1,
      outline: hl ? { parentId: hl.getAttribute('data-parent-id'), source: hl.getAttribute('data-source') } : null,
      line: line ? { parentId: line.getAttribute('data-parent-id'), insertIndex: Number(line.getAttribute('data-insert-index')) } : null,
    };
  });
}

// ─── Loading under a shared, loaded dev server ──────────────────────────

/** Window flag set once a seed has loaded; a reload of the tab clears it. */
const LOADED_MARK = '__d1_loaded';

/** `editor.load`, retried once when the canvas never came up — the shared
 *  :4333 server full-reloads open tabs when other files in the repo change,
 *  and on a loaded machine the first boot can miss the 30s canvas wait. */
/**
 * Drop Vite's `full-reload` pushes for this test's tab (editor :4333 and the
 * canvas sandbox :5174). The shared dev servers broadcast one whenever ANY
 * file in the repo changes — with other batches editing specs and helpers
 * that is every 10–40s, and each one wipes the editor mid-gesture. HMR
 * updates and everything else still pass through untouched.
 */
const muted = new WeakSet<Page>();
export async function muteViteFullReloads(page: Page): Promise<void> {
  if (muted.has(page)) return;
  muted.add(page);
  await page.context().routeWebSocket(
    (url) => url.searchParams.has('token') && (url.port === '4333' || url.port === '5174' || url.port === '5175'),
    (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => {
        if (typeof m === 'string' && m.includes('"type":"full-reload"')) return;
        ws.send(m);
      });
    },
  );
}

export async function loadSeed(editor: Editor, seed: Parameters<Editor['load']>[0], opts: Parameters<Editor['load']>[1] = {}): Promise<void> {
  await muteViteFullReloads(editor.page());
  try {
    await editor.load(seed, opts);
  } catch (e) {
    if (!/Timeout|Execution context was destroyed|navigation|ERR_ABORTED|reading 'settled'|detached/.test(String(e))) throw e;
    await editor.load(seed, opts);
  }
  await editor.page().evaluate((m) => { (window as any)[m] = true; }, LOADED_MARK);
}

/**
 * Run a test body; when it fails BECAUSE the editor tab reloaded under it
 * (the loaded-flag is gone: a full reload pushed by the shared dev server),
 * re-run it from a fresh seed. A failure on a page that did not reload is
 * rethrown untouched, so a real product failure is never retried away.
 */
export async function survivesReloads(editor: Editor, body: () => Promise<void>, attempts = 3): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await body();
      return;
    } catch (e) {
      const page = editor.page();
      const reloaded = await page.evaluate((m) => !(window as any)[m], LOADED_MARK).catch(() => true);
      if (i >= attempts || !reloaded) throw e;
      console.warn(`[d1] editor tab reloaded under the test (attempt ${i}); re-running from a fresh seed: ${String(e).split('\n')[0]}`);
      await page.mouse.up().catch(() => {});
      // Next load() re-seeds from scratch instead of reading what was saved.
      await page.evaluate(() => sessionStorage.removeItem('__e2e_seeded')).catch(() => {});
      editor.errors.length = 0;
    }
  }
}
