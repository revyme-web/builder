// dom-utils.ts — DOM element creation and event helpers.
// Reduces boilerplate for imperative DOM code (Renderer, ViewportHeaderManager).

/**
 * Create a DOM element with attributes, styles, and event listeners in one call.
 * Replaces 10+ lines of createElement + setAttribute + style assignments.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options?: {
    attrs?: Record<string, string>;
    styles?: Partial<CSSStyleDeclaration>;
    text?: string;
    children?: (HTMLElement | null)[];
    on?: Record<string, (e: any) => void>;
  },
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);

  if (options?.attrs) {
    for (const [k, v] of Object.entries(options.attrs)) {
      element.setAttribute(k, v);
    }
  }

  if (options?.styles) {
    for (const [k, v] of Object.entries(options.styles)) {
      if (v !== undefined && v !== null) {
        (element.style as any)[k] = v;
      }
    }
  }

  if (options?.text) {
    element.textContent = options.text;
  }

  if (options?.children) {
    for (const child of options.children) {
      if (child) element.appendChild(child);
    }
  }

  if (options?.on) {
    for (const [event, handler] of Object.entries(options.on)) {
      element.addEventListener(event, handler);
    }
  }

  return element;
}

/**
 * Attach pointer-based drag listeners to window.
 * Handles threshold detection, cleanup on pointerup.
 * Uses pointer events (not mouse events) — immune to native drag capture.
 *
 * Returns a cleanup function to remove listeners early (e.g., on cancel).
 */
export function attachDragListeners(options: {
  startX: number;
  startY: number;
  threshold?: number;
  onThresholdMet?: () => void;
  onMove: (dx: number, dy: number, e: PointerEvent) => void;
  onUp: (e: PointerEvent) => void;
}): () => void {
  const { startX, startY, threshold = 3, onThresholdMet, onMove, onUp } = options;
  let started = false;

  // Cache the latest pointer event so we can synthesise a sensible `upEvent`
  // if `pointercancel` fires before `pointerup`. The system fires
  // `pointercancel` when the gesture is interrupted (e.g. cursor crosses
  // into a sibling iframe / OS captures the input / native drag claims
  // the pointer). Without this safety, an auto-pan-driven gesture can
  // end with `pointercancel` instead of `pointerup`, so the creator's
  // `onUp` never runs and the in-flight frame/marquee silently disappears.
  let lastEvent: PointerEvent | null = null;

  const handleMove = (e: PointerEvent) => {
    lastEvent = e;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!started) {
      if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;
      started = true;
      onThresholdMet?.();
    }

    onMove(dx, dy, e);
  };

  const handleUp = (e: PointerEvent) => {
    cleanup();
    onUp(e);
  };

  // pointercancel → treat as a successful pointerup at the last seen
  // position. The fallback synth event mirrors the real one's shape so
  // creators / drag coordinators that read clientX/Y from upEvent get a
  // valid value. Better than no-op (which strands the gesture and leaks
  // the listeners).
  const handleCancel = (e: PointerEvent) => {
    cleanup();
    onUp(lastEvent ?? e);
  };

  const cleanup = () => {
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);
    window.removeEventListener('pointercancel', handleCancel);
  };

  window.addEventListener('pointermove', handleMove);
  window.addEventListener('pointerup', handleUp, { once: true });
  window.addEventListener('pointercancel', handleCancel, { once: true });

  return cleanup;
}

/**
 * Read a numeric CSS style value from an element.
 * parseFloat(el.style.left) || 0 — but centralized.
 */
export function getStyleNum(el: HTMLElement, prop: string): number {
  return parseFloat((el.style as any)[prop]) || 0;
}

/**
 * Detect "empty" TipTap-edited HTML — used by the empty-frame double-click
 * revert flow to know if the user typed anything before committing. TipTap
 * keeps a non-empty DOM even when the visible content is nothing: an empty
 * paragraph, a paragraph with just a `<br>`, or a paragraph containing only
 * the zero-width space we seeded the editor with.
 *
 * Returns true when stripping all those structural-only artifacts leaves
 * an empty string.
 */
export function isEmptyTextEditHtml(html: string | null | undefined): boolean {
  if (!html) return true;
  const stripped = html
    // Strip zero-width spaces (the seed character used by TextCreator).
    .replace(/​/g, '')
    // TipTap's empty paragraph variants.
    .replace(/<p>\s*<\/p>/gi, '')
    .replace(/<p>\s*<br\s*\/?>\s*<\/p>/gi, '')
    // Stray <br> tags.
    .replace(/<br\s*\/?>/gi, '')
    // Any HTML tags left (their text content is what matters).
    .replace(/<[^>]+>/g, '')
    .trim();
  return stripped.length === 0;
}

/**
 * Run `cb` after `n` animation frames. `nextFrames(2, cb)` is the classic
 * double-rAF "after the next paint settles" trick — previously hand-rolled
 * as `requestAnimationFrame(() => requestAnimationFrame(cb))` at ~8 sites.
 */
export function nextFrames(n: number, cb: () => void): void {
  if (n <= 0) { cb(); return; }
  requestAnimationFrame(() => nextFrames(n - 1, cb));
}

/**
 * Commit a focused PANEL input by blurring it — call this BEFORE anything that
 * changes the selection.
 *
 * Panel inputs commit on blur, and their commit handler closes over whatever
 * node is selected AT THAT MOMENT. Click straight from a half-typed Font Size
 * onto a different element and the browser's order is: canvas mousedown →
 * selection changes → React re-renders the panel with the NEW node → blur fires
 * → the typed value lands on the node the user just clicked. The trace of the
 * report shows it precisely: hit-test selects `frame-mrz14wdv-1` at 2635.679s,
 * then `control:update-style {nodeIds:["frame-mrz14wdv-1"], fontSize:"53px"}` at
 * 2635.707s — 28ms later, with the value typed for a different node
 * (user report 2026-07-26).
 *
 * Blurring first makes the commit run while the ORIGINAL selection is still
 * active, so the edit lands where it was typed. One call at the canvas
 * mousedown funnel covers every panel input — font size, width, gap, radius —
 * rather than each control having to remember its own target.
 *
 * Scoped to parent-frame `<input>`/`<textarea>`: canvas text editing runs inside
 * the sandbox iframe (whose `activeElement` from here is the iframe ELEMENT, not
 * an input), so TipTap is never affected.
 */
export function commitFocusedPanelInput(): void {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return;
  const tag = el.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return;
  el.blur();
}
