// sketch-live-sync.ts — Brush-change → all-strokes-update engine.
//
// Strategy: every change does TWO things in the same frame.
//
//   1. Commit to source via the mutation queue + flushNow.
//      This is what the Renderer eventually reads. Without it, ANY
//      atom change anywhere in the app (selection, hover, viewport
//      poll) triggers a Renderer rebuild that reads stale source and
//      blows away pure-DOM-direct updates. The earlier "DOM patch only,
//      commit later" model lost updates this way in non-edit mode.
//
//   2. Patch the iframe DOM directly via the bridge (belt-and-braces).
//      The mutation pipeline is fast but not instant — there's a brief
//      window between source-commit and Renderer-paint where the DOM
//      lags by one frame. Bridge-direct closes that window so the user
//      sees the new attrs the moment their finger moves.
//
// RAF-coalesced: pointermove fires at 60–120 Hz on modern hardware.
// We cap actual work to once per frame regardless of input rate, so a
// rapid drag doesn't flood the parser. Coalescing means the LATEST
// pending brush always wins on the next frame (no lost-state issues).

import { getStroke } from 'perfect-freehand';
import { getDefaultStore } from 'jotai';
import {
  buildStrokeOptions,
  pointsFromAttr,
  readSvgAttr,
  type BrushConfig,
} from '@/code/stores/sketch-edit-store';
import { nodesAtom } from '@/code/stores/store';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { getViewportPrefix, getActiveFilePath } from '@/canvas/node-ops';
import { getReplicaContext } from '@/canvas/drag/replica-context';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { modifyProjectFile } from '@/code/project/modify-file';
import { ensureShapeChildIds } from '@/code/generation/generator-attrs';
import { pathDToCss } from '@/shared/svg-path/svg-path-parser';
import type { CanvasNode } from '@/code/parsing/parser';
import { trace } from '@/shared/debug-trace';

// kebab SVG attr → camelCase CSS property, for routing a stroke's colors as a
// per-tile CSS override (mirrors SvgShapeTool's CSS_ROUTABLE_SHAPE_ATTRS). `d`
// is handled separately (wrapped via pathDToCss).
const SKETCH_ATTR_CAMEL: Record<string, string> = {
  fill: 'fill',
  stroke: 'stroke',
  'stroke-width': 'strokeWidth',
};

// Wrappers whose path children we've already stamped with stable data-ids this
// session, so a continuous slider drag doesn't re-run the flushing stamp each
// tick. ensureShapeChildIds is idempotent — a stale entry only skips a no-op.
const _stampedSketchWrappers = new Set<string>();

/** Convert a perfect-freehand outline to an SVG path `d` attribute. */
export function outlineToPathD(outline: number[][]): string {
  if (outline.length === 0) return '';
  let d = `M ${outline[0][0].toFixed(2)} ${outline[0][1].toFixed(2)}`;
  for (let i = 1; i < outline.length; i++) {
    d += ` L ${outline[i][0].toFixed(2)} ${outline[i][1].toFixed(2)}`;
  }
  d += ' Z';
  return d;
}

interface StrokeRegen {
  childIndex: number;
  attrs: Record<string, string>;
}

/**
 * For every `path` child of the wrapper, produce the attr patch each
 * one needs for the current brush. Pure — no mutation, no DOM, no
 * bridge.
 *
 * Strokes WITH `data-points`: replay through getStroke for full geometry
 *   regeneration (size / taper / thinning / etc all affect the d).
 *
 * Strokes WITHOUT `data-points`: still update fill / stroke / stroke-width
 *   (color changes apply) but skip geometry — we have no input data to
 *   replay. This is the resilience case: if any operation accidentally
 *   strips data-points from a stroke, the user can still change its
 *   colors. Logs a warning so the strip path is visible.
 */
function buildStrokeRegens(
  wrapperId: string,
  brush: BrushConfig,
  nodes: Map<string, CanvasNode>,
): StrokeRegen[] {
  const wrapper = nodes.get(wrapperId);
  if (!wrapper) return [];
  const childIds = wrapper.children ?? [];
  const out: StrokeRegen[] = [];
  for (let i = 0; i < childIds.length; i++) {
    const child = nodes.get(childIds[i]);
    if (!child || child.type !== 'path') continue;
    const rawPoints = readSvgAttr(child.attrs, 'data-points');
    const inputPoints = rawPoints ? pointsFromAttr(rawPoints) : [];
    const hasReplayableGeometry = inputPoints.length >= 2;

    const attrs: Record<string, string> = {
      fill: brush.color,
    };
    if (hasReplayableGeometry) {
      const outline = getStroke(inputPoints, buildStrokeOptions(brush));
      const newD = outlineToPathD(outline);
      if (newD) attrs.d = newD;
    } else {
      // Diagnostic: a stroke inside a sketch wrapper that lost its
      // input points. We can still apply color changes; just not the
      // size/taper/thinning ones. eslint-disable for the console.warn
      // because this is a real surprise the user should see.
       
      console.warn('[sketch-live-sync] stroke missing data-points — color updates only', {
        wrapperId, childIndex: i, childId: child.id,
      });
    }
    if (brush.strokeWidth > 0) {
      attrs.stroke = brush.strokeColor;
      attrs['stroke-width'] = String(brush.strokeWidth);
    } else {
      // Empty string = remove attribute (same "empty value means delete
      // this property" contract as style writes).
      attrs.stroke = '';
      attrs['stroke-width'] = '';
    }
    out.push({ childIndex: i, attrs });
  }
  return out;
}

/** Apply a list of regens to the iframe DOM via the bridge AND queue
 *  source mutations. CRITICAL: we do NOT call flushNow here — the
 *  mutation queue auto-flushes on the next RAF, and the auto-flush
 *  path (processQueue) calls `onBeforeFlush → markCanvasUpdate` so the
 *  Renderer SKIPS its rebuild. flushNow() bypasses onBeforeFlush, so
 *  every flushNow per drag-tick = full Renderer rebuild = ~6 fps with
 *  many strokes. SvgShapeTool uses this same queue+bridge pattern.
 *
 *  Order: bridge FIRST so the iframe DOM carries the new values
 *  immediately; queueMutation SECOND so source eventually catches up
 *  on the next RAF (within ~16 ms). The brief window where source is
 *  stale doesn't matter because the bridge has already painted, and
 *  the Renderer is told to skip its rebuild when the queue flushes. */
function applyRegens(
  wrapperId: string,
  vpId: string,
  regens: StrokeRegen[],
): void {
  if (regens.length === 0) return;

  const vpPrefix = getViewportPrefix(vpId);
  const bridge = getCanvasBridge() as {
    setChildShapeAttribute?: (parent: string, vp: string, idx: number, attr: string, value: string | null) => void;
  };

  // ── Per-variant / per-replica routing ──────────────────────────────────
  // On a NON-primary tile (a component's non-default variant OR a page replica)
  // the regenerated d/fill/stroke must land on THAT tile ONLY — a flat
  // `updateSvgAttrs` write bleeds the brush change to every variant. Route each
  // stroke's attrs as a per-tile CSS OVERRIDE on the inner path's stable id
  // (variant object / @media), EXACTLY like SvgShapeTool routes a shape's
  // fill/stroke and SvgEditorOverlay routes geometry `d`. The base path attrs
  // stay the shared cross-tile fallback; "Reset Override" clears the tile value.
  const ctx = getReplicaContext(vpId, getActiveFilePath(), getViewportWidths());
  if (!ctx.isPrimary) {
    // Stamp the path children with stable `${wrapperId}-g${i}` ids once so the
    // override can target each stroke. modifyProjectFile auto-flushes + re-syncs,
    // so the ids exist before the styleUpdate below targets them. Cached so a
    // continuous drag doesn't re-stamp each tick.
    if (!_stampedSketchWrappers.has(wrapperId)) {
      modifyProjectFile(getActiveFilePath(), (code) => ensureShapeChildIds(code, wrapperId).code);
      _stampedSketchWrappers.add(wrapperId);
    }
    for (const r of regens) {
      const childId = `${wrapperId}-g${r.childIndex}`;
      const styles: Record<string, string> = {};
      for (const [key, value] of Object.entries(r.attrs)) {
        if (key === 'd') styles.d = value ? pathDToCss(value) : '';
        else styles[SKETCH_ATTR_CAMEL[key] ?? key] = value;
      }
      for (const u of ctx.styleUpdate(childId, styles)) queueMutation(u as any);
      // Instant per-tile feedback on the vpPrefix-scoped element.
      if (bridge.setChildShapeAttribute) {
        for (const [key, value] of Object.entries(r.attrs)) {
          bridge.setChildShapeAttribute(wrapperId, vpPrefix, r.childIndex, key, value === '' ? null : value);
        }
      }
    }
    // NO flushNow here — the queued styleUpdate mutations auto-flush on the next
    // RAF via the markCanvasUpdate path (Renderer skips its rebuild), same as the
    // primary path. flushNow per LIVE tick recreated the ColorPicker DOM mid-drag
    // (froze color drags) and forced a full rebuild per frame. The COMMIT path
    // (applyBrushToSketchNow) still flushes once after this returns.
    return;
  }

  // ── Primary tile — flat write (shared base attrs) ──────────────────────
  // 1. Bridge-direct DOM patch — instant visual feedback.
  if (bridge.setChildShapeAttribute) {
    for (const r of regens) {
      for (const [key, value] of Object.entries(r.attrs)) {
        bridge.setChildShapeAttribute(
          wrapperId, vpPrefix, r.childIndex, key,
          value === '' ? null : value,
        );
      }
    }
  }

  // 2. Queue source commits — auto-flushed on next RAF without
  //    triggering a Renderer rebuild (markCanvasUpdate path).
  for (const r of regens) {
    queueMutation({
      type: 'updateSvgAttrs',
      nodeId: wrapperId,
      attrs: r.attrs,
      childIndex: r.childIndex,
    });
  }
}

// ─── RAF-coalesced applier ──────────────────────────────────────────────────

interface PendingApply {
  targetId: string;
  vpId: string;
  brush: BrushConfig;
}

// Coalesced PER TARGET — a Map, not a single slot. The SketchTool fans a
// multi-select brush edit over every selected sketch; with the old single
// `pendingApply` slot each loop iteration overwrote the previous target and
// only the LAST selected sketch updated per frame (the multi-select fill
// bug, user report 2026-07-29).
const pendingApplies = new Map<string, PendingApply>();
let rafScheduled = false;

function runApply() {
  rafScheduled = false;
  if (pendingApplies.size === 0) return;
  const batch = [...pendingApplies.values()];
  pendingApplies.clear();
  const nodes = getDefaultStore().get(nodesAtom);
  let strokes = 0;
  for (const p of batch) {
    const regens = buildStrokeRegens(p.targetId, p.brush, nodes);
    applyRegens(p.targetId, p.vpId, regens);
    strokes += regens.length;
  }
  trace.action('sketch-live-sync:apply', {
    targets: batch.map((b) => b.targetId), strokes, brushSize: batch[0].brush.size,
  });
}

/**
 * Schedule a brush-change → strokes-update for the next animation
 * frame. Use this for ALL change paths — slider drag (live tick),
 * slider release, color drag, checkbox toggle, select change, reset.
 * Coalescing means rapid input doesn't queue rapid pipeline runs;
 * distinct targets coalesce independently (multi-select fan-out).
 */
export function applyBrushToSketch(
  targetId: string | null,
  vpId: string,
  brush: BrushConfig,
): void {
  if (!targetId) return;
  pendingApplies.set(targetId, { targetId, vpId, brush });
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(runApply);
}

/**
 * "Commit now" version — runs the regen + queues source mutations
 * synchronously (no RAF wait), then forces an immediate flush so the
 * source is settled before whatever the user does next. Used on
 * explicit "done" gestures: slider release, ToolInput Enter, reset
 * button, checkbox toggle, select change.
 *
 * Unlike the live path, the flushNow here is fine for perf — it
 * fires once per gesture, not 60×/sec. The Renderer's rebuild from
 * the resulting `nodes` change is also a one-time cost.
 */
export function applyBrushToSketchNow(
  targetId: string | null,
  vpId: string,
  brush: BrushConfig,
): void {
  if (!targetId) return;
  applyBrushToSketchNowBatch([targetId], vpId, brush);
}

/** Multi-select commit: regen every target, then ONE flush — N sketches must
 *  not pay N parse+render cycles on a single release. */
export function applyBrushToSketchNowBatch(
  targetIds: readonly string[],
  vpId: string,
  brush: BrushConfig,
): void {
  const ids = targetIds.filter(Boolean);
  if (ids.length === 0) return;
  // Cancel any pending RAF work for these targets — we're doing it now.
  for (const id of ids) pendingApplies.delete(id);
  if (pendingApplies.size === 0) rafScheduled = false;
  const nodes = getDefaultStore().get(nodesAtom);
  let strokes = 0;
  for (const id of ids) {
    const regens = buildStrokeRegens(id, brush, nodes);
    applyRegens(id, vpId, regens);
    strokes += regens.length;
  }
  // One-shot flush — the queue is small (one gesture's worth), so the
  // parse+render cost is bounded and worth paying for the clean
  // "source is up to date" guarantee.
  flushNow();
  trace.action('sketch-live-sync:apply-now', {
    targets: ids, strokes, brushSize: brush.size,
  });
}
