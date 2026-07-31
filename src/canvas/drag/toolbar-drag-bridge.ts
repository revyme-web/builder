// toolbar-drag-bridge.ts — Module-level bridge connecting the insert panel sidebar
// to the canvas DragCoordinator. Same singleton pattern as dropLineOps/parentHighlightOps.

import type { ToolbarItem } from './toolbar-item-config';
import type { DragCoordinator } from './DragCoordinator';
import type { NewNodeDescriptor } from '@/shared/types';
import { trace } from '@/shared/debug-trace';
import { normalizeLayoutDescriptor } from './layout-normalize';

let _coordinator: DragCoordinator | null = null;

/** Called by Canvas.tsx on mount to register the coordinator. */
export function setToolbarDragCoordinator(c: DragCoordinator | null): void {
  _coordinator = c;
  trace.fn('setToolbarDragCoordinator', { hasCoordinator: !!c });
}

/** Called by insert panel GridCard to initiate a toolbar drag. */
export function startToolbarDrag(item: ToolbarItem, event: PointerEvent): void {
  if (!_coordinator) {
    trace.error('startToolbarDrag', 'No coordinator registered');
    return;
  }
  trace.action('toolbar-drag:start', { itemId: item.id, elementType: item.elementType });
  _coordinator.startToolbarDrag(item, event);
}

/** A serializable layout spec a PLUGIN can send over the SDK: a full
 *  NewNodeDescriptor tree (root element + recursive children/text/attrs) plus
 *  a display name and the ghost size to show while dragging. Plain JSON, so it
 *  survives postMessage. */
export interface LayoutDragSpec {
  root: NewNodeDescriptor;
  name?: string;
  ghostSize?: { width: number; height: number };
}

/** Arm the SAME native toolbar drag the Insert panel uses, but from a plugin's
 *  layout tree. The root descriptor becomes the dragged element; its children
 *  are the inner tree the drop builds. `clientX/clientY` are PARENT-frame
 *  coords (the caller translates from the plugin iframe). Once armed, the
 *  DragCoordinator's window pointer listeners take over as the cursor crosses
 *  onto the canvas — full line indicators / reparent / insert, for free. */
export function startLayoutDrag(spec: LayoutDragSpec, clientX: number, clientY: number): void {
  if (!_coordinator) {
    trace.error('startLayoutDrag', 'No coordinator registered');
    return;
  }
  // Make the plugin-supplied tree well-formed + oracle-compliant at the SDK
  // boundary, so ANY plugin (even a naive hand-written one) drops working,
  // editable nodes — the host guarantees the node dialect, not the plugin.
  const root = normalizeLayoutDescriptor(spec.root);
  const kids = root.children;
  const item: ToolbarItem = {
    id: `plugin-layout-${root.id ?? root.tag}`,
    elementType: root.tag,
    name: spec.name ?? root.name,
    defaultStyles: root.styles ?? {},
    defaultAttrs: root.attrs,
    textContent: root.textContent,
    children: kids && kids.length ? () => kids : undefined,
    ghostSize: spec.ghostSize ?? { width: 320, height: 200 },
  };
  trace.action('layout-drag:start', { id: item.id, name: item.name, childCount: kids?.length ?? 0 });
  // Synthesize the initial pointer at the given position; native window
  // listeners drive the rest as the cursor reaches the canvas.
  const ev = new PointerEvent('pointermove', { clientX, clientY, bubbles: true });
  _coordinator.startToolbarDrag(item, ev);
}

/** Feed a pointer MOVE into an armed layout drag. The plugin iframe captures
 *  the mouse for the whole gesture (so the parent window's own pointermove
 *  listeners never fire), so the plugin forwards every move and we drive the
 *  coordinator here. `clientX/clientY` are PARENT-frame coords. */
export function updateLayoutDrag(clientX: number, clientY: number): void {
  if (!_coordinator) return;
  _coordinator.handleMouseMove(new PointerEvent('pointermove', { clientX, clientY, bubbles: true }));
}

/** End an armed layout drag at a final position — the coordinator commits the
 *  drop when it's over a valid target, or cancels when it isn't. */
export function endLayoutDrag(clientX: number, clientY: number): void {
  if (!_coordinator) return;
  trace.action('layout-drag:end', { clientX, clientY });
  _coordinator.handleMouseMove(new PointerEvent('pointermove', { clientX, clientY, bubbles: true }));
  _coordinator.handleMouseUp();
}

/** Cancel an armed layout drag (e.g. Escape, or a release with no valid drop). */
export function cancelLayoutDrag(): void {
  if (!_coordinator) return;
  trace.action('layout-drag:cancel', {});
  _coordinator.cancel();
}

/** Called by parent-frame UI affordances (e.g. CanvasNodeNameDisplay) to
 *  initiate a drag on an EXISTING canvas node — same code-path as a
 *  click-and-drag inside the iframe. The strategy auto-selects based on
 *  the node's position/parent (CanvasDrag for canvas-level floaters,
 *  AbsoluteInFrame / LayoutLifted for nodes inside viewports). */
export function startNodeDrag(nodeId: string, event: MouseEvent | PointerEvent, vpPrefix: string = ''): void {
  if (!_coordinator) {
    trace.error('startNodeDrag', 'No coordinator registered');
    return;
  }
  trace.action('node-drag:start-from-bridge', { nodeId, vpPrefix });
  _coordinator.startPending(nodeId, event as MouseEvent, vpPrefix);
}
