// CanvasNodeNameDisplay.tsx — Floating name + icon label above every
// CANVAS-LEVEL node (top-level floaters with `data-canvas-node="true"`)
// and every TOP-LEVEL VARIANT root in a component master file.
//
// Ported from the old builder's CanvasNodeNameDisplay. Architectural
// adaptations for Revyme:
//
//   - Canvas elements live inside a sandboxed iframe at :5174. Reading
//     rects goes through the bridge (`findNodeRect`); the label itself
//     renders in the parent frame as `position: fixed`.
//   - Node identity / name / type come from the Jotai NodeMap, NOT
//     from DOM `data-*` attributes. The map is reactive — name changes
//     show instantly without polling.
//   - Selection uses `selectedIdsAtom`; drag start goes through the
//     `startNodeDrag` bridge so the right strategy gets picked
//     (CanvasDrag for floaters, AbsoluteInFrame / LayoutLifted for
//     anything inside a viewport).
//   - Rename writes a `data-name` attribute via the mutation queue —
//     the parser folds it back into `node.name` on the next parse.
//
// Hidden when:
//   - dragging (`canvasInteractingAtom`) — labels would just chase
//     the cursor and clutter the canvas
//   - canvas zoom < 0.2 (matches old builder threshold)
//   - the node has a non-translate visual transform (rotate/scale/skew)
//
// Always uses screen-pixel font sizes — labels stay readable at any
// canvas zoom.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { nodesAtom, selectedIdsAtom, canvasInteractingAtom, isComponentFileAtom } from '@/code/stores/store';
import { useLiveNode, useLiveNodesMap } from '@/code/stores/node-family';
import { contextMenuAtom } from '@/code/stores/context-menu-store';
import { shapeEditingIdAtom, shapeEditCommitPendingAtom } from '@/code/stores/shape-edit-store';
import { repositionSignalOps } from '@/canvas/drag/reposition-signal';
import { sketchEditingIdAtom } from '@/code/stores/sketch-edit-store';
import { interactingViewportIdAtom, visibleViewportsAtom } from '@/code/stores/viewport-store';
import { previewModeAtom, previewComponentFileOverrideAtom } from '@/code/stores/editor-store';
import { activeFilePathAtom, isTemplateFilePath } from '@/code/project/active-file-store';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { renameVariant } from '@/code/variants/variant-ops';
import { projectFS, stableProjectVersionAtom } from '@/code/project/project-fs';
import { findNodeRect, findNodeComputedStyle, getViewportPrefix } from '@/canvas/node-ops';
import { getScreenCornersById } from '@/canvas/resize/geometry-utils';
import { transformManager } from '@/canvas/transform';
import { startNodeDrag } from '@/canvas/drag/toolbar-drag-bridge';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { trace } from '@/shared/debug-trace';
import { useIsViewer } from '@/code/stores/viewer-mode-store';

const LABEL_HEIGHT = 24; // screen px; gap above the node
const FONT_SIZE = 11;
const ICON_SIZE = 12;
const DRAG_THRESHOLD_PX = 5;
const MIN_VISIBLE_SCALE = 0.2;

// Inline SVG icon — project doesn't have lucide-react, and only one
// case actually renders an icon (top-level variant root → crown).
function CrownIcon({ color }: { color: string }) {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 12 12" fill="none">
      <path
        d="M2 9.5h8M2 3.5l2 2.5L6 2.5l2 3.5 2-2.5v6H2v-6z"
        stroke={color}
        strokeWidth="1.1"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Play button shown next to the name label on (a) top-level variant
// roots of a component master file and (b) component instances on
// regular pages. Mirrors the reference's "preview this component in
// isolation" affordance — click to open the preview overlay with the
// component master file pinned so the user can preview JUST the
// component, no surrounding page chrome.
const PLAY_BUTTON_SIZE = 18;
function PlayButton({
  componentFile,
  size = PLAY_BUTTON_SIZE,
}: {
  componentFile: string;
  size?: number;
}) {
  const setPreviewMode = useSetAtom(previewModeAtom);
  const setPreviewOverride = useSetAtom(previewComponentFileOverrideAtom);
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        // Stop the label's own drag-listener from kicking in.
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setPreviewOverride(componentFile);
        setPreviewMode(true);
        trace.action('canvas-node-name:play', { componentFile });
      }}
      title="Preview this component"
      style={{
        // `display: flex` (not inline-flex) inside the parent flex —
        // explicit flexShrink:0 prevents the button from compressing
        // when the parent has narrow maxWidth, and keeps it as a
        // standalone item that doesn't overlap the text sibling.
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        flexGrow: 0,
        width: size,
        height: size,
        minWidth: size,
        padding: 0,
        background: 'var(--accent-secondary, #a78bfa)',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        color: 'white',
      }}
    >
      <svg width={size - 8} height={size - 8} viewBox="0 0 24 24" fill="currentColor">
        <polygon points="6,4 20,12 6,20" />
      </svg>
    </button>
  );
}

// ─── Per-node label component ─────────────────────────────────────────────

interface LabelProps {
  nodeId: string;
  vpId: string;
}

function NameDisplay({ nodeId, vpId }: LabelProps) {
  // Viewer mode — the label is a pure visual marker: no click-to-select,
  // no double-click rename, no drag. `pointerEvents: 'none'` on the
  // label root kills all three at once.
  const isViewer = useIsViewer();
  // Per-node subscription — each floating label re-renders only when ITS
  // node changes, instead of every label on every commit (a big page mounts
  // one label per top-level node). The container below (whole-map, category
  // B) still decides WHICH labels exist.
  // LIVE read — the label's name/canvas-ness must flip the same frame a
  // drop commits (the parsed atom lags by the deferred fan-out).
  const node = useLiveNode(nodeId);
  const selectedIds = useAtomValue(selectedIdsAtom);
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const setContextMenu = useSetAtom(contextMenuAtom);
  const isComponentFile = useAtomValue(isComponentFileAtom);
  // When a variant root label is clicked, switch the interacting
  // viewport to that variant — otherwise clicking variant-1's "Frame"
  // label leaves the user editing the default variant's styles.
  const setInteractingVp = useSetAtom(interactingViewportIdAtom);
  const interactingVpId = useAtomValue(interactingViewportIdAtom);
  // Read here at the TOP of the component (before any early returns)
  // so the hook order stays stable across renders — moving this read
  // below the `if (!rect) return null` short-circuit triggers React's
  // "rendered more hooks than during the previous render" error when
  // the rect comes/goes between paint cycles.
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const projectVersion = useAtomValue(stableProjectVersionAtom);
  // For a TOP-LEVEL VARIANT root the canvas label shows the variant's LABEL — the same name the variant-select
  // tool shows for a component instance — NOT the root's shared `data-name`. Resolve it from `variantConfig`
  // for THIS label's variant (vpId; the primary tile's vpId is `desktop` → the `default` variant). Memoised so
  // it re-parses only on a code change, never per pan frame. Null for non-component / non-variant contexts.
  const variantLabel = useMemo(() => {
    const variantName = vpId === 'desktop' ? 'default' : vpId;
    const code = projectFS.readFile(activeFilePath);
    if (!code) return null;
    return parseVariantConfig(code).find(v => v.name === variantName)?.label ?? null;
  }, [activeFilePath, vpId, projectVersion]);

  // For variant-root labels, "selected" means the master root is in
  // selectedIds AND this label is on the currently-interacting variant
  // viewport — otherwise every variant's label would highlight as
  // accent when the user selects any one of them (since they all
  // share the same nodeId).
  const isSelected = selectedIds.includes(nodeId) && vpId === interactingVpId;
  const [isHovered, setIsHovered] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editingName, setEditingName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-render only when the canvas transform actually changes (pan/zoom).
  // Originally this was a per-label RAF that called `setState` every
  // animation frame even when the canvas was idle — fine for ONE label,
  // catastrophic with many: N labels × 60 React renders/sec dominates the
  // main thread and makes pan/zoom feel laggy when the user has lots of
  // canvas-level vectors. `transformManager.subscribe` fires only on
  // actual transform deltas and pipes through React via `useSyncExternalStore`,
  // so each label re-renders 1× per pan-frame instead of 60× per second.
  useSyncExternalStore(
    transformManager.subscribe.bind(transformManager),
    () => transformManager.getTransform().scale + ',' + transformManager.getTransform().x + ',' + transformManager.getTransform().y,
    () => '0,0,0',
  );

  // Focus input on entering edit mode.
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  if (!node) return null;

  // Skip if a non-translate transform is on the node — the label would
  // sit at the post-transform AABB which doesn't visually align.
  const transform = findNodeComputedStyle(nodeId, vpId, 'transform') || '';
  if (transform && transform !== 'none' && !isPureTranslate(transform)) {
    return null;
  }

  const scale = transformManager.getTransform().scale;
  if (scale < MIN_VISIBLE_SCALE) return null;

  // For SVG nodes the visual bounds = painted bbox (the strokes /
  // shapes the user actually sees), NOT the wrapper rect that
  // `findNodeRect` returns. SelectionBorder + InteractionOutline
  // draw against the painted bbox via `cornersCache` — the name
  // label needs to anchor to the same geometry, otherwise it sits
  // up-left of the visible content (offset proportional to the
  // wrapper's empty margin around the strokes). Read corners and
  // compute the AABB.
  let rect: { left: number; top: number; width: number; height: number } | null;
  if (node.type === 'svg') {
    const c = getScreenCornersById(nodeId, vpId);
    if (c) {
      const left = Math.min(c.TL.x, c.TR.x, c.BR.x, c.BL.x);
      const top = Math.min(c.TL.y, c.TR.y, c.BR.y, c.BL.y);
      const right = Math.max(c.TL.x, c.TR.x, c.BR.x, c.BL.x);
      const bottom = Math.max(c.TL.y, c.TR.y, c.BR.y, c.BL.y);
      rect = { left, top, width: right - left, height: bottom - top };
    } else {
      rect = findNodeRect(nodeId, vpId);
    }
  } else {
    rect = findNodeRect(nodeId, vpId);
  }
  if (!rect) return null;

  // Color rules:
  //   - selected → accent
  //   - component / variant root → secondary accent (purple)
  //   - hovered → accent
  //   - default → muted
  //
  // `node.componentFile` is set on EVERY expanded descendant of an
  // instance (parser stamps it on the master's nodes when they get
  // pulled into the page's tree), so it's NOT a reliable "is this
  // node an instance" check. `isComponentInstance` IS — the parser
  // only sets it on the wrapper tag itself. Same fix the labeled
  // list above uses.
  const isComponentInstance = !!node.isComponentInstance;
  const isVariantRoot = isComponentFile && !node.parentId && !node.isCanvasNode;
  // INSIDE A COMPONENT MASTER, EVERY name label is purple — not just the
  // variant root. The whole of component-editing chrome (control labels,
  // selection, the layers tree, the modals) uses `--accent-secondary` to say
  // "you are in a component", so a blue floater on a child frame was the one
  // thing breaking that signal (user report 2026-08-08).
  const isAccented = isComponentInstance || isComponentFile;
  // Idle color: a fixed mid-dark gray that reads as quiet metadata in
  // BOTH themes. `--text-tertiary` (#999 light / #666 dark) was too
  // bright on dark mode and too washed-out on light mode. #555 lands
  // in the middle: visible-but-quiet on light bg (close to body text
  // but distinctly muted), and quiet on dark bg without being invisible.
  const color =
    isSelected || isHovered
      ? isAccented ? 'var(--accent-secondary)' : 'var(--selection)'
      : '#555';

  // Icons only on top-level variant roots (crown). Plain canvas
  // floaters render as name-only — keeps the canvas surface quiet
  // when the user is mostly looking at a layout.
  const Icon = isVariantRoot ? CrownIcon : null;

  // Play affordance: shown on (a) component instances on regular
  // pages (`node.componentFile` set) and (b) top-level variant roots
  // of a component master file. Click → open preview overlay pinned
  // to the component master so the user previews it in isolation
  // without first navigating into the master.
  //
  // Resolve which component file to preview:
  //   • instance → `node.componentFile` (the master it expanded from)
  //   • variant root (master file) → the active file (read at the
  //     TOP of the component to keep the hook order stable across
  //     renders — see the early returns above).
  // `componentFile` is the master file path (set on instance wrappers
  // by the parser, and ALSO on every expanded descendant — but we
  // already gated `isComponentInstance` to wrappers only above).
  const playTargetFile =
    isComponentInstance && node.componentFile
      ? node.componentFile
      : isVariantRoot
        ? activeFilePath
        : null;

  // Label sits one row above the node, anchored to its left edge.
  const labelTop = rect.top - LABEL_HEIGHT - 2;
  const labelLeft = rect.left;
  const labelMaxWidth = Math.max(60, rect.width);

  // A top-level variant root shows its variant LABEL (kept in sync with the variant-select tool); everything
  // else shows the node's data-name.
  const displayName = (isVariantRoot && variantLabel) ? variantLabel : (node.name || capitalize(node.type || 'Element'));

  const commitRename = (newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === displayName) {
      setIsEditing(false);
      return;
    }
    if (isVariantRoot) {
      // The canvas label IS the variant's LABEL. Write the variantConfig label AND the root's data-name so
      // the two stay in lock-step (the user asked for both to update together; the variant-select tool reads
      // the label, the Layers tree / instance name reads the data-name).
      const variantName = vpId === 'desktop' ? 'default' : vpId;
      renameVariant(activeFilePath, variantName, trimmed);
    }
    queueMutation({
      type: 'updateHtmlAttrs',
      nodeId,
      attrs: { 'data-name': trimmed },
    });
    trace.action('canvas-node-name:rename', { nodeId, name: trimmed, isVariantRoot });
    setIsEditing(false);
  };

  return (
    <div
      // Identifying attribute so the top-level cleanup effect can
      // wipe stale label divs left over from HMR re-mounts.
      data-canvas-node-label={`${vpId}:${nodeId}`}
      style={{
        position: 'fixed',
        left: labelLeft,
        top: labelTop,
        height: LABEL_HEIGHT,
        maxWidth: labelMaxWidth,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontSize: FONT_SIZE,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        userSelect: 'none',
        // Viewer: fully inert — the label still shows the node name but
        // can't be clicked, double-clicked (rename) or dragged.
        pointerEvents: isViewer ? 'none' : 'auto',
        zIndex: 5,
        color,
        cursor: isEditing ? 'text' : 'default',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={(e) => {
        if (isEditing) return;
        e.preventDefault();
        e.stopPropagation();
        // Switch interacting viewport to whichever variant this label
        // belongs to so the user lands editing THAT variant's styles.
        // No-op for plain canvas-level floaters (they use the
        // currently-interacting vpId).
        if (vpId !== interactingVpId) setInteractingVp(vpId);
        if (e.shiftKey) {
          // Multi-select: append unless already there
          setSelectedIds(
            selectedIds.includes(nodeId)
              ? selectedIds.filter((id) => id !== nodeId)
              : [nodeId, ...selectedIds],
          );
        } else {
          setSelectedIds([nodeId]);
        }
        trace.action('canvas-node-name:click', { nodeId, vpId, shift: e.shiftKey });
      }}
      onContextMenu={(e) => {
        if (isEditing) return;
        // Right-click the name label = right-click the node it labels: select it
        // (switching to its variant viewport) + open the node context menu at the
        // cursor. Without this the event bubbled to the canvas handler, which
        // opens the menu for the PREVIOUSLY-selected node (wrong target). Keep an
        // existing multi-selection that already includes this node.
        e.preventDefault();
        e.stopPropagation();
        if (vpId !== interactingVpId) setInteractingVp(vpId);
        // Functional update (fresh state, not the stale closure): if this node is
        // already selected keep the selection as-is (don't collapse a multi-select
        // and never unselect); otherwise select just this node.
        setSelectedIds((prev) => (prev.includes(nodeId) ? prev : [nodeId]));
        setContextMenu({ show: true, x: e.clientX, y: e.clientY, nodeId });
        trace.action('canvas-node-name:contextmenu', { nodeId, vpId });
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isEditing) {
          setEditingName(displayName);
          setIsEditing(true);
        }
      }}
      onMouseUp={(e) => { if (e.button !== 0) e.stopPropagation(); }}
      onMouseDown={(e) => {
        if (isEditing) return;
        // Non-left button (right-click for the context menu): DON'T bubble to the
        // canvas mouse controller — its handleMouseDown/Up would clear the
        // selection, deselecting the node right before the menu opens. Selection
        // is handled in onContextMenu below.
        if (e.button !== 0) { e.stopPropagation(); return; }
        e.preventDefault();
        e.stopPropagation();

        // 5px threshold drag detection — same pattern the old builder
        // used. Below threshold, treat as a click (selection only).
        const startX = e.clientX;
        const startY = e.clientY;
        const startEvent = e.nativeEvent;
        let dragStarted = false;

        const onMove = (move: MouseEvent) => {
          if (dragStarted) return;
          const dx = move.clientX - startX;
          const dy = move.clientY - startY;
          if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
          dragStarted = true;
          // Hand off to the existing drag pipeline. Pass the original
          // mousedown event so DragCoordinator's startMouse anchors at
          // the click point — exactly as if the user had grabbed the
          // node directly inside the iframe.
          //
          // For a VARIANT ROOT, pass that variant's viewport prefix —
          // every variant shares one nodeId but renders as its own
          // replica, so an empty prefix would drag the DEFAULT variant
          // instead of the one the user grabbed. Canvas floaters have a
          // single instance, so they keep the empty prefix.
          startNodeDrag(nodeId, startEvent, isVariantRoot ? getViewportPrefix(vpId) : '');
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      }}
    >
      {playTargetFile && isSelected && <PlayButton componentFile={playTargetFile} />}
      {Icon && !(playTargetFile && isSelected) && <Icon color={color} />}
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editingName}
          onChange={(e) => setEditingName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename(editingName);
            else if (e.key === 'Escape') setIsEditing(false);
          }}
          onBlur={() => commitRename(editingName)}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          style={{
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'inherit',
            font: 'inherit',
            fontSize: FONT_SIZE,
            padding: 0,
            margin: 0,
            minWidth: 60,
            maxWidth: labelMaxWidth - ICON_SIZE - 8,
          }}
        />
      ) : (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1, minWidth: 0 }}>{displayName}</span>
      )}
    </div>
  );
}

// ─── Top-level container — picks which nodes get a label ───────────────────

export default function CanvasNodeNameDisplay() {
  // LIVE whole-map — which nodes get labels (canvas roots) must update the
  // same frame a reparent/unparent commits, not after the deferred parse.
  const nodes = useLiveNodesMap();
  const isInteracting = useAtomValue(canvasInteractingAtom);
  const isComponentFile = useAtomValue(isComponentFileAtom);
  // Templates (`LayoutClient.tsx`) are "component-like", so their root would
  // otherwise get a variant-root name+play label — but a template has no
  // variants and its root is just the page wrapper, so the label is noise.
  // Suppress it when editing a template.
  const isTemplate = isTemplateFilePath(useAtomValue(activeFilePathAtom));
  const vpId = useAtomValue(interactingViewportIdAtom);
  // Hide every name label while the user is in shape-edit mode — the
  // anchor handles already imply the selected shape, and the floating
  // label would visually compete with anchor positions near the top of
  // the SVG.
  const shapeEditingId = useAtomValue(shapeEditingIdAtom);
  // Same shape-edit-commit gate as SelectionOverlay: between
  // SvgEditorOverlay's unmount and the renderer's post-commit re-render,
  // findNodeRect returns the STALE pre-edit bounds. Without this guard,
  // the floating name label paints at the old position for one frame
  // before the cache catches up, producing the same visible jump the
  // selection box used to have. Cleared by Canvas.tsx's onRenderComplete.
  const shapeEditCommitPending = useAtomValue(shapeEditCommitPendingAtom);
  // Sketch edit mode: hide every floating name label. The dashed
  // accent outline rendered by SketchEditOverlay already identifies
  // the active sketch; an additional "Sketch" pill floating in the
  // top-left of the wrapper is just visual noise during drawing.
  // Also hide labels for OTHER canvas-node sketches on the page —
  // those grayed-out labels in the periphery distract from the
  // active drawing surface and the user can't interact with them
  // anyway while sketch-edit is active.
  const sketchEditingId = useAtomValue(sketchEditingIdAtom);
  // Subscribe to canvas transform — when the user pans/zooms, every
  // label needs to reposition. RAF poll inside the per-label component
  // handles that, but the parent also needs to re-render to add/remove
  // labels as nodes scroll into / out of the visible canvas (the
  // `findNodeRect` call inside per-label gates on a missing rect).
  // Subscribing here is cheap.
  // Composite x/y/scale key (rounded) — pans AND zooms must re-run the
  // on-screen filter below, not just zooms.
  const cameraKey = useSyncExternalStore(
    transformManager.subscribe.bind(transformManager),
    () => {
      const t = transformManager.getTransform();
      return `${Math.round(t.x / 8)}:${Math.round(t.y / 8)}:${t.scale.toFixed(3)}`;
    },
    () => '1',
  );

  // Hide every name label across a drag-commit reposition gap. A node dragged
  // in/out of a layout still reads `isCanvasNode` from the stale cache until the
  // commit lands, so its floating label would flash back on mouseup. Same role
  // as `shapeEditCommitPending`; cleared by Canvas's onRenderComplete.
  const repositionCommitPending = useSyncExternalStore(
    repositionSignalOps.subscribe,
    repositionSignalOps.isCommitPending,
    () => false,
  );

  // In component master files, variants share the same JSX tree but
  // each renders in its OWN viewport (id 'desktop' for default + one
  // per non-default variant). The variant ROOT node is a single node
  // in the nodesAtom map, but the iframe paints it once per variant
  // viewport. We want a permanent label on EVERY variant, not just
  // the currently-interacted one — otherwise the user can only see
  // the "Frame" name on the variant they're hovering and the others
  // float around unlabelled. Pull the variant viewport list from
  // visibleViewportsAtom (parsed from variantConfig in component
  // master mode) and emit one label per (variant, root) pair.
  const visibleViewports = useAtomValue(visibleViewportsAtom);

  // Filter: canvas-level floaters + (in component master) variant
  // roots. Skip overlay nodes — they're rendered through the overlay
  // portal pipeline and the label would float in dead space.
  //
  // Output shape: `{ id, vpId }` so the same variant-root id can be
  // emitted once per variant viewport. For plain canvas-level nodes
  // there's only one viewport that matters (the interacting one).
  const labeled = useMemo(() => {
    const out: { id: string; vpId: string }[] = [];
    // Dedup `(vpId, nodeId)` pairs — a node that satisfies multiple
    // emission branches (e.g. a canvas-rooted component instance is
    // BOTH a canvas node AND has componentFile) would otherwise get
    // labeled twice and the user sees overlapping name + play
    // button labels at the same position.
    const seen = new Set<string>();
    const push = (id: string, vpId: string): void => {
      const key = `${vpId}:${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      // OFFSCREEN CULL: rect caches now REPLAY culled/offscreen nodes (they
      // used to be simply absent), so without this gate EVERY canvas root on
      // a big page mounts a label component with its own RAF poll — dozens
      // of per-frame polls + React updates for labels nobody can see, plus
      // an unmount/remount storm around every drag. ±200px margin keeps
      // near-edge labels mounted; `cameraKey` in the deps re-runs the filter
      // on pan/zoom. A missing rect keeps the label (the per-label component
      // gates on it anyway — same as before).
      const r = findNodeRect(id, vpId);
      if (r && (r.right < -200 || r.left > window.innerWidth + 200 || r.bottom < -200 || r.top > window.innerHeight + 200)) return;
      out.push({ id, vpId });
    };
    for (const [id, node] of nodes) {
      if ((node as any).isOverlay) continue;
      // Overlay extracted to the canvas (its trigger was dragged out): it's
      // rendered/positioned by the overlay pipeline and only visible in overlay
      // mode — a floating "div" name label over it is just noise. Skip it.
      if (node.attrs?.['data-overlay']) continue;
      if (node.isCanvasNode) {
        push(id, vpId);
        continue;
      }
      if (isComponentFile && !isTemplate && !node.parentId && !node.isCanvasNode) {
        // Variant root: emit once per variant viewport so the name
        // label is visible on every variant card simultaneously.
        // Fall back to the interacting vpId when the visible-viewport
        // list is empty (defensive — shouldn't happen on a master).
        if (visibleViewports.length > 0) {
          for (const vp of visibleViewports) push(id, vp.id);
        } else {
          push(id, vpId);
        }
        continue;
      }
      // No other label emission. Rule: a node only gets a floating
      // name label when it has NO parent (canvas-level floaters and
      // variant roots, handled above). Component instances sitting
      // INSIDE a viewport — even at the top of the page tree —
      // visually have a parent (the viewport / page root) and must
      // stay quiet: the standard play affordance only applies
      // to canvas-rooted instances, which are already covered by
      // the `isCanvasNode` branch above. Nested instances obviously
      // also stay unlabelled.
    }
    return out;
  }, [nodes, isComponentFile, isTemplate, vpId, visibleViewports, cameraKey]);

  // Defensive HMR-cleanup pass — remove any label divs in the document
  // whose key isn't in the current `labeled` set. Vite's hot reload
  // occasionally leaves the previous component's `position: fixed` DOM
  // sibling behind when the JSX shape changes (e.g. when adding the
  // PlayButton next to the name); the new mount paints OVER the old,
  // producing the visible "doubled label" the user reported. Each
  // render runs this pass; orphan divs disappear on the next paint.
  useEffect(() => {
    const validKeys = new Set(labeled.map(({ id, vpId: labelVpId }) => `${labelVpId}:${id}`));
    document.querySelectorAll('[data-canvas-node-label]').forEach((el) => {
      const key = el.getAttribute('data-canvas-node-label');
      if (key && !validKeys.has(key)) {
        // Only remove if this stale node isn't a React-managed mount —
        // React still owns elements whose attribute matches a labeled
        // entry. Stale here means: no React parent, leftover from HMR.
        const reactKey = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
        if (!reactKey) el.remove();
      }
    });
  });

  if (isInteracting) return null;
  if (shapeEditingId) return null;
  if (shapeEditCommitPending) return null;
  // NOTE: the old `if (repositionCommitPending) return null;` latch (hide all
  // labels until Canvas's onRenderComplete) is GONE — it existed to mask the
  // stale `isCanvasNode` cache read on mouseup, but the label set now derives
  // from the LIVE cache (useLiveNodesMap), which is correct at commit time.
  // Keeping it made the label appear ~0.5s late after an unparent (it waited
  // for the deferred render's completion instead of the commit).
  void repositionCommitPending;
  if (sketchEditingId) return null;
  if (labeled.length === 0) return null;

  return (
    <>
      {labeled.map(({ id, vpId: labelVpId }) => (
        <NameDisplay key={`${labelVpId}:${id}`} nodeId={id} vpId={labelVpId} />
      ))}
    </>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function isPureTranslate(transform: string): boolean {
  // A pure translate has matrix(1, 0, 0, 1, tx, ty). Any rotation /
  // scale / skew flips a/b/c/d off [1,0,0,1].
  const m = transform.match(/matrix\(([^)]+)\)/);
  if (!m) return false;
  const v = m[1].split(',').map((s) => parseFloat(s.trim()));
  if (v.length < 4) return false;
  const [a, b, c, d] = v;
  return Math.abs(a - 1) < 0.01 && Math.abs(b) < 0.01 && Math.abs(c) < 0.01 && Math.abs(d - 1) < 0.01;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
