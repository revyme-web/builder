// useEditorPanel.tsx — pushPanel-if-nested-else-own-ToolPopup routing.
//
// The canonical branch shared by the compound StylesTool atoms (Border /
// Clip Path / Fill / Filter / Gradient / Image / Mask / Shadow): when the
// control renders INSIDE a ToolPopup (variable modal, Fill popup, …) its
// editor opens as a sliding panel via `pushPanel`; standalone in the
// properties panel it opens the control's own anchored ToolPopup.

import { useState, type ReactNode, type RefObject } from 'react';
import ToolPopup, { useToolPopupOptional } from '../ui/ToolPopup';

export function useEditorPanel(
  title: string,
  render: () => ReactNode,
  options?: { width?: number },
) {
  const parentPopup = useToolPopupOptional();
  const [isOpen, setIsOpen] = useState(false);

  /** Open the editor. Optional `content` overrides `render()` in the
   *  pushPanel branch only — for controls that must bake click-time-fresh
   *  data into the pushed panel (state set in the same handler isn't
   *  committed yet). The own-popup branch always renders `render()` live. */
  const openPanel = (content?: ReactNode) => {
    if (parentPopup) {
      parentPopup.pushPanel(title, content ?? render());
    } else {
      setIsOpen(true);
    }
  };

  /** The control's own anchored ToolPopup — render at the end of the
   *  control's fragment; renders nothing when nested (the parent popup
   *  hosts the panel instead). */
  const panelPopup = (anchorRef: RefObject<HTMLElement | null>): ReactNode => (
    !parentPopup && (
      <ToolPopup isOpen={isOpen} onClose={() => setIsOpen(false)} title={title} anchorRef={anchorRef} width={options?.width}>
        {render()}
      </ToolPopup>
    )
  );

  return { parentPopup, isOpen, setIsOpen, openPanel, panelPopup };
}
