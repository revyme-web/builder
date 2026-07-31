// GradientControl.tsx — Granular `background` (gradient) ToolAtom.
//
// Used by the variable-editor registry: when the user creates a Gradient
// variable from the Fill submenu (or edits an existing one in the modal),
// the modal mounts this atom in `variableDefault` mode so they get the full
// GradientEditor — same UI as the Fill popup's Gradient tab.
//
// The atom binds to the `background` CSS property because that's how the
// FillControl writes gradients (`background: linear-gradient(...)`). Image
// fills bind to `backgroundImage` instead — see ImageControl for that.
//
// Stays minimal on purpose: editing the gradient via the modal updates a
// buffer; the actual node application + overlay handling live in FillControl
// where the original full-feature implementation belongs.

import { useRef } from 'react';
import { UnifiedControlProvider, useControlContext, ControlRow } from '../../../controls/unified';
import { ControlActionRow, ColorSwatch } from '../../../controls';
import GradientEditor from '../../../ui/GradientEditor';
import { useEditorPanel } from '../../../hooks/useEditorPanel';
import { createDefaultGradient, formatGradient } from '@/shared/gradient-utils';
import type { AtomProps } from '../../../controls/unified/types';
import { trace } from '@/shared/debug-trace';

// Compact row: swatch + label, clicking opens the GradientEditor in a popup.
// Same shape in every mode; only the label's `plain` flag flips.
function GradientAtom() {
  const { value, onChange } = useControlContext();
  const { openPanel, panelPopup } = useEditorPanel('Gradient', () => (
    <GradientEditor value={editorValue} onChange={onChange} hideOverlay />
  ));
  const rowRef = useRef<HTMLDivElement>(null);

  const css = value || '';
  const isGradient = /^(linear|radial|conic)-gradient/.test(css);
  const editorValue = css || formatGradient(createDefaultGradient());

  const handleClick = () => {
    trace.action('gradient-control:open', { hasValue: isGradient });
    openPanel();
  };

  return (
    <>
      <div ref={rowRef} className="w-full min-w-0">
        <ControlActionRow onClick={handleClick}>
          {isGradient ? (
            <ColorSwatch style={{ background: css }} />
          ) : (
            <ColorSwatch className="bg-[var(--bg-hover)]" />
          )}
          <span className="text-xs text-[var(--text-primary)] truncate flex-1 text-left">
            {isGradient ? 'Gradient' : 'Add gradient'}
          </span>
        </ControlActionRow>
      </div>
      {panelPopup(rowRef)}
    </>
  );
}

export function GradientControl({ mode = 'direct', ...mp }: AtomProps) {
  // Route through the SHARED ControlRow (same as the color/image atoms): the row's
  // variable name + "Gradient" sub-line, the exact same value-column width as every
  // other row, and the chevron / "Set Variable" menu on instance rows. ControlRow's
  // `(plain || !isDirect) && !hoistItem` keeps it plain inside the Variable modal.
  return (
    <UnifiedControlProvider property="background" defaultValue="" mode={mode} {...mp}>
      <ControlRow label="Gradient"><GradientAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}
