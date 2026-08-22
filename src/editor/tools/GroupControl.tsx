// GroupControl.tsx — Properties-panel control for a code-component `group`.
//
// A `group` control (`@controls` type "group") is a button showing a summary
// that opens a ToolPopup containing NESTED controls. The nested controls are
// ordinary flat props on the component — the group only organises them in the
// UI (standard: "Arrows", "Dots", "Effects" popups). The actual control
// rendering is delegated back to ComponentPropsTool's `renderControl` so every
// control type (slider/color/select/…/group again) works inside the popup.

import { useState, useRef } from 'react';
import { ToolRow } from '../controls';
import ToolPopup from '../ui/ToolPopup';
import type { ComponentControlDef } from '@/code/components/controls-parser';
import { trace } from '@/shared/debug-trace';

interface GroupControlProps {
  label: string;
  /** The nested controls, keyed by their (flat) prop name. */
  controls: Record<string, ComponentControlDef>;
  /** Delegated control renderer from ComponentPropsTool. */
  renderControl: (propName: string, def: ComponentControlDef) => React.ReactNode;
}

export default function GroupControl({ label, controls, renderControl }: GroupControlProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const entries = Object.entries(controls);

  trace.fn('GroupControl:render', { label, count: entries.length, open });

  return (
    <ToolRow label={label}>
      <button
        ref={btnRef}
        onClick={() => setOpen(o => !o)}
        className="w-full h-[var(--control-height-sm)] px-2 flex items-center gap-1.5 text-xs cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] bg-[var(--control-bg)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] hover:border-[var(--control-border-hover)] text-[var(--text-primary)] transition-colors"
      >
        <span className="text-[var(--accent-text)] text-[13px] leading-none tracking-tighter">•••</span>
        <span className="flex-1 text-left text-[var(--text-tertiary)]">
          {entries.length} setting{entries.length === 1 ? '' : 's'}
        </span>
      </button>

      <ToolPopup isOpen={open} onClose={() => setOpen(false)} title={label} anchorRef={btnRef}>
        {/* No padding wrapper — ToolPopup already wraps children in
            `px-3 pb-3 pt-1` + `gap-3.5` (same as the normal CSS-control
            popups). A second wrapper would double-pad. */}
        {entries.map(([propName, def]) => renderControl(propName, def))}
      </ToolPopup>
    </ToolRow>
  );
}
