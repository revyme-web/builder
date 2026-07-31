// TransitionVariableEditor.tsx — `variableDefault` mode atom for transition.
//
// Mounted by:
//   1. VariableModal's Default Value field when the user clicks "Create
//      Variable" on the Transition row.
//   2. ComponentPropsTool's prop row when the master file declares a
//      transition-typed prop (so the page-level instance can edit it).
//
// In both contexts we render a COMPACT row — curve icon + summary text —
// with a ToolPopup that hosts the full TransitionPanel. Same shape as the
// VariantTransitionControl in StylesTool, so the user's mental model
// stays consistent: transition UI = curve preview + click to edit.
//
// The string buffer (`externalValue`) carries the transition object as
// JSON. We decode on read, encode on write — the modal/registry plumbing
// is string-only so this is the cleanest interop point.

import { useState, useRef, useMemo, useCallback } from 'react';
import TransitionPanel from '../../AnimationTool/TransitionPanel';
import { summarizeTransition, TransitionCurveIcon } from '../../AnimationTool/CurvePreview';
import ToolPopup from '../../../ui/ToolPopup';
import { ControlActionRow } from '../../../controls';
import { UnifiedControlProvider, ControlRow, useControlContext } from '../../../controls/unified';
import type { AtomProps } from '../../../controls/unified/types';

/**
 * Decode the modal/prop's string buffer into the Record<string, string>
 * shape TransitionPanel expects. Accepts:
 *   - JSON-encoded object: `'{"type":"tween","duration":"0.3"}'`
 *   - Empty / unparseable input: yields an empty object so the panel
 *     defaults to the "Default" preset.
 */
function decode(value: unknown): Record<string, string> {
  if (!value) return {};
  // The Template tool stores a transition as a real OBJECT in its route map (so framer-motion gets an object, not
  // an ignored string) — so `value` may arrive as an object, not a JSON string. Accept BOTH.
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return {}; }
  }
  if (parsed && typeof parsed === 'object') {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      out[k] = String(v);
    }
    return out;
  }
  return {};
}

/** Encode the panel's transition object back to the JSON the buffer stores. */
function encode(transition: Record<string, string>): string {
  return JSON.stringify(transition);
}

function TransitionVariableEditorAtom() {
  const { value, onChange } = useControlContext();
  const [isOpen, setIsOpen] = useState(false);
  const btnRef = useRef<HTMLDivElement>(null);

  const initial = useMemo(() => decode(value || ''), [value]);
  const handleWrite = useCallback((t: Record<string, string>) => {
    onChange(encode(t));
  }, [onChange]);

  const hasTrans = Object.keys(initial).length > 0;
  const summary = hasTrans ? summarizeTransition(initial) : 'Default';
  const isSpring = initial.type === 'spring';

  return (
    <>
      <span ref={btnRef} className="contents">
        <ControlActionRow onClick={() => setIsOpen(true)}>
          <TransitionCurveIcon isSpring={isSpring} />
          <span className="truncate flex-1">{summary}</span>
        </ControlActionRow>
      </span>
      <ToolPopup
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="Transition"
        anchorRef={btnRef}
        width={280}
      >
        {/* The OUTER row label can be hidden (Template tool passes `hideLabel` to suppress its redundant
            "Transition" row label) — but the popup's sub-control labels (Stiffness/Damping/Mass/Delay) are NOT
            redundant and must ALWAYS show. ControlLabel hides on the unified context's hideLabel, and the portal'd
            popup inherits that context — so reset hideLabel=false for the panel. */}
        <UnifiedControlProvider property="transition" defaultValue="" mode="variableDefault" hideLabel={false}>
          <TransitionPanel initialTransition={initial} onWrite={handleWrite} />
        </UnifiedControlProvider>
      </ToolPopup>
    </>
  );
}

export function TransitionVariableEditor({ mode = 'variableDefault', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="transition" defaultValue="" mode={mode} {...mp}>
      {/* ControlRow renders the "Transition" label on the left; the atom
          provides the value column (curve button + popup) on the right.
          Same shape as every other Styles row + ComponentPropsTool prop
          row, so the layout looks consistent. The Default Value section
          inside VariableModal also gets the label, which reads slightly
          redundant against the modal's own "Default Value" header but
          matches the convention every other variable editor follows. */}
      <ControlRow label="Transition">
        <TransitionVariableEditorAtom />
      </ControlRow>
    </UnifiedControlProvider>
  );
}
