// VariableModalHost.tsx — Single, app-stable mount point for the variable manage modal.
//
// WHY THIS EXISTS: the "Create Variable" flow lives inside a ControlLabel's chevron menu, but compound
// controls (Shadow/Fill/Border) re-render into a SEPARATE ControlLabel the instant a variable is bound,
// unmounting the one that initiated creation. If the modal's open-state lived on that ControlLabel it
// would be torn down before it could render (the user sees the variable created but no modal). By driving
// the modal from a global atom (`variableModalRequestAtom`) and rendering ONE instance here — mounted high
// in PropertiesPanel, which survives the control re-render — the modal opens reliably for every control.

import { useAtom } from 'jotai';
import { variableModalRequestAtom } from '@/code/stores/store';
import { getLayoutForPage, getLayoutClientPath } from '@/code/project/active-file-store';
import { getActiveFilePath } from '@/canvas/node-ops';
import VariableModal from './VariableModal';
import { useVariablePreview } from '@/editor/hooks/useVariablePreview';
import { trace } from '@/shared/debug-trace';

export function VariableModalHost() {
  const [req, setReq] = useAtom(variableModalRequestAtom);
  // LIVE imperative preview of the edited variable's value while dragging the Default control (color/border
  // width/…), so the variable modal's drag is as smooth as the Template tool — no code-write-per-frame. Use
  // the active page's TEMPLATE client (where hoisted instance bindings live), falling back to the active file
  // itself (editing a template/component directly). Hook is memoised; cheap when the modal is closed.
  const activeFile = getActiveFilePath();
  const layoutPath = getLayoutForPage(activeFile);
  const previewClientPath = (layoutPath ? getLayoutClientPath(layoutPath) : null) ?? activeFile;
  const { previewVar } = useVariablePreview(previewClientPath);
  trace.fn('VariableModalHost:render', { open: !!req, ref: req?.variableRef });
  return (
    <VariableModal
      isOpen={!!req}
      onClose={() => setReq(null)}
      property={req?.property ?? ''}
      propertyLabel={req?.propertyLabel ?? ''}
      currentValue={req?.currentValue ?? ''}
      currentVariableRef={req?.variableRef}
      nameEditable={req?.nameEditable}
      onPreviewLive={previewVar}
    />
  );
}
