// EntryList.tsx — Shared multi-entry list UI for ShadowControl, MaskControl, etc.
// Renders: first entry row with ControlLabel, additional entry rows with spacer,
// "Add..." row, and empty-state "Add" button.

import React from 'react';
import ControlLabel from './ControlLabel';
import { ControlActionRow } from './ControlActionRow';
import { RemoveButton } from './RemoveButton';
import { ColorSwatch } from './ColorSwatch';
import { useOverriddenLabel } from './label-override-context';
import { useControlContextOptional } from './unified/useControlContext';
import { trace } from '@/shared/debug-trace';

interface EntryListProps<T extends { id: string }> {
  /** ControlLabel text (e.g., "Shadow", "Mask") */
  label: string;
  /** CSS property for ControlLabel (e.g., "boxShadow", "mask") */
  property: string;
  /** Current entries to display */
  entries: T[];
  /** Called when user clicks an entry row to open editor */
  onEdit: (index: number) => void;
  /** Called when user clicks the remove button on an entry */
  onRemove: (index: number) => void;
  /** Called when user clicks "Add" (empty state) or "Add..." (existing entries) */
  onAdd: () => void;
  /** Return CSSProperties for the ColorSwatch of an entry */
  renderSwatch: (entry: T) => React.CSSProperties;
  /** Optional: render a custom icon (e.g. a glyph swatch) INSTEAD of the plain
   *  ColorSwatch. Called with the entry for filled rows, and `null` for the
   *  empty / "Add…" rows. When omitted, the ColorSwatch is used. */
  renderIcon?: (entry: T | null) => React.ReactNode;
  /** Return display label text for an entry */
  renderLabel: (entry: T) => string;
  /** Ref forwarded to the first row (for popup anchoring) — always in DOM */
  addButtonRef?: React.RefObject<HTMLElement | null>;
  /** When true, hide additional entries and "Add..." row (only show first entry) */
  singleOnly?: boolean;
  /** Icon component to show in grayed-out state when no entries */
  EmptyIcon?: React.FC<React.SVGProps<SVGSVGElement> & { bg?: string; iconColor?: string }>;
  /** When true, render the label as a plain non-interactive text (no menu,
   *  no chevron, no variable/preset/locale ops). Use when the surrounding
   *  context is a preset editor — there's no node to navigate to. */
  nonInteractive?: boolean;
  /** Force the LABEL to plain mode independently of `nonInteractive`. Used by
   *  the variable / instance-prop context (mode !== 'direct') so the label
   *  column matches the other atoms (plain, with the 2px shim, no chevron). */
  plainLabel?: boolean;
  /** Mark the label as overridden (accent) + provide a Reset Override handler —
   *  forwarded to the ControlLabel (e.g. a per-viewport/variant Collection List edit). */
  overridden?: boolean;
  onResetOverride?: () => void;
  /** Extra classes on each value-row ControlActionRow (e.g. `!pr-2 min-w-0` so the ×
   *  + box width match sibling rows like Filters/Pagination). */
  rowClassName?: string;
  /** Text for the empty "Add" row (default "Add"; pass "Add…" to match Filters/Pagination). */
  addLabel?: string;
  /** Optional control rendered in the HEADER row's value slot (to the right of
   *  the label) INSTEAD of the first entry. When provided, ALL entries render on
   *  their own rows below the header (none share the label row), and the "Add…"
   *  row always shows so an empty list can still grow. Used by MaskControl to put
   *  the Preset select on the "Mask" header row. */
  headerAccessory?: React.ReactNode;
}

export function EntryList<T extends { id: string }>({
  label,
  property,
  entries,
  onEdit,
  onRemove,
  onAdd,
  renderSwatch,
  renderIcon,
  renderLabel,
  addButtonRef,
  singleOnly,
  EmptyIcon,
  nonInteractive,
  plainLabel,
  overridden,
  onResetOverride,
  rowClassName,
  addLabel,
  headerAccessory,
}: EntryListProps<T>) {
  trace.fn('EntryList:render', { label, entryCount: entries.length, singleOnly, nonInteractive });

  // On a component-instance prop row the variable name overrides the atom's
  // own label (e.g. "Shadow"/"Mask") and demotes it to the sub-line.
  const { label: ovLabel, subLabel: ovSubLabel } = useOverriddenLabel(label);

  // Variable modal's Default row hides the label (ControlLabel returns null). The first-row label and
  // the additional-row / Add-row SPACER spans must vanish together, else the extra rows stay indented
  // by the spacer while the first row's control sits flush-left — visible misalignment.
  const hideLabel = useControlContextOptional()?.hideLabel ?? false;

  // When a header accessory is present it OWNS the header value slot, so the
  // first entry no longer shares the label row — every entry renders below.
  const hasAccessory = headerAccessory !== undefined;
  const belowEntries = hasAccessory
    ? entries.map((entry, i) => ({ entry, idx: i }))
    : entries.slice(1).map((entry, i) => ({ entry, idx: i + 1 }));

  return (
    <>
      {/* First entry, Add button, or header accessory — same row as label. Ref is always attached for popup anchoring. */}
      <div ref={addButtonRef as React.RefObject<HTMLDivElement>} className="flex items-center justify-between w-full">
        <ControlLabel label={ovLabel} property={property} plain={nonInteractive || plainLabel} subLabel={ovSubLabel} overridden={overridden} onResetOverride={onResetOverride} />
        {hasAccessory ? (
          headerAccessory
        ) : entries.length > 0 ? (
          <ControlActionRow onClick={() => onEdit(0)} className={rowClassName}>
            {renderIcon ? renderIcon(entries[0]) : <ColorSwatch style={renderSwatch(entries[0])} />}
            <span className="flex-1 text-xs text-[var(--text-primary)] truncate text-left">
              {renderLabel(entries[0])}
            </span>
            <RemoveButton onClick={() => onRemove(0)} />
          </ControlActionRow>
        ) : (
          <ControlActionRow onClick={onAdd} className={rowClassName}>
            {renderIcon ? renderIcon(null) : (EmptyIcon && <EmptyIcon width={20} height={20} bg="var(--control-border)" className="shrink-0 opacity-50" />)}
            <span className="flex-1 min-w-0 text-xs text-[var(--text-secondary)] text-left truncate">{addLabel ?? 'Add'}</span>
          </ControlActionRow>
        )}
      </div>

      {/* Additional entries (2nd+).
          The spacer must consume the EXACT same flex space as the
          first-row ControlLabel — otherwise the value buttons drift
          out of alignment with the original. The trick is two-fold:
          1. Same width / padding / negative-margin classes as the
             non-plain ControlLabel (`w-3/4 pl-[18px] -ml-[18px]`).
          2. Render the label text with `invisible` so the spacer's
             intrinsic min-width matches the real label's. An empty
             `<span>` has min-width 0, which lets flex shrink it below
             the label's content min-width — and the difference shows
             up as the extra rows being ~2-18 px WIDER than the
             original (user-reported bug: 2nd shadow + "Add..." rows
             extended past the first shadow's right edge). With the
             invisible label text, the spacer can't shrink any more
             than the real label and the right edges line up. */}
      {!singleOnly && belowEntries.map(({ entry, idx }) => (
        <div key={entry.id} className="flex items-center justify-between w-full">
          {!hideLabel && (
            <span className="w-3/4 text-xs font-bold select-none pl-[18px] -ml-[18px] invisible" aria-hidden>
              {label}
            </span>
          )}
          <ControlActionRow onClick={() => onEdit(idx)} className={rowClassName}>
            {renderIcon ? renderIcon(entry) : <ColorSwatch style={renderSwatch(entry)} />}
            <span className="flex-1 text-xs text-[var(--text-primary)] truncate text-left">
              {renderLabel(entry)}
            </span>
            <RemoveButton onClick={() => onRemove(idx)} />
          </ControlActionRow>
        </div>
      ))}

      {/* Add more button — when there's already an entry, or a header accessory
          owns the header row (so an empty accessory list can still grow). */}
      {!singleOnly && (entries.length > 0 || hasAccessory) && (
        <div className="flex items-center justify-between w-full">
          {!hideLabel && (
            <span className="w-3/4 text-xs font-bold select-none pl-[18px] -ml-[18px] invisible" aria-hidden>
              {label}
            </span>
          )}
          <ControlActionRow onClick={onAdd}>
            {renderIcon ? renderIcon(null) : <ColorSwatch className="bg-[var(--bg-hover)]" />}
            <span className="text-xs text-[var(--text-secondary)]">Add...</span>
          </ControlActionRow>
        </div>
      )}
    </>
  );
}

export default EntryList;
