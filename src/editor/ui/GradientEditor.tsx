// GradientEditor.tsx — Complete gradient editor panel with type selector,
// direction/center controls, color stops bar, and color picker for selected stop.

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import ToolSegmentedControl from '../controls/ToolSegmentedControl';
import ToolSlider from '../controls/ToolSlider';
import ToolInput from '../controls/ToolInput';
import ToolSelect from '../controls/ToolSelect';
import ControlLabel from '../controls/ControlLabel';
import { YES_NO_OPTIONS } from '../controls/css-property-options';
import ColorPicker from './ColorPicker';
import CreateColorPresetPanel from './CreateColorPresetPanel';
import ColorPresetEditPanel from './ColorPresetEditPanel';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { presetTokensAtom } from '@/code/stores/preset-store';
import { useToolPopupOptional } from './ToolPopup';
import GradientStopsBar from './GradientStopsBar';
import { parseGradient, formatGradient, createDefaultGradient, type GradientData, type GradientStop } from '@/shared/gradient-utils';
import { activeGradientAtom, selectedGradientStopAtom, gradientUpdateCallbackAtom, gradientStopUpdateCallbackAtom, gradientStopSelectCallbackAtom, gradientCommitCallbackAtom } from '@/code/stores/gradient-store';
import { trace } from '@/shared/debug-trace';
import { parseVarRef } from '@/shared/css-utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface GradientEditorProps {
  value: string;  // CSS gradient string
  onChange: (css: string) => void;
  /** Fast live-update during a drag — wire to the canvas DOM patch
   *  (`updateStyleLive`), NOT a code mutation. When provided, dragging a stop /
   *  slider only PATCHES the canvas every frame (no per-frame re-parse) and the
   *  single `onChange` commit fires on pointer release. Falls back to per-frame
   *  `onChange` when omitted. */
  onLiveChange?: (css: string) => void;
  extraAfterType?: React.ReactNode;  // Optional content rendered after the type selector (e.g. border width)
  /** Hide canvas overlay (for per-portion text gradients where overlay doesn't apply) */
  hideOverlay?: boolean;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function GradientEditor({ value, onChange, onLiveChange, extraAfterType, hideOverlay }: GradientEditorProps) {
  // Color presets for per-stop color picker
  const allTokens = useAtomValue(presetTokensAtom);
  const colorPresets = useMemo(() => allTokens.filter(t => t.category === 'color'), [allTokens]);
  const popupCtx = useToolPopupOptional();

  // Parse incoming value into GradientData (or use default)
  const [data, setData] = useState<GradientData>(() => {
    const parsed = parseGradient(value);
    return parsed || createDefaultGradient();
  });
  const [selectedStopId, setSelectedStopId] = useState<string | null>(
    () => data.stops.length > 0 ? data.stops[0].id : null
  );

  // True while the user is actively dragging ANY control in this editor (a
  // stop, the direction/angle/center sliders, the color picker). Set on a
  // pointerdown anywhere in the editor, cleared on the next pointerup.
  const interactingRef = useRef(false);
  const liveEditedRef = useRef(false); // a live drag actually changed the gradient
  const handleRootPointerDown = useCallback(() => {
    interactingRef.current = true;
    liveEditedRef.current = false;
    const onUp = () => {
      interactingRef.current = false;
      window.removeEventListener('pointerup', onUp);
      // The drag only LIVE-PATCHED the canvas (no per-frame code write). Commit
      // the final value to CODE once, on release — but ONLY if a live edit
      // happened (a pure click that just selects a stop must not write).
      if (onLiveChangeRef.current && liveEditedRef.current) onChangeRef.current(lastWrittenRef.current);
      liveEditedRef.current = false;
    };
    window.addEventListener('pointerup', onUp);
  }, []);

  // Sync from props only when value changes EXTERNALLY (e.g. selecting a different node).
  // Skip when we caused the change ourselves (via onChange callback during drag).
  const lastWrittenRef = useRef(value);
  useEffect(() => {
    // CRITICAL: never re-sync mid-drag. Each drag frame writes the style, which
    // echoes back as a NEW `value` prop (FillControl: value={styles.background}).
    // If the canvas reformats it (rounded positions, normalized colors) the
    // string differs from what we wrote, so the guard below misses and
    // `setData(parsed)` would SNAP the handle back to the rounded value — the
    // next pointermove jumps forward again → the oscillation the user saw.
    // Skipping while interacting keeps `data` authoritative during the drag.
    if (interactingRef.current) { lastWrittenRef.current = value; return; }
    if (value === lastWrittenRef.current) return; // We wrote this — skip
    const parsed = parseGradient(value);
    if (parsed) {
      // PRESERVE the selected stop across the reparse. parseGradient mints
      // FRESH ids each time, so matching by id always fails and the selection
      // would jump to stop[0] (the bug the user saw on release). Re-select the
      // reparsed stop CLOSEST IN POSITION to the one we had selected (robust to
      // reordering + the rounding the canvas may apply on the round-trip).
      const prevStop = dataRef.current.stops.find(s => s.id === selectedStopIdRef.current);
      let nextSelId: string | null = parsed.stops.length > 0 ? parsed.stops[0].id : null;
      if (prevStop && parsed.stops.length > 0) {
        let best = Infinity;
        for (const s of parsed.stops) {
          const d = Math.abs(s.position - prevStop.position);
          if (d < best) { best = d; nextSelId = s.id; }
        }
      }
      dataRef.current = parsed;
      setData(parsed);
      setSelectedStopId(nextSelId);
      lastWrittenRef.current = value;
      return;
    }
    lastWrittenRef.current = value;
  }, [value]);

  trace.fn('GradientEditor:render', { type: data.type, stopCount: data.stops.length, selectedStopId });

  // ─── Publish gradient state for canvas overlay ────────────────────────────
  const setActiveGradient = useSetAtom(activeGradientAtom);
  const setSelectedGradientStop = useSetAtom(selectedGradientStopAtom);
  const setGradientCallback = useSetAtom(gradientUpdateCallbackAtom);
  const setStopUpdateCallback = useSetAtom(gradientStopUpdateCallbackAtom);
  const setStopSelectCallback = useSetAtom(gradientStopSelectCallbackAtom);
  const setGradientCommitCallback = useSetAtom(gradientCommitCallbackAtom);

  // Refs hold latest values so callbacks always read fresh data without re-registering
  const dataRef = useRef(data);
  const onChangeRef = useRef(onChange);
  const onLiveChangeRef = useRef(onLiveChange);
  const selectedStopIdRef = useRef(selectedStopId);
  dataRef.current = data;
  onChangeRef.current = onChange;
  onLiveChangeRef.current = onLiveChange;
  selectedStopIdRef.current = selectedStopId;

  // Helper: update data + push to overlay atom in one batch (avoids double render)
  const updateAndPublish = useCallback((next: GradientData) => {
    setData(next);
    if (!hideOverlay) setActiveGradient(next);
  }, [setActiveGradient, hideOverlay]);

  // Initial publish + mount callbacks. Cleanup on unmount.
  useEffect(() => {
    if (hideOverlay) return; // Skip overlay for per-portion text gradients
    setActiveGradient(data);
    setSelectedGradientStop(selectedStopId);
    // These fire per-frame while the user drags a handle on the CANVAS overlay.
    // Like the panel drag, they LIVE-PATCH the canvas DOM (onLiveChange) and
    // NEVER commit per frame — the commit happens once via the commit callback
    // below, on pointer release. `dataRef`/`lastWrittenRef` are updated
    // synchronously so the commit reads the final value. Falls back to per-frame
    // onChange when there's no live path (other consumers).
    const liveApply = (next: GradientData) => {
      dataRef.current = next;
      const css = formatGradient(next);
      lastWrittenRef.current = css;
      setData(next);
      (onLiveChangeRef.current ?? onChangeRef.current)(css);
      setActiveGradient(next); // move the overlay handles in the same batch
    };
    setGradientCallback(() => (updates: Partial<GradientData>) => {
      liveApply({ ...dataRef.current, ...updates });
    });
    setStopUpdateCallback(() => (id: string, position: number) => {
      liveApply({ ...dataRef.current, stops: dataRef.current.stops.map(s => s.id === id ? { ...s, position } : s) });
    });
    setGradientCommitCallback(() => () => {
      // Commit the final live-patched value to CODE. No-op without a live path
      // (then onChange already fired every frame above).
      if (onLiveChangeRef.current) onChangeRef.current(lastWrittenRef.current);
    });
    setStopSelectCallback(() => (id: string) => {
      setSelectedStopId(id);
      setSelectedGradientStop(id);
    });
    return () => {
      setActiveGradient(null);
      setSelectedGradientStop(null);
      setGradientCallback(null);
      setStopUpdateCallback(null);
      setGradientCommitCallback(null);
      setStopSelectCallback(null);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Update from canvas overlay handles ───────────────────────────────────
  const updateDataFromOverlay = useCallback((updates: Partial<GradientData>) => {
    setData(prev => {
      const next = { ...prev, ...updates };
      const css = formatGradient(next);
      lastWrittenRef.current = css;
      onChange(css);
      return next;
    });
  }, [onChange]);

  // ─── Update helper: updates data + emits CSS ─────────────────────────────

  const updateData = useCallback((updater: (prev: GradientData) => GradientData) => {
    // Compute `next` from the REF (synchronous latest) — not setData's async
    // `prev` — so `lastWrittenRef`/`dataRef` are updated immediately and the
    // pointer-release commit (handleRootPointerDown) reads the final value.
    const next = updater(dataRef.current);
    dataRef.current = next;
    const css = formatGradient(next);
    trace.action('gradient-editor:update', { type: next.type, css: css.slice(0, 80) });
    lastWrittenRef.current = css;
    setData(next);
    // While dragging (interactingRef) and a live path exists, ONLY patch the
    // canvas DOM every frame (fast, no code re-parse). The single code commit
    // (`onChange`) fires once on pointer-release. Otherwise commit per call
    // (single clicks, type/direction taps, or consumers without a live path).
    if (interactingRef.current && onLiveChangeRef.current) { liveEditedRef.current = true; onLiveChangeRef.current(css); }
    else onChange(css);
    // Only drive the canvas overlay when it's active for this editor.
    // `hideOverlay` (variable / hoisted-variable context, per-portion text
    // gradients) means there's no node to anchor handles to.
    if (!hideOverlay) setActiveGradient(next); // sync overlay in same React batch
  }, [onChange, setActiveGradient, hideOverlay]);

  // ─── Type change ─────────────────────────────────────────────────────────

  const handleTypeChange = useCallback((newType: string) => {
    trace.action('gradient-editor:type-change', { from: data.type, to: newType });
    updateData(prev => ({ ...prev, type: newType as GradientData['type'] }));
  }, [data.type, updateData]);

  // ─── Direction (linear) ──────────────────────────────────────────────────

  const handleDirectionChange = useCallback((dir: number) => {
    updateData(prev => ({ ...prev, direction: dir }));
  }, [updateData]);

  // ─── Center X/Y (radial/conic) ──────────────────────────────────────────

  const handleCenterXChange = useCallback((cx: number) => {
    updateData(prev => ({ ...prev, centerX: cx }));
  }, [updateData]);

  const handleCenterYChange = useCallback((cy: number) => {
    updateData(prev => ({ ...prev, centerY: cy }));
  }, [updateData]);

  // ─── Angle (conic) ──────────────────────────────────────────────────────

  const handleAngleChange = useCallback((angle: number) => {
    updateData(prev => ({ ...prev, angle }));
  }, [updateData]);

  // ─── Stop operations ─────────────────────────────────────────────────────

  const handleSelectStop = useCallback((id: string) => {
    trace.action('gradient-editor:select-stop', { id });
    setSelectedStopId(id);
  }, []);

  const handleUpdateStop = useCallback((id: string, updates: Partial<GradientStop>) => {
    updateData(prev => ({
      ...prev,
      stops: prev.stops.map(s => s.id === id ? { ...s, ...updates } : s),
    }));
  }, [updateData]);

  const handleAddStop = useCallback((position: number, color: string) => {
    const newId = `stop-${Date.now()}`;
    trace.action('gradient-editor:add-stop', { position, color, newId });
    updateData(prev => ({
      ...prev,
      stops: [...prev.stops, { id: newId, color, position }].sort((a, b) => a.position - b.position),
    }));
    setSelectedStopId(newId);
  }, [updateData]);

  const handleRemoveStop = useCallback((id: string) => {
    trace.action('gradient-editor:remove-stop', { id });
    updateData(prev => {
      if (prev.stops.length <= 2) return prev; // minimum 2 stops
      const newStops = prev.stops.filter(s => s.id !== id);
      return { ...prev, stops: newStops };
    });
    setSelectedStopId(prev => {
      if (prev === id) {
        // Select next available stop
        const remaining = data.stops.filter(s => s.id !== id);
        return remaining.length > 0 ? remaining[0].id : null;
      }
      return prev;
    });
  }, [data.stops, updateData]);

  // ─── Selected stop color change (from ColorPicker) ───────────────────────

  const handleStopColorChange = useCallback((color: string) => {
    if (!selectedStopId) return;
    trace.action('gradient-editor:stop-color-change', { stopId: selectedStopId, color });
    handleUpdateStop(selectedStopId, { color });
  }, [selectedStopId, handleUpdateStop]);

  // Resolve var() references for editor UI display (CSS vars aren't available in the panel)
  const resolveColor = useCallback((c: string) => {
    const name = parseVarRef(c);
    if (!name) return c;
    return colorPresets.find(t => t.name === name)?.value || '#000000';
  }, [colorPresets]);

  // ─── Selected stop for color picker ──────────────────────────────────────

  const selectedStop = data.stops.find(s => s.id === selectedStopId);

  return (
    <div className="flex flex-col gap-2" onPointerDownCapture={handleRootPointerDown}>
      {/* 1. Type selector */}
      <ToolSegmentedControl
        value={data.type}
        onChange={handleTypeChange}
        options={[
          { value: 'linear', label: 'Linear' },
          { value: 'radial', label: 'Radial' },
          { value: 'conic', label: 'Conic' },
        ]}
        size="sm"
      />

      {/* Optional extra content after type selector (e.g. border width) */}
      {extraAfterType}

      {/* Repeating toggle */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Repeat" property="" plain />
        <div className="w-full">
          <ToolSegmentedControl
            value={data.repeating ? 'yes' : 'no'}
            onChange={(v) => updateData(prev => ({ ...prev, repeating: v === 'yes' }))}
            options={YES_NO_OPTIONS}
            size="sm"
          />
        </div>
      </div>

      {/* Radial shape (circle/ellipse) */}
      {data.type === 'radial' && (
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Shape" property="" plain />
          <div className="w-full">
            <ToolSegmentedControl
              value={data.radialShape}
              onChange={(v) => updateData(prev => ({ ...prev, radialShape: v as any }))}
              options={[{ value: 'ellipse', label: 'Ellipse' }, { value: 'circle', label: 'Circle' }]}
              size="sm"
            />
          </div>
        </div>
      )}

      {/* Radial size mode */}
      {data.type === 'radial' && (
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Size" property="" plain />
          <ToolSelect
            value={data.radialSize}
            onChange={(v) => updateData(prev => ({ ...prev, radialSize: v as any }))}
            options={[
              { value: 'custom', label: 'Custom' },
              { value: 'closest-side', label: 'Closest Side' },
              { value: 'closest-corner', label: 'Closest Corner' },
              { value: 'farthest-side', label: 'Farthest Side' },
              { value: 'farthest-corner', label: 'Farthest Corner' },
            ]}
          />
        </div>
      )}

      {/* 2. Direction (linear only) */}
      {data.type === 'linear' && (
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Direction" property="" plain />
          <div className="flex items-center gap-2 w-full">
            <ToolSlider value={data.direction} min={0} max={360} step={1} onChange={handleDirectionChange} />
            <ToolInput value={String(Math.round(data.direction))} onChange={(v) => handleDirectionChange(parseFloat(v) || 0)} step={1} />
          </div>
        </div>
      )}

      {/* 3. Center X (radial/conic) */}
      {(data.type === 'radial' || data.type === 'conic') && (
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Center X" property="" plain />
          <div className="flex items-center gap-2 w-full">
            <ToolSlider value={data.centerX} min={0} max={100} step={1} onChange={handleCenterXChange} />
            <ToolInput value={String(Math.round(data.centerX))} onChange={(v) => handleCenterXChange(parseFloat(v) || 50)} step={1} />
          </div>
        </div>
      )}

      {/* 4. Center Y (radial/conic) */}
      {(data.type === 'radial' || data.type === 'conic') && (
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Center Y" property="" plain />
          <div className="flex items-center gap-2 w-full">
            <ToolSlider value={data.centerY} min={0} max={100} step={1} onChange={handleCenterYChange} />
            <ToolInput value={String(Math.round(data.centerY))} onChange={(v) => handleCenterYChange(parseFloat(v) || 50)} step={1} />
          </div>
        </div>
      )}

      {/* 5. Angle (conic only) */}
      {data.type === 'conic' && (
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Angle" property="" plain />
          <div className="flex items-center gap-2 w-full">
            <ToolSlider value={data.angle} min={0} max={360} step={1} onChange={handleAngleChange} />
            <ToolInput value={String(Math.round(data.angle))} onChange={(v) => handleAngleChange(parseFloat(v) || 0)} step={1} />
          </div>
        </div>
      )}

      {/* 6. Color stops bar (resolved colors for editor UI display) */}
      <GradientStopsBar
        stops={data.stops.map(s => ({ ...s, color: resolveColor(s.color) }))}
        selectedStopId={selectedStopId}
        onSelectStop={handleSelectStop}
        onUpdateStop={handleUpdateStop}
        onAddStop={handleAddStop}
        onRemoveStop={handleRemoveStop}
      />

      {/* 7. Color picker for selected stop (with color presets) */}
      {selectedStop && (() => {
        // Resolve var() references for visual display, keep var() stored in data
        const rawColor = selectedStop.color;
        const varName = parseVarRef(rawColor);
        const resolvedColor = varName
          ? (colorPresets.find(t => t.name === varName)?.value || '#000000')
          : rawColor;
        const activePresetName = varName ?? undefined;

        return (
          <ColorPicker
            value={resolvedColor}
            onChange={handleStopColorChange}
            showAlpha
            colorPresets={colorPresets}
            activePresetName={activePresetName}
            onApplyPreset={(varVal) => {
              // Store var() reference directly in gradient stop — reactive to preset changes
              handleStopColorChange(varVal);
            }}
            onCreatePreset={popupCtx ? (color) => {
              popupCtx.pushPanel('New Color Preset', (
                <CreateColorPresetPanel initialColor={color} onCreated={() => popupCtx.popPanel()} />
              ));
            } : undefined}
            onEditPreset={popupCtx ? (presetName) => {
              const token = colorPresets.find(t => t.name === presetName);
              if (!token) return;
              const displayName = token.label
                || presetName.replace(/^color-/, '').split('-')
                  .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
              popupCtx.pushPanel(`Edit "${displayName}"`, (
                <ColorPresetEditPanel
                  presetName={presetName}
                  initialValue={token.value}
                  onUpdate={(val) => {
                    // Live-drag fast path: write the CSS variable directly
                    // on the iframe contentRoot so every var(--name)
                    // consumer repaints next frame. Then queue the
                    // persistent mutation for tokens.css.
                    const bridge = getCanvasBridge() as any;
                    if (typeof bridge?.setCanvasTokenVar === 'function') {
                      bridge.setCanvasTokenVar(presetName, val);
                    }
                    queueMutation({ type: 'updatePresetToken', name: presetName, value: val });
                  }}
                />
              ));
            } : undefined}
          />
        );
      })()}
    </div>
  );
}
