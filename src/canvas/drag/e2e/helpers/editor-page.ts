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

  /** Read VISUAL order of root's direct children by reading rect.top inside the iframe.
   *
   * Cross-origin iframe — parent-frame `page.evaluate` can't reach into
   * `contentDocument`. Iterate child data-ids via Playwright's frame
   * locator (which has privileged access), measure each rect via the
   * locator's bounding box, then sort by `y`.
   */
  async getRootChildrenVisualOrder(): Promise<string[]> {
    // Read direct children IDs from the in-memory ProjectFS (parent
    // frame, no iframe boundary). The visual sort still uses the
    // iframe's boundingBox per id. Doing the JSX-children read via
    // ProjectFS avoids cross-frame DOM gymnastics — and is the same
    // source-of-truth the Renderer uses.
    const code = await this.getPageCode();
    const ids = parseDirectChildIds(code, 'root');
    const measured: { id: string; top: number }[] = [];
    for (const id of ids) {
      const box = await this.sandbox().locator(`[data-id="${id}"]`).first().boundingBox();
      if (box) measured.push({ id, top: box.y });
    }
    measured.sort((a, b) => a.top - b.top);
    return measured.map(m => m.id);
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
