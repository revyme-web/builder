// FilterControl.tsx — Self-contained filter ToolAtom.
// Fully migrated — uses useControlContext(), no legacy delegation.

import { useState, useRef, useEffect } from 'react';
import { ToolInput, ToolSlider, ControlLabel, SingleEntryRow } from '../../../controls';
import { useOverriddenLabel } from '../../../controls/label-override-context';
import { useHoistMenuItem } from '../../../controls/hoist-context';
import { FilterIcon } from '@/design-system/PropertyIcons';
import { UnifiedControlProvider, useControlContext } from '../../../controls/unified';
import { UsedByRow } from '../../../controls/unified/UsedByRow';
import { VariableBoundPill } from '../../../controls/VariableBoundPill';
import { useEditorPanel } from '../../../hooks/useEditorPanel';
import { extractNonShadowFilter } from '../../../ui/shadow-utils';
import type { AtomProps } from '../../../controls/unified/types';

// ─── Filter parse/format ────────────────────────────────────────────────────

function parseFilter(raw: string | undefined): {
  blur: number; brightness: number; contrast: number; saturate: number; grayscale: number; hueRotate: number;
} {
  const def = { blur: 0, brightness: 100, contrast: 100, saturate: 100, grayscale: 0, hueRotate: 0 };
  if (!raw || raw === 'none') return def;
  const clean = extractNonShadowFilter(raw);
  if (!clean) return def;
  const num = (re: RegExp, fallback: number) => {
    const m = clean.match(re);
    return m ? parseFloat(m[1]) : fallback;
  };
  return {
    blur: num(/blur\(\s*(-?[\d.]+)px\s*\)/, 0),
    brightness: num(/brightness\(\s*(-?[\d.]+)%?\s*\)/, 100),
    contrast: num(/contrast\(\s*(-?[\d.]+)%?\s*\)/, 100),
    saturate: num(/saturate\(\s*(-?[\d.]+)%?\s*\)/, 100),
    grayscale: num(/grayscale\(\s*(-?[\d.]+)%?\s*\)/, 0),
    hueRotate: num(/hue-rotate\(\s*(-?[\d.]+)deg\s*\)/, 0),
  };
}

function formatFilter(v: { blur: number; brightness: number; contrast: number; saturate: number; grayscale: number; hueRotate: number }, rawFilter?: string): string {
  const parts: string[] = [];
  if (v.blur !== 0) parts.push(`blur(${v.blur}px)`);
  if (v.brightness !== 100) parts.push(`brightness(${v.brightness}%)`);
  if (v.contrast !== 100) parts.push(`contrast(${v.contrast}%)`);
  if (v.saturate !== 100) parts.push(`saturate(${v.saturate}%)`);
  if (v.grayscale !== 0) parts.push(`grayscale(${v.grayscale}%)`);
  if (v.hueRotate !== 0) parts.push(`hue-rotate(${v.hueRotate}deg)`);
  const nonShadow = parts.join(' ');
  if (rawFilter) {
    const dropParts = (rawFilter.match(/drop-shadow\([^)]*(?:\([^)]*\)[^)]*)*\)/gi) || []).join(' ');
    if (dropParts) return nonShadow ? `${nonShadow} ${dropParts}` : dropParts;
  }
  return nonShadow || '';
}

// ─── Self-contained editor panel (reactive inside pushPanel) ─────────────────

function FilterEditorPanel({ initialValue, rawFilter, onChangeLive, onCommit }: {
  initialValue: string;
  rawFilter: string;
  /** Per-frame DOM patch during a slider/chevron drag. */
  onChangeLive: (val: string) => void;
  /** Code write — slider/chevron release + typed input. */
  onCommit: (val: string) => void;
}) {
  const [localValue, setLocalValue] = useState(initialValue);
  const f = parseFilter(localValue);

  // External re-seed (undo/redo while this editor is open): the parsed value
  // comes back through the prop — re-seed when it changed. Own commits are
  // skipped via the self-write counter so live/mid-drag state is never
  // clobbered by the round-trip (ShadowControl's pattern).
  const selfWriteRef = useRef(0);
  const prevInitRef = useRef(initialValue);
  useEffect(() => {
    if (initialValue === prevInitRef.current) return;
    prevInitRef.current = initialValue;
    if (selfWriteRef.current > 0) { selfWriteRef.current--; return; }
    setLocalValue(initialValue);
  }, [initialValue]);

  // `live=true` → DOM-only patch every frame; `live=false` → code commit.
  const update = (patch: Partial<typeof f>, live: boolean) => {
    const merged = { ...f, ...patch };
    const val = formatFilter(merged, rawFilter);
    setLocalValue(val);
    if (live) { onChangeLive(val); } else { selfWriteRef.current++; onCommit(val); }
  };
  type FKey = keyof typeof f;
  // Slider: live every tick, commit on release. Input: typed commits, chevron
  // drag is live + commit on release (ToolInput onChangeLive/onCommit).
  const sliderProps = (key: FKey) => ({
    onChange: (v: number) => update({ [key]: v } as Partial<typeof f>, true),
    onCommit: (v: number) => update({ [key]: v } as Partial<typeof f>, false),
  });
  const inputProps = (key: FKey, fallback: number) => ({
    onChange: (v: string) => update({ [key]: parseFloat(v) || fallback } as Partial<typeof f>, false),
    onChangeLive: (v: string) => update({ [key]: parseFloat(v) || fallback } as Partial<typeof f>, true),
    onCommit: (v: string) => update({ [key]: parseFloat(v) || fallback } as Partial<typeof f>, false),
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <ControlLabel label="Blur" property="filter" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolSlider value={f.blur} min={0} max={20} step={0.5} {...sliderProps('blur')} />
          <ToolInput value={`${f.blur}px`} {...inputProps('blur', 0)} step={0.5} />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <ControlLabel label="Brightness" property="filter" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolSlider value={f.brightness} min={0} max={200} step={1} {...sliderProps('brightness')} />
          <ToolInput value={`${f.brightness}%`} {...inputProps('brightness', 100)} step={1} />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <ControlLabel label="Contrast" property="filter" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolSlider value={f.contrast} min={0} max={200} step={1} {...sliderProps('contrast')} />
          <ToolInput value={`${f.contrast}%`} {...inputProps('contrast', 100)} step={1} />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <ControlLabel label="Saturate" property="filter" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolSlider value={f.saturate} min={0} max={200} step={1} {...sliderProps('saturate')} />
          <ToolInput value={`${f.saturate}%`} {...inputProps('saturate', 100)} step={1} />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <ControlLabel label="Grayscale" property="filter" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolSlider value={f.grayscale} min={0} max={100} step={1} {...sliderProps('grayscale')} />
          <ToolInput value={`${f.grayscale}%`} {...inputProps('grayscale', 0)} step={1} />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <ControlLabel label="Hue Rotate" property="filter" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolSlider value={f.hueRotate} min={0} max={360} step={1} {...sliderProps('hueRotate')} />
          <ToolInput value={`${f.hueRotate}deg`} {...inputProps('hueRotate', 0)} step={1} />
        </div>
      </div>
    </div>
  );
}

// ─── Atom ────────────────────────────────────────────────────────────────────

function FilterAtom() {
  const { value, onChange, onChangeLive, node, binding, mode, allProps, hasVariable } = useControlContext();
  const { openPanel, panelPopup } = useEditorPanel('Filter', () => (
    <FilterEditorPanel initialValue={value || ''} rawFilter={allProps.filter || ''} onChangeLive={onChangeLive} onCommit={onChange} />
  ));
  const btnRef = useRef<HTMLSpanElement>(null);
  // Variable-name override for the instance-prop row (see useOverriddenLabel).
  const { label: ovLabel, subLabel: ovSubLabel } = useOverriddenLabel('Filter');
  // Plain label (no chevron, matches ControlRow atoms) on a page instance;
  // non-plain (chevron → Hoist menu) only when a hoist item is present
  // (component master) or in direct StylesTool editing. Mirrors
  // ControlRow's `isPlain` so all instance-prop rows line up identically.
  const ovHoist = useHoistMenuItem();
  const labelPlain = mode !== 'direct' && !ovHoist;

  // Binding check — animation/scroll first, variable pill second.
  if (mode === 'direct' && binding.bound) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Filter" property="filter" />
        <UsedByRow binding={binding} />
      </div>
    );
  }
  if (mode === 'direct' && hasVariable) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Filter" property="filter" />
        <VariableBoundPill propertyLabel="Filter" />
      </div>
    );
  }

  const nonShadowFilter = extractNonShadowFilter(value || '');
  const hasFilter = !!nonShadowFilter;

  const openEditor = () => {
    openPanel();
  };

  return (
    <>
      <SingleEntryRow
        label={ovLabel} property="filter" plain={labelPlain} subLabel={ovSubLabel}
        hasValue={hasFilter}
        onOpen={openEditor}
        anchorRef={btnRef}
        EmptyIcon={FilterIcon}
        renderPreview={() => {
          const fns = (nonShadowFilter || '').match(/\w+\(/g) || [];
          const label = fns.length === 1 ? fns[0].replace('(', '').replace(/^\w/, c => c.toUpperCase()) : 'Mixed';
          return <span className="truncate flex-1">{label}</span>;
        }}
        onRemove={() => {
          const dropOnly = (allProps.filter || '').match(/drop-shadow\([^)]*(?:\([^)]*\)[^)]*)*\)/gi)?.join(' ') || '';
          onChange(dropOnly);
        }}
      />
      {panelPopup(btnRef)}
    </>
  );
}

export function FilterControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="filter" defaultValue="" mode={mode} {...mp}>
      <FilterAtom />
    </UnifiedControlProvider>
  );
}
