// SvgEditorOverlay.tsx — Parent-frame thin RPC for the iframe-hosted SVG
// path editor. The actual `SvgPathEditor` instance lives in the sandbox
// (see `canvas-sandbox/shape-edit-host.ts`); all anchor drag events
// happen entirely inside the iframe in the same coord space as the SVG
// content. This component does three things only:
//
//   1. On mount → call `bridge.startShapeEdit(nodeId, vpPrefix)` and
//      flip iframe pointer-events to 'auto' so anchors receive clicks.
//   2. On unmount → `await bridge.commitShapeEdit()`, queue source
//      mutations from the returned payload (replaceSvgInner +
//      updateHtmlAttrs(viewBox) + updateStyles(width/height/left/top))
//      in one synchronous batch, then `flushNow()`.
//
// Why RPC-return instead of postMessage event for commit: React effect
// cleanup is synchronous and clears its callback closures immediately
// after returning. An event arriving AFTER the cleanup function lands
// on a dead handler — the symptom was "after exit the wrapper doesn't
// fit, but it catches up after another reshape". Pulling the result via
// Comlink-await keeps the queue write inside the alive cleanup scope.

import { useEffect } from 'react';
import { getDefaultStore } from 'jotai';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { getViewportPrefix, getActiveFilePath, getSvgGroupAncestorChain } from '@/canvas/node-ops';
import { getReplicaContext } from '@/canvas/drag/replica-context';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { modifyProjectFile } from '@/code/project/modify-file';
import { ensureShapeChildIds } from '@/code/generation/generator-attrs';
import { pathDToCss } from '@/shared/svg-path/svg-path-parser';
import { queueMutation, setForceRender, flushNow } from '@/code/mutation/mutation-queue';
import { shapeEditCommitPendingAtom, shapeEditPenModeAtom, shapeEditCreatedNodeAtom } from '@/code/stores/shape-edit-store';
import { nodesAtom } from '@/code/stores/store';
import { refitGroupChain } from '@/code/svg/refit-group';
import { trace } from '@/shared/debug-trace';

export interface SvgEditorOverlayProps {
  nodeId: string;
  vpId: string;
}

interface ShapeEditCommitPayload {
  nodeId: string;
  vpPrefix: string;
  innerJSX: string;
  shapes: { dataId: string; d: string }[];
  wrapper: { viewBox: string; widthPx: string; heightPx: string; leftPx: string; topPx: string };
}

interface BridgeWithShapeEdit {
  startShapeEdit?: (nodeId: string, vpPrefix: string, pen?: boolean) => void;
  commitShapeEdit?: () => Promise<ShapeEditCommitPayload | null>;
}

export default function SvgEditorOverlay({ nodeId, vpId }: SvgEditorOverlayProps) {
  useEffect(() => {
    const bridge = getCanvasBridge() as BridgeWithShapeEdit;

    if (typeof bridge.startShapeEdit !== 'function') {
      trace.error('svg-editor-overlay:no-bridge', { nodeId });
      return;
    }

    const vpPrefix = getViewportPrefix(vpId);

    // The iframe defaults to `pointer-events: none` so the parent's
    // DragCoordinator / canvas-dnd own canvas clicks. While the shape
    // editor is mounted, clicks must reach inside the iframe so
    // SvgPathEditor can drive its anchor / handle interactions. Flip
    // to 'auto' for the duration — same pattern as text-edit.
    const iframe = document.querySelector('iframe[src*="5174"]') as HTMLIFrameElement | null;
    if (iframe) iframe.style.pointerEvents = 'auto';

    // Pen mode = the PATH TOOL opened this to draw a NEW shape, so the editor
    // starts with the pen active (place points + edit vertices mid-draw).
    const pen = getDefaultStore().get(shapeEditPenModeAtom);
    bridge.startShapeEdit(nodeId, vpPrefix, pen);
    trace.action('svg-editor-overlay:started', { nodeId, vpId, pen });

    return () => {
      // Restore iframe pointer-events first so the user's outside click
      // (which triggered this unmount) doesn't get re-targeted at the
      // iframe content as the canvas regains pointer focus.
      if (iframe) iframe.style.pointerEvents = 'none';

      // Pen mode is per-session — clear it on exit so a later NORMAL shape-edit
      // (double-click an existing shape) doesn't wrongly start with the pen.
      getDefaultStore().set(shapeEditPenModeAtom, false);

      // Suppress SelectionOverlay / CanvasNodeNameDisplay / ParentHighlight
      // until the renderer's next `renderComplete` event populates the
      // rect cache with the post-commit geometry. Without this, the
      // selection box paints one frame at the OLD (pre-edit) bounds —
      // visible as a jump-to-fit when the shape's bbox changed during
      // shape-edit. Cleared in Canvas.tsx's `onRenderComplete` handler
      // (the SVG-group-drag commit path uses the same atom).
      getDefaultStore().set(shapeEditCommitPendingAtom, true);

      // Pull the final state via Comlink RPC. The iframe synchronously
      // builds the payload (already-normalized wrapper bounds + inner
      // SVG markup), Comlink ferries it back. Once it lands here we
      // queue the same trio of mutations the old event-based path did,
      // then flushNow() so the renderer applies styles + attrs in one
      // synchronous tick: browser paints once with final geometry.
      bridge.commitShapeEdit?.().then(payload => {
        if (!payload || payload.nodeId !== nodeId) {
          trace.action('svg-editor-overlay:no-payload', { nodeId });
          // No commit happened — clear the suppression atom so overlays
          // don't stay hidden forever waiting for a render that won't fire.
          getDefaultStore().set(shapeEditCommitPendingAtom, false);
          return;
        }
        // Fresh PEN-creation seed: if the user drew nothing real (no L/C/Q/A draw
        // commands — just the seed M point), DELETE the viewport-sized node
        // instead of committing a stray empty shape.
        const createdNode = getDefaultStore().get(shapeEditCreatedNodeAtom);
        if (createdNode === nodeId) {
          getDefaultStore().set(shapeEditCreatedNodeAtom, null);
          if (!/[LCQAlcqa]/.test(payload.innerJSX)) {
            setForceRender();
            queueMutation({ type: 'removeNode', nodeId });
            flushNow();
            getDefaultStore().set(shapeEditCommitPendingAtom, false);
            trace.action('svg-editor-overlay:delete-empty-pen-node', { nodeId });
            return;
          }
        }

        const file = getActiveFilePath();
        const ctx = getReplicaContext(vpId, file, getViewportWidths());
        // ctx.styleUpdate returns PendingUpdates (drag/resize types), NOT raw
        // mutations. A plain primary write comes back as `{type:'style'}` — which
        // the mutation queue handles under the name `'updateStyles'`. Every other
        // styleUpdate caller (drag orchestrator, arrow-nudge, node-ops, Canvas)
        // performs this same translation; queueing the raw `'style'` PendingUpdate
        // here silently DROPPED the wrapper bounds, so the viewBox grew while the
        // box kept its old size → preserveAspectRatio="none" squeezed the shape
        // (the "shape-edit commit scales down / jumps" bug).
        const queuePending = (u: { type: string; nodeId?: string; styles?: Record<string, string> }) => {
          if (u.type === 'style' && u.nodeId && u.styles) {
            queueMutation({ type: 'updateStyles', nodeId: u.nodeId, styles: u.styles });
          } else {
            queueMutation(u as any);
          }
        };
        trace.action('svg-editor-overlay:commit-received', {
          nodeId: payload.nodeId,
          innerLen: payload.innerJSX.length,
          shapeCount: payload.shapes.length,
          isPrimary: ctx.isPrimary,
          variantName: ctx.variantName,
          wrapper: payload.wrapper,
        });
        setForceRender();
        const w = payload.wrapper;

        if (ctx.isPrimary) {
          // PRIMARY / default tile → geometry is the BASE: write it as the `d`
          // ATTRIBUTE on each path (always renders, incl. browsers without CSS-`d`).
          // This is the original unconditional path.
          queueMutation({ type: 'replaceSvgInner', nodeId: payload.nodeId, innerJSX: payload.innerJSX });
          if (w.viewBox) {
            queueMutation({ type: 'updateHtmlAttrs', nodeId: payload.nodeId, attrs: { viewBox: w.viewBox } });
          }
          if (w.widthPx && w.heightPx) {
            // Route the wrapper bounds through the per-tile system, NOT a raw
            // updateStyles. On a component this edits the DEFAULT branch of the
            // width/height ternary (and the default position) while PRESERVING
            // any variant overrides — a raw style write clobbered a width/height
            // set by a prior variant resize (the "shape-edit then resize variant
            // breaks + moves primary" bug). With no variants it writes a plain
            // literal (writeInstanceConditionalStyles), so behaviour is unchanged.
            for (const u of ctx.styleUpdate(payload.nodeId, {
              width: w.widthPx, height: w.heightPx, left: w.leftPx, top: w.topPx,
            })) queuePending(u);
          }
          flushNow();
          // Stamp each inner shape with a stable, deterministic data-id so a LATER
          // per-variant / per-viewport edit has addressable path nodes to route a
          // `d` override onto (index-aligned with the sandbox's payload.shapes).
          modifyProjectFile(file, code => ensureShapeChildIds(code, payload.nodeId).code);
          flushNow();
        } else {
          // NON-PRIMARY tile (component variant OR page-replica viewport) → DON'T
          // overwrite the shared base markup. Make the base shapes addressable,
          // then route each shape's geometry as a per-tile CSS `d` OVERRIDE
          // (variants object for variants, `@media` for viewports) — independent
          // per tile, like the reference. The base `d` attribute stays the fallback.
          modifyProjectFile(file, code => ensureShapeChildIds(code, payload.nodeId).code);
          flushNow();
          for (const s of payload.shapes) {
            for (const u of ctx.styleUpdate(s.dataId, { d: pathDToCss(s.d) })) queuePending(u);
          }
          // DO NOT route the normalized wrapper bounds on a non-primary tile.
          // `computeNormalizedBounds` tightens the box by REFRAMING the viewBox
          // (window into the path's coordinate space) + rescaling width/height —
          // it does NOT rewrite the path `d`. That reframe is only self-consistent
          // when the new viewBox travels WITH the new width/height. But viewBox is
          // an SVG attribute with no CSS property, so it can't live in a `@media`
          // rule or a variants object — it stays the shared BASE viewBox. Routing
          // just the rescaled width/height (674×278 over a 313×304 viewBox with
          // preserveAspectRatio="none") therefore STRETCHES the shape and floats
          // the editor's re-open anchors off it. The per-shape `d` above already
          // carries the full edited geometry in the base viewBox space, so the box
          // can stay as-is — geometry that spills past it shows via overflow:visible.
          flushNow();
          getDefaultStore().set(shapeEditCommitPendingAtom, false);
          trace.action('svg-editor-overlay:committed-per-tile', { nodeId: payload.nodeId, vpId, shapeCount: payload.shapes.length });
          return;
        }

        // If the reshaped shape is a CHILD of an SVG group, its new geometry can
        // spill outside its box. Refit the group: this normalizes the child box
        // to wrap its geometry AND re-tightens the group bounds (rotation-aware),
        // so the group box keeps matching the painted content — otherwise a
        // later resize of the rotated group "moves both sides". A no-op for a
        // standalone shape (no group parent).
        const nodes = getDefaultStore().get(nodesAtom);
        const node = nodes.get(payload.nodeId);
        const parent = node?.parentId ? nodes.get(node.parentId) : null;
        if (node?.type === 'svg' && parent?.type === 'svg' && node.parentId) {
          // Refit the WHOLE `<svg>`-group ancestor chain (rotation-aware) — a
          // reshaped GRANDCHILD must shrink-wrap its nested group AND the outer
          // group above it, not just the immediate parent.
          const chain = getSvgGroupAncestorChain(payload.nodeId, nodes);
          refitGroupChain(chain.length > 0 ? chain : [node.parentId], getActiveFilePath());
        }
      }).catch(err => {
        trace.error('svg-editor-overlay:commit-failed', String(err));
        // Safety: never leave overlays suppressed if the commit RPC fails.
        getDefaultStore().set(shapeEditCommitPendingAtom, false);
      });
      trace.action('svg-editor-overlay:stopped', { nodeId });
    };
  }, [nodeId, vpId]);

  // No DOM in the parent frame — the editor renders inside the iframe.
  return null;
}
