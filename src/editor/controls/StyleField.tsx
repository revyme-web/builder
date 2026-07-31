// StyleField.tsx — Universal style property control.
//
// Auto-detects value type and renders the right control:
//   numeric (12px, 50%, 1.5em) → slider + number input
//   color (#fff, rgb(...))     → color input (TODO: color picker)
//   enum (flex, center, ...)   → select dropdown
//   text (anything else)       → text input
//
// Every StyleField automatically gets:
//   - ControlLabel with variable create/remove menu
//   - Override detection (blue label on variant/replica)
//   - Same visual design regardless of where it's used
//
// Usage:
//   <StyleField property="gap" label="Gap" />
//   <StyleField property="flexDirection" label="Direction" options={[...]} />
//   <StyleField property="backgroundColor" label="Background" />

import { useCallback } from 'react';
import ControlLabel from './ControlLabel';
import LocaleBoundPill, { useLocaleStyleOverrides } from './LocaleBoundPill';
import { useAtomValue } from 'jotai';
import { selectedNodeAtom } from '@/code/stores/store';
import ToolInput from './ToolInput';
import ToolSlider from './ToolSlider';
import ToolSelect from './ToolSelect';
import { useControl } from './ControlProvider';
import { resolveControl } from './control-registry';
import ColorInput from './ColorInput';
import { CmsBoundPill } from './CmsBoundPill';
import { trace } from '@/shared/debug-trace';
import { LegacyVariableBoundPill } from './VariableBoundPill';

// ─── Value Type Detection ───────────────────────────────────────────────────

type ControlType = 'numeric' | 'color' | 'select' | 'text';

function detectControlType(value: string, options?: SelectOption[] | null): ControlType {
  if (options && options.length > 0) return 'select';
  if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return 'color';
  if (/^rgba?\(/.test(value)) return 'color';
  if (/^hsla?\(/.test(value)) return 'color';
  if (/^-?[\d.]+(?:px|%|em|rem|vh|vw|deg|fr|s|ms)?$/.test(value)) return 'numeric';
  return 'text';
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface SelectOption {
  value: string;
  label: string;
}

interface StyleFieldProps {
  /** CSS property name (e.g., 'gap', 'flexDirection', 'backgroundColor') */
  property: string;
  /** Display label */
  label: string;
  /** If provided, renders a select dropdown instead of auto-detecting */
  options?: SelectOption[];
  /** Default value when the property is not set */
  defaultValue?: string;
  /** Slider min (for numeric, default 0) */
  min?: number;
  /** Slider max (for numeric, default 100) */
  max?: number;
  /** Step (for numeric, default 1) */
  step?: number;
  /** Hide the ControlLabel variable menu */
  hideCreateVariable?: boolean;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function StyleField({
  property,
  label,
  options: explicitOptions,
  defaultValue = '',
  min,
  max,
  step,
  hideCreateVariable,
}: StyleFieldProps) {
  const { styles, updateStyle, updateStyleLive, getValueSource, removeVariable, cmsBinding } = useControl();

  const rawValue = styles[property] || defaultValue;
  // Hooks must run unconditionally (a CMS-bound early return sits below).
  const selectedIdForLocale = useAtomValue(selectedNodeAtom);
  const localeOverridesFor = useLocaleStyleOverrides(property, selectedIdForLocale);
  // ALL hooks must run before any conditional return below — the locale/CMS
  // branches TOGGLE at runtime (Localize converts, bindings appear) and an
  // early return above a hook crashes with "Rendered fewer hooks" (the Gap
  // Localize crash, 2026-07-22).
  const handleChange = useCallback((value: string) => {
    updateStyle(property, value);
    trace.action('style-field:change', { property, value });
  }, [property, updateStyle]);

  // CMS binding takes priority — show the blue ⚡-pill in place of the
  // regular control. Same short-circuit pattern as the variable case
  // below; only renders inside a `.map()` over a CMS collection.
  const cmsField = cmsBinding?.getBindingForProperty(property);
  if (cmsField) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label={label} property={property} hideCreateVariable={hideCreateVariable} />
        <CmsBoundPill property={property} fallbackValue={rawValue} />
      </div>
    );
  }

  // Locale-localized property → the blue Locale pill replaces the control
  // (body opens the Localize popup, × clears — localization overhaul Phase 4).
  if (localeOverridesFor.length > 0 && selectedIdForLocale) {
    return (
      <div className="grid grid-cols-[var(--tool-label-col)_minmax(0,1fr)] items-center w-full">
        <ControlLabel label={label} property={property} hideCreateVariable={hideCreateVariable} cell />
        <LocaleBoundPill
          property={property}
          propertyLabel={label}
          nodeId={selectedIdForLocale}
          baseValue={rawValue}
          onChangeBase={(v) => updateStyle(property, v)}
        />
      </div>
    );
  }

  const valueSource = getValueSource(property);
  const hasVariable = valueSource.source === 'prop';
  const variableRef = valueSource.ref;

  // ─── Resolution chain ───────────────────────────────────────
  const registryDef = resolveControl(property);

  // 1. Custom component from registry
  if (registryDef?.type === 'custom') {
    const Comp = registryDef.component;
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label={label} property={property} hideCreateVariable={hideCreateVariable} />
        <Comp property={property} value={rawValue} onChange={handleChange} label={label} />
      </div>
    );
  }

  // 2. Variable bound → render the shared purple pill (body opens the modal, × unbinds). Previously a
  // bespoke button + a LOCAL VariableModal — that showed the raw prop id with NO glyph and the modal
  // state was lost when the row re-rendered (the "click just closes" bug). The shared pill resolves the
  // label + the type glyph (select → option, numeric → number) and owns its own modal.
  if (hasVariable && variableRef) {
    const iconHint = registryDef?.type === 'numeric' ? 'number'
      : (registryDef?.type === 'select' || explicitOptions) ? 'option'
      : undefined;
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label={label} property={property} hideCreateVariable={hideCreateVariable} />
        <LegacyVariableBoundPill
          property={property}
          propertyLabel={label}
          variableRef={variableRef}
          currentValue={rawValue}
          removeVariable={removeVariable}
          iconKey={iconHint}
        />
      </div>
    );
  }

  // 3. Resolve options: explicit prop > registry select > null
  const resolvedOptions = explicitOptions ?? (registryDef?.type === 'select' ? registryDef.options : null);

  // 4. Resolve numeric ranges: explicit props > registry > hardcoded defaults
  const resolvedMin = min ?? (registryDef?.type === 'numeric' ? registryDef.min : undefined) ?? 0;
  const resolvedMax = max ?? (registryDef?.type === 'numeric' ? registryDef.max : undefined) ?? 100;
  const resolvedStep = step ?? (registryDef?.type === 'numeric' ? registryDef.step : undefined) ?? 1;

  // 5. Detect control type from resolved state.
  //
  // Registry hints win over auto-detection when they exist. Without
  // this, properties like `gap` / `rowGap` / `columnGap` (registered
  // as `numeric`) fall back to a plain text input whenever the value
  // is empty — `detectControlType('', …)` doesn't match the numeric
  // regex on empty strings. The user reported this on the Layout
  // tool: an unset `gap` should still expose a slider clamped at 0
  // so dragging it adds the property, not a text field that requires
  // the user to know the right CSS unit.
  const controlType: ControlType =
    registryDef?.type === 'numeric' ? 'numeric'
    : registryDef?.type === 'select' ? 'select'
    : detectControlType(rawValue, resolvedOptions ?? undefined);

  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label={label} property={property} hideCreateVariable={hideCreateVariable} />
      <div className="flex items-center gap-2 w-full">
        {controlType === 'select' && resolvedOptions && (
          <ToolSelect
            value={rawValue}
            onChange={handleChange}
            options={resolvedOptions}
          />
        )}

        {controlType === 'numeric' && (
          <>
            <ToolSlider
              value={parseFloat(rawValue) || 0}
              min={resolvedMin}
              max={resolvedMax}
              step={resolvedStep}
              // Live preview only — bypass the mutation queue + code
              // generator on every tick so the canvas updates at 60fps.
              // Without this, every slider tick wrote to ProjectFS,
              // re-parsed the source, and re-rendered the entire canvas
              // tree — visible as oscillating jitter on any layout-
              // affecting prop (gap, padding, etc.) and even a noticeable
              // drag lag on cheap props like opacity.
              onChange={(v) => {
                const unit = rawValue.replace(/^-?[\d.]+/, '') || 'px';
                updateStyleLive(property, `${v}${unit}`);
              }}
              onCommit={(v) => {
                const unit = rawValue.replace(/^-?[\d.]+/, '') || 'px';
                handleChange(`${v}${unit}`);
              }}
            />
            <ToolInput
              value={String(parseFloat(rawValue) || 0)}
              onChange={(v) => {
                const unit = rawValue.replace(/^-?[\d.]+/, '') || 'px';
                handleChange(`${parseFloat(v) || 0}${unit}`);
              }}
              step={resolvedStep}
            />
          </>
        )}

        {controlType === 'color' && (
          <ColorInput value={rawValue} onChange={handleChange} onChangeLive={(v) => updateStyleLive(property, v)} />
        )}

        {controlType === 'text' && (
          <ToolInput
            value={rawValue}
            onChange={handleChange}
            text
          />
        )}
      </div>
    </div>
  );
}
