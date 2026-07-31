// insertion-bridge.ts — One pipe for "drop this thing onto the canvas
// at the smart location."
//
// The paste rule engine (`src/code/features/paste-engine/paste`) is
// the single source of truth for where a new node should land
// relative to the current selection: absolute-in-frame sibling, flex
// child of selected layout, canvas-node next to selected canvas node,
// or visible-center fallback. Until now, only Ctrl+V went through it.
//
// This bridge lets the cmd+K palette, the library drag drop, and
// future template/template drop call sites all reuse the same rules.
// Build a `ClipboardNode` for the thing you're inserting, hand it to
// `insertNodes()`, and the engine routes it the same way it routes a
// real paste.
//
// Canvas.tsx publishes live refs via `setInsertionRefs(...)` at mount
// (same pattern as canvas-commands-bridge). Calls before mount trace
// + no-op rather than throwing — but in practice Canvas mounts before
// any UI surface that could trigger an insert.

import { getDefaultStore } from 'jotai';
import { selectedIdsAtom, nodesAtom } from '@/code/stores/store';
import { interactingViewportIdAtom, viewportWidthsAtom } from '@/code/stores/viewport-store';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { transformManager } from '@/canvas/transform';
import { executePaste } from '@/code/features/paste-engine/paste';
import { generateNodeId } from '@/shared/id-utils';
import { getComponentRootSize } from '@/code/components/component-registry';
import { projectFS } from '@/code/project/project-fs';
import type { ClipboardNode, ClipboardData } from '@/code/features/paste-engine/types';
import { trace } from '@/shared/debug-trace';

export interface InsertionRefs {
  /** Set by Canvas.tsx so insertNodes can re-bind the
   *  selection-mutation hook on the resulting node ids. */
  setSelectedIds: (ids: string[]) => void;
}

let _refs: InsertionRefs | null = null;

export function setInsertionRefs(refs: InsertionRefs | null): void {
  _refs = refs;
  trace.fn('insertion-bridge:set', { hasRefs: !!refs });
}

const store = getDefaultStore();

/** Visible canvas viewport rect, used by the paste engine's
 *  'visible-center' positioning fallback. Same `[data-canvas-viewport]`
 *  query the paste flow uses for its container size — keeps the two
 *  paths in lockstep. */
function getCanvasContainerSize(): { width: number; height: number } | null {
  const el = document.querySelector('[data-canvas-viewport]') as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { width: r.width, height: r.height };
}

export interface InsertOptions {
  /** Force the new node to drop into this parent at this index. Used
   *  when the call site already knows the target (template drop on a
   *  specific frame, etc.). Leave undefined for selection-based
   *  routing through the paste rules. */
  forceInsertIndex?: number;
  /** Pre-computed canvas coordinates for free-floating placements.
   *  When omitted the engine falls back to 'visible-center'. */
  forcePosition?: { x: number; y: number };
  forceNoLayoutPosition?: { x: number; y: number };
}

/**
 * Insert one or more nodes onto the canvas at the right place, using
 * the same rule engine that handles `Ctrl+V`. Returns the created
 * root ids so the caller can select them afterwards.
 *
 * The `nodes` array is a flat list (same shape as `ClipboardData.nodes`):
 * include the root + every descendant the root references via
 * `children`. Single-node inserts pass `[root]`.
 */
export function insertNodes(nodes: ClipboardNode[], opts: InsertOptions = {}): string[] {
  if (nodes.length === 0) return [];
  const overrideClipboard: ClipboardData = {
    version: 1,
    timestamp: Date.now(),
    nodes,
  };

  const selectedIds = store.get(selectedIdsAtom);
  const liveNodes = store.get(nodesAtom);
  const interactingVpId = store.get(interactingViewportIdAtom);
  const viewportWidths = store.get(viewportWidthsAtom);
  const activeFilePath = store.get(activeFilePathAtom);
  const transform = transformManager.getTransform();
  const container = getCanvasContainerSize();

  const result = executePaste({
    selectedIds,
    nodes: liveNodes,
    transform,
    containerWidth: container?.width,
    containerHeight: container?.height,
    forceInsertIndex: opts.forceInsertIndex,
    forcePosition: opts.forcePosition,
    forceNoLayoutPosition: opts.forceNoLayoutPosition,
    interactingVpId,
    viewportWidths,
    activeFilePath,
    overrideClipboard,
  });

  if (!result.success) {
    trace.error('insertion-bridge:failed', { message: result.message });
    return [];
  }
  if (_refs && result.createdIds.length > 0) {
    _refs.setSelectedIds(result.createdIds);
  }
  trace.action('insertion-bridge:insert', {
    count: result.createdIds.length,
    rule: result.message,
  });
  return result.createdIds;
}

// ─── ClipboardNode builders ─────────────────────────────────────────────────
// Helpers for the common shapes call sites need to insert. Each
// produces a flat `ClipboardNode[]` (root + descendants) suitable for
// `insertNodes(...)`.

/**
 * Build a single-node ClipboardNode array for a component / icon-set /
 * vector instance. The renderer resolves the master's
 * children at render time, so the clipboard payload is just the
 * instance tag (a leaf node with `type` set to the internal name and
 * `componentFile` pointing at the master).
 *
 * `filePath` controls the kind of master:
 *   - `components/X.tsx`  → design component instance
 *   - `icons/X.tsx`       → icon-set instance (auto-adds `name="icon-1"`)
 *   - `vectors/X.tsx`     → local vector instance
 *
 * `elementType` is the JSX tag (component internal name) — same string
 * the LibraryPanel drag uses. The instance tag's `data-name` becomes
 * `elementType` so the layers panel shows a friendly label.
 */
export function buildInstanceClipboardNode(
  filePath: string,
  elementType: string,
): ClipboardNode[] {
  const isIcon = filePath.startsWith('icons/');
  const isVector = filePath.startsWith('vectors/');
  // Icon instances need a `name` attr or the master renders
  // the full grid view instead of a single variant — same logic
  // useComponentDrag uses for the drag-from-library flow.
  const attrs: Record<string, string> = {};
  if (isIcon) attrs.name = 'icon-1';

  const isSquare = isIcon;
  // A DESIGN component (components/) is everything that isn't an icon
  // set or a local vector — it inherits the master ROOT's authored width/height
  // (the PRIMARY variant's dimensions) so the instance matches the master.
  // Mirrors `useComponentDrag`'s design-component branch.
  const isDesignComponent = !isIcon && !isVector;
  const rootSize = isDesignComponent ? getComponentRootSize(projectFS.readFile(filePath) ?? '') : {};
  const id = generateNodeId(isSquare ? 'icon' : 'component');

  return [{
    id,
    type: elementType,
    parentId: null,
    children: [],
    order: 0,
    name: elementType,
    styles: {
      position: 'relative',
      // Instance sizing — matches `useComponentDrag` defaults.
      // Icon sets render square; local vectors render a 300×120
      // placeholder; DESIGN components take the master root's primary-variant
      // width/height. All get `flex: 0 0 auto` so they don't collapse in flex.
      ...(isDesignComponent ? rootSize : {
        width: isSquare ? '240px' : '300px',
        height: isSquare ? '240px' : (isVector ? '120px' : '200px'),
      }),
      flex: '0 0 auto',
    },
    attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
    componentFile: filePath,
  }];
}

/**
 * Build a single-node ClipboardNode array for a raw SVG insertion
 * (Iconify search results). The renderer treats `textContent` as
 * inner SVG markup when the node's `type` is `svg`.
 *
 * `viewBox` and `inner` come from the fetched SVG; `name` is what
 * appears in the layers panel.
 */
export function buildSvgClipboardNode(opts: {
  name: string;
  viewBox: string;
  inner: string;
  size?: number;
}): ClipboardNode[] {
  const size = opts.size ?? 48;
  return [{
    id: generateNodeId('icon'),
    type: 'svg',
    parentId: null,
    children: [],
    order: 0,
    name: opts.name,
    styles: {
      position: 'relative',
      width: `${size}px`,
      height: `${size}px`,
      color: 'currentColor',
      display: 'block',
      flex: '0 0 auto',
    },
    attrs: {
      viewBox: opts.viewBox,
      xmlns: 'http://www.w3.org/2000/svg',
    },
    textContent: opts.inner,
    hasMixedContent: true,
  }];
}
