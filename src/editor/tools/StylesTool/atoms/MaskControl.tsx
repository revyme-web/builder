// MaskControl.tsx — Fully self-contained mask ToolAtom with multi-entry list + gradient/image editor.
// Uses unified control system for value/onChange routing and binding detection.

import { useState, useRef, useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { UnifiedControlProvider, useControlContext } from '../../../controls/unified';
import { UsedByRow } from '../../../controls/unified/UsedByRow';
import { VariableBoundPill } from '../../../controls/VariableBoundPill';
import type { AtomProps } from '../../../controls/unified/types';
import { ToolInput, ToolSelect, ToolSlider, ToolSegmentedControl, EntryList, ControlLabel } from '../../../controls';
import { MaskIcon } from '@/design-system/PropertyIcons';
import { useEditorPanel } from '../../../hooks/useEditorPanel';
import { parseGradient as gradientParseGradient, formatGradient as gradientFormatGradient, createDefaultGradient as gradientCreateDefault } from '@/shared/gradient-utils';
import { parseMaskEntries, formatMaskCSS, detectMaskType, nextMaskActiveEntry, MASK_PRESETS, MASK_PRESET_OPTIONS, detectMaskPreset, type MaskEntry } from '@/shared/mask-utils';
import { activeGradientAtom, gradientUpdateCallbackAtom, gradientStopUpdateCallbackAtom, gradientStopSelectCallbackAtom, selectedGradientStopAtom, isMaskGradientAtom } from '@/code/stores/gradient-store';
import { trace } from '@/shared/debug-trace';

// ─── Mask Gradient Editor (alpha-only, no color picker) ─────────────────────

function MaskGradientEditor({ value, onChange, hideOverlay }: { value: string; onChange: (css: string) => void; hideOverlay?: boolean }) {
  const isImageMask = value.includes('url(');
  const [maskMode, setMaskMode] = useState<'gradient' | 'image'>(() => isImageMask ? 'image' : 'gradient');
  const [imageUrl, setImageUrl] = useState(() => {
    const m = value.match(/url\(["']?([^"')]+)["']?\)/);
    return m ? m[1] : '';
  });

  // ALL hooks must be called before any early return
  const parsed = gradientParseGradient(value) || gradientCreateDefault();
  const data = { ...parsed };

  const setActiveGradient = useSetAtom(activeGradientAtom);
  const setGradientCallback = useSetAtom(gradientUpdateCallbackAtom);
  const setStopUpdateCallback = useSetAtom(gradientStopUpdateCallbackAtom);
  const setStopSelectCallback = useSetAtom(gradientStopSelectCallbackAtom);
  const setSelectedStop = useSetAtom(selectedGradientStopAtom);
  const setIsMask = useSetAtom(isMaskGradientAtom);

  // Ref holds latest data+onChange so overlay drag callbacks always use fresh values
  const dataRef = useRef(data);
  const onChangeRef = useRef(onChange);
  dataRef.current = data;
  onChangeRef.current = onChange;

  // Mount/unmount: set up callbacks + initial atom. Clean up on unmount or mode change.
  useEffect(() => {
    // Variable / hoisted-variable context: no node to anchor the mask
    // handles to (the mask lives on a nested child), so suppress the canvas
    // overlay entirely — the user edits via the popup controls. Same
    // decision as gradient + clip-path variables.
    if (hideOverlay || maskMode === 'image') {
      setActiveGradient(null);
      setGradientCallback(null);
      setStopUpdateCallback(null);
      setStopSelectCallback(null);
      setIsMask(false);
      return;
    }
    setActiveGradient({ ...dataRef.current });
    setIsMask(true);
    setGradientCallback(() => (updates: any) => {
      const next = { ...dataRef.current, ...updates };
      setActiveGradient(next); // sync overlay in same batch
      onChangeRef.current(gradientFormatGradient(next));
    });
    setStopUpdateCallback(() => (id: string, position: number) => {
      const newStops = dataRef.current.stops.map(s => s.id === id ? { ...s, position } : s);
      const next = { ...dataRef.current, stops: newStops };
      setActiveGradient(next); // sync overlay in same batch
      onChangeRef.current(gradientFormatGradient(next));
    });
    setStopSelectCallback(() => (id: string) => {
      setSelectedStop(id);
    });
    return () => {
      setActiveGradient(null);
      setGradientCallback(null);
      setStopUpdateCallback(null);
      setStopSelectCallback(null);
      setIsMask(false);
    };
  }, [maskMode, hideOverlay]);

  // For image masks, render URL input + mode selector
  if (maskMode === 'image') {
    return (
      <div className="flex flex-col gap-2">
        <ToolSegmentedControl value="image" onChange={(v) => {
          if (v !== 'image') {
            setMaskMode('gradient');
            onChange('linear-gradient(0deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)');
          }
        }} options={[
          { value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' },
          { value: 'conic', label: 'Conic' }, { value: 'image', label: 'Image' },
        ]} size="sm" />
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="URL" property="mask" plain />
          <ToolInput value={imageUrl} onChange={(v) => {
            setImageUrl(v);
            onChange(v ? `url(${v}) center center / cover no-repeat` : 'none');
          }} text />
        </div>
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Mode" property="mask" plain />
          <ToolSelect value={value.includes('luminance') ? 'luminance' : 'alpha'}
            onChange={(v) => {
              const base = imageUrl ? `url(${imageUrl}) center center / cover no-repeat` : 'none';
              onChange(v === 'luminance' ? `${base} luminance` : base);
            }}
            options={[{ value: 'alpha', label: 'Alpha' }, { value: 'luminance', label: 'Luminance' }]} />
        </div>
      </div>
    );
  }

  const update = (updates: Partial<typeof data>) => {
    const next = { ...data, ...updates };
    onChange(gradientFormatGradient(next));
  };

  // Stop positions (0-100%) — these move the circles on the overlay
  const firstStop = data.stops[0];
  const lastStop = data.stops[data.stops.length - 1];
  const startPos = firstStop ? firstStop.position : 0;
  const endPos = lastStop ? lastStop.position : 100;

  const updateStopPosition = (index: number, pos: number) => {
    const clamped = Math.max(0, Math.min(100, pos));
    const newStops = [...data.stops];
    if (newStops[index]) newStops[index] = { ...newStops[index], position: clamped };
    trace.action('mask:stop-position', { index, position: clamped });
    update({ stops: newStops });
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Type selector */}
      <ToolSegmentedControl
        value={data.type}
        onChange={(v: string) => {
          if (v === 'image') {
            setMaskMode('image');
            onChange('url() center center / cover no-repeat');
          } else {
            update({ type: v as any });
          }
        }}
        options={[
          { value: 'linear', label: 'Linear' },
          { value: 'radial', label: 'Radial' },
          { value: 'conic', label: 'Conic' },
          { value: 'image', label: 'Image' },
        ]}
        size="sm"
      />

      {/* Start position — where the masked (transparent) region begins */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Start" property="mask" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolSlider value={startPos} min={0} max={100} step={1}
            onChange={(v) => updateStopPosition(0, v)} />
          <ToolInput value={String(Math.round(startPos))} onChange={(v) => updateStopPosition(0, parseInt(v) || 0)} step={1} />
        </div>
      </div>

      {/* End position — where the visible (opaque) region begins */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="End" property="mask" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolSlider value={endPos} min={0} max={100} step={1}
            onChange={(v) => updateStopPosition(data.stops.length - 1, v)} />
          <ToolInput value={String(Math.round(endPos))} onChange={(v) => updateStopPosition(data.stops.length - 1, parseInt(v) || 0)} step={1} />
        </div>
      </div>

      {/* Direction/Rotation (linear) */}
      {data.type === 'linear' && (
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Rotation" property="mask" plain />
          <div className="flex items-center gap-2 w-full">
            <ToolSlider value={data.direction} min={0} max={360} step={1}
              onChange={(v) => update({ direction: v })} />
            <ToolInput value={String(Math.round(data.direction))} onChange={(v) => update({ direction: parseFloat(v) || 0 })} step={1} />
          </div>
        </div>
      )}

      {/* Center X/Y (radial/conic) */}
      {(data.type === 'radial' || data.type === 'conic') && (
        <>
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Center X" property="mask" plain />
            <div className="flex items-center gap-2 w-full">
              <ToolSlider value={data.centerX} min={0} max={100} step={1}
                onChange={(v) => update({ centerX: v })} />
              <ToolInput value={String(Math.round(data.centerX))} onChange={(v) => update({ centerX: parseFloat(v) || 50 })} step={1} />
            </div>
          </div>
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Center Y" property="mask" plain />
            <div className="flex items-center gap-2 w-full">
              <ToolSlider value={data.centerY} min={0} max={100} step={1}
                onChange={(v) => update({ centerY: v })} />
              <ToolInput value={String(Math.round(data.centerY))} onChange={(v) => update({ centerY: parseFloat(v) || 50 })} step={1} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Mask Editor Panel (self-contained for pushPanel) ──────────────────────

function MaskEditorPanel({ entries: initEntries, entryIdx, commitEntries, hideOverlay }: {
  entries: MaskEntry[]; entryIdx: number;
  commitEntries: (entries: MaskEntry[]) => void;
  hideOverlay?: boolean;
}) {
  const [localEntries, setLocalEntries] = useState(initEntries);

  // External re-seed (undo/redo while the mask editor is open). Own commits
  // round-trip to the same entries, so a value-compare against local state
  // doubles as the self-write guard.
  const initSig = JSON.stringify(initEntries);
  const localSigRef = useRef(initSig);
  const prevInitSigRef = useRef(initSig);
  useEffect(() => {
    if (initSig === prevInitSigRef.current) return;
    prevInitSigRef.current = initSig;
    if (localSigRef.current === initSig) return;
    localSigRef.current = initSig;
    setLocalEntries(initEntries);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initSig]);

  const entry = localEntries[entryIdx];
  if (!entry) return null;

  const update = (newEntries: MaskEntry[]) => {
    setLocalEntries(newEntries);
    localSigRef.current = JSON.stringify(newEntries);
    commitEntries(newEntries);
  };

  return (
    <div className="flex flex-col gap-2">
      {entryIdx > 0 && (
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Composite" property="mask" plain />
          <ToolSelect
            value={entry.composite || 'add'}
            onChange={(v) => {
              const n = [...localEntries];
              n[entryIdx] = { ...n[entryIdx], composite: v };
              update(n);
            }}
            options={[
              { value: 'add', label: 'Add' },
              { value: 'subtract', label: 'Subtract' },
              { value: 'intersect', label: 'Intersect' },
              { value: 'exclude', label: 'Exclude' },
            ]}
          />
        </div>
      )}
      <MaskGradientEditor
        value={entry.gradient}
        hideOverlay={hideOverlay}
        onChange={(css) => {
          const n = [...localEntries];
          n[entryIdx] = { ...n[entryIdx], gradient: css };
          update(n);
        }}
      />
    </div>
  );
}

// ─── MaskAtom (multi-entry list, fully self-contained) ─────────────────────

function MaskAtom() {
  const { node, nodeId, onChange, onChangeMultiple, binding, mode, allProps, hasVariable } = useControlContext();
  const styles = allProps;

  // Resolve mask entries from the DOM properties. New format = `mask-image`
  // (gradients) + `mask-composite` (operators). Legacy pages carry the operator
  // inline on `mask`/`maskImage` (`… subtract`) — parseMaskEntries handles both.
  const maskImageVal = styles.maskImage || styles.WebkitMaskImage || '';
  const maskCompositeVal = styles.maskComposite || styles.WebkitMaskComposite || '';
  const maskShorthandVal = styles.mask || styles.WebkitMask || '';
  const readEntries = (): MaskEntry[] =>
    maskImageVal ? parseMaskEntries(maskImageVal, maskCompositeVal || undefined)
      : parseMaskEntries(maskShorthandVal);
  // Single key that changes whenever ANY mask-related prop changes (so a
  // composite-only edit is still detected as an external change).
  const maskKey = `${maskShorthandVal}||${maskImageVal}||${maskCompositeVal}`;

  const [entries, setEntries] = useState<MaskEntry[]>(readEntries);
  const [activeEntryIdx, setActiveEntryIdx] = useState<number>(0);
  const btnRef = useRef<HTMLElement>(null);

  // Re-sync entries when the mask CSS or the selected node changes. CRUCIAL:
  // only reset the active entry to 0 when a DIFFERENT node is selected — NOT
  // when the SAME node's mask value changes because WE just committed an edit.
  // Editing the 2nd (or Nth) mask entry rewrites the mask props → maskKey
  // changes → this effect re-fires; snapping activeEntryIdx to 0 there made the
  // popup jump back to the first entry so entries past the first could never be
  // edited (live find 2026-07-04). nextMaskActiveEntry encodes the rule.
  const prevMaskRef = useRef(maskKey);
  const prevNodeIdRef = useRef(nodeId);
  useEffect(() => {
    const nodeChanged = nodeId !== prevNodeIdRef.current;
    const maskChanged = maskKey !== prevMaskRef.current;
    if (!nodeChanged && !maskChanged) return;
    prevNodeIdRef.current = nodeId;
    prevMaskRef.current = maskKey;
    const parsed = readEntries();
    setEntries(parsed);
    setActiveEntryIdx((i) => nextMaskActiveEntry({ nodeChanged, maskChanged, prevActiveIdx: i, entryCount: parsed.length }));
    trace.action('mask:resync', { nodeId, nodeChanged, maskChanged, count: parsed.length });
  }, [maskKey, nodeId]);

  // Commit entries back to CSS. Multi-layer masks MUST use mask-image (gradients
  // only) + mask-composite (operators) — `mask-image: 'A, B subtract'` is invalid
  // and silently drops the 2nd layer. formatMaskCSS emits the shifted operators.
  const commitEntries = (newEntries: MaskEntry[]) => {
    setEntries(newEntries);
    const { image, composite, webkitComposite } = formatMaskCSS(newEntries);
    trace.action('mask:commit', { count: newEntries.length, composite });
    const updates: Record<string, string> = {
      maskImage: image,
      WebkitMaskImage: image,
      // '' removes the property when there's a single layer / no mask.
      maskComposite: composite,
      WebkitMaskComposite: webkitComposite,
    };
    // We write longhands now — clear any legacy shorthand so it can't win.
    if (styles.mask) updates.mask = '';
    if (styles.WebkitMask) updates.WebkitMask = '';
    onChangeMultiple(updates);
  };

  // Apply a named preset (edge fades / vignette / all-edge combos).
  const applyPreset = (name: string) => {
    if (name === 'custom') return;
    const preset = MASK_PRESETS[name];
    if (!preset) return;
    const fresh = preset.entries();
    trace.action('mask:preset', { name, count: fresh.length });
    commitEntries(fresh);
    setActiveEntryIdx(0);
  };

  const { isOpen, openPanel, panelPopup } = useEditorPanel('Mask', () => (
    entries[activeEntryIdx] && (
      <div className="flex flex-col gap-2">
        {/* Composite selector — only for 2nd+ entry */}
        {activeEntryIdx > 0 && (
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Composite" property="mask" plain />
            <ToolSelect
              value={entries[activeEntryIdx].composite || 'add'}
              onChange={(v) => {
                const newEntries = [...entries];
                newEntries[activeEntryIdx] = { ...newEntries[activeEntryIdx], composite: v };
                trace.action('mask:composite', { index: activeEntryIdx, value: v });
                commitEntries(newEntries);
              }}
              options={[
                { value: 'add', label: 'Add' },
                { value: 'subtract', label: 'Subtract' },
                { value: 'intersect', label: 'Intersect' },
                { value: 'exclude', label: 'Exclude' },
              ]}
            />
          </div>
        )}

        {/* Mask gradient editor — simplified: type + direction/center + alpha */}
        <MaskGradientEditor
          value={entries[activeEntryIdx].gradient}
          hideOverlay={mode !== 'direct'}
          onChange={(css) => {
            const newEntries = [...entries];
            newEntries[activeEntryIdx] = { ...newEntries[activeEntryIdx], gradient: css };
            trace.action('mask:gradient-change', { index: activeEntryIdx, css: css.slice(0, 80) });
            commitEntries(newEntries);
          }}
        />
      </div>
    )
  ));

  // Open the mask editor — pushPanel if inside a popup, standalone ToolPopup otherwise
  // Pass freshEntries when the entry was just added (state hasn't updated yet)
  const openEditor = (entryIdx: number, freshEntries?: MaskEntry[]) => {
    setActiveEntryIdx(entryIdx);
    openPanel(
      <MaskEditorPanel entries={freshEntries || entries} entryIdx={entryIdx} commitEntries={commitEntries} hideOverlay={mode !== 'direct'} />
    );
  };

  trace.fn('MaskAtom:render', { entryCount: entries.length, activeEntryIdx, isOpen });

  // Bound state: animation/scroll → UsedByRow; component variable → pill.
  if (mode === 'direct' && binding.bound) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Mask" property="mask" />
        <UsedByRow binding={binding} />
      </div>
    );
  }
  if (mode === 'direct' && hasVariable) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Mask" property="mask" />
        <VariableBoundPill propertyLabel="Mask" />
      </div>
    );
  }

  const handleAdd = () => {
    if (entries.length === 0) {
      const newEntry: MaskEntry = { id: `mask-${Date.now()}`, gradient: 'linear-gradient(0deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)', composite: '' };
      const fresh = [newEntry];
      commitEntries(fresh);
      openEditor(0, fresh);
    } else {
      const newEntry: MaskEntry = { id: `mask-${Date.now()}`, gradient: 'linear-gradient(0deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)', composite: 'add' };
      const fresh = [...entries, newEntry];
      commitEntries(fresh);
      openEditor(fresh.length - 1, fresh);
    }
  };

  const handleRemove = (idx: number) => {
    const n = [...entries];
    n.splice(idx, 1);
    commitEntries(n);
  };

  return (
    <>
      {/* Preset picker sits in the "Mask" header row's value slot (one-click edge
          fades / vignette / all-edge combos; 'Custom' leaves the mask untouched).
          Direct mode only — the mask entries render on their own rows below it. */}
      <EntryList
        label="Mask"
        property="mask"
        entries={entries}
        onEdit={openEditor}
        onRemove={handleRemove}
        onAdd={handleAdd}
        renderSwatch={(e) => ({ background: e.gradient || '#000' })}
        renderLabel={(e) => detectMaskType(e.gradient)}
        addButtonRef={btnRef}
        singleOnly={mode !== 'direct'}
        plainLabel={mode !== 'direct'}
        EmptyIcon={MaskIcon}
        headerAccessory={mode === 'direct' ? (
          <ToolSelect
            value={detectMaskPreset(entries)}
            onChange={applyPreset}
            options={MASK_PRESET_OPTIONS}
          />
        ) : undefined}
      />

      {/* Mask entry editor popup — only when NOT inside another popup */}
      {panelPopup(btnRef)}
    </>
  );
}

// ─── Exported ToolAtom ──────────────────────────────────────────────────────

export function MaskControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="mask" defaultValue="" mode={mode} {...mp}>
      <MaskAtom />
    </UnifiedControlProvider>
  );
}
