// ShapeEditOverlayHost.tsx — Stable wrapper that mounts the SVG path
// editor overlay whenever shape-edit mode is active on the selected
// node. Hoisted out of SelectionOverlay (which has many conditional
// return paths) so the mount position is invariant — React keeps the
// same instance across isInteracting flips, hover changes, pan mode,
// etc. Without this, the JSX position of <SvgEditorOverlay/> changed
// between SelectionOverlay's branches and React unmounted + remounted
// it, firing commitShapeEdit on unmount and dropping the editor's
// selection on remount → setShapeEditAnchorPosition saw no selected
// anchor → Position chevron drag froze after one tick.

import { useAtomValue } from 'jotai';
import { selectedNodeAtom } from '@/code/stores/store';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { shapeEditingIdAtom } from '@/code/stores/shape-edit-store';
import SvgEditorOverlay from './SvgEditorOverlay';

export default function ShapeEditOverlayHost() {
  const shapeEditingId = useAtomValue(shapeEditingIdAtom);
  const selectedId = useAtomValue(selectedNodeAtom);
  const vpId = useAtomValue(interactingViewportIdAtom);
  if (!shapeEditingId || selectedId !== shapeEditingId) return null;
  return <SvgEditorOverlay nodeId={shapeEditingId} vpId={vpId} />;
}
