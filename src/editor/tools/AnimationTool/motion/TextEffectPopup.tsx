// TextEffectPopup.tsx — Main text animation editor popup.
// Reuses MotionPropsEditor for properties (same controls as hover/tap/appear).
// Adds preset dropdown, split type selector, stagger delay, transition row.

import { useCallback } from 'react';
import { ToolSelect, ToolSegmentedControl, ControlLabel, ControlActionRow } from '../../../controls';
import { useToolPopup } from '../../../ui/ToolPopup';
import { SliderRow } from '../shared';
import { summarizeTransition, TransitionCurveIcon } from '../CurvePreview';
import TransitionPanel from '../TransitionPanel';
import MotionPropsEditor from './MotionPropsEditor';
import TextEffectPreview from './TextEffectPreview';
import {
  type TextAnimConfig,
  type TextAnimScope,
  TEXT_ANIM_PRESETS,
  ANIM_TYPE_OPTIONS,
  detectTextAnimPreset,
  resolveTextAnimForScope,
  setTextAnimScoped,
} from './text-anim-presets';
import { trace } from '@/shared/debug-trace';

// ─── Config ↔ Record<string, string> conversion ─────────────────────────────

/** Convert TextAnimConfig to Record<string, string> for MotionPropsEditor */
function configToMotionProps(config: TextAnimConfig): Record<string, string> {
  const props: Record<string, string> = {};
  if (config.opacity !== undefined && config.opacity !== 1) props.opacity = String(config.opacity);
  if (config.scale !== undefined && config.scale !== 1) props.scale = String(config.scale);
  if (config.blur !== undefined && config.blur !== 0) props.filter = `blur(${config.blur}px)`;
  if (config.rotateX !== undefined && config.rotateX !== 0) props.rotateX = String(config.rotateX);
  if (config.rotateY !== undefined && config.rotateY !== 0) props.rotateY = String(config.rotateY);
  if (config.rotateZ !== undefined && config.rotateZ !== 0) props.rotate = String(config.rotateZ);
  if (config.skewX !== undefined && config.skewX !== 0) props.skewX = String(config.skewX);
  if (config.skewY !== undefined && config.skewY !== 0) props.skewY = String(config.skewY);
  if (config.x !== undefined && config.x !== 0) props.x = String(config.x);
  if (config.y !== undefined && config.y !== 0) props.y = String(config.y);
  return props;
}

/** Convert MotionPropsEditor output back to TextAnimConfig fields */
/** Offsets keep their UNIT. A percentage resolves against the unit's OWN box, which is what makes a
 *  masked reveal work at every type size — `parseFloat` would turn '100%' into 100 pixels and quietly
 *  break the mask everywhere but the breakpoint it was authored at. */
function parseOffset(v: string): number | string {
  const s = String(v).trim();
  return s.endsWith('%') ? s : parseFloat(s);
}

function motionPropsToConfig(props: Record<string, string>, prev: TextAnimConfig): TextAnimConfig {
  const config = { ...prev };
  config.opacity = props.opacity !== undefined ? parseFloat(props.opacity) : 1;
  config.scale = props.scale !== undefined ? parseFloat(props.scale) : 1;
  config.x = props.x !== undefined ? parseOffset(props.x) : 0;
  config.y = props.y !== undefined ? parseOffset(props.y) : 0;
  config.rotateX = props.rotateX !== undefined ? parseFloat(props.rotateX) : 0;
  config.rotateY = props.rotateY !== undefined ? parseFloat(props.rotateY) : 0;
  config.rotateZ = props.rotate !== undefined ? parseFloat(props.rotate) : 0;
  config.skewX = props.skewX !== undefined ? parseFloat(props.skewX) : 0;
  config.skewY = props.skewY !== undefined ? parseFloat(props.skewY) : 0;
  // Parse blur from filter: "blur(Xpx)"
  if (props.filter) {
    const m = props.filter.match(/blur\((\d+(?:\.\d+)?)px\)/);
    config.blur = m ? parseFloat(m[1]) : 0;
  } else {
    config.blur = 0;
  }
  return config;
}

/** Convert TextAnimConfig.transition to Record<string, string> for TransitionPanel */
function transitionToRecord(t?: TextAnimConfig['transition']): Record<string, string> {
  if (!t) return { type: 'spring', stiffness: '300', damping: '30' };
  const result: Record<string, string> = {};
  if (t.type) result.type = t.type;
  if (t.stiffness !== undefined) result.stiffness = String(t.stiffness);
  if (t.damping !== undefined) result.damping = String(t.damping);
  if (t.mass !== undefined) result.mass = String(t.mass);
  if (t.duration !== undefined) result.duration = String(t.duration);
  if (t.ease) result.ease = t.ease;
  if (t.bounce !== undefined) result.bounce = String(t.bounce);
  if (t.delay !== undefined) result.delay = String(t.delay);
  return result;
}

/** Convert TransitionPanel output back to TextAnimConfig.transition */
function recordToTransition(t: Record<string, string>): TextAnimConfig['transition'] {
  const transition: TextAnimConfig['transition'] = {};
  if (t.type) transition.type = t.type as 'spring' | 'tween';
  if (t.stiffness) transition.stiffness = parseFloat(t.stiffness);
  if (t.damping) transition.damping = parseFloat(t.damping);
  if (t.mass) transition.mass = parseFloat(t.mass);
  if (t.duration) transition.duration = parseFloat(t.duration);
  if (t.ease) transition.ease = t.ease;
  if (t.bounce) transition.bounce = parseFloat(t.bounce);
  if (t.delay) transition.delay = parseFloat(t.delay);
  return transition;
}

// ─── Component ───────────────────────────────────────────────────────────────

interface TextEffectPopupProps {
  nodeId: string;
  /** The FULL base config (incl. `responsive`). The popup resolves it for the active scope for display
   *  and folds edits back via setTextAnimScoped, returning the merged full config to `onChange`. */
  config: TextAnimConfig;
  /** Active tile scope (null = primary/desktop = base). Value edits on a scope write a per-scope override
   *  (the blue reset); structural edits (Split/Play) always fold into the base. */
  scope?: TextAnimScope | null;
  onChange: (config: TextAnimConfig) => void;
}

export default function TextEffectPopup({ nodeId, config, scope = null, onChange }: TextEffectPopupProps) {
  const { pushPanel } = useToolPopup();

  // `view` = base ⊕ this scope's override — every control renders from it.
  const view = resolveTextAnimForScope(config, scope);
  trace.fn('TextEffectPopup:render', { animationType: view.animationType, scoped: !!scope });

  // `emit` folds an edited resolved-config back into the full base+responsive spec for the active scope.
  const emit = useCallback((next: TextAnimConfig) => onChange(setTextAnimScoped(config, next, scope)), [config, scope, onChange]);

  const activePreset = detectTextAnimPreset(view);
  const transitionRecord = transitionToRecord(view.transition);

  // MotionPropsEditor onChange → update config (scoped via emit)
  const handleMotionPropsChange = useCallback((newProps: Record<string, string>) => {
    const next = motionPropsToConfig(newProps, view);
    trace.action('text-effect:props-change', { keys: Object.keys(newProps), scoped: !!scope });
    emit(next);
  }, [view, scope, emit]);

  // Transition panel write
  const handleTransitionWrite = useCallback((t: Record<string, string>) => {
    emit({ ...view, transition: recordToTransition(t) });
    trace.action('text-effect:transition-write', { type: t.type });
  }, [view, emit]);

  const presetOptions = TEXT_ANIM_PRESETS.map(p => ({ value: p.name, label: p.name }));
  if (!activePreset) presetOptions.push({ value: '__custom', label: 'Custom' });

  // Transition row (passed to MotionPropsEditor as transitionRow)
  const transitionRow = (
    <>
      <SliderRow label="Stagger" value={view.delay ?? 0.05} min={0} max={2} step={0.01}
        onChange={(v) => emit({ ...view, delay: v })} suffix="s" />
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Transition" property="" plain />
        <ControlActionRow onClick={() => pushPanel('Transition', (
          <TransitionPanel initialTransition={transitionRecord} onWrite={handleTransitionWrite} />
        ))}>
          <TransitionCurveIcon isSpring={view.transition?.type === 'spring'} />
          <span className="truncate flex-1">{summarizeTransition(transitionRecord)}</span>
        </ControlActionRow>
      </div>
    </>
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Live Preview */}
      <TextEffectPreview config={view} />

      {/* Preset */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Preset" property="" plain />
        <div className="w-full">
          <ToolSelect
            value={activePreset ?? '__custom'}
            onChange={(name) => {
              const preset = TEXT_ANIM_PRESETS.find(p => p.name === name);
              if (preset) {
                trace.action('text-effect:preset', { name, scoped: !!scope });
                emit({ ...preset.config, animationType: view.animationType, delay: view.delay, trigger: view.trigger, scrollStart: view.scrollStart, scrollEnd: view.scrollEnd });
              }
            }}
            options={presetOptions}
          />
        </div>
      </div>

      {/* Animation Type */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Split" property="" plain />
        <div className="w-full">
          <ToolSelect
            value={view.animationType}
            onChange={(v) => emit({ ...view, animationType: v as TextAnimConfig['animationType'] })}
            options={ANIM_TYPE_OPTIONS}
          />
        </div>
      </div>

      {/* Mask — clip each unit so it slides out from BEHIND the line ("cut-off" reveal) instead of
          floating in from open space. Structural (it adds a wrapper element), so it lives on the base
          config and is stored in data-text-anim — otherwise any regeneration drops it. */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Mask" property="" plain />
        <div className="w-full">
          <ToolSegmentedControl
            value={view.mask ? 'on' : 'off'}
            onChange={(v) => {
              trace.action('text-effect:mask', { on: v === 'on', scoped: !!scope });
              emit({ ...view, mask: v === 'on' });
            }}
            options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]}
            size="sm"
          />
        </div>
      </div>

      {/* Play — View (reveal once on enter) vs Scroll (reveal scrubbed to scroll progress) */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Play" property="" plain />
        <div className="w-full">
          <ToolSegmentedControl
            value={view.trigger ?? 'view'}
            onChange={(v) => emit({ ...view, trigger: v as 'view' | 'scroll' })}
            options={[{ value: 'view', label: 'View' }, { value: 'scroll', label: 'Scroll' }]}
            size="sm"
          />
        </div>
      </div>

      {/* Scroll behavior — only in scroll mode. Start/End = viewport position (% from top) of the
          element's top edge when the reveal begins / completes. Default 90 (entering from bottom) → 35. */}
      {view.trigger === 'scroll' && (
        <>
          <SliderRow label="Start" value={view.scrollStart ?? 90} min={0} max={100} step={5}
            onChange={(v) => emit({ ...view, scrollStart: v })} suffix="%" />
          <SliderRow label="End" value={view.scrollEnd ?? 35} min={0} max={100} step={5}
            onChange={(v) => emit({ ...view, scrollEnd: v })} suffix="%" />
        </>
      )}

      {/* Properties — reuses full MotionPropsEditor with all ToolAtom controls */}
      <MotionPropsEditor
        nodeId={nodeId}
        props={configToMotionProps(view)}
        onChange={handleMotionPropsChange}
        preview={false}
        mode="motionVariant"
        transitionRow={transitionRow}
      />
    </div>
  );
}
