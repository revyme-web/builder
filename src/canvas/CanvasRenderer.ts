// CanvasRenderer.ts — Render coordinator: owns the bridge.render() call and
// the single skip-decision for when full iframe re-renders should be
// suppressed. Replaces the 4-ref ad-hoc synchronization that lived inline
// in Canvas.tsx (updatingFromCanvasRef, canvasInteractingRef,
// textCommitPendingRef, structuralChangePendingRef).
//
// Why a class:
//   - The "should we render?" decision involves five orthogonal flags. Inlining
//     them in a useEffect with refs requires every contributor to remember the
//     full ANDing logic, AND get the ordering right (set ref BEFORE the atom
//     update that would trigger the effect, etc.).
//   - Now there's a single `shouldSkip()` predicate. Adding a new condition is
//     one place. Removing one is one place. Reading the rules: one place.
//   - The class has no React dependency, so it can be unit-tested without
//     mounting Canvas.tsx.
//
// Responsibility boundary:
//   - OWNS: bridge.render() invocation + the skip predicate state
//   - DOES NOT own: React state, atom subscriptions, event wiring, drag
//     coordination, viewport-header rendering. Canvas.tsx still owns those.
//   - Canvas.tsx wires its React state into this class via setters
//     (setInteracting, markCanvasUpdate, etc.) and calls render() from a
//     single useEffect on the relevant atom dependencies.

import type { PostMessageBridge } from '@/canvas-sandbox/bridge-host';
import type { CanvasNode } from '@/code/parsing/parser';
import type { ViewportConfig, NodeOverride } from '@/shared/types';
import { transformManager } from '@/canvas/transform';
import { trace } from '@/shared/debug-trace';

export interface RenderInput {
  nodes: Map<string, CanvasNode>;
  viewports: ViewportConfig[];
  code: string;
  css: string;
  globalsCss: string;
  /** The page's TEMPLATE responsive CSS (LayoutClient <style>, selectors
   *  prefixed to `layout::` ids), computed parent-side — the sandbox's fs
   *  stub can't read the LayoutClient, so this is the only route template
   *  @media overrides reach templated-page tiles. '' = no template. */
  layoutCss?: string;
  activeLocale?: string;
  defaultLocale?: string;
  /** Per-node locale overrides (text/props/styles). Forwarded to the iframe
   *  so its `renderNodes` call can apply translations from i18n/{locale}.json
   *  on top of the JSX defaults. Without this the iframe always renders the
   *  default-locale text even when fr.json holds a translation. */
  localeOverrides?: Map<string, NodeOverride>;
  /** CMS schemas + item data mirrored into the iframe stub so collection
   *  list ghost copies render against real rows. See bridge-host's render. */
  cmsCollections?: { data: Record<string, any[]>; schemas: Record<string, any> };
}

/** Shallow ref-equality over record values (same keys, Object.is values). */
function shallowRecordEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!Object.is(a[k], b[k])) return false;
  return true;
}

export class CanvasRenderer {
  private bridge: PostMessageBridge | null = null;
  private sandboxReady = false;

  /** Inputs of the last render actually FORWARDED to the iframe. The React
   *  render effect re-fires on any dep identity change (e.g. selection restore
   *  or a derived-atom recompute in a later commit) even when the semantic
   *  render inputs are unchanged — on a big page each redundant forward costs
   *  a full sandbox renderNodes pass (live find 2026-07-17: two ~200ms passes
   *  per Cmd+Z). Skip forwards whose inputs match the last one. */
  private lastForwarded: {
    nodes: RenderInput['nodes'];
    code: string;
    viewportsJson: string;
    globalsCss: string;
    layoutCss?: string;
    activeLocale?: string;
    defaultLocale?: string;
    localeOverrides?: RenderInput['localeOverrides'];
    cmsSchemas?: Record<string, unknown>;
    cmsData?: Record<string, unknown>;
  } | null = null;

  private isDuplicateForward(input: RenderInput, viewportsJson: string): boolean {
    const p = this.lastForwarded;
    if (!p) return false;
    return (
      p.nodes === input.nodes &&
      p.code === input.code &&
      p.viewportsJson === viewportsJson &&
      p.globalsCss === input.globalsCss &&
      p.layoutCss === input.layoutCss &&
      p.activeLocale === input.activeLocale &&
      p.defaultLocale === input.defaultLocale &&
      p.localeOverrides === input.localeOverrides &&
      shallowRecordEqual(p.cmsSchemas, input.cmsCollections?.schemas) &&
      shallowRecordEqual(p.cmsData, input.cmsCollections?.data)
    );
  }

  private rememberForward(input: RenderInput, viewportsJson: string): void {
    this.lastForwarded = {
      nodes: input.nodes,
      code: input.code,
      viewportsJson,
      globalsCss: input.globalsCss,
      layoutCss: input.layoutCss,
      activeLocale: input.activeLocale,
      defaultLocale: input.defaultLocale,
      localeOverrides: input.localeOverrides,
      cmsSchemas: input.cmsCollections?.schemas,
      cmsData: input.cmsCollections?.data,
    };
  }

  // Skip-decision state. All five flags must be false for a render to fire.
  private canvasUpdating = false;     // canvas-initiated style write in progress
  private structuralPending = false;  // move/reorder/add — needs full rebuild on flush, but block intermediate renders
  private textEditing = false;        // TipTap overlay active
  private interacting = false;        // user dragging / sliding (color picker, etc.)
  private gradientActive = false;     // gradient overlay editor active
  // A STRUCTURAL flush (add/move/reorder) landed and its render hasn't reached
  // the iframe yet — the next forwarded render is OWED and must not be eaten.
  // Guards the two-flush drop race: a toolbar drop into a parent with explicit
  // `order:N` siblings queues the addNode flush (structuralPending=true, no
  // mark) and then the order-renumber STYLE flush a tick later — by then
  // structuralPending is false, so onBeforeFlush marked canvasUpdating and the
  // ONE React render carrying BOTH changes got skipped. Nothing re-renders
  // after that, so the dropped node existed in code/layers but never in the
  // canvas DOM until a page-switch forceRender ("icon drop invisible until I
  // switch pages", live find 2026-07-24). While owed: markCanvasUpdate is a
  // no-op and an already-set canvasUpdating flag cannot skip the render.
  // Cleared the moment any render actually forwards to the bridge.
  private structuralRenderOwed = false;

  setBridge(bridge: PostMessageBridge | null): void {
    this.bridge = bridge;
  }

  setSandboxReady(ready: boolean): void {
    this.sandboxReady = ready;
  }

  /** Call once per mount when canvas style writes start, BEFORE the cache
   *  mutation that would trigger React. The next render() call will be
   *  skipped (and the flag auto-clears). */
  markCanvasUpdate(): void {
    if (this.structuralRenderOwed) {
      // A structural change is still waiting for its render — marking now
      // would eat that render (the two-flush drop race, see the field doc).
      trace.fn('CanvasRenderer:mark-suppressed-structural-owed', {});
      return;
    }
    this.canvasUpdating = true;
  }

  /** Force the next render to NOT be skipped by the canvas-update flag.
   *  Used after locale clears, force-render mutations, etc., where the
   *  caller needs the iframe to actually re-render the new state. */
  clearCanvasUpdate(): void {
    this.canvasUpdating = false;
  }

  /** Set true when a move/reorder mutation is queued so onBeforeFlush
   *  doesn't suppress the post-flush render (we WANT the structural change
   *  to land in the iframe). RAF-cleared by the caller. */
  setStructuralPending(v: boolean): void {
    this.structuralPending = v;
    // Latch separately from the flag itself: structuralPending is cleared
    // synchronously right after the commit's flushNow, but the render that
    // carries the structural change runs LATER (React effect). The owed
    // latch survives until that render actually forwards.
    if (v) this.structuralRenderOwed = true;
  }

  /** Set true while TipTap is mounted over a text node. Re-renders mid-edit
   *  tear down the overlay. */
  setTextEditing(v: boolean): void {
    this.textEditing = v;
  }

  /** Set true while the user is dragging/sliding. The canvas patches the
   *  bridge directly via patchStyles for instant feedback; we don't need
   *  full re-renders during the interaction. */
  setInteracting(v: boolean): void {
    this.interacting = v;
  }

  /** Set true while the gradient editor's overlay is painting handles on
   *  top of canvas DOM. */
  setGradientActive(v: boolean): void {
    this.gradientActive = v;
  }

  /** Read access for code that still needs to inspect the flag (e.g. drag
   *  init logic that conditionally restores it). */
  isInteracting(): boolean { return this.interacting; }
  isTextEditing(): boolean { return this.textEditing; }
  isStructuralPending(): boolean { return this.structuralPending; }

  /** Send the current state to the iframe. Called from a single React
   *  effect in Canvas.tsx whenever the relevant atom dependencies change.
   *  Internally checks the skip predicate; no-ops if any flag bars rendering.
   *
   *  `opts.intentional` — the caller is an IMPERATIVE truth-sync (undo/redo
   *  restore via patchCanvasRender): the DOM must end up equal to THIS input.
   *  Such a render is immune to the canvasUpdating skip (it consumes any
   *  pending mark — an unbalanced mark anywhere must never eat an undo) and
   *  to the duplicate-forward dedup (returning to the last-forwarded state is
   *  exactly the undo-after-skipped-commit case: the DOM has imperatively
   *  diverged from it, so "already forwarded" is FALSE in DOM terms — the
   *  stale-lineHeight-after-Cmd+Z bug, 2026-07-21). */
  render(input: RenderInput, opts?: { intentional?: boolean }): void {
    // These skips must NOT consume `canvasUpdating` — a render that bails for
    // one of them (e.g. the `interacting`→false flip render that fires just
    // before the drop's setCode render) would otherwise eat the markCanvasUpdate
    // flag, and the REAL post-parse render a tick later would proceed
    // unskipped. Check them first; only consume canvasUpdating on a render
    // that would otherwise actually run. An INTENTIONAL render that bails
    // here still invalidates the dedup baseline, so the next render can't
    // be dup-skipped into keeping a diverged DOM.
    if (this.textEditing || this.gradientActive || this.interacting) {
      if (opts?.intentional) this.lastForwarded = null;
      return;
    }

    // Canvas-initiated update consumed: clear the flag and bail. The bridge
    // already received patchStyles for the visual; a full render here would
    // rebuild the iframe DOM and remount React code-component roots.
    // The DOM has now DIVERGED from `lastForwarded` via imperative patches —
    // invalidate the dedup baseline, or a later restore of the last-forwarded
    // state (Cmd+Z right after a commit) dedups away and the canvas keeps the
    // patched values forever.
    // `structuralRenderOwed` bypasses this skip: a mark set BEFORE the
    // structural flush (style commit earlier in the same gesture) must not
    // eat the render that carries the new/moved node.
    if (this.canvasUpdating && !opts?.intentional && !this.structuralRenderOwed) {
      this.canvasUpdating = false;
      this.lastForwarded = null;
      trace.fn('CanvasRenderer:skip-canvasUpdating', {});
      return;
    }
    this.canvasUpdating = false;

    if (!this.sandboxReady || !this.bridge) return;

    const viewportsJson = JSON.stringify(input.viewports);
    if (!opts?.intentional && this.isDuplicateForward(input, viewportsJson)) {
      trace.fn('CanvasRenderer:skip-duplicate-input', { nodeCount: input.nodes.size });
      return;
    }
    if (this.lastForwarded) {
      const p = this.lastForwarded;
      trace.fn('CanvasRenderer:forward-diff', {
        codeLen: input.code.length,
        prevCodeLen: p.code.length,
        nodes: p.nodes !== input.nodes,
        code: p.code !== input.code,
        viewports: p.viewportsJson !== viewportsJson,
        globals: p.globalsCss !== input.globalsCss,
        layout: p.layoutCss !== input.layoutCss,
        locale: p.activeLocale !== input.activeLocale || p.defaultLocale !== input.defaultLocale,
        overrides: p.localeOverrides !== input.localeOverrides,
        cms: !shallowRecordEqual(p.cmsSchemas, input.cmsCollections?.schemas) || !shallowRecordEqual(p.cmsData, input.cmsCollections?.data),
      });
    }

    const t = transformManager.getTransform();
    this.bridge.render(
      input.nodes,
      input.viewports,
      input.code,
      input.css,
      input.globalsCss,
      input.activeLocale,
      input.defaultLocale,
      t,
      input.cmsCollections,
      input.localeOverrides,
      input.layoutCss,
    );
    this.rememberForward(input, viewportsJson);
    // The owed structural render (if any) just reached the iframe.
    this.structuralRenderOwed = false;
  }

  /** Force a render even if interacting/canvasUpdating flags are set. Used
   *  by drag strategies after a STRUCTURAL change (live re-parent) — the
   *  iframe DOM must reflect the new parent before the next patchStyles
   *  call writes to the element, otherwise the inline style is interpreted
   *  in the wrong parent's coordinate space. */
  /** Returns whether the render actually SHIPPED to the iframe. A drop
   *  (sandbox not ready / no bridge yet) must be OBSERVABLE: the file-switch
   *  path keys "did this file reach the iframe" off it — treating a dropped
   *  force as delivered left the iframe on the PREVIOUS file's DOM with
   *  nothing ever retrying (template created right after an undo rendered
   *  the old page inside the template view, user report 2026-07-27). */
  forceRender(input: RenderInput): boolean {
    if (!this.sandboxReady || !this.bridge) {
      trace.fn('CanvasRenderer:forceRender-dropped', { sandboxReady: this.sandboxReady, hasBridge: !!this.bridge });
      return false;
    }
    // Clear the canvasUpdating flag so the next React render-effect tick
    // doesn't get suppressed by it (it's been "consumed" by this forced render).
    this.canvasUpdating = false;
    const t = transformManager.getTransform();
    trace.fn('CanvasRenderer:forceRender', { nodeCount: input.nodes.size });
    this.bridge.render(
      input.nodes,
      input.viewports,
      input.code,
      input.css,
      input.globalsCss,
      input.activeLocale,
      input.defaultLocale,
      t,
      input.cmsCollections,
      input.localeOverrides,
      input.layoutCss,
      // File switch / full refresh: never trust per-element patch keys
      // stamped by a previous file's render (data-ids collide across files).
      true,
    );
    // Forced renders bypass the duplicate check but still count as the
    // last forwarded state for subsequent regular renders.
    this.rememberForward(input, JSON.stringify(input.viewports));
    // A forced render satisfies any owed structural render too.
    this.structuralRenderOwed = false;
    return true;
  }
}

/** Module-singleton — one renderer per app. Imperative code (drag strategies,
 *  control providers) reaches it via this getter without going through React. */
let _renderer: CanvasRenderer | null = null;

export function getCanvasRenderer(): CanvasRenderer {
  if (!_renderer) _renderer = new CanvasRenderer();
  return _renderer;
}
