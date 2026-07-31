// SketchTool.tsx — Right-panel properties tool for sketch wrappers
// (`<svg data-sketch="true">`). Replaces SvgShapeTool when the selected
// element is a sketch.
//
// Live-update model — IMPERATIVE, not effect-driven:
//
//   onChange (slider drag, color drag) → setBrush atom + applyBrushToSketch
//                                        (RAF-coalesced: bridge DOM patch +
//                                        source commit, capped at 60 Hz)
//
//   onCommit (slider release)          → setBrush atom + applyBrushToSketchNow
//                                        (synchronous: bridge + flush, no RAF)
//
//   one-shot (checkbox, select)        → setBrush atom + applyBrushToSketchNow
//
// The earlier model patched DOM-only on tick and committed source on a
// debounce. That looked fine in edit mode (the SketchEditOverlay's
// stable mount tree avoids stray Renderer cycles) but broke in selected
// mode — any unrelated atom change triggered a Renderer rebuild that
// read stale source and overwrote the bridge's pending DOM updates.
// Committing source on every tick (RAF-throttled) keeps source as the
// single source of truth, and the bridge call closes the brief paint
// gap between commit and Renderer cycle.
//
// Layout uses the same `ControlLabel` / `ToolSlider` / `ToolInput` /
// `ColorInput` / `ToolSection` primitives every other tool in the
// panel uses, so the visual rhythm matches StylesTool / SvgShapeTool /
// AnchorTool exactly.

import { useAtom, useAtomValue } from 'jotai';
import { useMemo, useCallback, useState } from 'react';
import {
  brushConfigAtom,
  sketchEditingIdAtom,
  type BrushConfig,
} from '@/code/stores/sketch-edit-store';
import { nodesAtom, selectedIdsAtom } from '@/code/stores/store';
import {
  isReplicaViewportAtom,
  interactingViewportWidthAtom,
  isComponentVariantViewportAtom,
  activeComponentVariantAtom,
} from '@/code/stores/viewport-store';
import { getReplicaContext } from '@/canvas/drag/replica-context';
import { getActiveFilePath } from '@/canvas/node-ops';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { resolveSketchTargets } from './sketch-targets';
import { ColorInput, ToolInput, ToolSlider, ToolSection, ToolDivider, ToolSegmentedControl } from '@/editor/controls';
import ControlLabel from '@/editor/controls/ControlLabel';
import { ControlActionRow } from '@/editor/controls/ControlActionRow';
import { useControl } from '@/editor/controls/ControlProvider';
import {
  applyBrushToSketch,
  applyBrushToSketchNow,
  applyBrushToSketchNowBatch,
} from '@/canvas/sketch/sketch-live-sync';
import { trace } from '@/shared/debug-trace';

// ─── Row primitives ─────────────────────────────────────────────────────────

/** Label that shows the purple per-variant override indicator + per-row "Reset
 *  Override" when `overridden`, else a plain label — mirrors SvgShapeTool. */
function BrushLabel({ label, prop, overridden, onReset }: {
  label: string; prop: string; overridden?: boolean; onReset?: () => void;
}) {
  if (overridden && onReset) {
    return (
      <ControlLabel
        label={label}
        property={prop}
        overridden
        onResetOverride={onReset}
        hideCreateVariable
        hideResetStyle
        hideCmsBinding
      />
    );
  }
  return <ControlLabel label={label} property={prop} plain />;
}

function SliderRow({
  label, prop, value, min, max, step, format, onLive, onCommit, overridden, onReset,
}: {
  label: string;
  prop: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onLive: (v: number) => void;
  onCommit: (v: number) => void;
  overridden?: boolean;
  onReset?: () => void;
}) {
  return (
    <div className="flex items-center justify-between w-full">
      <BrushLabel label={label} prop={prop} overridden={overridden} onReset={onReset} />
      <div className="flex items-center gap-2 w-full">
        <ToolSlider
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={onLive}
          onCommit={onCommit}
        />
        <ToolInput
          value={format ? format(value) : String(value)}
          onChange={raw => {
            const parsed = parseFloat(raw);
            if (Number.isFinite(parsed)) onCommit(parsed);
          }}
          step={step}
        />
      </div>
    </div>
  );
}

function ColorRow({
  label, prop, value, onLive, dim, overridden, onReset,
}: {
  label: string;
  prop: string;
  value: string;
  overridden?: boolean;
  onReset?: () => void;
  /** Fires on every drag tick of ColorInput's saturation / hue / alpha
   *  sliders. Routes through `applyBrushToSketch` (RAF-coalesced bridge
   *  patch + queued source mutation that auto-flushes via
   *  `markCanvasUpdate`). We deliberately do NOT chain a synchronous
   *  commit here — the synchronous flushNow path ran on every tick
   *  triggered re-renders aggressive enough to recreate ColorPicker's
   *  saturation-square DOM, which silently dropped the active
   *  pointermove listener and froze the drag. The auto-flush handles
   *  source persistence within ~16ms; no need to force-commit per tick. */
  onLive: (v: string) => void;
  dim?: boolean;
}) {
  return (
    <div className="flex items-center justify-between w-full" style={dim ? { opacity: 0.5 } : undefined}>
      <BrushLabel label={label} prop={prop} overridden={overridden} onReset={onReset} />
      <div className="flex items-center gap-2 w-full">
        <ColorInput
          value={value}
          onChange={onLive}
          showAlpha={false}
        />
      </div>
    </div>
  );
}

/** Yes/No segmented control row — matches the visual rhythm used by
 *  StylesTool's Visible / Overflow toggles. ToolSegmentedControl works
 *  on string values, so we map the boolean through 'yes'/'no'. */
function YesNoRow({
  label, prop, checked, onChange, overridden, onReset,
}: {
  label: string;
  prop: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  overridden?: boolean;
  onReset?: () => void;
}) {
  return (
    <div className="flex items-center justify-between w-full">
      <BrushLabel label={label} prop={prop} overridden={overridden} onReset={onReset} />
      <div className="flex items-center gap-2 w-full">
        <ToolSegmentedControl
          value={checked ? 'yes' : 'no'}
          onChange={v => onChange(v === 'yes')}
          options={[
            { value: 'no', label: 'No' },
            { value: 'yes', label: 'Yes' },
          ]}
        />
      </div>
    </div>
  );
}

// ─── Per-variant brush params (editor metadata) ──────────────────────────────
// Brush params (Size/Thinning/…) are LOSSY — they bake into the outline `d` and
// can't be read back. To show each control's value + per-row override indicator
// PER VARIANT (like shape controls), we persist them in the wrapper's variant
// object as CSS custom properties (`--brush-size: 54`, …) routed exactly like
// any other per-variant style. These are editor-only metadata (nothing renders
// them); the actual visual is the baked d/fill/stroke that sketch-live-sync
// routes into each variant (stage 1). Custom props avoid the JSON-in-attribute
// quoting that updateHtmlAttrsInCode can't emit safely.
const BRUSH_VARS: Record<string, keyof BrushConfig> = {
  '--brush-size': 'size',
  '--brush-thinning': 'thinning',
  '--brush-streamline': 'streamline',
  '--brush-smoothing': 'smoothing',
  '--brush-taper-start': 'taperStart',
  '--brush-taper-end': 'taperEnd',
  '--brush-cap-start': 'capStart',
  '--brush-cap-end': 'capEnd',
  '--brush-color': 'color',
  '--brush-stroke-color': 'strokeColor',
  '--brush-stroke-width': 'strokeWidth',
};
const VAR_OF = Object.fromEntries(Object.entries(BRUSH_VARS).map(([v, k]) => [k, v])) as Partial<Record<keyof BrushConfig, string>>;
const BOOL_KEYS = new Set<keyof BrushConfig>(['capStart', 'capEnd']);
const STR_KEYS = new Set<keyof BrushConfig>(['color', 'strokeColor']);

function serializeBrushVal(key: keyof BrushConfig, val: unknown): string {
  if (BOOL_KEYS.has(key)) return val ? '1' : '0';
  return String(val);
}
function parseBrushVal(key: keyof BrushConfig, raw: string): number | boolean | string | undefined {
  if (BOOL_KEYS.has(key)) return raw === '1' || raw === 'true';
  if (STR_KEYS.has(key)) return raw;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Read a variant's stored brush params from the wrapper's variant style object. */
function readVariantBrush(variantStyles: Record<string, string> | undefined): Partial<BrushConfig> {
  if (!variantStyles) return {};
  const out: Partial<BrushConfig> = {};
  for (const [cssVar, key] of Object.entries(BRUSH_VARS)) {
    if (cssVar in variantStyles) {
      const v = parseBrushVal(key, variantStyles[cssVar]);
      if (v !== undefined) (out as Record<string, unknown>)[key] = v;
    }
  }
  return out;
}
/** Convert a brush patch → the CSS custom props to route per variant. */
function brushPatchToVars(patch: Partial<BrushConfig>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(patch) as (keyof BrushConfig)[]) {
    const cssVar = VAR_OF[k];
    if (cssVar) out[cssVar] = serializeBrushVal(k, (patch as Record<string, unknown>)[k]);
  }
  return out;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function SketchTool() {
  const [brush, setBrush] = useAtom(brushConfigAtom);
  const editingId = useAtomValue(sketchEditingIdAtom);
  const { node, nodeId, vpId } = useControl();
  const nodes = useAtomValue(nodesAtom);

  // Per-tile (component variant / page replica) context.
  useAtomValue(isReplicaViewportAtom);
  const isComponentVariant = useAtomValue(isComponentVariantViewportAtom);
  const activeVariant = useAtomValue(activeComponentVariantAtom);
  useAtomValue(interactingViewportWidthAtom); // re-render on replica width change
  const inNonDefaultVariant = isComponentVariant && !!activeVariant && activeVariant !== 'default';

  const targetId = editingId ?? nodeId ?? null;
  // MULTI-SELECT fan-out: one brush edit hits EVERY selected sketch, not just
  // the primary (only the last-selected sketch recolored — user report
  // 2026-07-29). Sketch-edit mode still pins to the edited sketch.
  const selectedIdsAll = useAtomValue(selectedIdsAtom);
  const brushTargets = useMemo(
    () => resolveSketchTargets(editingId, selectedIdsAll, nodeId ?? null, nodes),
    [editingId, selectedIdsAll, nodeId, nodes],
  );

  // Live-drag buffer: while dragging a slider on a variant we DON'T rewrite the
  // data-brush JSON every tick — we hold the in-flight values here so sliders
  // stay responsive, and persist on commit (release).
  const [pending, setPending] = useState<Partial<BrushConfig>>({});

  // This variant's PERSISTED brush params (empty on the default / primary tile).
  const variantBrush = useMemo<Partial<BrushConfig>>(() => {
    if (!inNonDefaultVariant) return {};
    return readVariantBrush(node?.motionVariants?.[activeVariant!]);
  }, [inNonDefaultVariant, node, activeVariant]);

  // What the controls SHOW: global ⊕ this variant's persisted params ⊕ in-flight.
  const effectiveBrush: BrushConfig = inNonDefaultVariant
    ? { ...brush, ...variantBrush, ...pending }
    : brush;

  // A param is overridden on this tile when it's persisted OR being dragged now.
  const isParamOverridden = (key: keyof BrushConfig): boolean =>
    inNonDefaultVariant && (key in variantBrush || key in pending);

  // The stamped stroke ids (`${nodeId}-g${i}`) — used by the "Reset all" path.
  const childPathIds = useMemo(() => {
    if (!nodeId) return [];
    const out: string[] = [];
    for (const id of nodes.keys()) if (id.startsWith(`${nodeId}-g`)) out.push(id);
    return out;
  }, [nodeId, nodes]);

  const hasTileOverride = useMemo(() => {
    if (!inNonDefaultVariant) return false;
    if (Object.keys(variantBrush).length > 0) return true;
    for (const cid of childPathIds) {
      const v = nodes.get(cid)?.motionVariants?.[activeVariant!];
      if (v && Object.keys(v).length > 0) return true;
    }
    return false;
  }, [inNonDefaultVariant, variantBrush, childPathIds, nodes, activeVariant]);

  // Persist a patch as `--brush-*` custom props on the wrapper's variant object.
  const writeVariantBrush = useCallback((patch: Partial<BrushConfig>) => {
    if (!nodeId) return;
    const ctx = getReplicaContext(vpId, getActiveFilePath(), getViewportWidths());
    if (ctx.isPrimary) return;
    for (const t of brushTargets) {
      for (const u of ctx.styleUpdate(t, brushPatchToVars(patch))) queueMutation(u as any);
    }
    flushNow();
  }, [nodeId, vpId, brushTargets]);

  /** Live tick (RAF-coalesced). On a variant: buffer the value + re-bake; don't
   *  touch the global atom (that would change the default). */
  const live = (patch: Partial<BrushConfig>) => {
    if (inNonDefaultVariant) {
      setPending((p) => ({ ...p, ...patch }));
      for (const t of brushTargets) applyBrushToSketch(t, vpId, { ...effectiveBrush, ...patch });
      return;
    }
    const next = { ...brush, ...patch };
    setBrush(next);
    for (const t of brushTargets) applyBrushToSketch(t, vpId, next);
  };

  /** Commit (release / enter). On a variant: persist to data-brush + re-bake. */
  const commit = (patch: Partial<BrushConfig>) => {
    if (inNonDefaultVariant) {
      writeVariantBrush(patch);
      applyBrushToSketchNowBatch(brushTargets, vpId, { ...effectiveBrush, ...patch });
      setPending((p) => { const n = { ...p }; for (const k of Object.keys(patch)) delete (n as any)[k]; return n; });
      trace.action('sketch-tool:commit-variant', { targets: brushTargets, patch, variant: activeVariant });
      return;
    }
    const next = { ...brush, ...patch };
    setBrush(next);
    applyBrushToSketchNowBatch(brushTargets, vpId, next);
    trace.action('sketch-tool:commit', { targets: brushTargets, patch });
  };

  /** Reset ONE param on this variant → drop its `--brush-*` custom prop and
   *  re-bake the strokes with that param fallen back to the global/default. */
  const resetParam = useCallback((key: keyof BrushConfig) => {
    if (!nodeId) return;
    const ctx = getReplicaContext(vpId, getActiveFilePath(), getViewportWidths());
    if (ctx.isPrimary) return;
    const cssVar = VAR_OF[key];
    if (cssVar) for (const u of ctx.styleUpdate(nodeId, { [cssVar]: '' })) queueMutation(u as any);
    setPending((p) => { const n = { ...p }; delete (n as Record<string, unknown>)[key]; return n; });
    const remaining = { ...variantBrush };
    delete (remaining as Record<string, unknown>)[key];
    applyBrushToSketchNow(targetId, vpId, { ...brush, ...remaining });
    flushNow();
    trace.action('sketch-tool:reset-param', { nodeId, key, variant: activeVariant });
  }, [nodeId, vpId, variantBrush, targetId, brush, activeVariant]);

  /** Reset ALL params on this variant: drop every `--brush-*` prop AND the baked
   *  stroke overrides, so the strokes revert to the default's brush entirely. */
  const resetTileBrush = useCallback(() => {
    if (!nodeId) return;
    const ctx = getReplicaContext(vpId, getActiveFilePath(), getViewportWidths());
    if (ctx.isPrimary) return;
    trace.action('sketch-tool:reset-tile-brush', { nodeId, strokes: childPathIds.length, variant: activeVariant });
    const clearVars: Record<string, string> = {};
    for (const cssVar of Object.keys(BRUSH_VARS)) clearVars[cssVar] = '';
    for (const u of ctx.styleUpdate(nodeId, clearVars)) queueMutation(u as any);
    for (const cid of childPathIds) {
      for (const u of ctx.styleUpdate(cid, { d: '', fill: '', stroke: '', strokeWidth: '' })) queueMutation(u as any);
    }
    setPending({});
    flushNow();
  }, [nodeId, vpId, childPathIds, activeVariant]);

  // Per-row override props (purple label + per-row Reset Override).
  const ov = (key: keyof BrushConfig) => ({
    overridden: isParamOverridden(key),
    onReset: () => resetParam(key),
  });

  return (
    <>
      <ToolSection title="Brush">
        {/* This variant has its own baked brush — offer to drop it back to the
            default. (Brush params are lossy, so the sliders below still show the
            working brush, not this variant's exact values — see SketchTool docs.) */}
        {hasTileOverride && (
          <ControlActionRow center onClick={resetTileBrush} data-testid="sketch-reset-variant">
            Reset to default
          </ControlActionRow>
        )}
        <ColorRow
          label="Fill"
          prop="__brush-fill"
          value={effectiveBrush.color}
          {...ov('color')}
          onLive={color => live({ color })}
        />
        {/* Slider maxes are deliberately wide (1000 for size / taper,
            200 for stroke width). perfect-freehand is happy with any
            positive number — the rendered shape just keeps growing.
            Wide ranges give the user headroom for canvas-scale work
            without needing to type values directly. */}
        <SliderRow
          label="Size"
          prop="__brush-size"
          value={effectiveBrush.size}
          {...ov('size')}
          min={1}
          max={200}
          step={1}
          format={v => Math.round(v).toString()}
          onLive={size => live({ size })}
          onCommit={size => commit({ size })}
        />
        <SliderRow
          label="Thinning"
          prop="__brush-thinning"
          value={effectiveBrush.thinning}
          {...ov('thinning')}
          min={-1}
          max={1}
          step={0.05}
          format={v => v.toFixed(2)}
          onLive={thinning => live({ thinning })}
          onCommit={thinning => commit({ thinning })}
        />
        <SliderRow
          label="Streamline"
          prop="__brush-streamline"
          value={effectiveBrush.streamline}
          {...ov('streamline')}
          min={0}
          max={1}
          step={0.05}
          format={v => v.toFixed(2)}
          onLive={streamline => live({ streamline })}
          onCommit={streamline => commit({ streamline })}
        />
        <SliderRow
          label="Smoothing"
          prop="__brush-smoothing"
          value={effectiveBrush.smoothing}
          {...ov('smoothing')}
          min={0}
          max={1}
          step={0.05}
          format={v => v.toFixed(2)}
          onLive={smoothing => live({ smoothing })}
          onCommit={smoothing => commit({ smoothing })}
        />
        {/* No top-level "Easing" row: it shapes the pressure→thickness
            curve, which only matters for input devices that produce
            varied pressure (Apple Pencil, Wacom). Mouse strokes use a
            uniform 0.5 pressure → easing maps a constant to a
            constant → no visible effect on the rendered file. */}
      </ToolSection>

      <ToolDivider />

      <ToolSection title="Stroke">
        <SliderRow
          label="Width"
          prop="__brush-stroke-width"
          value={effectiveBrush.strokeWidth}
          {...ov('strokeWidth')}
          min={0}
          max={200}
          step={0.5}
          format={v => (v === 0 ? '0' : v.toString())}
          onLive={strokeWidth => live({ strokeWidth })}
          onCommit={strokeWidth => commit({ strokeWidth })}
        />
        <ColorRow
          label="Color"
          prop="__brush-stroke-color"
          value={effectiveBrush.strokeColor}
          {...ov('strokeColor')}
          onLive={strokeColor => live({ strokeColor })}
          dim={effectiveBrush.strokeWidth === 0}
        />
      </ToolSection>

      <ToolDivider />

      {/* Taper sections: distance + cap toggle only. Per-end easing
          dropped — like the top-level easing it has no observable
          effect with uniform-pressure mouse input, so it would just
          add panel noise. */}
      <ToolSection title="Start taper">
        <SliderRow
          label="Distance"
          prop="__brush-taper-start"
          value={effectiveBrush.taperStart}
          {...ov('taperStart')}
          min={0}
          max={1000}
          step={1}
          format={v => Math.round(v).toString()}
          onLive={taperStart => live({ taperStart })}
          onCommit={taperStart => commit({ taperStart })}
        />
        <YesNoRow
          label="Cap"
          prop="__brush-cap-start"
          checked={effectiveBrush.capStart}
          {...ov('capStart')}
          onChange={capStart => commit({ capStart })}
        />
      </ToolSection>

      <ToolDivider />

      <ToolSection title="End taper">
        <SliderRow
          label="Distance"
          prop="__brush-taper-end"
          value={effectiveBrush.taperEnd}
          {...ov('taperEnd')}
          min={0}
          max={1000}
          step={1}
          format={v => Math.round(v).toString()}
          onLive={taperEnd => live({ taperEnd })}
          onCommit={taperEnd => commit({ taperEnd })}
        />
        <YesNoRow
          label="Cap"
          prop="__brush-cap-end"
          checked={effectiveBrush.capEnd}
          {...ov('capEnd')}
          onChange={capEnd => commit({ capEnd })}
        />
      </ToolSection>
    </>
  );
}
