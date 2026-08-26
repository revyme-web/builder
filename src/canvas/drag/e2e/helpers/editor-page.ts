// EditorPage — Page Object Model for the Revyme editor.
//
// Architecture quirks the helpers paper over:
//   1. Canvas content lives in a sandboxed iframe at :5174. Its
//      `pointer-events: none` style routes all pointer events to the
//      parent (:5173) where DragCoordinator captures them. So tests
//      use the parent-frame `mouse` API for drag, but query the iframe
//      for canvas-element rects (data-id="hero" etc.).
//   2. Drop-line / hover-outline / snap-guide overlays render in the
//      parent frame as `position: fixed`. Read those from `page.locator`
//      directly, NOT from the iframe.
//   3. ProjectFS is the source of truth for "what got committed".
//      Read it via `window.__e2e.readFile(path)` (dev-only hook in
//      ProjectLoader).

import type { Page, Locator, FrameLocator } from '@playwright/test';
import { SEEDS, type SeedName } from '../fixtures/seeds';

/** Wait for the iframe to load AND the sandbox to send 'ready'. */
async function waitForCanvasReady(page: Page): Promise<void> {
  // The iframe is at SANDBOX_ORIGIN (5174). Wait for the FIRST <div>
  // with `data-content-root` inside it — that's stamped by the
  // sandbox's main.tsx as soon as the bridge is wired up.
  const sandbox = page.frameLocator('iframe[src*="5174"]');
  await sandbox.locator('[data-content-root]').first().waitFor({ state: 'attached', timeout: 30_000 });
  // Also wait for at least one viewport to be rendered.
  await sandbox.locator('[data-viewport]').first().waitFor({ state: 'attached' });
}

export class EditorPage {
  constructor(private readonly _page: Page) {}

  /** Underlying Playwright page — exposed for tests that need direct
   *  mouse / keyboard / locator API access without re-implementing it
   *  in helpers. */
  page(): Page {
    return this._page;
  }

  // ─── Setup ─────────────────────────────────────────────────────────

  /** Seed localStorage with one of the named test fixtures, then navigate. */
  async gotoWithSeed(seed: SeedName): Promise<void> {
    const project = SEEDS[seed];
    await this._page.addInitScript(
      (data) => {
        window.localStorage.setItem('revyme-project-local', JSON.stringify(data));
        // Fresh browser profile would otherwise mount the onboarding
        // spotlight overlay, which swallows every pointer event.
        window.localStorage.setItem('revyme-onboarding-completed', 'true');
      },
      project,
    );
    await this._page.goto('/');
    await waitForCanvasReady(this._page);
    // One animation frame so Renderer has painted everything we'll
    // assert against.
    await this._page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
  }

  // ─── Locators ──────────────────────────────────────────────────────

  /** The canvas iframe scoped as a FrameLocator. */
  sandbox(): FrameLocator {
    return this._page.frameLocator('iframe[src*="5174"]');
  }

  /** A canvas element inside the iframe by data-id. */
  node(dataId: string): Locator {
    return this.sandbox().locator(`[data-id="${dataId}"]`).first();
  }

  /** The drop-line indicator (parent frame, position:fixed). */
  dropLine(): Locator {
    // DropLineIndicator renders the line as a 2px-thick fixed div with
    // SELECTION_COLOR background. We disambiguate by also matching the
    // companion dot's transform, but the simplest unique marker is to
    // add a data-attribute. Since I don't want to touch the React tree,
    // grep by SELECTION_COLOR `rgb(0, 102, 255)` (or whatever it is).
    // We'll add a data attribute in a small follow-up if this turns
    // out to be flaky.
    return this._page.locator('[data-drop-line-indicator]');
  }

  /** Parent highlight outline (whole frame highlighted as drop target). */
  parentHighlight(): Locator {
    return this._page.locator('[data-parent-highlight]');
  }

  // ─── Reads ──────────────────────────────────────────────────────────

  /** Live page.tsx code from in-memory ProjectFS. */
  async getPageCode(): Promise<string> {
    return this._page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  }

  /** Read the JSX-source order of root's children (data-ids in JSX order). */
  async getRootChildrenJsxOrder(): Promise<string[]> {
    const code = await this.getPageCode();
    return parseDirectChildIds(code, 'root');
  }

  /** Read VISUAL order of root's direct children from their painted rects.
   *
   * Cross-origin iframe — parent-frame `page.evaluate` can't reach into
   * `contentDocument`. Iterate child data-ids via Playwright's frame
   * locator (which has privileged access), measure each rect via the
   * locator's bounding box, then sort in READING order: top first, and
   * left as the tie-break within the same band.
   *
   * The tie-break is load-bearing. Sorting on `y` alone made every ROW
   * layout report JSX order (all children share a top), so a row reorder
   * that committed perfectly still "failed" — the row-flex spec sat
   * skipped as a "harness flake" because of it. The 2px band tolerance
   * absorbs sub-pixel layout noise and keeps flex-wrap lines grouped.
   */
  async getRootChildrenVisualOrder(): Promise<string[]> {
    // Read direct children IDs from the in-memory ProjectFS (parent
    // frame, no iframe boundary). The visual sort still uses the
    // iframe's boundingBox per id. Doing the JSX-children read via
    // ProjectFS avoids cross-frame DOM gymnastics — and is the same
    // source-of-truth the Renderer uses.
    const code = await this.getPageCode();
    const ids = parseDirectChildIds(code, 'root');
    const measured: { id: string; top: number; left: number }[] = [];
    for (const id of ids) {
      const box = await this.sandbox().locator(`[data-id="${id}"]`).first().boundingBox();
      if (box) measured.push({ id, top: box.y, left: box.x });
    }
    measured.sort((a, b) =>
      Math.abs(a.top - b.top) > 2 ? a.top - b.top : a.left - b.left,
    );
    return measured.map(m => m.id);
  }

  /**
   * Wait until root has `count` direct children in the source.
   *
   * An insert into an ordered parent commits in TWO flushes ~30ms apart,
   * so reading straight after mouseup catches the page mid-commit and
   * sees the pre-insert child list. Poll instead of sleeping a magic
   * number.
   */
  async waitForRootChildren(count: number, timeoutMs = 5_000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    let ids = await this.getRootChildrenJsxOrder();
    while (ids.length !== count && Date.now() < deadline) {
      await this._page.waitForTimeout(100);
      ids = await this.getRootChildrenJsxOrder();
    }
    return ids;
  }

  // ─── Pointer ops ────────────────────────────────────────────────────

  /** Center of a canvas node, in viewport (parent-frame) coordinates. */
  async nodeCenter(dataId: string): Promise<{ x: number; y: number }> {
    const handle = await this.node(dataId).elementHandle();
    if (!handle) throw new Error(`Node ${dataId} not found`);
    const box = await handle.boundingBox();
    if (!box) throw new Error(`Node ${dataId} has no boundingBox`);
    // boundingBox already returns parent-frame coords for cross-origin
    // iframe children — no additional offset needed.
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  /** Bounding box of a canvas node, in parent-frame coordinates. */
  async nodeBox(dataId: string): Promise<{ x: number; y: number; width: number; height: number }> {
    const handle = await this.node(dataId).elementHandle();
    if (!handle) throw new Error(`Node ${dataId} not found`);
    const box = await handle.boundingBox();
    if (!box) throw new Error(`Node ${dataId} has no boundingBox`);
    return box;
  }

  /**
   * Drag a canvas node by simulating real pointer events.
   *
   * Drives DragCoordinator's `pointerdown` → `pointermove`* → `pointerup`
   * sequence. The intermediate moves matter: most drag strategies have
   * grace-frame counters that won't trip on a single hop. We emit at
   * least 8 moves with a small delay so RAF can settle.
   */
  async dragNodeFromTo(
    fromDataId: string,
    to: { x: number; y: number },
    opts?: { steps?: number; releaseDelayMs?: number },
  ): Promise<void> {
    const from = await this.nodeCenter(fromDataId);
    await this.dragFromTo(from, to, opts);
  }

  /** Drag from a screen point to a screen point with intermediate moves. */
  async dragFromTo(
    from: { x: number; y: number },
    to: { x: number; y: number },
    opts?: { steps?: number; releaseDelayMs?: number },
  ): Promise<void> {
    const steps = opts?.steps ?? 12;
    const mouse = this._page.mouse;
    await mouse.move(from.x, from.y);
    await mouse.down();
    // Intermediate moves: linearly interpolate from→to. Important for
    // DragCoordinator's drag-threshold check (5px) AND for entry
    // hysteresis (5 frames in candidate parent before confirm).
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      await mouse.move(x, y, { steps: 1 });
      // Force a microtask + RAF so DragCoordinator's per-frame counters
      // tick. Without this, all moves arrive in the same task and the
      // entry-hysteresis grace window collapses to a single frame.
      await this._page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
    }
    if (opts?.releaseDelayMs) await this._page.waitForTimeout(opts.releaseDelayMs);
    await mouse.up();
    // Wait for the post-drop flush to land in ProjectFS.
    await this._page.waitForTimeout(80);
  }

  /** Hover at a screen point (no buttons pressed). */
  async hover(point: { x: number; y: number }): Promise<void> {
    await this._page.mouse.move(point.x, point.y);
  }

  /**
   * "Pump" the drag at the current cursor position. Emits a few small
   * wiggle moves so DragCoordinator's per-frame grace counter (e.g.
   * ENTRY_GRACE_FRAMES = 5) can advance to the confirm threshold.
   *
   * Call this AFTER moving the cursor to the final position but BEFORE
   * asserting on overlays that gate on entry-confirm.
   */
  async pumpDrag(at: { x: number; y: number }, frames: number = 8): Promise<void> {
    for (let i = 0; i < frames; i++) {
      // Integer ±1px wiggle. Sub-pixel deltas (e.g. 0.5) are rounded
      // away by the OS / browser and produce no pointermove event,
      // which would defeat the whole point of pumping. ±1px is the
      // minimum motion the strategy will actually see.
      const dx = i % 2 === 0 ? 0 : 1;
      const dy = i % 2 === 0 ? 1 : 0;
      await this._page.mouse.move(at.x + dx, at.y + dy, { steps: 1 });
      await this._page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
    }
  }

  // ─── Engagement guard ───────────────────────────────────────────────

  /**
   * Drag a node and FAIL LOUDLY if the gesture never engaged.
   *
   * Synthetic pointer streams can miss a strategy entirely (the
   * replica-roundtrip-offset trap: the drag "ran", nothing moved, and the
   * assertions that followed measured a page that was never touched — a
   * test that can only pass). So: measure the node, press, move, and
   * verify mid-gesture that it actually left its start position before
   * releasing. A test built on this can never be green for the wrong
   * reason.
   *
   * Returns the mid-drag box so callers can assert on the lifted position.
   */
  async dragNodeAsserted(
    dataId: string,
    to: { x: number; y: number },
    opts?: { steps?: number; releaseDelayMs?: number; vpId?: string; minDelta?: number; prime?: boolean },
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    if (opts?.prime) await this.primeNode(dataId, opts?.vpId);
    const box = opts?.vpId ? await this.nodeBoxIn(opts.vpId, dataId) : await this.nodeBox(dataId);
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const steps = opts?.steps ?? 12;
    const minDelta = opts?.minDelta ?? 2;
    const mouse = this._page.mouse;

    await mouse.move(from.x, from.y);
    await mouse.down();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, { steps: 1 });
      await this._page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
    }

    // A GONE box also proves engagement: a replica drag-out SPLITS mid-drag
    // (the gesture continues on a fresh-id clone and the source is hidden on
    // its origin viewport), so the source id legitimately stops having a box.
    // Only "still sitting exactly where it started" means the gesture never
    // engaged.
    const during = await (opts?.vpId ? this.nodeBoxIn(opts.vpId, dataId) : this.nodeBox(dataId))
      .catch(() => null);
    const moved = !during
      || Math.abs(during.x - box.x) >= minDelta || Math.abs(during.y - box.y) >= minDelta;
    if (!moved) {
      await mouse.up();
      throw new Error(
        `Drag never engaged for "${dataId}": still at (${box.x}, ${box.y}) after ${steps} moves ` +
        `toward (${to.x}, ${to.y}). The strategy did not pick up the gesture — assertions after ` +
        `this point would be meaningless.`,
      );
    }

    if (opts?.releaseDelayMs) await this._page.waitForTimeout(opts.releaseDelayMs);
    await mouse.up();
    await this._page.waitForTimeout(80); // post-drop flush → ProjectFS
    // Split gestures have no mid-drag source box — report the start box so
    // callers that only use the return value for logging keep working.
    return during ?? box;
  }

  /**
   * Run assertions in the MIDDLE of a drag: press, move to `to`, pump the
   * grace frames, hand control to `assert`, then release. Use for anything
   * only true while the gesture is live — placeholder position, drop-line,
   * parent highlight, or a replica twin that must stay hidden.
   */
  async duringDrag(
    dataId: string,
    to: { x: number; y: number },
    assert: () => Promise<void>,
    opts?: { steps?: number; pumpFrames?: number; vpId?: string; prime?: boolean },
  ): Promise<void> {
    if (opts?.prime) await this.primeNode(dataId, opts?.vpId);
    const box = opts?.vpId ? await this.nodeBoxIn(opts.vpId, dataId) : await this.nodeBox(dataId);
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const steps = opts?.steps ?? 12;
    const mouse = this._page.mouse;
    await mouse.move(from.x, from.y);
    await mouse.down();
    try {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, { steps: 1 });
        await this._page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
      }
      // Entry hysteresis is 3 frames (canvas) / 5 (absolute sibling) — pump
      // past both before asserting on anything entry-gated.
      await this.pumpDrag(to, opts?.pumpFrames ?? 8);
      // Same engagement guard as dragNodeAsserted — a GONE box also counts as
      // engaged (replica drag-out split: the source hides on its origin
      // viewport and the gesture continues on a fresh-id clone).
      const during = await (opts?.vpId ? this.nodeBoxIn(opts.vpId, dataId) : this.nodeBox(dataId))
        .catch(() => null);
      if (during && Math.abs(during.x - box.x) < 2 && Math.abs(during.y - box.y) < 2) {
        throw new Error(
          `Drag never engaged for "${dataId}"${opts?.vpId ? ` in viewport ${opts.vpId}` : ''}: ` +
          `still at (${box.x}, ${box.y}) with the button down. Mid-drag assertions would be meaningless.`,
        );
      }
      await assert();
    } finally {
      await mouse.up();
      await this._page.waitForTimeout(80);
    }
  }

  /**
   * Real click on a node before dragging it — select + prime.
   *
   * Two things a synthetic press alone doesn't get you: a drag that starts
   * on an UNSELECTED node reads as a marquee, and a replica tile's rect
   * stream only starts flowing once something in it has actually been
   * clicked. Without this, drags that begin in a replica silently never
   * engage (the gesture "runs" and nothing moves).
   */
  async primeNode(dataId: string, vpId?: string): Promise<void> {
    const box = vpId ? await this.nodeBoxIn(vpId, dataId) : await this.nodeBox(dataId);
    await this._page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await this._page.waitForTimeout(150);
  }

  // ─── Selection / files ──────────────────────────────────────────────

  /** Select node(s) without click choreography. `vpId` also sets the
   *  interacting viewport, which is what routes writes to a replica. */
  async select(ids: string[], vpId?: string): Promise<void> {
    await this._page.evaluate(
      ([i, v]) => (window as any).__e2e.select(i, v),
      [ids, vpId] as const,
    );
    await this._page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
  }

  /** Switch the active file (component master, template, another page). */
  async openFile(path: string): Promise<void> {
    await this._page.evaluate((p) => (window as any).__e2e.openFile(p), path);
    await this._page.waitForTimeout(250);
  }

  /** Any project file's current in-memory contents. */
  async readFile(path: string): Promise<string> {
    return this._page.evaluate((p) => (window as any).__e2e.readFile(p), path);
  }

  // ─── Multi-viewport (replica tiles) ─────────────────────────────────

  /**
   * A node inside a SPECIFIC viewport tile.
   *
   * Every tile renders the SAME `data-id` — the tile identity lives on
   * `data-node-id`, which the primary leaves bare (`chip-b`) and replicas
   * prefix (`tablet-chip-b`). That prefixed attribute is also what the
   * drag code's own selectors use, so matching on it is matching what the
   * product does. An unscoped `[data-id=…]` just grabs whichever copy the
   * DOM lists first, which silently measures the wrong tile.
   */
  async nodeIn(vpId: string, dataId: string): Promise<Locator> {
    const prefix = await this.vpPrefix(vpId);
    return this.sandbox().locator(`[data-node-id="${prefix}${dataId}"]`).first();
  }

  /** '' for the primary tile, '<vpId>-' for replicas. Resolved from the
   *  live DOM once per test (seeds decide which viewport is primary). */
  private async vpPrefix(vpId: string): Promise<string> {
    const cached = this._vpPrefixes.get(vpId);
    if (cached !== undefined) return cached;
    const prefixed = await this.sandbox().locator(`[data-node-id^="${vpId}-"]`).count();
    const prefix = prefixed > 0 ? `${vpId}-` : '';
    this._vpPrefixes.set(vpId, prefix);
    return prefix;
  }
  private readonly _vpPrefixes = new Map<string, string>();

  async nodeBoxIn(vpId: string, dataId: string): Promise<{ x: number; y: number; width: number; height: number }> {
    const box = await (await this.nodeIn(vpId, dataId)).boundingBox();
    if (!box) throw new Error(`Node ${dataId} not found (or has no box) in viewport ${vpId}`);
    return box;
  }

  /** Zoom-to-fit and settle. Off-camera tiles are CULLED — a replica that
   *  was never on screen reports no box at all — so fit before measuring
   *  anything in a multi-viewport seed. */
  async fitCamera(): Promise<void> {
    await this._page.keyboard.press('Shift+1');
    await this._page.waitForTimeout(600);
  }

  // ─── Commit-channel assertions ──────────────────────────────────────
  //
  // The same visual result must land in a DIFFERENT place depending on
  // where you dragged: primary → inline style, page replica → an @media
  // band, component variant → a ternary. Asserting only the pixels lets a
  // mis-routed write pass — it looks right until the next re-render.

  /** Inline style value on an element in the page source, e.g. order. */
  async getInlineStyleProp(dataId: string, prop: string, path = 'app/page.client.tsx'): Promise<string | null> {
    const code = await this.readFile(path);
    const tag = tagFor(code, dataId);
    if (!tag) return null;
    const m = new RegExp(`(?:^|[{,\\s])${prop}:\\s*'([^']*)'`).exec(tag);
    return m ? m[1] : null;
  }

  /** The CSS text of the `@media (max-width: <width>px)` band, if present. */
  async getMediaBand(width: number, path = 'app/page.client.tsx'): Promise<string | null> {
    const code = await this.readFile(path);
    const head = code.indexOf(`@media (max-width: ${width}px)`);
    if (head === -1) return null;
    const open = code.indexOf('{', head);
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') { depth--; if (depth === 0) return code.slice(open + 1, i); }
    }
    return null;
  }

  /** A single declaration for `dataId` inside that band (null if absent). */
  async getBandStyleProp(width: number, dataId: string, prop: string, path = 'app/page.client.tsx'): Promise<string | null> {
    const band = await this.getMediaBand(width, path);
    if (!band) return null;
    const rule = new RegExp(`\\[data-id="${dataId}"\\][^{]*\\{([^}]*)\\}`).exec(band);
    if (!rule) return null;
    const decl = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;!]+)`).exec(rule[1]);
    return decl ? decl[1].trim() : null;
  }

  // ─── Toolbar / Insert panel ────────────────────────────────────────

  /** Open the Insert panel (left toolbar) and click into a category. */
  async openInsertPanel(): Promise<void> {
    // The Insert panel button has a `+` icon. We target it by
    // aria-label / role / data-attribute. Without one, fall back to
    // the first button in the LeftMenu that triggers Insert. Tests
    // that need this can refine.
    await this._page.locator('[data-left-menu-item="insert"]').click();
  }

  /** Drag a toolbar item by its data-toolbar-item attribute. */
  async dragToolbarItemTo(
    toolbarItemId: string,
    to: { x: number; y: number },
    opts?: { steps?: number },
  ): Promise<void> {
    const toolbarItem = this._page.locator(`[data-toolbar-item="${toolbarItemId}"]`).first();
    const box = await toolbarItem.boundingBox();
    if (!box) throw new Error(`Toolbar item ${toolbarItemId} not found`);
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await this.dragFromTo(from, to, opts);
  }
}

/** The full opening tag of the element carrying `data-id`, or null. */
function tagFor(code: string, dataId: string): string | null {
  const idx = code.indexOf(`data-id="${dataId}"`);
  if (idx === -1) return null;
  const start = code.lastIndexOf('<', idx);
  // Walk to the tag's real end: skip over the braces of style={{ … }} so a
  // nested `}` can't end the tag early.
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return code.slice(start, i + 1);
  }
  return null;
}

// ─── Tiny code-only parser for assertions ────────────────────────────

/**
 * Returns the JSX-source order of direct children of the element with
 * the given `data-id`. Handles unbalanced-tag situations (self-closing
 * + opening/closing pairs) by tracking nesting depth.
 *
 * Pure string ops — no babel — so tests stay fast and fixture-only.
 */
function parseDirectChildIds(code: string, parentDataId: string): string[] {
  const ids: string[] = [];
  // Find the parent's opening tag end position.
  const parentMatch = new RegExp(`<\\w+[^>]*data-id="${parentDataId}"[^>]*>`).exec(code);
  if (!parentMatch) return ids;
  const startIdx = parentMatch.index + parentMatch[0].length;

  // Walk the source from startIdx forward, counting depth. At depth 1
  // (immediate children), each opening tag with data-id is a direct
  // child.
  let depth = 1;
  let i = startIdx;
  while (i < code.length && depth > 0) {
    if (code[i] === '<') {
      // Comment skip
      if (code.startsWith('<!--', i)) {
        const end = code.indexOf('-->', i);
        if (end === -1) break;
        i = end + 3;
        continue;
      }
      const close = code.indexOf('>', i);
      if (close === -1) break;
      const tag = code.slice(i, close + 1);
      const isClosing = tag.startsWith('</');
      const isSelfClosing = tag.endsWith('/>');
      if (isClosing) {
        depth--;
      } else {
        // Track depth=1 children (this tag is a direct child of parent).
        if (depth === 1) {
          const idMatch = /data-id="([^"]+)"/.exec(tag);
          if (idMatch) ids.push(idMatch[1]);
        }
        if (!isSelfClosing) depth++;
      }
      i = close + 1;
    } else {
      i++;
    }
  }
  return ids;
}
