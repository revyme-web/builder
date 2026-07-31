// SingleEntryRow — the shared single-value compound-control row skeleton.
//
// Border / Filter / Clip Path / Pseudo previously each hand-rolled the same
// row: label + full-width action button that shows either the value preview
// (+ optional remove ×) or the greyed empty-icon + "Add" state, and opens
// the control's editor on click. Remove semantics stay at the call site —
// each control's × clears something different (whole border, non-shadow
// filter functions, clip-path + overlay, one pseudo element).
//
// Sits on the shared control-row GRID primitive (label track sized by
// --tool-label-col, value cell = the remainder) — NOT the legacy
// `flex justify-between` layout. `ControlLabel cell` opts the label into
// the grid geometry.

import React from 'react';
import ControlLabel from './ControlLabel';
import { ControlActionRow } from './ControlActionRow';
import { RemoveButton } from './RemoveButton';

interface SingleEntryRowProps {
  /** ControlLabel props — forwarded verbatim. */
  label: string;
  property: string;
  plain?: boolean;
  subLabel?: string;
  /** Whether the control currently has a value (preview vs "Add" state). */
  hasValue: boolean;
  /** Opens the control's editor (popup / pushPanel). */
  onOpen: () => void;
  /** Filled-state content: preview swatch/summary spans. */
  renderPreview: () => React.ReactNode;
  /** When provided, renders the remove × after the preview. Receives the
   *  click event (RemoveButton stops propagation itself). */
  onRemove?: (e: React.MouseEvent) => void;
  /** Greyed icon for the empty "Add" state. */
  EmptyIcon: React.FC<React.SVGProps<SVGSVGElement> & { bg?: string; iconColor?: string }>;
  /** Popup anchor — wraps the action row in a display-contents span. */
  anchorRef?: React.RefObject<HTMLElement | null>;
}

export function SingleEntryRow({
  label,
  property,
  plain,
  subLabel,
  hasValue,
  onOpen,
  renderPreview,
  onRemove,
  EmptyIcon,
  anchorRef,
}: SingleEntryRowProps) {
  const row = (
    <ControlActionRow onClick={onOpen}>
      {hasValue ? (
        <>
          {renderPreview()}
          {onRemove && <RemoveButton onClick={onRemove} />}
        </>
      ) : (<>
        <EmptyIcon width={20} height={20} bg="var(--control-border)" className="shrink-0 opacity-50" />
        <span className="text-[var(--text-secondary)]">Add</span>
      </>)}
    </ControlActionRow>
  );

  return (
    <div data-tool-row className="grid grid-cols-[var(--tool-label-col)_minmax(0,1fr)] items-center w-full">
      <ControlLabel label={label} property={property} plain={plain} subLabel={subLabel} cell />
      <div data-tool-row-value className="flex items-center gap-2 w-full min-w-0">
        {anchorRef
          ? <span ref={anchorRef as React.RefObject<HTMLSpanElement | null>} className="contents">{row}</span>
          : row}
      </div>
    </div>
  );
}

