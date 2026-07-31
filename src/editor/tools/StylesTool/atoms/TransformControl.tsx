// TransformControl.tsx — Self-contained transform ToolAtom.
// Wraps the existing transform popup with UnifiedControlProvider.
// In direct mode, renders popup button.

import { useState, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { ToolInput, ToolSlider, ToolSegmentedControl, ControlLabel, ControlActionRow, RemoveButton } from '../../../controls';
import { TransformIcon } from '@/design-system/PropertyIcons';
import { YES_NO_OPTIONS } from '../../../controls/css-property-options';
import { UnifiedControlProvider, ControlRow, useControlContext } from '../../../controls/unified';
import ToolPopup from '../../../ui/ToolPopup';
import type { AtomProps } from '../../../controls/unified/types';
import { activeFilePathAtom, isComponentFilePath } from '@/code/project/active-file-store';
import { isReplicaViewportAtom, isComponentVariantViewportAtom } from '@/code/stores/viewport-store';
import { trace } from '@/shared/debug-trace';

// ─── Transform parse/format (from existing TransformControl.tsx) ─────────────

interface TransformData {
  rotateZ: number; rotateX: number; rotateY: number;
  scaleX: number; scaleY: number;
  skewX: number; skewY: number;
  perspective: number;
  rest: string;
}

/**
 * The value a transform field commits.
 *
 * `neutral` is the value at which the prop can be DROPPED on a BASE write — 0
 * for rotate/skew/perspective, 1 for scale — because an absent prop and its
 * neutral value render identically.
 *
 * That equivalence does NOT hold for a SCOPED write. On a non-default variant
 * (or a page replica) an empty value means "reset this override", so the tile
 * falls back to the BASE — and if the base is rotated, typing 0 silently reverts
 * to the base angle instead of applying 0. Reported on variant-4 of a master
 * whose default rotates 90°: the field snapped back every time (user trace
 * 2026-07-26 — `control:update-style {rotate: ""}` → `updateVariantStyleInCode
 * { rotate: "" }` → key deleted). Scoped writes emit the EXPLICIT neutral.
 *
 * Same root cause as the rotate HANDLE's 0° bug (RotateManager's
 * `commitVariantRotation`) — a third path into the same trap. The popup's ×
 * (clear ALL transforms) deliberately keeps writing '' : that IS a reset.
 */
export function transformFieldValue(n: number, neutral: number, isScopedWrite: boolean): string {
  return n === neutral && !isScopedWrite ? '' : String(n);
}

function parseTransform(raw: string | undefined): TransformData {
  const def: TransformData = { rotateZ: 0, rotateX: 0, rotateY: 0, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0, perspective: 0, rest: '' };
  if (!raw || raw === 'none') return def;
  let rest = raw;
  const extract = (re: RegExp): number | null => {
    const m = rest.match(re);
    if (!m) return null;
    rest = rest.replace(m[0], '').trim();
    return parseFloat(m[1]);
  };

  const perspective = extract(/perspective\(\s*(-?[\d.]+)px\s*\)/) ?? 0;
  const rotateZ = extract(/rotateZ\(\s*(-?[\d.]+)deg\s*\)/) ?? extract(/rotate\(\s*(-?[\d.]+)deg\s*\)/) ?? 0;
  const rotateX = extract(/rotateX\(\s*(-?[\d.]+)deg\s*\)/) ?? 0;
  const rotateY = extract(/rotateY\(\s*(-?[\d.]+)deg\s*\)/) ?? 0;
  let scaleX = extract(/scaleX\(\s*(-?[\d.]+)\s*\)/);
  let scaleY = extract(/scaleY\(\s*(-?[\d.]+)\s*\)/);
  const scaleMatch = rest.match(/scale\(\s*(-?[\d.]+)(?:\s*,\s*(-?[\d.]+))?\s*\)/);
  if (scaleMatch) {
    rest = rest.replace(scaleMatch[0], '').trim();
    if (scaleX === null) scaleX = parseFloat(scaleMatch[1]);
    if (scaleY === null) scaleY = parseFloat(scaleMatch[2] ?? scaleMatch[1]);
  }
  const skewX = extract(/skewX\(\s*(-?[\d.]+)deg\s*\)/) ?? 0;
  const skewY = extract(/skewY\(\s*(-?[\d.]+)deg\s*\)/) ?? 0;

  return { rotateZ, rotateX, rotateY, scaleX: scaleX ?? 1, scaleY: scaleY ?? 1, skewX, skewY, perspective, rest: rest.trim() };
}

function formatTransform(v: TransformData): string {
  const parts: string[] = [];
  if (v.perspective > 0) parts.push(`perspective(${v.perspective}px)`);
  if (v.rest) parts.push(v.rest);
  if (v.rotateZ !== 0) parts.push(`rotate(${v.rotateZ}deg)`);
  if (v.rotateX !== 0) parts.push(`rotateX(${v.rotateX}deg)`);
  if (v.rotateY !== 0) parts.push(`rotateY(${v.rotateY}deg)`);
  if (v.scaleX !== 1 || v.scaleY !== 1) {
    if (v.scaleX === v.scaleY) parts.push(`scale(${v.scaleX})`);
    else parts.push(`scaleX(${v.scaleX})`, `scaleY(${v.scaleY})`);
  }
  if (v.skewX !== 0) parts.push(`skewX(${v.skewX}deg)`);
  if (v.skewY !== 0) parts.push(`skewY(${v.skewY}deg)`);
  return parts.join(' ') || 'none';
}

// Matches every flavour of translate (`translate`, `translateX`, `translateY`,
// `translateZ`, `translate3d`). The Transform control intentionally ignores
// translates — they're managed by the position/anchor system (e.g. centering
// with `translate(-50%, -50%)`) and should NOT be surfaced as an editable
// transform here.
const TRANSLATE_RE = /translate(?:3d|X|Y|Z)?\([^)]*\)/g;

function stripTranslates(raw: string | undefined): string {
  if (!raw) return '';
  return raw.replace(TRANSLATE_RE, '').replace(/\s+/g, ' ').trim();
}

function extractTranslates(raw: string | undefined): string {
  if (!raw) return '';
  return (raw.match(TRANSLATE_RE) || []).join(' ').trim();
}

// ─── Atom ────────────────────────────────────────────────────────────────────

/** Read a numeric motion-prop value, or null when absent/empty. */
function numOr(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = parseFloat(String(raw));
  return Number.isFinite(n) ? n : null;
}

function TransformAtom() {
  const { value, onChange, onChangeLive, node, onChangeMultiple, mode, allProps } = useControlContext();
  const [isOpen, setIsOpen] = useState(false);
  const btnRef = useRef<HTMLSpanElement>(null);

  // On a motion.* element (design component) each transform lives as an
  // INDEPENDENT motion motion prop (rotate/scaleX/skewX/transformPerspective…),
  // NOT a combined CSS `transform` string. Read/write those props directly so
  // setting one field never clobbers another (the rotate-reset bug). Plain page
  // elements still use the CSS `transform` string. `parseTransform(value)` is
  // the fallback reader for an un-normalized motion element / plain element.
  //
  // NOTE: the parser STRIPS the `motion.` prefix (`<motion.div>` → type 'div'),
  // so node.type can't be used. Component-master files convert every element to
  // motion.*, so being in a component file (or a node carrying variants — page
  // instances of a component) is the reliable signal.
  const activeFile = useAtomValue(activeFilePathAtom);
  const isReplica = useAtomValue(isReplicaViewportAtom);
  const isComponentVariantViewport = useAtomValue(isComponentVariantViewportAtom);
  // Overlays are ALWAYS `motion.div`s (even on a plain page, with no variants),
  // so their transforms live as independent motion props (rotate/skewX/scale…) in
  // `style`, NOT a combined CSS `transform`. Without this the control read the
  // empty `transform` string and showed 0 for an already-rotated overlay.
  // In the Variable modal / Template-tool Default editor (`variableDefault`) there is NO node — the value is a
  // single CSS `transform` STRING the variable holds. Force the PLAIN path so edits commit one composed
  // transform string via `onChange` (→ the variable default). The motion path writes per-prop
  // (rotate/scaleX/…) via `onChangeMultiple`, which a single-value variable default can't represent → the
  // values never committed on release.
  // Writing to a viewport `@media` rule (page replica) or a variant object
  // rather than the node's base style — see `setField`.
  const isScopedWrite = isReplica || isComponentVariantViewport;
  const isMotion = mode !== 'variableDefault' && (isComponentFilePath(activeFile)
    || !!node?.motionVariants || !!(node as any)?.motionVariantsRef
    || !!(node as any)?.attrs?.['data-overlay']);
  const parsed = parseTransform(value);
  const t: TransformData = isMotion
    ? {
        rotateZ: numOr(allProps.rotate ?? (allProps as any).rotateZ) ?? parsed.rotateZ,
        rotateX: numOr((allProps as any).rotateX) ?? parsed.rotateX,
        rotateY: numOr((allProps as any).rotateY) ?? parsed.rotateY,
        skewX: numOr((allProps as any).skewX) ?? parsed.skewX,
        skewY: numOr((allProps as any).skewY) ?? parsed.skewY,
        scaleX: numOr((allProps as any).scaleX) ?? numOr((allProps as any).scale) ?? parsed.scaleX,
        scaleY: numOr((allProps as any).scaleY) ?? numOr((allProps as any).scale) ?? parsed.scaleY,
        perspective: numOr((allProps as any).transformPerspective) ?? parsed.perspective,
        rest: parsed.rest,
      }
    : parsed;

  const motionHasTransform = !!(t.rotateZ || t.rotateX || t.rotateY || t.skewX || t.skewY
    || t.scaleX !== 1 || t.scaleY !== 1 || t.perspective);
  // `visibleValue` ignores translate*() — see stripTranslates comment.
  const visibleValue = stripTranslates(value);
  const hasTransform = isMotion ? motionHasTransform : (!!visibleValue && visibleValue !== 'none');

  // Plain elements: rebuild the combined CSS `transform`. Motion elements: each
  // setter writes only its own prop(s) via onChangeMultiple, leaving the rest.
  const update = (patch: Partial<TransformData>) => {
    const merged = { ...t, ...patch };
    const val = formatTransform(merged);
    trace.action('transform:update', { patch, result: val });
    onChange(val);
  };
  // Live DOM-only patch during a slider drag — push the FULL composed CSS
  // transform (all current fields + the dragged one). The static canvas has no
  // motion FLIP, so a transform string is safe for instant feedback; on
  // release `setField` commits the motion prop and the Renderer re-folds to the
  // same visual. Works for motion and plain elements alike.
  const liveTransform = (override: Partial<TransformData>) => {
    onChangeLive(formatTransform({ ...t, ...override }));
  };
  /** ToolInput field handlers — the chevron DRAG/hold live-patches the canvas (DOM-only, NO code write per
   *  frame) and commits ONCE on release; typing + arrow keys commit. Mirrors the slider's
   *  onChange(live)/onCommit split — this is what makes the rotate/skew/scale chevrons high-FPS instead of
   *  re-parsing+regenerating the whole file every step (the slow-chevron bug). `onChangeLive`+`onCommit` are
   *  what route the chevron through `applyValue(live=true)` in ToolInput; without them it falls back to
   *  per-frame `onChange`. */
  const fieldInputProps = (field: keyof TransformData, neutral: number, clamp?: (n: number) => number) => {
    const num = (v: string) => { const n = parseFloat(v) || neutral; return clamp ? clamp(n) : n; };
    return {
      onChange: (v: string) => setField(field, num(v), neutral),
      onChangeLive: (v: string) => liveTransform({ [field]: num(v) } as Partial<TransformData>),
      onCommit: (v: string) => setField(field, num(v), neutral),
    };
  };
  /** Write a single transform field — see `transformFieldValue` for why the
   *  neutral-value collapse is BASE-only. */
  const setField = (field: keyof TransformData, v: number, neutral: number) => {
    if (!isMotion) { update({ [field]: v } as Partial<TransformData>); return; }
    const out = (n: number, neu: number) => transformFieldValue(n, neu, isScopedWrite);
    trace.action('transform:setMotionField', { field, v });
    switch (field) {
      case 'rotateZ': onChangeMultiple({ rotate: out(v, 0) }); break;
      case 'rotateX': onChangeMultiple({ rotateX: out(v, 0) }); break;
      case 'rotateY': onChangeMultiple({ rotateY: out(v, 0) }); break;
      case 'skewX': onChangeMultiple({ skewX: out(v, 0) }); break;
      case 'skewY': onChangeMultiple({ skewY: out(v, 0) }); break;
      case 'perspective': onChangeMultiple({ transformPerspective: out(v, 0) }); break;
      // Scale writes BOTH axes (clearing the uniform `scale` to avoid a
      // conflicting key), preserving the other axis's current value.
      case 'scaleX': onChangeMultiple({ scaleX: out(v, 1), scaleY: out(t.scaleY, 1), scale: '' }); break;
      case 'scaleY': onChangeMultiple({ scaleX: out(t.scaleX, 1), scaleY: out(v, 1), scale: '' }); break;
    }
  };

  return (
    <>
      <span ref={btnRef} className="contents">
      <ControlActionRow onClick={() => setIsOpen(true)}>
        {hasTransform ? (() => {
          const parts = visibleValue.match(/\w+\([^)]+\)/g) || [];
          const label = parts.length === 1 ? parts[0] : 'Mixed';
          // Removing clears the transform. Motion elements: wipe every motion
          // transform prop. Plain elements: keep translates (owned by the
          // position/anchor system).
          const handleRemove = () => {
            if (isMotion) {
              onChangeMultiple({ rotate: '', rotateX: '', rotateY: '', skewX: '', skewY: '', scaleX: '', scaleY: '', scale: '', transformPerspective: '' });
            } else {
              onChange(extractTranslates(value));
            }
          };
          return (
            <>
              <span className="truncate flex-1">{label}</span>
              <RemoveButton onClick={handleRemove} />
            </>
          );
        })() : (<>
          <TransformIcon width={20} height={20} bg="var(--control-border)" className="shrink-0 opacity-50" />
          <span className="text-[var(--text-secondary)]">Add</span>
        </>)}
      </ControlActionRow>
      </span>
      <ToolPopup isOpen={isOpen} onClose={() => setIsOpen(false)} title="Transform" anchorRef={btnRef}>
        <div className="flex flex-col gap-2">
          {/* Rotate */}
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Rotate" property="transform" plain forceShow />
            <div className="flex items-center gap-2 w-full">
              <ToolSlider value={t.rotateZ} min={-360} max={360} step={1} onChange={(v) => liveTransform({ rotateZ: v })} onCommit={(v) => setField('rotateZ', v, 0)} />
              <ToolInput value={String(t.rotateZ)} {...fieldInputProps('rotateZ', 0)} step={1} />
            </div>
          </div>
          {/* Rotate 3D */}
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Rotate 3D" property="transform" plain forceShow />
            <div className="flex items-center gap-1 w-full">
              <ToolInput value={String(t.rotateX)} {...fieldInputProps('rotateX', 0)} step={1} chevronLabel="X" />
              <ToolInput value={String(t.rotateY)} {...fieldInputProps('rotateY', 0)} step={1} chevronLabel="Y" />
            </div>
          </div>
          {/* Skew */}
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Skew" property="transform" plain forceShow />
            <div className="flex items-center gap-1 w-full">
              <ToolInput value={String(t.skewX)} {...fieldInputProps('skewX', 0)} step={1} chevronLabel="X" />
              <ToolInput value={String(t.skewY)} {...fieldInputProps('skewY', 0)} step={1} chevronLabel="Y" />
            </div>
          </div>
          {/* Scale */}
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Scale" property="transform" plain forceShow />
            <div className="flex items-center gap-1 w-full">
              <ToolInput value={String(t.scaleX)} {...fieldInputProps('scaleX', 1)} step={0.1} chevronLabel="X" />
              <ToolInput value={String(t.scaleY)} {...fieldInputProps('scaleY', 1)} step={0.1} chevronLabel="Y" />
            </div>
          </div>
          {/* Perspective */}
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Perspective" property="transform" plain forceShow />
            <div className="flex items-center gap-2 w-full">
              <ToolSlider value={t.perspective} min={0} max={2000} step={10}
                onChange={(v) => liveTransform({ perspective: v > 0 && v < 300 ? 300 : v })}
                onCommit={(v) => setField('perspective', v > 0 && v < 300 ? 300 : v, 0)} />
              <ToolInput value={String(t.perspective)}
                {...fieldInputProps('perspective', 0, (n) => n > 0 && n < 300 ? 300 : n)}
                step={10} />
            </div>
          </div>
          {/* Preserve 3D */}
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Preserve 3D" property="transform" plain forceShow />
            <div className="w-full">
              <ToolSegmentedControl
                value={allProps.transformStyle === 'preserve-3d' ? 'yes' : 'no'}
                onChange={(v) => onChangeMultiple({ transformStyle: v === 'yes' ? 'preserve-3d' : '' })}
                options={YES_NO_OPTIONS}
                size="sm" />
            </div>
          </div>
        </div>
      </ToolPopup>
    </>
  );
}

export function TransformControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="transform" defaultValue="none" mode={mode} {...mp}>
      <ControlRow label="Transform"><TransformAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}
