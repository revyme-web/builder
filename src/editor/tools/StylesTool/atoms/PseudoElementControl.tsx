// PseudoElementControl.tsx — Visual editor for ::before and ::after pseudo-element CSS rules.
// Row style matches Border/Filter/Shadow: ControlLabel + ControlActionRow with summary + RemoveButton.
// Inner editor reuses real ToolAtom controls via MotionPropsEditor pattern (stopProps + onStopChange).
// Live preview via injectCanvasCSS. Writes via queueMutation({ type: 'updatePseudoStyle' }).

import { useState, useCallback, useRef, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { ControlLabel, ControlActionRow, RemoveButton, ToolInput, ToolSlider, ToolSelect, SingleEntryRow } from '../../../controls';
import ColorInput from '../../../controls/ColorInput';
import ToolPopup, { useToolPopupOptional } from '../../../ui/ToolPopup';
import { useControl } from '../../../controls/ControlProvider';
import { pseudoStylesAtom } from '@/code/stores/pseudo-store';
import { keyframeNamesAtom } from '@/code/stores/animation-store';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { injectCanvasCSS, removeCanvasCSS } from '@/canvas/node-ops';
import { toKebab } from '@/shared/css-utils';
import {
  parseAnimationShorthand, formatAnimationShorthand, animationSummary,
  CSS_EASING_OPTIONS, CSS_DIRECTION_OPTIONS, CSS_FILL_OPTIONS, CSS_ITERATION_OPTIONS,
} from '@/shared/animation-utils';
import { trace } from '@/shared/debug-trace';
import { OpacityControl } from './OpacityControl';
import { RadiusControl } from './RadiusControl';
import { ClipPathControl } from './ClipPathControl';
import { FillControl } from './FillControl';
import { FilterControl } from './FilterControl';
import { ShadowControl } from './ShadowControl';
import { BorderControl } from './BorderControl';
import { MaskControl } from './MaskControl';
import { TransformControl } from './TransformControl';
import { ShadowControl as TextShadowControl } from '../../TextStyleTool/atoms/ShadowControl';
import { getPropertyIcon, PseudoIcon } from '@/design-system/PropertyIcons';
import type { AtomProps } from '../../../controls/unified/types';
import type { ComponentType } from 'react';

// ─── ToolAtom properties (reuse centralized controls) ──────────────────────

const ADDABLE_STYLE_ATOMS: { key: string; label: string; Atom: ComponentType<AtomProps> }[] = [
  { key: 'backgroundColor', label: 'Background', Atom: FillControl },
  { key: 'opacity', label: 'Opacity', Atom: OpacityControl },
  { key: 'borderRadius', label: 'Border Radius', Atom: RadiusControl },
  { key: 'clipPath', label: 'Clip Path', Atom: ClipPathControl },
  { key: 'filter', label: 'Filter', Atom: FilterControl },
  { key: 'boxShadow', label: 'Shadow', Atom: ShadowControl },
  { key: 'border', label: 'Border', Atom: BorderControl },
  { key: 'maskImage', label: 'Mask', Atom: MaskControl },
  { key: 'transform', label: 'Transform', Atom: TransformControl },
];

const SUB_PROPERTY_MAP: Record<string, string> = {
  borderWidth: 'border', borderStyle: 'border', borderColor: 'border',
  borderTopWidth: 'border', borderTopStyle: 'border', borderTopColor: 'border',
  borderRightWidth: 'border', borderRightStyle: 'border', borderRightColor: 'border',
  borderBottomWidth: 'border', borderBottomStyle: 'border', borderBottomColor: 'border',
  borderLeftWidth: 'border', borderLeftStyle: 'border', borderLeftColor: 'border',
  WebkitMaskImage: 'maskImage', mask: 'maskImage', WebkitMask: 'maskImage',
  background: 'backgroundColor', backgroundImage: 'backgroundColor',
};

// ─── Raw-value properties (slider+input, select, color, or text) ─────────

type RawPropType = 'numeric' | 'color' | 'text' | 'select' | 'dimension';
interface RawPropDef { key: string; label: string; type: RawPropType; min?: number; max?: number; step?: number; defaultValue: string; options?: { value: string; label: string }[] }

const POSITION_OPTIONS = [
  { value: 'absolute', label: 'Absolute' },
  { value: 'relative', label: 'Relative' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'sticky', label: 'Sticky' },
];

const POINTER_EVENTS_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'auto', label: 'Auto' },
];

const DIMENSION_UNIT_OPTIONS = [
  { value: 'px', label: 'px' },
  { value: '%', label: '%' },
  { value: 'rem', label: 'rem' },
  { value: 'vw', label: 'vw' },
  { value: 'vh', label: 'vh' },
  { value: 'auto', label: 'auto' },
];

const BLEND_MODE_OPTIONS = [
  { value: 'normal', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'color-burn', label: 'Color Burn' },
  { value: 'hard-light', label: 'Hard Light' },
  { value: 'soft-light', label: 'Soft Light' },
  { value: 'difference', label: 'Difference' },
  { value: 'exclusion', label: 'Exclusion' },
];

const RAW_PROPS: RawPropDef[] = [
  { key: 'content', label: 'Content', type: 'text', defaultValue: "''" },
  { key: 'position', label: 'Position', type: 'select', defaultValue: 'absolute', options: POSITION_OPTIONS },
  { key: 'inset', label: 'Inset', type: 'text', defaultValue: '0' },
  { key: 'top', label: 'Top', type: 'numeric', min: -500, max: 500, step: 1, defaultValue: '0' },
  { key: 'left', label: 'Left', type: 'numeric', min: -500, max: 500, step: 1, defaultValue: '0' },
  { key: 'right', label: 'Right', type: 'numeric', min: -500, max: 500, step: 1, defaultValue: '0' },
  { key: 'bottom', label: 'Bottom', type: 'numeric', min: -500, max: 500, step: 1, defaultValue: '0' },
  { key: 'width', label: 'Width', type: 'dimension', defaultValue: '100%' },
  { key: 'height', label: 'Height', type: 'dimension', defaultValue: '100%' },
  { key: 'color', label: 'Color', type: 'color', defaultValue: '#ffffff' },
  { key: 'zIndex', label: 'Z-Index', type: 'numeric', min: -10, max: 100, step: 1, defaultValue: '1' },
  { key: 'mixBlendMode', label: 'Blend Mode', type: 'select', defaultValue: 'normal', options: BLEND_MODE_OPTIONS },
  { key: 'pointerEvents', label: 'Pointer Events', type: 'select', defaultValue: 'none', options: POINTER_EVENTS_OPTIONS },
  { key: 'fontSize', label: 'Font Size', type: 'numeric', min: 0, max: 200, step: 1, defaultValue: '16px' },
  { key: 'fontFamily', label: 'Font Family', type: 'text', defaultValue: 'inherit' },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function stylesToCSS(styles: Record<string, string>): string {
  return Object.entries(styles)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${toKebab(k)}: ${v} !important`)
    .join('; ');
}

function buildSummary(styles: Record<string, string>): string {
  const count = Object.keys(styles).filter(k => styles[k] !== '').length;
  return `${count} style${count !== 1 ? 's' : ''}`;
}

/** Parse numeric value from CSS string like "2px", "-10", "50%" */
function parseNum(raw: string): number {
  return parseFloat(raw) || 0;
}

/** Normalize text-shadow to "Xpx Ypx BLURpx COLOR" format that TextShadowControl expects.
 *  AI often generates "-1px 0 #FF0033" (no blur, no px on zero). */
function normalizeTextShadow(raw: string): string {
  if (!raw || raw === 'none') return 'none';
  // Match: X Y [blur] color — where values may lack px units
  const m = raw.match(/(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+(?:(-?[\d.]+)(?:px)?\s+)?(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))/);
  if (!m) return raw;
  const x = m[1], y = m[2], blur = m[3] || '0', color = m[4];
  return `${x}px ${y}px ${blur}px ${color}`;
}

// ─── Animation editor panel ────────────────────────────────────────────────

function AnimationEditorPanel({ initialValue, onCommit }: { initialValue: string; onCommit: (v: string) => void }) {
  const keyframeNames = useAtomValue(keyframeNamesAtom);
  const parsed = parseAnimationShorthand(initialValue);
  const initial = parsed[0] || { keyframeName: '', duration: 1, easing: 'ease', delay: 0, iterationCount: '1', direction: 'normal', fillMode: 'none' };
  const [vals, setVals] = useState(initial);

  const update = (patch: Partial<typeof vals>) => {
    const next = { ...vals, ...patch };
    setVals(next);
    if (!next.keyframeName) { onCommit('none'); return; }
    onCommit(formatAnimationShorthand([next]));
  };

  const nameOptions = [
    { value: '', label: 'None' },
    ...keyframeNames.map(n => ({ value: n, label: n })),
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <ControlLabel label="Keyframe" property="" plain />
        <div className="w-full">
          <ToolSelect value={vals.keyframeName} onChange={(v) => update({ keyframeName: v })} options={nameOptions} />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <ControlLabel label="Duration" property="" plain />
        <div className="flex items-center gap-1 w-full">
          <ToolSlider value={vals.duration} min={0} max={10} step={0.1} onChange={(v) => update({ duration: v })} />
          <ToolInput value={`${vals.duration}s`} onChange={(v) => update({ duration: parseFloat(v) || 0 })} step={0.1} />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <ControlLabel label="Easing" property="" plain />
        <div className="w-full">
          <ToolSelect value={vals.easing} onChange={(v) => update({ easing: v })} options={CSS_EASING_OPTIONS} />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <ControlLabel label="Delay" property="" plain />
        <div className="flex items-center gap-1 w-full">
          <ToolSlider value={vals.delay} min={0} max={5} step={0.1} onChange={(v) => update({ delay: v })} />
          <ToolInput value={`${vals.delay}s`} onChange={(v) => update({ delay: parseFloat(v) || 0 })} step={0.1} />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <ControlLabel label="Iterations" property="" plain />
        <div className="w-full">
          <ToolSelect value={vals.iterationCount} onChange={(v) => update({ iterationCount: v })} options={CSS_ITERATION_OPTIONS} />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <ControlLabel label="Direction" property="" plain />
        <div className="w-full">
          <ToolSelect value={vals.direction} onChange={(v) => update({ direction: v })} options={CSS_DIRECTION_OPTIONS} />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <ControlLabel label="Fill Mode" property="" plain />
        <div className="w-full">
          <ToolSelect value={vals.fillMode} onChange={(v) => update({ fillMode: v })} options={CSS_FILL_OPTIONS} />
        </div>
      </div>
    </div>
  );
}

/** Animation row — shows keyframe name summary, opens editor panel */
function AnimationRow({ value, onChange, onRemove }: {
  value: string; onChange: (v: string) => void; onRemove: () => void;
}) {
  const popupCtx = useToolPopupOptional();
  const parsed = parseAnimationShorthand(value);
  const summary = parsed.length > 0 ? animationSummary(parsed) : 'None';

  const handleClick = () => {
    if (popupCtx?.pushPanel) {
      popupCtx.pushPanel('Animation', <AnimationEditorPanel initialValue={value} onCommit={onChange} />);
    }
  };

  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label="Animation" property="" plain />
      <ControlActionRow onClick={handleClick}>
        <span className="truncate flex-1">{summary}</span>
        <RemoveButton onClick={(e) => { e.stopPropagation(); onRemove(); }} />
      </ControlActionRow>
    </div>
  );
}

// ─── Raw property row — renders slider+input for numeric, ColorInput for color, ToolInput for text

function RawPropertyRow({ def, value, onChange, onRemove }: {
  def: RawPropDef; value: string; onChange: (v: string) => void; onRemove: () => void;
}) {
  const unit = value.replace(/^-?[\d.]+/, '') || '';

  if (def.type === 'color') {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label={def.label} property="" plain />
        <div className="w-full">
          <ControlActionRow onClick={undefined}>
            <ColorInput value={value} onChange={onChange} />
            <RemoveButton onClick={onRemove} />
          </ControlActionRow>
        </div>
      </div>
    );
  }

  if (def.type === 'select' && def.options) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label={def.label} property="" plain />
        <div className="flex items-center gap-1 w-full">
          <div className="flex-1">
            <ToolSelect value={value} onChange={onChange} options={def.options} />
          </div>
          <RemoveButton onClick={onRemove} />
        </div>
      </div>
    );
  }

  if (def.type === 'dimension') {
    const numVal = value === 'auto' ? '' : String(parseFloat(value) || 0);
    const unitVal = value === 'auto' ? 'auto' : (value.replace(/^-?[\d.]+/, '') || 'px');
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label={def.label} property="" plain />
        <div className="flex items-center gap-1 w-full">
          <div className="flex-1">
            <ToolInput
              value={numVal}
              onChange={(v) => {
                if (unitVal === 'auto') onChange('auto');
                else onChange(`${parseFloat(v) || 0}${unitVal}`);
              }}
              step={1}
              disabled={unitVal === 'auto'}
            />
          </div>
          <div className="flex-1">
            <ToolSelect
              value={unitVal}
              onChange={(u) => {
                if (u === 'auto') onChange('auto');
                else onChange(`${parseFloat(numVal) || 0}${u}`);
              }}
              options={DIMENSION_UNIT_OPTIONS}
            />
          </div>
          <RemoveButton onClick={onRemove} />
        </div>
      </div>
    );
  }

  if (def.type === 'numeric') {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label={def.label} property="" plain />
        <div className="flex items-center gap-1 w-full">
          <ToolSlider value={parseNum(value)} min={def.min ?? -500} max={def.max ?? 500} step={def.step ?? 1}
            onChange={(v) => onChange(`${v}${unit || 'px'}`)} />
          <ToolInput value={value} onChange={onChange} />
          <RemoveButton onClick={onRemove} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label={def.label} property="" plain />
      <div className="flex items-center gap-1 w-full">
        <div className="flex-1">
          <ToolInput value={value} onChange={onChange} />
        </div>
        <RemoveButton onClick={onRemove} />
      </div>
    </div>
  );
}

// ─── PseudoEditor (inside ToolPopup) ────────────────────────────────────────

function PseudoEditor({ nodeId, pseudo, styles }: {
  nodeId: string; pseudo: 'before' | 'after'; styles: Record<string, string>;
}) {
  const popupCtx = useToolPopupOptional();
  const pushPanel = popupCtx?.pushPanel;
  const popPanel = popupCtx?.popPanel;
  const [localStyles, setLocalStyles] = useState<Record<string, string>>(() => ({ ...styles }));
  const localRef = useRef(localStyles);
  localRef.current = localStyles;
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // External re-seed (undo/redo while the pseudo editor is open). Own
  // commits are debounced writes counted by selfWriteRef — skipped so
  // mid-typing state is never clobbered by the round-trip.
  const stylesSig = JSON.stringify(styles);
  const selfWriteRef = useRef(0);
  const prevStylesSigRef = useRef(stylesSig);
  useEffect(() => {
    if (stylesSig === prevStylesSigRef.current) return;
    prevStylesSigRef.current = stylesSig;
    if (selfWriteRef.current > 0) { selfWriteRef.current--; return; }
    setLocalStyles({ ...styles });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stylesSig]);

  trace.fn('PseudoEditor:render', { nodeId, pseudo, propCount: Object.keys(localStyles).length });

  // Live preview via injectCanvasCSS
  useEffect(() => {
    const selector = `[data-id="${nodeId}"]::${pseudo}`;
    const css = stylesToCSS(localRef.current);
    if (css) injectCanvasCSS(selector, css);
    return () => {
      removeCanvasCSS(selector);
      if (writeTimerRef.current !== null) {
        clearTimeout(writeTimerRef.current);
        writeTimerRef.current = null;
        doWrite(localRef.current);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const selector = `[data-id="${nodeId}"]::${pseudo}`;
    const css = stylesToCSS(localStyles);
    if (css) injectCanvasCSS(selector, css);
  }, [localStyles, nodeId, pseudo]);

  const doWrite = useCallback((s: Record<string, string>) => {
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(s)) { if (v) filtered[k] = v; }
    queueMutation({ type: 'updatePseudoStyle', nodeId, pseudo, styles: filtered });
    trace.action('pseudo-editor:write', { nodeId, pseudo, propCount: Object.keys(filtered).length });
  }, [nodeId, pseudo]);

  const scheduleWrite = useCallback((s: Record<string, string>) => {
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => { writeTimerRef.current = null; selfWriteRef.current++; doWrite(s); }, 400);
  }, [doWrite]);

  const handleChange = useCallback((newStyles: Record<string, string>) => {
    setLocalStyles(newStyles);
    scheduleWrite(newStyles);
  }, [scheduleWrite]);

  // Mode props for ToolAtom controls — route through stopProps/onStopChange
  const mp: AtomProps = { mode: 'scrollStop' as const, stopProps: localStyles, onStopChange: handleChange };

  // Determine which ToolAtom keys are active
  const allKeys = new Set(Object.keys(localStyles));
  for (const key of [...allKeys]) {
    if (SUB_PROPERTY_MAP[key]) allKeys.add(SUB_PROPERTY_MAP[key]);
  }
  const activeAtomKeys = [...allKeys].filter(k => ADDABLE_STYLE_ATOMS.some(a => a.key === k));
  const activeRawProps = RAW_PROPS.filter(p => allKeys.has(p.key));
  const hasTextShadow = allKeys.has('textShadow');
  const hasAnimation = allKeys.has('animation');

  // Available to add
  const availableAtoms = ADDABLE_STYLE_ATOMS.filter(a => !allKeys.has(a.key));
  const availableRaw = RAW_PROPS.filter(p => !allKeys.has(p.key));
  const canAddTextShadow = !hasTextShadow;
  const canAddAnimation = !hasAnimation;

  return (
    <div className="flex flex-col gap-2">
      {/* Raw value properties — slider+input, color, or text rows */}
      {activeRawProps.map((def) => (
        <RawPropertyRow
          key={def.key}
          def={def}
          value={localStyles[def.key] || ''}
          onChange={(v) => handleChange({ ...localRef.current, [def.key]: v })}
          onRemove={() => {
            const updated = { ...localRef.current };
            delete updated[def.key];
            handleChange(updated);
            trace.action('pseudo-editor:remove-property', { nodeId, pseudo, property: def.key });
          }}
        />
      ))}

      {/* Text Shadow — standalone control, renders its own label + row */}
      {hasTextShadow && (
        <TextShadowControl
          value={normalizeTextShadow(localStyles.textShadow || 'none')}
          onChange={(v) => handleChange({ ...localRef.current, textShadow: v })}
        />
      )}

      {/* Animation — keyframe selector + timing controls */}
      {hasAnimation && (
        <AnimationRow
          value={localStyles.animation || 'none'}
          onChange={(v) => handleChange({ ...localRef.current, animation: v })}
          onRemove={() => {
            const updated = { ...localRef.current };
            delete updated.animation;
            handleChange(updated);
          }}
        />
      )}

      {/* ToolAtom-backed properties — reuse centralized controls */}
      {activeAtomKeys.map(key => {
        const entry = ADDABLE_STYLE_ATOMS.find(a => a.key === key);
        if (!entry) return null;
        return <entry.Atom key={key} {...mp} />;
      })}

      {/* Add Property button — same width pattern as other rows.
          Empty ControlLabel claims the chevron-gutter space so the right
          column lines up; `<div className="w-full">` wrapper makes the
          button fill the column instead of shrinking to content. */}
      {(availableAtoms.length > 0 || availableRaw.length > 0 || canAddTextShadow || canAddAnimation) && (
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="" property="" plain />
          <div className="w-full">
          <button onClick={() => {
            const addList = (
              <div className="flex flex-col gap-1 max-h-[320px] overflow-y-auto">
                {availableRaw.map(({ key, label, defaultValue }) => (
                  <button key={key}
                    onClick={() => {
                      handleChange({ ...localRef.current, [key]: defaultValue });
                      popPanel?.();
                      trace.action('pseudo-editor:add-property', { nodeId, pseudo, property: key });
                    }}
                    className="w-full h-[var(--control-height)] shrink-0 flex items-center gap-2 px-2 bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] cursor-pointer transition-colors text-xs text-[var(--text-primary)]">
                    {(() => { const I = getPropertyIcon(key); return <I width={20} height={20} className="shrink-0" />; })()}
                    {label}
                  </button>
                ))}
                {canAddTextShadow && (
                  <button
                    onClick={() => {
                      handleChange({ ...localRef.current, textShadow: 'none' });
                      popPanel?.();
                      trace.action('pseudo-editor:add-property', { nodeId, pseudo, property: 'textShadow' });
                    }}
                    className="w-full h-[var(--control-height)] shrink-0 flex items-center gap-2 px-2 bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] cursor-pointer transition-colors text-xs text-[var(--text-primary)]">
                    {(() => { const I = getPropertyIcon('textShadow'); return <I width={20} height={20} className="shrink-0" />; })()}
                    Text Shadow
                  </button>
                )}
                {canAddAnimation && (
                  <button
                    onClick={() => {
                      handleChange({ ...localRef.current, animation: 'none' });
                      popPanel?.();
                      trace.action('pseudo-editor:add-property', { nodeId, pseudo, property: 'animation' });
                    }}
                    className="w-full h-[var(--control-height)] shrink-0 flex items-center gap-2 px-2 bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] cursor-pointer transition-colors text-xs text-[var(--text-primary)]">
                    {(() => { const I = getPropertyIcon('animation'); return <I width={20} height={20} className="shrink-0" />; })()}
                    Animation
                  </button>
                )}
                {availableAtoms.map(({ key, label }) => (
                  <button key={key}
                    onClick={() => {
                      const defaults: Record<string, string> = {
                        backgroundColor: 'transparent', opacity: '1', borderRadius: '0',
                        clipPath: 'none', filter: 'none', boxShadow: 'none',
                        border: 'none', maskImage: 'none', transform: 'none',
                      };
                      handleChange({ ...localRef.current, [key]: defaults[key] || '0' });
                      popPanel?.();
                      trace.action('pseudo-editor:add-property', { nodeId, pseudo, property: key });
                    }}
                    className="w-full h-[var(--control-height)] shrink-0 flex items-center gap-2 px-2 bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] cursor-pointer transition-colors text-xs text-[var(--text-primary)]">
                    {(() => { const I = getPropertyIcon(key); return <I width={20} height={20} className="shrink-0" />; })()}
                    {label}
                  </button>
                ))}
              </div>
            );
            if (pushPanel) pushPanel('Add Property', addList);
          }}
            className="w-full h-[var(--control-height)] flex items-center justify-center text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] cursor-pointer transition-colors">
            + Add Property
          </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Pseudo entry row inside the popup (::before or ::after) ───────────────

function PseudoEntryRow({ nodeId, pseudo, styles, pushPanel }: {
  nodeId: string; pseudo: 'before' | 'after'; styles: Record<string, string> | undefined;
  pushPanel: (title: string, content: React.ReactNode) => void;
}) {
  const hasStyles = !!styles && Object.keys(styles).length > 0;

  const handleAdd = () => {
    const defaults: Record<string, string> = {
      content: "''",
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
    };
    queueMutation({ type: 'updatePseudoStyle', nodeId, pseudo, styles: defaults });
    trace.action('pseudo-entry:add', { nodeId, pseudo });
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    queueMutation({ type: 'removePseudo', nodeId, pseudo });
    removeCanvasCSS(`[data-id="${nodeId}"]::${pseudo}`);
    trace.action('pseudo-entry:remove', { nodeId, pseudo });
  };

  const openEditor = () => {
    if (hasStyles) {
      pushPanel(`::${pseudo}`, <PseudoEditor nodeId={nodeId} pseudo={pseudo} styles={styles!} />);
    } else {
      handleAdd();
    }
  };

  return (
    <SingleEntryRow
      label={`::${pseudo}`} property="" plain
      hasValue={hasStyles}
      onOpen={openEditor}
      EmptyIcon={PseudoIcon}
      renderPreview={() => <span className="truncate flex-1">{buildSummary(styles!)}</span>}
      onRemove={handleRemove}
    />
  );
}

// ─── Main popup content ────────────────────────────────────────────────────

function PseudoPopupContent({ nodeId }: { nodeId: string }) {
  const pseudoStyles = useAtomValue(pseudoStylesAtom);
  const popupCtx = useToolPopupOptional();
  const nodeStyles = pseudoStyles.get(nodeId);

  if (!popupCtx?.pushPanel) return null;

  return (
    <div className="flex flex-col gap-2">
      <PseudoEntryRow nodeId={nodeId} pseudo="before" styles={nodeStyles?.before} pushPanel={popupCtx.pushPanel} />
      <PseudoEntryRow nodeId={nodeId} pseudo="after" styles={nodeStyles?.after} pushPanel={popupCtx.pushPanel} />
    </div>
  );
}

// ─── Main export ────────────────────────────────────────────────────────────

/** Single "Pseudo Styles" row → opens popup with ::before / ::after entries that slide into editors. */
export function PseudoElementControl() {
  const { node } = useControl();
  const pseudoStyles = useAtomValue(pseudoStylesAtom);
  const [isOpen, setIsOpen] = useState(false);
  const btnRef = useRef<HTMLSpanElement>(null);

  if (!node) return null;

  const nodeId = node.id;
  const nodeStyles = pseudoStyles.get(nodeId);
  const hasBefore = !!nodeStyles?.before && Object.keys(nodeStyles.before).length > 0;
  const hasAfter = !!nodeStyles?.after && Object.keys(nodeStyles.after).length > 0;
  const hasAny = hasBefore || hasAfter;

  const summary = hasAny
    ? [hasBefore && '::before', hasAfter && '::after'].filter(Boolean).join(', ')
    : '';

  trace.fn('PseudoElementControl:render', { nodeId, hasBefore, hasAfter });

  return (
    <>
      <SingleEntryRow
        label="Pseudo" property="" plain
        hasValue={hasAny}
        onOpen={() => setIsOpen(!isOpen)}
        anchorRef={btnRef}
        EmptyIcon={PseudoIcon}
        renderPreview={() => <span className="truncate flex-1">{summary}</span>}
      />

      <ToolPopup isOpen={isOpen} onClose={() => setIsOpen(false)} title="Pseudo Styles" anchorRef={btnRef}>
        <PseudoPopupContent nodeId={nodeId} />
      </ToolPopup>
    </>
  );
}
