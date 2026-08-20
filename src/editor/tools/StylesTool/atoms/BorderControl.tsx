// BorderControl.tsx — Self-contained border ToolAtom with uniform/individual/gradient modes + overlay/inline rendering.
// Fully rewritten to use unified control system — no delegation to legacy component.

import { useState, useRef, useEffect, useMemo } from 'react';
import { useAtomValue } from 'jotai';
// Stable mirror — border parses ::after rule from code, doesn't change on
// reparent. Avoids re-render cascade during fast drag.
import { UnifiedControlProvider, useControlContext, ShowControlLabels } from '../../../controls/unified';
import { BorderIcon } from '@/design-system/PropertyIcons';
import { UsedByRow } from '../../../controls/unified/UsedByRow';
import { VariableBoundPill } from '../../../controls/VariableBoundPill';
import type { AtomProps } from '../../../controls/unified/types';
import { ToolInput, ToolSelect, ToolSegmentedControl, ColorInput, ControlLabel, SingleEntryRow } from '../../../controls';
import { useOverriddenLabel } from '../../../controls/label-override-context';
import { useHoistMenuItem } from '../../../controls/hoist-context';
import ToolPopup from '../../../ui/ToolPopup';
import { useEditorPanel } from '../../../hooks/useEditorPanel';
import GradientEditor from '../../../ui/GradientEditor';
import { parseGradient as gradientParseGradient, formatGradient as gradientFormatGradient, createDefaultGradient as gradientCreateDefault } from '@/shared/gradient-utils';
import { parseBorderState, formatBorderUniform, formatBorderIndividual, formatBorderAfterCSS, parseBorderAfterCSS, extractBorderAfterRuleBody, BORDER_INLINE_KEYS, formatGradientBorderAfterCSS, parseGradientBorderAfterCSS, isGradientBorder, type BorderSide, type BorderState } from '../../../ui/border-utils';
import { groupBorderTokens, detectActiveBorderPreset, buildBorderClearStyles, getBorderTokenValue } from '../../../ui/border-preset-utils';
import EditBorderPresetPanel from '../../../ui/EditBorderPresetPanel';
import { stableCodeAtom as codeAtom } from '@/code/stores/store';
import { extractStyleCSS } from '@/code/parsing/parser';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { injectCanvasCSS, removeCanvasCSS } from '@/canvas/node-ops';
import { presetTokensAtom } from '@/code/stores/preset-store';
import { trace } from '@/shared/debug-trace';
import { resolvePresetColor } from '@/shared/css-utils';

const BORDER_STYLE_OPTIONS = [
  { value: 'none',   label: 'None'   },
  { value: 'solid',  label: 'Solid'  },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
  { value: 'double', label: 'Double' },
  { value: 'groove', label: 'Groove' },
  { value: 'ridge',  label: 'Ridge'  },
  { value: 'inset',  label: 'Inset'  },
  { value: 'outset', label: 'Outset' },
];

function BorderUniformIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="2 2 20 20" className={className}>
      <rect width="16.5" height="16.5" x="3.75" y="3.75" fill="none" stroke="currentColor"
        strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" rx="4" />
    </svg>
  );
}

function BorderIndividualIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 256 256" className={className}>
      <path fill="currentColor"
        d="M93.66 202.34A8 8 0 0 1 88 216H48a8 8 0 0 1-8-8v-40a8 8 0 0 1 13.66-5.66ZM88 40H48a8 8 0 0 0-8 8v40a8 8 0 0 0 13.66 5.66l40-40A8 8 0 0 0 88 40m123.06 120.61a8 8 0 0 0-8.72 1.73l-40 40A8 8 0 0 0 168 216h40a8 8 0 0 0 8-8v-40a8 8 0 0 0-4.94-7.39M208 40h-40a8 8 0 0 0-5.66 13.66l40 40A8 8 0 0 0 216 88V48a8 8 0 0 0-8-8" />
    </svg>
  );
}

// ─── Self-contained editor panel (reactive inside pushPanel) ─────────────────

function BorderEditorPanel({ styles: s, nodeId, onChangeMultiple, onChangeMultipleLive, controlMode = 'direct' }: {
  styles: Record<string, string>;
  nodeId: string;
  onChangeMultiple: (styles: Record<string, string>) => void;
  onChangeMultipleLive?: (styles: Record<string, string>) => void;
  controlMode?: string;
}) {
  const code = useAtomValue(codeAtom);
  const isScrollMode = controlMode !== 'direct';

  // ─── Read border state from ::after rule OR inline styles ──────────────
  const afterBody = extractBorderAfterRuleBody(extractStyleCSS(code), nodeId);
  const overlayStateFromCode = afterBody ? parseBorderAfterCSS(afterBody) : null;
  const inlineState = parseBorderState(s);
  const isOverlayFromCode = !!overlayStateFromCode;

  const [localState, setLocalState] = useState<BorderState | null>(null);
  const hasInlineBorder = inlineState.top.width > 0 || inlineState.right.width > 0 ||
    inlineState.bottom.width > 0 || inlineState.left.width > 0 || isGradientBorder(s);
  const [renderMode, setRenderMode] = useState<'inline' | 'overlay'>(() => {
    if (isScrollMode) return 'inline'; // ::after can't animate via useTransform
    if (isOverlayFromCode) return 'overlay';
    if (hasInlineBorder) return 'inline';
    return 'overlay';
  });

  const [borderType, setBorderType] = useState<'solid' | 'gradient'>(() => {
    if (isScrollMode) return 'solid';
    if (isGradientBorder(s)) return 'gradient';
    if (afterBody) {
      const gradResult = parseGradientBorderAfterCSS(afterBody);
      if (gradResult) return 'gradient';
    }
    return 'solid';
  });

  const gradientFromInline = isGradientBorder(s) ? gradientParseGradient(s.borderImageSource) : null;
  const gradientFromOverlay = afterBody ? parseGradientBorderAfterCSS(afterBody) : null;
  const gradientFromOverlayParsed = gradientFromOverlay ? gradientParseGradient(gradientFromOverlay.gradientCSS) : null;
  const [localGradient, setLocalGradient] = useState<any>(null);
  const activeGradient = localGradient || gradientFromOverlayParsed || gradientFromInline || gradientCreateDefault();
  const [gradientWidth, setGradientWidth] = useState(() => gradientFromOverlay?.width || parseInt(s.borderWidth || '1') || 1);

  const borderState = localState || overlayStateFromCode || inlineState;
  const hasBorder = borderState.top.width > 0 || borderState.right.width > 0 ||
    borderState.bottom.width > 0 || borderState.left.width > 0;
  const [showIndividual, setShowIndividual] = useState(() => hasBorder && !borderState.isUniform);

  // Source SIGNATURE — every fact the derived useStates (renderMode/borderType/
  // local drafts) are computed from. Re-syncing on it (not just [nodeId]) makes
  // the row react INSTANTLY to Paste Style / undo / external edits while the
  // node stays selected — previously the states stayed stale until reselect
  // remounted the atom ("Add" shown right after pasting a gradient border).
  // Safe on own commits: these are derived VALUES that converge to the flushed
  // code (a no-op re-set), NOT a selection index — the reset-on-own-commit trap
  // (see feedback_value_sync_effect_resets_on_own_commit) doesn't apply.
  const sourceSig = [
    isOverlayFromCode ? 'overlay' : hasInlineBorder ? 'inline' : 'none',
    afterBody ?? '',
    ...BORDER_INLINE_KEYS.map((k) => s[k] ?? ''),
  ].join('|');

  useEffect(() => {
    setLocalState(null);
    setLocalGradient(null);
    setRenderMode(isOverlayFromCode ? 'overlay' : hasInlineBorder ? 'inline' : 'overlay');
    const hasGrad = isGradientBorder(s) || (afterBody && parseGradientBorderAfterCSS(afterBody));
    setBorderType(hasGrad ? 'gradient' : 'solid');
    setGradientWidth(gradientFromOverlay?.width || parseInt(s.borderWidth || '1') || 1);
    trace.action('border:resync-from-source', { nodeId, overlay: isOverlayFromCode, inline: hasInlineBorder, gradient: !!hasGrad });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, sourceSig]);

  useEffect(() => {
    if (hasBorder && !borderState.isUniform) setShowIndividual(true);
  }, [hasBorder, borderState.isUniform]);

  const writeBorder = (state: BorderState, writeMode: 'inline' | 'overlay') => {
    setLocalState(state);
    // Force inline in scroll mode — ::after pseudo-elements can't animate via useTransform
    const effectiveMode = isScrollMode ? 'inline' : writeMode;
    if (effectiveMode === 'overlay') {
      const afterCSS = formatBorderAfterCSS(state);
      queueMutation({ type: 'updateBorderOverlay', nodeId, afterCSS });
      const clear: Record<string, string> = {};
      for (const key of BORDER_INLINE_KEYS) clear[key] = '';
      if (!s.position || s.position === 'static') clear.position = 'relative';
      onChangeMultiple(clear);
      injectCanvasCSS(`[data-id="${nodeId}"]::after`, afterCSS);
      trace.action('border-panel:write-overlay', { nodeId, width: state.top.width });
    } else {
      if (isOverlayFromCode || renderMode === 'overlay') {
        queueMutation({ type: 'removeBorderOverlay', nodeId });
        removeCanvasCSS(`[data-id="${nodeId}"]::after`);
      }
      // In non-direct modes (variableDefault — component-instance prop row,
      // scroll/animation stops) the write has to land in a SINGLE string
      // value because the downstream prop is a single field. Per-side
      // longhands (`borderTopWidth`, `borderTopStyle`, …) split the value
      // across 12 keys with no shorthand — the unified provider's
      // variableDefault branch then picks just the first key's value
      // (`'12px'`) and writes that as the prop, losing style/color.
      // Collapse to the uniform shorthand here using the top side as
      // the canonical value — same pragmatic compromise design tools use,
      // since a single string prop can't carry distinct per-side values.
      const useUniformShorthand = isScrollMode || state.isUniform;
      const result = useUniformShorthand
        ? formatBorderUniform(state.top)
        : formatBorderIndividual(state);
      onChangeMultiple(result);
      trace.action('border-panel:write-inline', { nodeId, width: state.top.width, coerced: useUniformShorthand && !state.isUniform });
    }
  };

  const writeGradientBorder = (gradient: any, width: number) => {
    setLocalGradient(gradient);
    setGradientWidth(width);
    const gradientCSS = gradientFormatGradient(gradient);
    const effectiveRenderMode = isScrollMode ? 'inline' : renderMode;
    if (effectiveRenderMode === 'overlay') {
      const afterCSS = formatGradientBorderAfterCSS(gradientCSS, width);
      queueMutation({ type: 'updateBorderOverlay', nodeId, afterCSS });
      injectCanvasCSS(`[data-id="${nodeId}"]::after`, afterCSS);
      const clear: Record<string, string> = {};
      for (const key of BORDER_INLINE_KEYS) clear[key] = '';
      if (!s.position || s.position === 'static') clear.position = 'relative';
      onChangeMultiple(clear);
    } else {
      if (isOverlayFromCode) {
        queueMutation({ type: 'removeBorderOverlay', nodeId });
        removeCanvasCSS(`[data-id="${nodeId}"]::after`);
      }
      onChangeMultiple({
        borderImageSource: gradientCSS, borderImageSlice: '1',
        borderWidth: `${width}px`, borderStyle: 'solid',
        border: '', borderColor: '',
        borderTopWidth: '', borderTopStyle: '', borderTopColor: '',
        borderRightWidth: '', borderRightStyle: '', borderRightColor: '',
        borderBottomWidth: '', borderBottomStyle: '', borderBottomColor: '',
        borderLeftWidth: '', borderLeftStyle: '', borderLeftColor: '',
      });
    }
    trace.action('border-panel:write-gradient', { nodeId, renderMode, width });
  };

  // Live (per-frame) twin of writeGradientBorder — used while the user DRAGS a
  // gradient stop / color or the gradient overlay. Paints the canvas DOM
  // imperatively ONLY: no queueMutation, no onChangeMultiple source write, no
  // setLocalGradient/setState — so the slide stays 60fps instead of triggering
  // a code re-parse + Renderer rebuild every frame (the lag the user reported).
  // The single source COMMIT fires once on pointer-release via the
  // GradientEditor's onChange → writeGradientBorder. Mirrors the fill-gradient
  // onLiveChange path (FillControl → updateStyleLive).
  const writeGradientBorderLive = (gradient: any, width: number) => {
    const gradientCSS = gradientFormatGradient(gradient);
    const effectiveRenderMode = isScrollMode ? 'inline' : renderMode;
    if (effectiveRenderMode === 'overlay') {
      // Imperative ::after repaint (CSS rule swap, no source touch).
      injectCanvasCSS(`[data-id="${nodeId}"]::after`, formatGradientBorderAfterCSS(gradientCSS, width));
    } else {
      // Live inline-style DOM patch (bridge), no source write.
      (onChangeMultipleLive ?? onChangeMultiple)({
        borderImageSource: gradientCSS, borderImageSlice: '1',
        borderWidth: `${width}px`, borderStyle: 'solid',
      });
    }
  };

  // Live (per-frame) twin of writeBorder for color-picker drags. Overlay mode:
  // the `injectCanvasCSS(::after)` paint already runs in `writeBorder` — here we
  // do ONLY that paint, skipping the per-frame `queueMutation`. Inline mode:
  // route the shorthand through `onChangeMultipleLive` (DOM patch, no source
  // write). The clear/position writes don't change during a color drag, so the
  // live path can skip them. Width/style unchanged → only the color matters.
  const writeBorderLive = (state: BorderState, writeMode: 'inline' | 'overlay') => {
    setLocalState(state);
    const effectiveMode = isScrollMode ? 'inline' : writeMode;
    if (effectiveMode === 'overlay') {
      injectCanvasCSS(`[data-id="${nodeId}"]::after`, formatBorderAfterCSS(state));
    } else {
      const useUniformShorthand = isScrollMode || state.isUniform;
      const result = useUniformShorthand ? formatBorderUniform(state.top) : formatBorderIndividual(state);
      // LIVE only: apply just the non-empty SETs. The format helpers also emit
      // empty longhand/shorthand clears (for source cleanup), but as separate
      // per-key CSSOM patches those run AFTER the `border` shorthand and strip
      // the longhands it just expanded into — wiping the live preview (the same
      // shorthand self-wipe that hit Radius/Padding/Margin). The clears are
      // re-applied correctly by the source COMMIT (onChangeMultiple) on release.
      const liveOnly = Object.fromEntries(Object.entries(result).filter(([, v]) => v !== ''));
      (onChangeMultipleLive ?? onChangeMultiple)(liveOnly);
    }
  };

  const updateUniform = (patch: Partial<BorderSide>) => {
    const newSide: BorderSide = { ...borderState.top, ...patch };
    if (newSide.width > 0 && newSide.style === 'none') newSide.style = 'solid';
    writeBorder({ top: newSide, right: newSide, bottom: newSide, left: newSide, isUniform: true }, renderMode);
  };
  const updateUniformLive = (patch: Partial<BorderSide>) => {
    const newSide: BorderSide = { ...borderState.top, ...patch };
    if (newSide.width > 0 && newSide.style === 'none') newSide.style = 'solid';
    writeBorderLive({ top: newSide, right: newSide, bottom: newSide, left: newSide, isUniform: true }, renderMode);
  };

  const updateIndividual = (sideKey: 'top' | 'right' | 'bottom' | 'left', patch: Partial<BorderSide>) => {
    const newState: BorderState = { ...borderState, [sideKey]: { ...borderState[sideKey], ...patch }, isUniform: false };
    if (newState[sideKey].width > 0 && newState[sideKey].style === 'none') newState[sideKey].style = 'solid';
    writeBorder(newState, renderMode);
  };
  const updateIndividualLive = (sideKey: 'top' | 'right' | 'bottom' | 'left', patch: Partial<BorderSide>) => {
    const newState: BorderState = { ...borderState, [sideKey]: { ...borderState[sideKey], ...patch }, isUniform: false };
    if (newState[sideKey].width > 0 && newState[sideKey].style === 'none') newState[sideKey].style = 'solid';
    writeBorderLive(newState, renderMode);
  };

  const switchToUniform = () => { setShowIndividual(false); writeBorder({ ...borderState, isUniform: true, right: borderState.top, bottom: borderState.top, left: borderState.top }, renderMode); };
  const switchToIndividual = () => { setShowIndividual(true); writeBorder({ ...borderState, isUniform: false }, renderMode); };

  const switchRenderMode = (newMode: 'inline' | 'overlay') => {
    if (renderMode === 'overlay') { queueMutation({ type: 'removeBorderOverlay', nodeId }); removeCanvasCSS(`[data-id="${nodeId}"]::after`); }
    if (renderMode === 'inline') {
      const clear: Record<string, string> = {};
      for (const key of BORDER_INLINE_KEYS) clear[key] = '';
      clear.borderImageSource = ''; clear.borderImageSlice = '';
      onChangeMultiple(clear);
    }
    setRenderMode(newMode);
    if (borderType === 'gradient') {
      const gCSS = gradientFormatGradient(activeGradient);
      if (newMode === 'overlay') {
        const afterCSS = formatGradientBorderAfterCSS(gCSS, gradientWidth);
        queueMutation({ type: 'updateBorderOverlay', nodeId, afterCSS });
        injectCanvasCSS(`[data-id="${nodeId}"]::after`, afterCSS);
        if (!s.position || s.position === 'static') onChangeMultiple({ position: 'relative' });
      } else {
        onChangeMultiple({ borderImageSource: gCSS, borderImageSlice: '1', borderWidth: `${gradientWidth}px`, borderStyle: 'solid' });
      }
    } else {
      if (newMode === 'overlay') {
        const afterCSS = formatBorderAfterCSS(borderState);
        queueMutation({ type: 'updateBorderOverlay', nodeId, afterCSS });
        injectCanvasCSS(`[data-id="${nodeId}"]::after`, afterCSS);
        if (!s.position || s.position === 'static') onChangeMultiple({ position: 'relative' });
      } else {
        onChangeMultiple(borderState.isUniform ? formatBorderUniform(borderState.top) : formatBorderIndividual(borderState));
      }
    }
    trace.action('border-panel:switch-render-mode', { newMode, borderType });
  };

  const switchBorderType = (newType: 'solid' | 'gradient') => {
    if (borderType === 'gradient') onChangeMultiple({ borderImageSource: '', borderImageSlice: '' });
    if (borderType === 'solid' && renderMode === 'overlay') { queueMutation({ type: 'removeBorderOverlay', nodeId }); removeCanvasCSS(`[data-id="${nodeId}"]::after`); }
    setBorderType(newType);
    if (newType === 'gradient') {
      const width = borderState.top.width || gradientWidth || 1;
      setGradientWidth(width);
      writeGradientBorder(activeGradient, width);
    } else {
      const side: BorderSide = borderState.top.width > 0 ? borderState.top : { width: 1, style: 'solid', color: '#000000' };
      const solidState: BorderState = { top: side, right: side, bottom: side, left: side, isUniform: true };
      setLocalState(solidState);
      writeBorder(solidState, renderMode);
    }
    trace.action('border-panel:switch-type', { newType, renderMode });
  };

  // Force per-field labels (Width / Style / Color) visible inside the expanded popup even when the atom
  // carries `hideLabel` from the Variable modal's Default row.
  return (
    <ShowControlLabels>
    <div className="flex flex-col gap-2">
      {!isScrollMode && <ToolSegmentedControl value={renderMode} onChange={(v) => switchRenderMode(v as 'inline' | 'overlay')}
        options={[{ value: 'overlay', label: 'Overlay' }, { value: 'inline', label: 'Inline' }]} size="sm" />}
      {!isScrollMode && <ToolSegmentedControl value={borderType} onChange={(v) => switchBorderType(v as 'solid' | 'gradient')}
        options={[{ value: 'solid', label: 'Solid' }, { value: 'gradient', label: 'Gradient' }]} size="sm" />}

      {borderType === 'solid' && (!showIndividual || isScrollMode ? (
        // Force uniform UI in non-direct modes (variableDefault — component-
        // instance prop row, animation/scroll stops). The downstream prop
        // is a single string field; per-side longhands can't survive a
        // single-value handoff. The uniform/individual toggle below is
        // also hidden in that case so the user can't reach a UI that
        // would silently coerce on write.
        <>
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Color" property="borderColor" plain />
            <ColorInput value={borderState.top.color} onChange={(v) => updateUniform({ color: v })} onChangeLive={(v) => updateUniformLive({ color: v })} showAlpha />
          </div>
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Width" property="borderWidth" plain />
            {/* Chevron drag MUST live-patch (onChangeLive → writeBorderLive → previewVar) + commit once on
                release (onCommit), like Color/Shadow — otherwise it committed code every frame (slow fps,
                stale DOM). The ToolInput chevron path uses onChangeLive during drag, onCommit on mouseup. */}
            <ToolInput value={String(borderState.top.width)}
              onChange={(v) => updateUniform({ width: parseFloat(v) || 0 })}
              onChangeLive={(v) => updateUniformLive({ width: parseFloat(v) || 0 })}
              onCommit={(v) => updateUniform({ width: parseFloat(v) || 0 })}
              step={1} />
          </div>
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Style" property="borderStyle" plain />
            <ToolSelect value={borderState.top.style} onChange={(v) => updateUniform({ style: v })} options={BORDER_STYLE_OPTIONS} />
          </div>
        </>
      ) : (
        <>
          {(['top', 'right', 'bottom', 'left'] as const).map((sideKey) => {
            const side = borderState[sideKey];
            const label = sideKey.charAt(0).toUpperCase() + sideKey.slice(1);
            return (
              <div key={sideKey} className="flex items-center gap-2 w-full">
                <span className="w-10 text-xs font-bold text-[var(--text-secondary)] shrink-0">{label}</span>
                <ToolInput value={String(side.width)}
                  onChange={(v) => updateIndividual(sideKey, { width: parseFloat(v) || 0 })}
                  onChangeLive={(v) => updateIndividualLive(sideKey, { width: parseFloat(v) || 0 })}
                  onCommit={(v) => updateIndividual(sideKey, { width: parseFloat(v) || 0 })}
                  step={1} className="w-14" />
                <ToolSelect value={side.style} onChange={(v) => updateIndividual(sideKey, { style: v })} options={BORDER_STYLE_OPTIONS} />
                <ColorInput value={side.color} onChange={(v) => updateIndividual(sideKey, { color: v })} onChangeLive={(v) => updateIndividualLive(sideKey, { color: v })} swatchOnly showAlpha />
              </div>
            );
          })}
        </>
      ))}

      {borderType === 'gradient' && (
        <GradientEditor
          value={gradientFormatGradient(activeGradient)}
          onChange={(css) => { const parsed = gradientParseGradient(css); if (parsed) writeGradientBorder(parsed, gradientWidth); }}
          // Smooth drag: live-paint the canvas DOM every frame (no code write);
          // onChange above commits once on pointer-release. Matches fill gradient.
          onLiveChange={(css) => { const parsed = gradientParseGradient(css); if (parsed) writeGradientBorderLive(parsed, gradientWidth); }}
          extraAfterType={
            <div className="flex items-center justify-between w-full">
              <ControlLabel label="Width" property="borderWidth" plain />
              <ToolInput value={String(gradientWidth)} onChange={(v) => writeGradientBorder(activeGradient, parseFloat(v) || 1)} step={1} />
            </div>
          }
        />
      )}

      {/* Uniform/individual toggle is hidden in non-direct modes — the prop
          downstream is a single string, no per-side longhand survives. */}
      {borderType === 'solid' && !isScrollMode && (
        <div className="flex justify-end">
          <div className="flex items-center border border-[var(--control-border)] cut-corners cut-border [--cut-border-color:var(--control-border)] overflow-hidden shrink-0">
            <button tabIndex={-1} onClick={switchToUniform}
              className={`flex items-center justify-center h-[var(--control-height-sm)] w-7 transition-colors ${!showIndividual ? 'bg-[var(--button-secondary-bg)] text-[var(--text-primary)]' : 'bg-[var(--choice-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
              title="Uniform"><BorderUniformIcon className="w-3 h-3" /></button>
            <button tabIndex={-1} onClick={switchToIndividual}
              className={`flex items-center justify-center h-[var(--control-height-sm)] w-7 transition-colors ${showIndividual ? 'bg-[var(--button-secondary-bg)] text-[var(--text-primary)]' : 'bg-[var(--choice-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
              title="Individual sides"><BorderIndividualIcon className="w-3 h-3" /></button>
          </div>
        </div>
      )}
    </div>
    </ShowControlLabels>
  );
}

function BorderAtom() {
  const { value, node, onChange, onChangeMultiple, onChangeMultipleLive, binding, mode, nodeId: ctxNodeId, allProps, hasVariable } = useControlContext();
  const { openPanel, panelPopup } = useEditorPanel('Border', () => (
    /* controlMode MUST be forwarded — the panel's `isScrollMode` flag
       (which forces inline writes and disables the overlay path) is
       derived from it. Without this, opening the panel from a
       variableDefault-mode row falls back to the overlay code path
       with an empty nodeId and the border CSS lands in a
       `[data-node-id=""]::after` ghost selector inside some
       unrelated element's <style> block. */
    <BorderEditorPanel styles={s} nodeId={nodeId} onChangeMultiple={onChangeMultiple} onChangeMultipleLive={onChangeMultipleLive} controlMode={mode} />
  ));
  const allTokens = useAtomValue(presetTokensAtom);
  const isScrollMode = mode !== 'direct';
  // allProps has ALL properties: node.styles in direct, stopProps in scrollStop.
  // In non-direct modes (variableDefault — component-instance prop row,
  // animation stops) `allProps` is empty / a stop bag; the actual prop
  // value lives in `value` (the resolved externalValue). Seed `s.border`
  // from there so the row preview swatch + the editor panel's read-side
  // (`parseBorderState`) both pick up the current value. Without this,
  // reselecting the instance loses the preview ("Add" placeholder
  // returns) even though the JSX still has `border="..."` set.
  const s: Record<string, string> = (() => {
    const base = isScrollMode && value ? { ...allProps, border: value } : allProps;
    // If shorthand 'border' is present but no individual keys, parse it
    if (base.border && !base.borderWidth) {
      const m = base.border.match(/^(\d+)px\s+(\w+)\s+(#[0-9a-fA-F]+|rgba?\([^)]+\))$/);
      if (m) return { ...base, borderWidth: m[1] + 'px', borderStyle: m[2], borderColor: m[3] };
    }
    return base;
  })();
  const nodeId = ctxNodeId || '';
  const code = useAtomValue(codeAtom);

  const btnRef = useRef<HTMLSpanElement>(null);

  // ─── Read border state for preview ─────────────────────────────────────
  const afterBody = extractBorderAfterRuleBody(extractStyleCSS(code), nodeId);
  const overlayStateFromCode = afterBody ? parseBorderAfterCSS(afterBody) : null;
  const inlineState = parseBorderState(s);
  const isOverlayFromCode = !!overlayStateFromCode;

  const [localState, setLocalState] = useState<BorderState | null>(null);
  const hasInlineBorder = inlineState.top.width > 0 || inlineState.right.width > 0 ||
    inlineState.bottom.width > 0 || inlineState.left.width > 0 || isGradientBorder(s);
  const [renderMode, setRenderMode] = useState<'inline' | 'overlay'>(() => {
    // Overlay mode (`::after` pseudo-element) requires a real DOM target keyed
    // by `nodeId`. In non-direct modes (variableDefault — i.e. a component-
    // instance prop row, or animation/scroll stops) there is no such target:
    // `nodeId` is empty, so we'd inject `[data-node-id=""]::after { ... }`
    // into the canvas <style> block (visible bug: border CSS lands on a
    // ghost selector, nothing renders, and the nested instance never gets
    // the border prop). Force inline mode so the writes flow through
    // `onChangeMultiple` → `border: shorthand` → `externalOnChange` → the
    // ComponentPropsTool's `handlePropChange` writes a normal prop value
    // onto the JSX tag.
    if (isScrollMode) return 'inline';
    if (isOverlayFromCode) return 'overlay';
    if (hasInlineBorder) return 'inline';
    return 'overlay';
  });

  const [borderType, setBorderType] = useState<'solid' | 'gradient'>(() => {
    if (isScrollMode) return 'solid';
    if (isGradientBorder(s)) return 'gradient';
    if (afterBody) {
      const gradResult = parseGradientBorderAfterCSS(afterBody);
      if (gradResult) return 'gradient';
    }
    return 'solid';
  });

  const gradientFromInline = isGradientBorder(s) ? gradientParseGradient(s.borderImageSource) : null;
  const gradientFromOverlay = afterBody ? parseGradientBorderAfterCSS(afterBody) : null;
  const gradientFromOverlayParsed = gradientFromOverlay ? gradientParseGradient(gradientFromOverlay.gradientCSS) : null;
  const [localGradient, setLocalGradient] = useState<any>(null);
  const activeGradient = localGradient || gradientFromOverlayParsed || gradientFromInline || gradientCreateDefault();
  const [gradientWidth, setGradientWidth] = useState(() => gradientFromOverlay?.width || parseInt(s.borderWidth || '1') || 1);

  // In non-direct modes (variableDefault — the variable modal's default-value row) the live `value`
  // is the source of truth: the popup editor writes it via onChangeMultiple → externalOnChange. The
  // trigger's own `localState` (set to the seed 1px when you first click an empty border, line ~555)
  // would otherwise MASK the popup's edits until the control remounts — so on first create the pill
  // stayed "1 · SOLID" while the popup showed the real value, only syncing on close/reopen. Ignore
  // localState here and read straight from `value` (overlay never applies in non-direct mode).
  const borderState = mode !== 'direct'
    ? (overlayStateFromCode || inlineState)
    : (localState || overlayStateFromCode || inlineState);
  const hasBorder = borderState.top.width > 0 || borderState.right.width > 0 ||
    borderState.bottom.width > 0 || borderState.left.width > 0;

  const [showIndividual, setShowIndividual] = useState(() => hasBorder && !borderState.isUniform);

  // Source SIGNATURE — every fact the derived useStates (renderMode/borderType/
  // local drafts) are computed from. Re-syncing on it (not just [nodeId]) makes
  // the row react INSTANTLY to Paste Style / undo / external edits while the
  // node stays selected — previously the states stayed stale until reselect
  // remounted the atom ("Add" shown right after pasting a gradient border).
  // Safe on own commits: these are derived VALUES that converge to the flushed
  // code (a no-op re-set), NOT a selection index — the reset-on-own-commit trap
  // (see feedback_value_sync_effect_resets_on_own_commit) doesn't apply.
  const sourceSig = [
    isOverlayFromCode ? 'overlay' : hasInlineBorder ? 'inline' : 'none',
    afterBody ?? '',
    ...BORDER_INLINE_KEYS.map((k) => s[k] ?? ''),
  ].join('|');

  useEffect(() => {
    setLocalState(null);
    setLocalGradient(null);
    setRenderMode(isOverlayFromCode ? 'overlay' : hasInlineBorder ? 'inline' : 'overlay');
    const hasGrad = isGradientBorder(s) || (afterBody && parseGradientBorderAfterCSS(afterBody));
    setBorderType(hasGrad ? 'gradient' : 'solid');
    setGradientWidth(gradientFromOverlay?.width || parseInt(s.borderWidth || '1') || 1);
    trace.action('border:resync-from-source', { nodeId, overlay: isOverlayFromCode, inline: hasInlineBorder, gradient: !!hasGrad });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, sourceSig]);

  useEffect(() => {
    if (hasBorder && !borderState.isUniform) setShowIndividual(true);
  }, [hasBorder, borderState.isUniform]);

  // ─── Write border (for initial default creation) ───────────────────────
  const writeBorder = (state: BorderState, writeMode: 'inline' | 'overlay') => {
    setLocalState(state);
    // Mirror BorderEditorPanel: in non-direct modes (variableDefault, scroll,
    // animation stops) `nodeId` is empty and the overlay path would inject
    // a ghost-selector CSS rule. Force inline so the border flows through
    // onChangeMultiple → `border: shorthand` → externalOnChange path.
    const effectiveMode = isScrollMode ? 'inline' : writeMode;
    if (effectiveMode === 'overlay') {
      const afterCSS = formatBorderAfterCSS(state);
      queueMutation({ type: 'updateBorderOverlay', nodeId, afterCSS });
      const clear: Record<string, string> = {};
      for (const key of BORDER_INLINE_KEYS) clear[key] = '';
      const currentPos = s.position;
      if (!currentPos || currentPos === 'static') clear.position = 'relative';
      onChangeMultiple(clear);
      injectCanvasCSS(`[data-id="${nodeId}"]::after`, afterCSS);
      trace.action('border:write-overlay', { nodeId, width: state.top.width });
    } else {
      if (isOverlayFromCode || renderMode === 'overlay') {
        queueMutation({ type: 'removeBorderOverlay', nodeId });
        removeCanvasCSS(`[data-id="${nodeId}"]::after`);
      }
      // See BorderEditorPanel.writeBorder for why isScrollMode coerces to
      // the uniform shorthand — the variableDefault prop is a single
      // string field and can't carry per-side longhands.
      const useUniformShorthand = isScrollMode || state.isUniform;
      const result = useUniformShorthand
        ? formatBorderUniform(state.top)
        : formatBorderIndividual(state);
      onChangeMultiple(result);
      trace.action('border:write-inline', { nodeId, width: state.top.width });
    }
  };

  // ─── Preview ───────────────────────────────────────────────────────────
  const previewLabel = hasBorder
    ? (borderState.isUniform ? `${borderState.top.width} · ${borderState.top.style.toUpperCase()}` : 'Mixed')
    : null;
  const isGradient = borderType === 'gradient';
  const hasAnyBorder = hasBorder || isGradient;

  const clearAllBorder = () => {
    trace.action('border:clear-all', { nodeId });
    const clear: Record<string, string> = {};
    for (const key of BORDER_INLINE_KEYS) clear[key] = '';
    onChangeMultiple(clear);
    queueMutation({ type: 'removeBorderOverlay', nodeId });
    removeCanvasCSS(`[data-id="${nodeId}"]::after`);
    setLocalState(null);
    setLocalGradient(null);
  };

  const openEditor = () => {
    openPanel();
  };

  trace.fn('BorderAtom:render', { hasBorder, showIndividual, renderMode, borderType, isUniform: borderState.isUniform, isOverlay: isOverlayFromCode });

  // Compound border preset detection — MUST run before any early return.
  // Previously these two useMemo calls lived AFTER the `binding.bound` /
  // `hasVariable` early returns, which violates the Rules of Hooks: when
  // the user removed the variable binding via the × button, hasVariable
  // flipped false on the next render, the useMemos suddenly ran, and
  // React crashed with "Rendered more hooks than during the previous
  // render." Hoisted above the returns so the hook order is stable
  // regardless of which branch the render takes.
  //
  // Detects a group of 3+ tokens applied as multiple var() refs across
  // border longhands (matching borderColor for solid, borderImageSource
  // for gradient). Used by `BorderPresetPillRow` below to collapse the
  // row into the blue-pill view.
  const borderGroups = useMemo(() => groupBorderTokens(allTokens), [allTokens]);
  const activeGroup = useMemo(() => detectActiveBorderPreset(s, borderGroups), [s, borderGroups]);

  const { label: ovLabel, subLabel: ovSubLabel } = useOverriddenLabel('Border');
  const ovHoist = useHoistMenuItem();
  const labelPlain = mode !== 'direct' && !ovHoist;

  // Bound check — after all hooks. Animation/scroll first, variable pill second.
  if (mode === 'direct' && binding.bound) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Border" property="border" />
        <UsedByRow binding={binding} />
      </div>
    );
  }
  if (mode === 'direct' && hasVariable) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Border" property="border" />
        <VariableBoundPill propertyLabel="Border" />
      </div>
    );
  }

  if (activeGroup && mode === 'direct') {
    return (
      <BorderPresetPillRow
        group={activeGroup}
        onClear={() => onChangeMultiple(buildBorderClearStyles())}
      />
    );
  }

  return (
    <>
      <SingleEntryRow
        label={ovLabel} property="border" plain={labelPlain} subLabel={ovSubLabel}
        hasValue={hasAnyBorder}
        onOpen={() => {
          if (!hasAnyBorder) {
            const defaultState: BorderState = { isUniform: true, top: { width: 1, style: 'solid', color: '#000000' }, right: { width: 1, style: 'solid', color: '#000000' }, bottom: { width: 1, style: 'solid', color: '#000000' }, left: { width: 1, style: 'solid', color: '#000000' } };
            writeBorder(defaultState, renderMode);
          }
          openEditor();
        }}
        anchorRef={btnRef}
        EmptyIcon={BorderIcon}
        renderPreview={() => (
          <>
            <span className="w-5 h-5 rounded flex-shrink-0 bg-[var(--bg-surface)]"
              style={isGradient
                ? { background: gradientFormatGradient(activeGradient), borderRadius: '3px' }
                : ({
                    borderTopWidth: `${Math.min(borderState.top.width, 3)}px`,
                    borderRightWidth: `${Math.min(borderState.right.width, 3)}px`,
                    borderBottomWidth: `${Math.min(borderState.bottom.width, 3)}px`,
                    borderLeftWidth: `${Math.min(borderState.left.width, 3)}px`,
                    borderTopStyle: borderState.top.style === 'none' ? 'none' : borderState.top.style,
                    borderRightStyle: borderState.right.style === 'none' ? 'none' : borderState.right.style,
                    borderBottomStyle: borderState.bottom.style === 'none' ? 'none' : borderState.bottom.style,
                    borderLeftStyle: borderState.left.style === 'none' ? 'none' : borderState.left.style,
                    // Preset colors arrive as `var(--brand)` strings. The
                    // editor lives in the PARENT frame where the canvas's
                    // CSS variables aren't in scope, so feeding the raw
                    // `var(--brand)` to the swatch's `border-color`
                    // resolves to currentColor (black) — visible bug:
                    // border swatch always rendered black even when the
                    // user picked a preset. Resolve the var() to the
                    // token's actual hex / rgba so the swatch paints the
                    // real colour. Same trick ShadowControl already uses.
                    borderTopColor: resolvePresetColor(borderState.top.color, allTokens),
                    borderRightColor: resolvePresetColor(borderState.right.color, allTokens),
                    borderBottomColor: resolvePresetColor(borderState.bottom.color, allTokens),
                    borderLeftColor: resolvePresetColor(borderState.left.color, allTokens),
                    borderRadius: '3px',
                  } as React.CSSProperties)
              } />
            <span className="truncate flex-1">
              {isGradient ? 'Gradient' : previewLabel}
            </span>
          </>
        )}
        /* The clear-X removes a STYLE from a node. In variableDefault mode (Template tool variable
           rows, variable modal default editor) the row edits a VARIABLE's value, not a node style —
           "remove" is meaningless there (you delete the variable via the modal), so hide the X. */
        onRemove={mode !== 'variableDefault' ? () => clearAllBorder() : undefined}
      />

      {panelPopup(btnRef)}
    </>
  );
}

// ─── Border preset pill row — opens an edit popup on click ─────────────────

/**
 * The blue pill the row collapses to when a compound border preset is
 * applied. Click → opens a ToolPopup that edits the GROUP'S tokens (live
 * updates fan out to every consumer). × → unlinks the preset from this node
 * only (caller's onClear, which clears all longhands).
 */
function BorderPresetPillRow({ group, onClear }: {
  group: ReturnType<typeof groupBorderTokens>[number];
  onClear: () => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const widthTokenValue = getBorderTokenValue(group, 'width') || '1px';
  const widthPx = parseInt(widthTokenValue) || 1;
  const previewWidth = `${Math.min(widthPx, 3)}px`;
  const previewStyle: React.CSSProperties = group.flavor === 'gradient'
    ? {
        borderWidth: previewWidth,
        borderStyle: 'solid',
        borderImageSource: getBorderTokenValue(group, 'image-source'),
        borderImageSlice: getBorderTokenValue(group, 'image-slice') || '1',
        borderRadius: '3px',
      }
    : {
        borderWidth: previewWidth,
        borderStyle: getBorderTokenValue(group, 'style') || 'solid',
        borderColor: getBorderTokenValue(group, 'color') || '#000',
        borderRadius: '3px',
      };

  return (
    <>
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Border" property="border" />
        <button
          ref={anchorRef}
          className="w-full h-8 flex items-center gap-2 px-2 bg-[var(--accent)] cut-corners cursor-pointer transition-colors min-w-0 overflow-hidden hover:opacity-90"
          onClick={() => setEditOpen(true)}
        >
          <span className="w-5 h-5 rounded bg-[var(--bg-surface)] flex-shrink-0" style={previewStyle} />
          <span className="text-xs font-medium text-[var(--accent-fg)] truncate flex-1 text-left">
            {group.label}
          </span>
          <span
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            className="text-[var(--accent-fg)] opacity-70 hover:opacity-100 text-sm leading-none cursor-pointer shrink-0"
          >
            &times;
          </span>
        </button>
      </div>

      {editOpen && (
        <ToolPopup
          isOpen={editOpen}
          onClose={() => setEditOpen(false)}
          title={`Edit "${group.label}"`}
          anchorRef={anchorRef}
          width={260}
        >
          <EditBorderPresetPanel group={group} />
        </ToolPopup>
      )}
    </>
  );
}

export function BorderControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="border" defaultValue="" mode={mode} {...mp}>
      <BorderAtom />
    </UnifiedControlProvider>
  );
}
