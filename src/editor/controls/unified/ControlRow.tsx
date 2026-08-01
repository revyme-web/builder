// ControlRow.tsx — Wraps ToolAtom content with label and binding detection.
// Shows UsedByRow if bound by animation, preset pill if preset ref, or normal control.

import type { ReactNode } from 'react';
import ControlLabel from '../ControlLabel';
import { useControlContext } from './useControlContext';
import { UsedByRow } from './UsedByRow';
import { VariableBoundPill } from '../VariableBoundPill';
import { useHoistMenuItem } from '../hoist-context';
import { useLabelOverride } from '../label-override-context';

interface ControlRowProps {
  label: string;
  children: ReactNode;
  /** If true, render a plain label without variable/override menu */
  plain?: boolean;
}

/** Format a token name for display: "color-brand-light" → "Brand Light" */
function formatPresetLabel(name: string): string {
  // Strip common prefixes
  let display = name;
  for (const prefix of ['color-', 'typo-', 'space-', 'radius-', 'shadow-']) {
    if (display.startsWith(prefix)) { display = display.slice(prefix.length); break; }
  }
  return display.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Wraps atom content: label on left, control on right. Shows UsedByRow if bound, preset pill if preset ref. */
export function ControlRow({ label, children, plain }: ControlRowProps) {
  const { property, binding, mode, onChange, hasVariable, hideLabel } = useControlContext();

  // hideLabel (variableDefault mounts inside popups/modals): render the
  // control FULL-WIDTH — keeping the two-column grid left a 110px empty
  // label track and collapsed compound editors (the padding cluster in the
  // Localize popup) to a sliver.
  if (hideLabel) {
    return <div data-tool-row className="w-full">{children}</div>;
  }

  // In non-direct modes, always render the control
  // In direct/htmlAttr mode, check if bound by animation/scroll/variable
  const isDirect = mode === 'direct' || mode === 'htmlAttr';
  const showUsedBy = isDirect && binding.bound;
  // Preset: show accent pill with name + × to remove
  const showPresetPill = isDirect && !binding.bound && !!binding.presetRef;
  // Variable: show purple pill with var name + × to remove. Variable binding
  // takes precedence over the editor children but NOT over animation binding —
  // an animation-driven property shouldn't have a variable, but if both fire
  // we still want the user to see the live animation source.
  const showVariablePill = isDirect && !binding.bound && !showPresetPill && hasVariable;

  // When an ambient `HoistMenuItemProvider` is set above us (component-
  // props tool, instance-prop row), force the label into non-plain mode
  // so the chevron renders and our hoist menu item is reachable. Without
  // this override, `variableDefault` mode (the path most nested-instance
  // prop rows take) sets `plain={true}` and ControlLabel short-circuits
  // before computing the menu items — visible symptom: no chevron on the
  // `Background` / `Padding` etc. labels in the user's properties panel.
  const hoistItem = useHoistMenuItem();
  const isPlain = (plain || !isDirect) && !hoistItem;

  // ComponentPropsTool's per-prop wrap sets the row's user-given name as
  // the primary label and demotes the atom's own hardcoded label to the
  // sub-line. Outside the provider this is null and ControlLabel renders
  // normally with the atom's own `label` prop.
  const labelOverride = useLabelOverride();
  const effectiveLabel = labelOverride?.label ?? label;
  const effectiveSubLabel = labelOverride?.subLabel;

  return (
    <div data-tool-row className="grid grid-cols-[var(--tool-label-col)_minmax(0,1fr)] items-center w-full">
      <ControlLabel
        label={effectiveLabel}
        property={property}
        cell
        plain={isPlain && !labelOverride?.overridden}
        subLabel={effectiveSubLabel}
        overridden={labelOverride?.overridden}
        onResetOverride={labelOverride?.onResetOverride}
      />
      <div data-tool-row-value className="flex items-center gap-2 w-full min-w-0">
      {showUsedBy ? (
        <UsedByRow binding={binding} />
      ) : showPresetPill ? (
        <button
          className="w-full h-8 flex items-center justify-between px-2 bg-[var(--accent)] rounded-[var(--radius-lg)] text-xs font-medium text-[var(--accent-fg)] cursor-pointer transition-colors hover:opacity-90 truncate"
          onClick={() => onChange('')}
          title={`Preset: ${binding.presetRef} — click to remove`}
        >
          <span className="truncate">{formatPresetLabel(binding.presetRef!)}</span>
          <span className="ml-1 text-white/70 hover:text-white text-sm">×</span>
        </button>
      ) : showVariablePill ? (
        <VariableBoundPill propertyLabel={label} />
      ) : children}
      </div>
    </div>
  );
}
