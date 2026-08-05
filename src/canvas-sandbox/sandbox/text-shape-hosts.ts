// text-shape-hosts.ts — sandbox API delegations into the text-edit and
// shape-edit hosts. Extracted verbatim from bridge-sandbox.ts (Phase 7 split).

import type { TextEditCommand } from '../sandbox-api';
import {
  startTextEdit as startTextEditImpl,
  commitTextEdit as commitTextEditImpl,
  cancelTextEdit as cancelTextEditImpl,
  runEditorCommand as runEditorCommandImpl,
} from '../text-edit-host';
import {
  startShapeEdit as startShapeEditImpl,
  commitShapeEdit as commitShapeEditImpl,
  cancelShapeEdit as cancelShapeEditImpl,
  setShapeEditHandleMode as setShapeEditHandleModeImpl,
  setShapeEditAnchorPosition as setShapeEditAnchorPositionImpl,
} from '../shape-edit-host';

  // ─── Text editing — TipTap mounts directly on the canvas element ───────
  // NOTE: this delegation must stay ARITY-COMPLETE with text-edit-host's
  // signature. A fixed 4-arg version silently DROPPED `syncExcludeVpIds`
  // (the parent's trace showed the list, the sandbox received []) — the
  // live keystroke mirror kept overwriting variant tiles with their own
  // text overrides even though both endpoints were correct (2026-08-05).
export function startTextEdit(nodeId: string, vpPrefix: string, initialHtml?: string, isResponsive?: boolean, syncExcludeVpIds?: string[]): void {
    startTextEditImpl(nodeId, vpPrefix, initialHtml, isResponsive, syncExcludeVpIds);
}
export function commitTextEdit(): { html: string } {
    return commitTextEditImpl();
}
export function cancelTextEdit(): void {
    cancelTextEditImpl();
}
export function editorCommand(command: TextEditCommand): void {
    runEditorCommandImpl(command);
}

  // ─── Shape editing — SvgPathEditor mounts directly on the SVG element ──
export function startShapeEdit(nodeId: string, vpPrefix: string, pen?: boolean): void {
    startShapeEditImpl(nodeId, vpPrefix, pen);
}
export function commitShapeEdit() {
    return commitShapeEditImpl();
}
export function cancelShapeEdit(): void {
    cancelShapeEditImpl();
}
export function setShapeEditHandleMode(mode: 'straight' | 'mirrored' | 'disconnected'): void {
    setShapeEditHandleModeImpl(mode);
}
export function setShapeEditAnchorPosition(x: number, y: number): void {
    setShapeEditAnchorPositionImpl(x, y);
}
