// protocol.ts — Iframe → parent event protocol.
//
// Parent → iframe RPC goes through Comlink (see sandbox-api.ts).
// Iframe → parent events stay as raw postMessage because they are high-
// frequency emit-only (cache updates, render-complete signals, mouse events)
// — no request/response correlation needed.

import type { CanvasNode } from '@/code/parsing/parser';

// ─── Sandbox → Parent Events ───────────────────────────────────────────────

/** Final FIT-text values computed by the sandbox at text-edit commit:
 *  the box width stays frozen, the font size + viewBox height re-solve for
 *  the committed text (see text-edit-host liveRefitFitText / fit-measure.ts). */
export interface TextEditFitResult {
  /** Bare node id of the FIT `<svg>` wrapper (`<textId>-svg`). */
  svgNodeId: string;
  /** Full viewBox attribute value, e.g. `0 0 1010 164`. */
  viewBox: string;
  /** Re-solved inner text font size in px. */
  fontSize: number;
  /** Ink-centering offset for the inner <p> (see fit-measure marginTop). */
  marginTop: number;
}

export type SandboxEvent =
  // Sandbox loaded and ready (Comlink.expose has been called)
  | { type: 'sandboxReady' }
  // Render completed
  | { type: 'renderComplete' }
  // All element rects after render (populates parent's rect cache)
  | {
      type: 'allRects';
      rects: Array<{
        nodeId: string;
        vpPrefix: string;
        rect: { left: number; top: number; width: number; height: number };
      }>;
      transform?: { x: number; y: number; scale: number };
      // contentRoot rect in iframe-space (canvas transform already applied).
      // The host caches this so getContainerRect() can serve sync calls.
      // Without this, ViewportHeaderManager's bridge math returns null and
      // headers never get rendered.
      containerRect?: { left: number; top: number; width: number; height: number };
      // Epoch of the RENDER these rects were measured against (host stamps
      // every render with ++renderSeq; the sandbox echoes the one it last
      // processed). The host DROPS an allRects from an older epoch: a
      // camera change right before a file switch triggers the OLD file's
      // remeasure, whose allRects lands AFTER the switch's cache wipe and
      // wholesale-repopulates the caches with the old file's geometry (the
      // ~14,000px 'mobile-root' rect that kept resurrecting on template
      // entry, user report 2026-07-27).
      renderSeq?: number;
    }
  // Single rect update after patchStyles (keeps parent rect cache fresh during drag)
  | {
      type: 'rectUpdate';
      nodeId: string;
      vpPrefix: string;
      rect: { left: number; top: number; width: number; height: number };
    }
  // Transformed corners update (rotated/skewed elements need corners, not just rect)
  | {
      type: 'cornersUpdate';
      nodeId: string;
      vpPrefix: string;
      corners: {
        TL: { x: number; y: number };
        TR: { x: number; y: number };
        BR: { x: number; y: number };
        BL: { x: number; y: number };
      };
      /** True when these corners are an SVG wrapper's PAINTED bbox, which
       *  intentionally decouples from the element's CSS-box `rect` (e.g. a
       *  group whose child is dragged past its box). The host's stale-event
       *  rejection compares corners-centre to rect-centre, so it must NOT
       *  apply to decoupled corners — otherwise a live group resize freezes
       *  the instant the painted centre drifts >8px from the static rect. */
      decoupled?: boolean;
    }
  // Computed style update after patchStyles (keeps parent computed cache fresh)
  | { type: 'computedUpdate'; nodeId: string; vpPrefix: string; styles: Record<string, string> }
  // Batched forms — the post-render measure pass emits ONE entry per node
  // (thousands on a big page); a single message per kind keeps the
  // postMessage + structured-clone overhead off the hot path. Entries are
  // applied through the exact same cache logic as the single-entry events.
  | {
      type: 'cornersUpdateBatch';
      /** The sandbox camera the entries were captured under. The host
       *  converts entries from THIS space into its cacheTransform space —
       *  using the host's live camera instead (like the single-entry event)
       *  mass-rejected whole batches whenever the camera moved between emit
       *  and processing (1.6k cornersUpdate-rejected-stale per pass while
       *  zooming). */
      transform: { x: number; y: number; scale: number };
      entries: Array<{
        nodeId: string;
        vpPrefix: string;
        corners: {
          TL: { x: number; y: number };
          TR: { x: number; y: number };
          BR: { x: number; y: number };
          BL: { x: number; y: number };
        };
        decoupled?: boolean;
      }>;
    }
  | { type: 'computedUpdateBatch'; entries: Array<{ nodeId: string; vpPrefix: string; styles: Record<string, string> }> }
  // Node was clicked/mousedown in sandbox
  | { type: 'nodeMouseDown'; nodeId: string; event: SerializedMouseEvent }
  // .map() ghost copy was clicked in sandbox. Renderer dispatches a
  // 'revyme:ghost-select' CustomEvent on the iframe's document; bridge-sandbox
  // forwards via this message; bridge-host re-dispatches the same CustomEvent
  // on the parent's document so existing parent-side listeners (Canvas.tsx
  // setMapItemIndex) work unchanged.
  | { type: 'ghostSelect'; ghostIndex: number; templateId: string }
  // RAF-throttled mouse position from the iframe. Parent uses this to run
  // its rectCache-based hit-test so hover overlays land on the correct
  // ghost copy (canvas-dnd's onDndHover only carries the canonical data-id).
  | { type: 'sandboxMouseMove'; clientX: number; clientY: number }
  // Error in sandbox
  | { type: 'error'; message: string; stack?: string }
  // Trace event from iframe — bridged into parent's trace buffer for diagnostics.
  // Iframe has its own debug-trace instance; this ferries entries across so both
  // sides land in one timeline. Type mirrors TraceEntry['type'].
  | { type: 'traceEvent'; traceType: 'action' | 'fn' | 'dom' | 'error' | 'state'; category: string; data?: any }
  // ─── Text editing (TipTap lives inside sandbox) ──────────────────────────
  // Selection-state snapshot computed on every TipTap transaction. The parent's
  // toolbar reads this instead of walking editor state directly (which it
  // can't do across origins). Includes per-property mixed-value detection so
  // useTextStyles.get can return { value, isMixed, mixedValues } without RPC.
  | { type: 'textEditSelectionChanged'; snapshot: TextEditSnapshot }
  // Live HTML from TipTap as the user types. Parent can use this for previews
  // or persistence — but typically NOT needed since the editor mounts on the
  // actual canvas element, so the layout updates inline.
  | { type: 'textEditContentChanged'; html: string }
  // User clicked outside the editor or pressed Escape. Parent should commit.
  // `fit` = the FINAL fit numbers for a FIT text (SVG foreignObject wrapper),
  // measured sandbox-side where the fonts live — the parent CANNOT touch the
  // cross-origin iframe DOM, so it persists these values to code verbatim.
  | { type: 'textEditCommitted'; html: string; fit?: TextEditFitResult }
  // User pressed an explicit cancel (rare today). Editor was torn down without
  // persisting; parent should drop the in-flight state.
  | { type: 'textEditCancelled' }
  // ─── Shape editing (SvgPathEditor lives inside sandbox) ──────────────
  // No commit event — commitShapeEdit is an awaitable Comlink RPC that
  // returns the final state synchronously. Event-based commit raced
  // against React's synchronous unmount cleanup. Cancel stays as an
  // event because Escape inside the iframe needs to push state to the
  // parent without an active RPC awaiting it.
  | { type: 'shapeEditCancelled' }
  // Pen-creation: user clicked empty canvas in select mode → the host asks the
  // parent to FINISH (exit shape-edit, which commits via the overlay unmount).
  // Distinct from shapeEditCancelled (Escape = discard); this COMMITS.
  | { type: 'shapeEditDone' }
  // Active anchor info changed in shape-edit mode. Fired by the SvgPathEditor
  // library's `onAnchorInfo` callback whenever the user selects a different
  // anchor or its handle-mode changes. Parent uses this to drive the
  // shape-edit Path tool (Position + Curve dropdown). `info: null` means no
  // anchor is currently selected — parent should hide the Path tool.
  | {
      type: 'anchorInfo';
      info: null | {
        shapeIndex: number;
        anchorIndex: number;
        x: number;
        y: number;
        handleMode: 'straight' | 'mirrored' | 'disconnected';
      };
    };

// ─── Text edit snapshot ──────────────────────────────────────────────────
// Sent on every TipTap transaction. Replaces the old SelectionStyles atom
// that the parent computed locally from `activeEditor.state`. With the editor
// inside the iframe, mixed-value detection has to be precomputed and shipped.

export interface TextEditValue {
  /** Single resolved value when uniform across the selection, '' otherwise. */
  value: string;
  /** All distinct non-empty values found in the selection (for gradient
   *  swatch previews and similar). Empty when value is uniform. */
  mixedValues: string[];
  isMixed: boolean;
}

export interface TextEditSnapshot {
  /** True when the selection is collapsed (no range). */
  cursorMode: boolean;
  /** Range bounds as ProseMirror positions. Useful for diagnostics. */
  from: number;
  to: number;
  /** Per-property values across textStyle marks (fontSize, fontWeight,
   *  fontFamily, color, letterSpacing, backgroundGradient, plus any
   *  text-decoration-* mark attrs). */
  marks: Record<string, TextEditValue>;
  /** Per-property values across paragraph attributes (lineHeight,
   *  textAlign, textDecoration, textTransform). */
  paragraph: Record<string, TextEditValue>;
  /** Highlight (background color) — uses the highlight extension, not textStyle. */
  highlight: TextEditValue;
  /** Cursor-mode fallback values: `editor.getAttributes(...)` results.
   *  Used when cursorMode is true and the range walk found nothing. */
  cursorMarkAttrs: Record<string, string>;
  cursorParagraphAttrs: Record<string, string>;
  cursorHighlightAttr: string;
}

// ─── Serialization Helpers ─────────────────────────────────────────────────

/** Serialized form of Map<string, CanvasNode> for postMessage / Comlink (maps don't structured-clone). */
export type SerializedNodeMap = Array<[string, CanvasNode]>;

/** Serialize a NodeMap for transfer. */
export function serializeNodeMap(nodes: Map<string, CanvasNode>): SerializedNodeMap {
  return Array.from(nodes.entries());
}

/** Deserialize a NodeMap. */
export function deserializeNodeMap(entries: SerializedNodeMap): Map<string, CanvasNode> {
  return new Map(entries);
}

/** Serialized mouse event (can't clone native MouseEvent). */
interface SerializedMouseEvent {
  clientX: number;
  clientY: number;
  button: number;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

// ─── Event Discriminator ───────────────────────────────────────────────────
// Iframe→parent events ride raw postMessage. Wrap with __sandbox so Comlink's
// own postMessage traffic and unrelated messages don't collide.

export interface SandboxEventMessage {
  __sandbox: true;
  payload: SandboxEvent;
}

export function wrapEvent(event: SandboxEvent): SandboxEventMessage {
  return { __sandbox: true, payload: event };
}

export function isSandboxEvent(data: any): data is SandboxEventMessage {
  return data && data.__sandbox === true && data.payload && typeof data.payload.type === 'string';
}

// ─── Origins ───────────────────────────────────────────────────────────────
// Sandbox is cross-origin (different port = different origin = browser-level
// process isolation). Comlink works cross-origin via postMessage transport.

/** Sandbox origin (iframe). Different port from parent — same host.
 *  Derived from the editor's own location so it works on localhost, a bare
 *  server IP, or a domain without per-environment config. */
export const SANDBOX_ORIGIN =
  typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:5174`
    : 'http://localhost:5174';
