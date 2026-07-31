// VariableBoundPill.tsx — Value-column pill shown when a property is bound to
// a component variable (prop). Replaces the atom's normal editor in that
// case, since rendering the raw `var:propName` value through Shadow/Fill/etc.
// parsers produces broken UI ("Add" buttons, empty entries, garbled previews).
//
// Click body → open VariableModal in view mode (rename / edit default / etc.)
// Click × → remove the binding.
//
// Two surfaces:
//   - `<VariableBoundPill propertyLabel=...>` — pulls binding info from the
//     unified `useControlContext()`. Used by atoms on the unified provider.
//   - `<LegacyVariableBoundPill property=... variableRef=... currentValue=...
//     removeVariable=... />` — explicit-prop variant for atoms still on the
//     legacy `useControl()` provider (ContentControl, TextColorControl).
//
// Both wrap a shared presentational `VariableBoundPillView` so the pixel
// design stays in one place.

import { useState, useCallback, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { isComponentFileAtom } from '@/code/stores/store';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { getPropLabel, getPropType } from '@/code/components/prop-meta';
import { useControlContext } from './unified/useControlContext';
import { getVariableType } from './variable-types';
import VariableModal from '../ui/VariableModal';
import { VariableTypeIcon, resolveVariableIconKey, type VariableIconKey } from './VariableTypeIcon';
import { trace } from '@/shared/debug-trace';

// ─── Presentational view ──────────────────────────────────────────────────

interface VariableBoundPillViewProps {
  property: string;
  propertyLabel: string;
  variableRef: string;
  currentValue: string;
  /** Called when user clicks ×. `(name, defaultValueToRestore) => void`. */
  onRemove: (name: string, defaultValue: string) => void;
  /** Explicit type glyph. When the binding isn't a CSS style (e.g. a code-component @control whose
   *  `property` is the prop name, not a CSS prop), the value/property can't reveal the data type — the
   *  caller knows it from the control's declared type and passes it here so we show #/color/toggle/…
   *  instead of the generic cube. Falls back to value/property inference when omitted. */
  iconKey?: VariableIconKey;
}

function VariableBoundPillView({
  property, propertyLabel, variableRef, currentValue, onRemove, iconKey,
}: VariableBoundPillViewProps) {
  const [modalOpen, setModalOpen] = useState(false);
  // Variables on component master files are visually distinct (purple) so the
  // user knows they're editing a component prop. On regular pages there's no
  // such two-context model — the binding is just a page variable, so we use
  // the standard accent (blue).
  const isComponentFile = useAtomValue(isComponentFileAtom);
  const pillBg = isComponentFile ? 'var(--accent-secondary)' : 'var(--accent)';

  // Show the variable's friendly LABEL (from @propMeta), not the raw camelCase prop id — and keep it in
  // sync when renamed in the modal (re-reads on every projectVersion bump). Page variables (non-component
  // context) have no @propMeta label, so they fall back to the ref name.
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const labelProjectVersion = useAtomValue(projectVersionAtom);
  const displayName = useMemo(
    () => (isComponentFile ? (getPropLabel(projectFS.readFile(activeFilePath) ?? '', variableRef) || variableRef) : variableRef),
    [isComponentFile, activeFilePath, variableRef, labelProjectVersion],
  );

  // Icon priority: explicit caller override → the variable's DECLARED @propMeta type (toggle→switch,
  // option→list, number→#, …) → CSS-property/value inference. Resolving from the type is what makes a
  // Hide (display) toggle show the switch glyph instead of the generic cube — `display` alone is
  // ambiguous (Hide=boolean vs Layout display=enum), so the property can't reveal the data type.
  const resolvedIcon: VariableIconKey = useMemo(() => {
    if (iconKey) return iconKey;
    const boundIcon = resolveVariableIconKey({ property, value: currentValue });
    if (isComponentFile) {
      const t = getPropType(projectFS.readFile(activeFilePath) ?? '', variableRef);
      const fam = getVariableType(t)?.iconKey;
      // A declared @propMeta type wins — UNLESS it's the generic 'text' fallback, in which case the CSS
      // property is the better signal (borderRadius → radius, boxShadow → shadow). Without this deferral a
      // radius variable whose stored type is 'text' showed the "T" glyph instead of the radius icon. Mirrors
      // the VariableModal list + ComponentPropsTool resolution.
      if (fam && fam !== 'text') return fam;
      if (boundIcon !== 'generic') return boundIcon;
      return fam ?? 'generic';
    }
    return boundIcon;
  }, [iconKey, isComponentFile, activeFilePath, variableRef, property, currentValue, labelProjectVersion]);

  const handleRemove = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onRemove(variableRef, '');
    trace.action('variable-bound-pill:remove', { property, variableRef });
  }, [property, variableRef, onRemove]);

  return (
    <>
      <button
        onClick={() => {
          trace.action('variable-bound-pill:open-modal', { property, variableRef });
          setModalOpen(true);
        }}
        // `border border-transparent` + `bg-clip-padding` so the pill's box model
        // matches the bordered value widgets (ToolSelect / ControlActionRow): same
        // 1px border-box width AND the fill insets 1px like theirs — without this the
        // borderless pill's colour reaches the outer edge and reads ~2px wider.
        className="w-full h-8 flex items-center gap-2 pl-1 pr-2 rounded-[var(--radius-lg)] border border-transparent bg-clip-padding text-xs font-medium text-white cursor-pointer transition-colors hover:opacity-90 truncate"
        style={{ backgroundColor: pillBg }}
        title={`Variable: ${displayName} — click to manage`}
      >
        <span className="w-4 h-4 rounded bg-white/20 flex items-center justify-center shrink-0 text-white">
          <VariableTypeIcon iconKey={resolvedIcon} size={11} />
        </span>
        <span className="truncate flex-1 text-left">{displayName}</span>
        <span
          role="button"
          tabIndex={0}
          onClick={handleRemove}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleRemove(e as any); }}
          className="text-white/70 hover:text-white text-sm leading-none shrink-0 cursor-pointer"
          title="Remove variable binding"
        >
          ×
        </span>
      </button>

      <VariableModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        property={property}
        propertyLabel={propertyLabel}
        currentValue={currentValue}
        currentVariableRef={variableRef}
        onCreateVariable={() => setModalOpen(false)}
        onRemoveVariable={(name, defVal) => {
          onRemove(name, defVal);
          setModalOpen(false);
        }}
      />
    </>
  );
}

// ─── Unified-provider wrapper ─────────────────────────────────────────────

interface VariableBoundPillProps {
  /** Display label of the property, used in the modal title (e.g. "Shadow"). */
  propertyLabel: string;
}

export function VariableBoundPill({ propertyLabel }: VariableBoundPillProps) {
  const { property, hasVariable, variableRef, removeVariable, value } = useControlContext();
  if (!hasVariable || !variableRef) return null;
  return (
    <VariableBoundPillView
      property={property}
      propertyLabel={propertyLabel}
      variableRef={variableRef}
      currentValue={value || ''}
      onRemove={removeVariable}
    />
  );
}

// ─── Legacy-provider wrapper ──────────────────────────────────────────────
// Used by atoms still on `useControl()` (TextColorControl, ContentControl).
// Caller passes the binding info directly so we don't have to ship a
// duplicate hook.

interface LegacyVariableBoundPillProps {
  property: string;
  propertyLabel: string;
  variableRef: string;
  currentValue: string;
  removeVariable: (property: string, propName: string, defaultValue: string) => void;
  /** Explicit data-type glyph — see VariableBoundPillView.iconKey. */
  iconKey?: VariableIconKey;
}

export function LegacyVariableBoundPill({
  property, propertyLabel, variableRef, currentValue, removeVariable, iconKey,
}: LegacyVariableBoundPillProps) {
  const onRemove = useCallback((name: string, defVal: string) => {
    removeVariable(property, name, defVal);
  }, [property, removeVariable]);
  return (
    <VariableBoundPillView
      property={property}
      propertyLabel={propertyLabel}
      variableRef={variableRef}
      currentValue={currentValue}
      onRemove={onRemove}
      iconKey={iconKey}
    />
  );
}
