// KeyframeSheet.tsx — Bottom sheet editor for CSS @keyframes animations.
// Shows a percentage-based ruler (0–100%) with draggable stop markers.
// Clicking a stop reveals a property editor below the ruler.
// Each stop defines what the element looks like at that % through the animation.
// The @keyframes block is written to app/globals.css (global); animation: property on the element.

import { useState, useRef, useCallback, useEffect } from 'react';
import { clamp } from '@/canvas/canvas-math';
import { createPortal } from 'react-dom';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  activeKeyframeSheetAtom,
  selectedKeyframeStopAtom,
  keyframesAtom,
  keyframesBumpAtom,
} from '@/code/stores/animation-store';
import { useNode } from '@/code/stores/node-family';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { refreshCanvasTokens, findNodeRect, getViewportPrefix } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import {
  parseAnimationShorthand,
  formatAnimationShorthand,
  formatKeyframes,
  CSS_EASING_OPTIONS,
  CSS_FILL_OPTIONS,
  CSS_ITERATION_OPTIONS,
  type KeyframeAnimation,
  type KeyframeStop,
  type AnimationData,
} from '@/shared/animation-utils';
import { trace } from '@/shared/debug-trace';
// ToolPopupContext no longer provided — controls open standalone popups for full-size editors
import MotionPropsEditor, { buildTransformPreview } from '../motion/MotionPropsEditor';

// ─── Constants ───────────────────────────────────────────────────────────────

const SHEET_MIN_HEIGHT = 180;
const SHEET_DEFAULT_HEIGHT = 340;
const SHEET_MAX_HEIGHT = 700;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const snapOffset = (v: number) => Math.round(clamp(v, 0, 100));

// ─── Stop Marker ─────────────────────────────────────────────────────────────

function StopMarker({ stop, index, selected, rulerRef, onSelect, onOffsetChange, onRemove }: {
  stop: KeyframeStop;
  index: number;
  selected: boolean;
  rulerRef: React.RefObject<HTMLDivElement | null>;
  onSelect: (index: number) => void;
  onOffsetChange: (index: number, newOffset: number) => void;
  onRemove: (index: number) => void;
}) {
  // Use window-level listeners for drag — avoids conflict with resize handle
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onSelect(index);

    const startX = e.clientX;
    const startOffset = stop.offset;
    trace.action('keyframe-sheet:stop-drag-start', { index, offset: stop.offset });

    const onMove = (ev: PointerEvent) => {
      const rulerWidth = rulerRef.current?.getBoundingClientRect().width ?? 0;
      if (rulerWidth === 0) return;
      const dx = ev.clientX - startX;
      const dOffset = (dx / rulerWidth) * 100;
      const newOffset = snapOffset(startOffset + dOffset);
      onOffsetChange(index, newOffset);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      trace.action('keyframe-sheet:stop-drag-end', { index });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [index, stop.offset, rulerRef, onSelect, onOffsetChange]);

  return (
    <div
      className="absolute top-0 bottom-0 flex flex-col items-center justify-center"
      style={{ left: `${stop.offset}%`, transform: 'translateX(-50%)', width: 20, cursor: 'grab' }}
      onPointerDown={handlePointerDown}
    >
      {/* Wider hit area, visible bar */}
      <div
        className={`w-3 cut-corners transition-all ${
          selected
            ? 'bg-white shadow-[0_0_0_2px_var(--accent)] h-9'
            : 'bg-[var(--accent)] opacity-70 hover:opacity-100 h-7'
        }`}
      />
      <span className="text-[9px] text-[var(--text-secondary)] mt-1 select-none tabular-nums whitespace-nowrap">
        {stop.offset}%
      </span>
      {selected && (
        <button
          className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500/80 hover:bg-red-500 flex items-center justify-center border-none cursor-pointer text-white"
          style={{ fontSize: 8 }}
          onPointerDown={(e) => { e.stopPropagation(); onRemove(index); }}
          title="Remove stop"
        >
          ×
        </button>
      )}
    </div>
  );
}

// ─── CSS ↔ MotionProps conversion ────────────────────────────────────────────

/** Motion transform props that map to CSS transform — not valid CSS property names. */
const MOTION_TRANSFORM_KEYS = new Set([
  'x', 'y', 'z', 'xPercent', 'yPercent', 'scale', 'scaleX', 'scaleY', 'scaleZ',
  'rotate', 'rotateX', 'rotateY', 'skew', 'skewX', 'skewY', 'perspective',
]);

/**
 * Convert CSS kebab-case stop properties to camelCase motion props
 * (the format MotionPropsEditor expects).
 */
function cssToMotionProps(css: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(css)) {
    // Skip raw CSS `transform` — MotionPropsEditor manages x/y/scale/rotate instead
    if (key === 'transform') continue;
    const camel = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    result[camel] = val;
  }
  return result;
}

/**
 * Convert MotionPropsEditor output (camelCase + motion transform props) back to CSS kebab-case.
 * Motion transform props (x, y, scale, rotate, etc.) are combined into a `transform` value.
 */
function motionPropsToCss(motionProps: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  let hasMotionTransform = false;

  for (const [key, val] of Object.entries(motionProps)) {
    if (MOTION_TRANSFORM_KEYS.has(key)) {
      hasMotionTransform = true;
    } else if (key === 'autoAlpha') {
      result['opacity'] = val;
    } else if (key === 'transformStyle') {
      result['transform-style'] = val;
    } else {
      // camelCase → kebab-case
      result[key.replace(/([A-Z])/g, '-$1').toLowerCase()] = val;
    }
  }

  if (hasMotionTransform) {
    const transformCSS = buildTransformPreview(motionProps);
    if (transformCSS) result['transform'] = transformCSS;
  }

  return result;
}

// ─── KeyframeSheet ────────────────────────────────────────────────────────────

export default function KeyframeSheet() {
  const [sheetInfo, setSheetInfo] = useAtom(activeKeyframeSheetAtom);
  const [selectedStop, setSelectedStop] = useAtom(selectedKeyframeStopAtom);
  const keyframes = useAtomValue(keyframesAtom);
  const bumpKeyframes = useSetAtom(keyframesBumpAtom);
  const [sheetHeight, setSheetHeight] = useState(SHEET_DEFAULT_HEIGHT);
  const [playState, setPlayState] = useState<'idle' | 'playing' | 'paused'>('idle');
  const [cursorPercent, setCursorPercent] = useState(0);
  const playTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const playStartMsRef = useRef<number>(0); // performance.now() when play started, adjusted for initial position
  const [addPropertyContent, setAddPropertyContent] = useState<React.ReactNode | null>(null);
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const innerRulerRef = useRef<HTMLDivElement>(null);
  // Stable ref so the keydown handler (closed over once) can call the current handlePlay
  const spacebarPlayRef = useRef<() => void>(() => {});

  // Reset selection when sheet closes, clear play state + rAF
  const setSelectedStopAtom = useSetAtom(selectedKeyframeStopAtom);
  useEffect(() => {
    if (!sheetInfo) {
      setSelectedStopAtom(null);
      setPlayState('idle');
      setCursorPercent(0);
      if (playTimerRef.current) clearTimeout(playTimerRef.current);
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    }
  }, [sheetInfo, setSelectedStopAtom]);

  // Reset add-property panel when stop selection changes
  useEffect(() => { setAddPropertyContent(null); }, [selectedStop]);

  // Close on Escape, spacebar to play/pause
  useEffect(() => {
    if (!sheetInfo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        trace.action('keyframe-sheet:close-escape', { name: sheetInfo.name });
        setSheetInfo(null);
      } else if (e.key === ' ' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        spacebarPlayRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheetInfo, setSheetInfo]);

  // Panel context removed — MotionPropsEditor uses inline Add Property list,
  // and controls like ColorInput open their own standalone ToolPopup

  // Per-node subscription for the sheet's target node (hook — lives ABOVE the
  // early return; null sheetInfo → no node id → undefined).
  const node = useNode(sheetInfo?.nodeId);

  if (!sheetInfo) return null;

  const { name, nodeId } = sheetInfo;
  trace.fn('keyframe-sheet:render', { name, nodeId, selectedStop });

  // Find keyframe data — fallback to default 2 stops if not yet parsed
  const keyframe: KeyframeAnimation = keyframes.find(k => k.name === name) ?? {
    name,
    stops: [{ offset: 0, properties: {} }, { offset: 100, properties: {} }],
  };

  // Read animation config from the node's styles
  const animationStr = node?.styles?.animation ?? '';
  const anims = parseAnimationShorthand(animationStr);
  const animData: AnimationData = anims[0] ?? {
    keyframeName: name,
    duration: 1,
    easing: 'ease',
    delay: 0,
    iterationCount: '1',
    direction: 'normal',
    fillMode: 'forwards',
  };

  // ─── Write helpers ────────────────────────────────────────────────────────

  const writeKeyframe = (updated: KeyframeAnimation) => {
    const css = formatKeyframes(updated);
    trace.action('keyframe-sheet:write-keyframe', { name: updated.name, stops: updated.stops.length });
    queueMutation({ type: 'updateKeyframes', name: updated.name, css });
    // Flush synchronously so tokens.css is written before we refresh canvas + re-read atom
    flushNow();
    refreshCanvasTokens();
    bumpKeyframes(v => v + 1);
  };

  const writeAnimData = (updated: AnimationData) => {
    const str = formatAnimationShorthand([updated, ...anims.slice(1)]);
    trace.action('keyframe-sheet:write-anim-data', { nodeId, str });
    queueMutation({ type: 'updateStyles', nodeId, styles: { animation: str } });
  };

  // ─── Play preview ─────────────────────────────────────────────────────────

  /** Start rAF cursor animation. Called on play and resume. */
  const startCursorRaf = (durationMs: number, iterationCount: string, offsetMs: number) => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    playStartMsRef.current = performance.now() - offsetMs;
    const isInfinite = iterationCount === 'infinite';
    const iterations = isInfinite ? Infinity : (parseFloat(iterationCount) || 1);

    const tick = () => {
      const elapsed = performance.now() - playStartMsRef.current;
      const iterationProgress = elapsed / durationMs; // total iterations elapsed
      if (!isInfinite && iterationProgress >= iterations) {
        setCursorPercent(100);
        setPlayState('idle');
        rafRef.current = null;
        return;
      }
      const withinIteration = iterationProgress % 1;
      setCursorPercent(withinIteration * 100);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  // Helper: patch animation styles on the canvas element via the bridge —
  // the canvas DOM lives in the sandbox iframe (parent-frame reads are null).
  const patchAnimStyle = (styles: Record<string, string>) => {
    const prefix = getViewportPrefix('desktop');
    getCanvasBridge().patchStyles(nodeId, prefix, styles);
  };

  const handlePlay = () => {
    // Node must be rendered in the canvas (bridge rect cache has it).
    if (!findNodeRect(nodeId, 'desktop')) { trace.error('keyframe-sheet:play-no-el', { nodeId }); return; }

    if (playState === 'playing') {
      // Pause
      patchAnimStyle({ animationPlayState: 'paused' });
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      if (playTimerRef.current) clearTimeout(playTimerRef.current);
      setPlayState('paused');
      trace.action('keyframe-sheet:pause', { name });
      return;
    }

    const durationMs = animData.duration * 1000;

    if (playState === 'paused') {
      // Resume — offset rAF by current cursor position so it continues from where it was
      patchAnimStyle({ animationPlayState: 'running' });
      setPlayState('playing');
      startCursorRaf(durationMs, animData.iterationCount, (cursorPercent / 100) * durationMs);
      trace.action('keyframe-sheet:resume', { name });
      return;
    }

    // Start from beginning — clear the animation, then re-set it so it
    // restarts from 0%. Each bridge patch forces a layout flush in the
    // sandbox (it reads getComputedStyle after applying), so the
    // 'none' → shorthand sequence reliably restarts the CSS animation.
    patchAnimStyle({ animationPlayState: '', animation: 'none' });
    patchAnimStyle({ animation: animationStr });
    setCursorPercent(0);
    setPlayState('playing');
    startCursorRaf(durationMs, animData.iterationCount, 0);
    trace.action('keyframe-sheet:play-start', { name, nodeId, duration: animData.duration });
  };

  const handleStop = () => {
    patchAnimStyle({ animationPlayState: '' });
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (playTimerRef.current) clearTimeout(playTimerRef.current);
    setCursorPercent(0);
    setPlayState('idle');
    trace.action('keyframe-sheet:stop', { name });
  };

  /** Drag the cursor playhead */
  const handleCursorDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Pause animation while scrubbing
    if (playState === 'playing') {
      patchAnimStyle({ animationPlayState: 'paused' });
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      setPlayState('paused');
    }
    const innerEl = innerRulerRef.current;
    if (!innerEl) return;

    const onMove = (ev: PointerEvent) => {
      const rect = innerEl.getBoundingClientRect();
      const pct = Math.max(0, Math.min(100, ((ev.clientX - rect.left) / rect.width) * 100));
      setCursorPercent(pct);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    // Initial position
    const rect = innerEl.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    setCursorPercent(pct);
    trace.action('keyframe-sheet:cursor-drag', { name });
  };

  // Keep spacebarPlayRef current so the keydown handler can call it
  spacebarPlayRef.current = handlePlay;
  const isPlaying = playState === 'playing';

  // ─── Stop operations ──────────────────────────────────────────────────────

  const handleStopSelect = (index: number) => {
    setSelectedStop(index);
    trace.action('keyframe-sheet:stop-select', { name, index, offset: keyframe.stops[index]?.offset });
  };

  const handleOffsetChange = (index: number, newOffset: number) => {
    const stops = keyframe.stops.map((s, i) => i === index ? { ...s, offset: newOffset } : s);
    const sorted = [...stops].sort((a, b) => a.offset - b.offset);
    const newIndex = sorted.findIndex(s => s === stops[index]);
    writeKeyframe({ ...keyframe, stops: sorted });
    setSelectedStop(newIndex >= 0 ? newIndex : index);
    trace.fn('keyframe-sheet:offset-change', { name, index, newOffset });
  };

  const handlePropsUpdate = (index: number, updatedProps: Record<string, string>) => {
    const stops = keyframe.stops.map((s, i) => i === index ? { ...s, properties: updatedProps } : s);
    writeKeyframe({ ...keyframe, stops });
    trace.action('keyframe-sheet:props-update', { name, index, propCount: Object.keys(updatedProps).length });
  };

  const handleAddStop = () => {
    const stops = keyframe.stops;
    // Pick midpoint between last two stops, or 50 if only 1 stop
    let newOffset = 50;
    if (stops.length >= 2) {
      const last = stops[stops.length - 1].offset;
      const prev = stops[stops.length - 2].offset;
      newOffset = Math.round((last + prev) / 2);
    }
    const newStop: KeyframeStop = { offset: newOffset, properties: {} };
    const newStops = [...stops, newStop].sort((a, b) => a.offset - b.offset);
    const newIndex = newStops.indexOf(newStop);
    writeKeyframe({ ...keyframe, stops: newStops });
    setSelectedStop(newIndex);
    trace.action('keyframe-sheet:add-stop', { name, offset: newOffset, newIndex });
  };

  const handleRemoveStop = (index: number) => {
    if (keyframe.stops.length <= 2) {
      trace.action('keyframe-sheet:remove-stop-blocked', { name, reason: 'min-2-stops' });
      return;
    }
    const stops = keyframe.stops.filter((_, i) => i !== index);
    writeKeyframe({ ...keyframe, stops });
    setSelectedStop(null);
    trace.action('keyframe-sheet:remove-stop', { name, index });
  };

  // ─── Resize handle ────────────────────────────────────────────────────────

  const handleResizeStart = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, input, select')) return;
    e.preventDefault();
    resizeRef.current = { startY: e.clientY, startH: sheetHeight };
    const onMove = (ev: PointerEvent) => {
      if (!resizeRef.current) return;
      const dy = resizeRef.current.startY - ev.clientY;
      setSheetHeight(clamp(resizeRef.current.startH + dy, SHEET_MIN_HEIGHT, SHEET_MAX_HEIGHT));
    };
    const onUp = () => {
      resizeRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      trace.action('keyframe-sheet:resize-end', { sheetHeight });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    trace.action('keyframe-sheet:resize-start', { sheetHeight });
  };

  const selectedStopData = selectedStop !== null ? keyframe.stops[selectedStop] ?? null : null;

  const content = (
    <div
      className="fixed bottom-0 left-[308px] right-[260px] z-[9999] flex flex-col bg-[var(--bg-surface)]"
      style={{
        height: sheetHeight,
        borderTop: '1px solid var(--border-light)',
      }}
    >
      {/* ── Header — resize grip + playback controls ───────────────────── */}
      <div
        className="flex items-center justify-between px-3 shrink-0 border-b border-[var(--border-light)] cursor-ns-resize"
        style={{ height: 40 }}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button, input, select')) return;
          handleResizeStart(e);
        }}
      >
        {/* Left: play, stop, separator, name, config */}
        <div className="flex items-center gap-2" style={{ minWidth: 0, overflow: 'hidden' }}>
          {/* Play/Pause */}
          <button
            onClick={handlePlay}
            className={`w-6 h-6 flex items-center justify-center cut-corners cursor-pointer border-none transition-colors shrink-0 ${
              isPlaying ? 'bg-yellow-500 hover:bg-yellow-400' : 'bg-[var(--accent)] hover:brightness-110'
            }`}
            title={isPlaying ? 'Pause (Space)' : playState === 'paused' ? 'Resume (Space)' : 'Play (Space)'}
          >
            {isPlaying ? (
              <svg width="8" height="8" viewBox="0 0 10 10" fill="var(--accent-fg)"><rect x="1" width="3" height="10" rx="0.5" /><rect x="6" width="3" height="10" rx="0.5" /></svg>
            ) : (
              <svg width="8" height="8" viewBox="0 0 10 10" fill="var(--accent-fg)"><polygon points="1,0 10,5 1,10" /></svg>
            )}
          </button>
          {/* Stop */}
          <button
            onClick={handleStop}
            disabled={playState === 'idle'}
            className={`w-6 h-6 flex items-center justify-center cut-corners cursor-pointer border-none transition-colors shrink-0 ${
              playState !== 'idle' ? 'bg-red-500/80 hover:bg-red-500' : 'bg-[var(--bg-hover)] opacity-40 cursor-default'
            }`}
            title="Stop & reset"
          >
            <svg width="8" height="8" viewBox="0 0 10 10" fill="var(--accent-fg)"><rect width="10" height="10" rx="1" /></svg>
          </button>
          {/* Separator */}
          <div className="w-px h-3 bg-[var(--border-light)] shrink-0" />
          {/* Label */}
          <span className="text-[11px] font-semibold text-[var(--text-primary)] shrink-0">Keyframe</span>
          <div className="w-px h-3 bg-[var(--border-light)] shrink-0" />
          <span className="text-[11px] text-[var(--accent-text)] font-mono shrink-0 max-w-[100px] truncate" title={name}>{name}</span>
          <div className="w-px h-3 bg-[var(--border-light)] shrink-0" />

          {/* Animation config — scrollable overflow */}
          <div className="flex items-center gap-2 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
            <div className="flex items-center gap-1 shrink-0">
              <span className="text-[10px] text-[var(--text-secondary)]">Duration</span>
              <input
                className="w-12 h-5 px-1 text-[10px] bg-[var(--bg-input)] border border-[var(--control-border)] cut-corners cut-sm cut-border focus:[--cut-border-color:var(--accent)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] tabular-nums"
                type="number" min={0} step={0.1}
                value={animData.duration}
                onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) writeAnimData({ ...animData, duration: v }); }}
              />
              <span className="text-[10px] text-[var(--text-secondary)]">s</span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <span className="text-[10px] text-[var(--text-secondary)]">Ease</span>
              <select
                className="h-5 px-1 text-[10px] bg-[var(--bg-input)] border border-[var(--control-border)] cut-corners cut-sm cut-border text-[var(--text-primary)] focus:outline-none cursor-pointer"
                value={animData.easing}
                onChange={(e) => writeAnimData({ ...animData, easing: e.target.value })}
              >
                {CSS_EASING_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <span className="text-[10px] text-[var(--text-secondary)]">Repeat</span>
              <select
                className="h-5 px-1 text-[10px] bg-[var(--bg-input)] border border-[var(--control-border)] cut-corners cut-sm cut-border text-[var(--text-primary)] focus:outline-none cursor-pointer"
                value={animData.iterationCount}
                onChange={(e) => writeAnimData({ ...animData, iterationCount: e.target.value })}
              >
                {CSS_ITERATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <span className="text-[10px] text-[var(--text-secondary)]">Fill</span>
              <select
                className="h-5 px-1 text-[10px] bg-[var(--bg-input)] border border-[var(--control-border)] cut-corners cut-sm cut-border text-[var(--text-primary)] focus:outline-none cursor-pointer"
                value={animData.fillMode}
                onChange={(e) => writeAnimData({ ...animData, fillMode: e.target.value })}
              >
                {CSS_FILL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* Right: circle-X close */}
        <button
          onClick={() => { trace.action('keyframe-sheet:close', { name }); setSheetInfo(null); }}
          className="w-6 h-6 flex items-center justify-center cursor-pointer bg-transparent border-none text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors shrink-0 ml-2"
          title="Close"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path fillRule="evenodd" d="M12 22c-4.714 0-7.071 0-8.536-1.465C2 19.072 2 16.714 2 12s0-7.071 1.464-8.536C4.93 2 7.286 2 12 2s7.071 0 8.535 1.464C22 4.93 22 7.286 22 12s0 7.071-1.465 8.535C19.072 22 16.714 22 12 22M8.97 8.97a.75.75 0 0 1 1.06 0L12 10.94l1.97-1.97a.75.75 0 0 1 1.06 1.06L13.06 12l1.97 1.97a.75.75 0 1 1-1.06 1.06L12 13.06l-1.97 1.97a.75.75 0 1 1-1.06-1.06L10.94 12l-1.97-1.97a.75.75 0 0 1 0-1.06" clipRule="evenodd" />
          </svg>
        </button>
      </div>

      {/* ── Body: two-pane (left: stop editor, right: ruler) ─────────────── */}
      <div className="flex flex-1 min-h-0">

        {/* Left pane — stop property editor */}
          <div
            className="flex flex-col border-r border-[var(--border-light)]"
            style={{ width: '30%', minWidth: 180, maxWidth: 320 }}
          >
            {/* Add Property sliding panel header */}
            {addPropertyContent && (
              <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-light)] shrink-0">
                <button
                  onClick={() => setAddPropertyContent(null)}
                  className="p-0.5 hover:bg-[var(--bg-hover)] cut-corners transition-colors text-[var(--text-secondary)] hover:text-[var(--text-primary)] border-none bg-transparent cursor-pointer"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </button>
                <span className="text-[11px] font-bold text-[var(--text-primary)]">Add Property</span>
              </div>
            )}

            {/* Main content area */}
            <div className="flex-1 overflow-y-auto p-3" style={{ scrollbarWidth: 'none' }}>
              {addPropertyContent ? (
                <div className="flex flex-col gap-1">{addPropertyContent}</div>
              ) : selectedStopData !== null ? (
                <div className="flex flex-col gap-3.5">
                  <span className="text-[11px] font-semibold text-[var(--text-primary)]">{selectedStopData.offset}%</span>
                  <MotionPropsEditor
                    nodeId={nodeId}
                    props={cssToMotionProps(selectedStopData.properties)}
                    onChange={(newMotionProps) => {
                      if (selectedStop !== null) {
                        handlePropsUpdate(selectedStop, motionPropsToCss(newMotionProps));
                      }
                    }}
                    mode="cssKeyframe"
                    preview={false}
                    renderAddPropertyList={(list) => setAddPropertyContent(list)}
                  />
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full gap-1 py-8">
                  <span className="text-[11px] text-center" style={{ color: 'var(--text-secondary)' }}>Click a stop to edit</span>
                  <span className="text-[10px] text-center leading-relaxed" style={{ color: 'var(--text-disabled)' }}>
                    e.g. opacity: 0 at 0%<br />opacity: 1 at 100%
                  </span>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="shrink-0 flex items-center justify-between px-3 py-2 border-t border-[var(--border-light)]">
              <button
                className="h-6 px-2 text-[11px] text-[var(--text-secondary)] border border-dashed border-[var(--control-border)] cut-corners hover:border-[var(--accent)] hover:text-[var(--accent-text)] transition-colors cursor-pointer bg-transparent"
                onClick={handleAddStop}
              >
                + Add Stop
              </button>
              <span className="text-[10px]" style={{ color: 'var(--text-disabled)' }}>
                {keyframe.stops.length} stops
              </span>
            </div>
          </div>

        {/* Right pane — keyframe ruler */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Ruler header bar with percentage labels + border-bottom */}
          <div className="shrink-0 relative border-b border-[var(--border-light)]" style={{ height: 28, marginLeft: 12, marginRight: 12 }}>
            {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(pct => (
              <div key={pct} className="absolute top-0 bottom-0 flex flex-col items-center justify-end pb-1"
                style={{ left: `${pct}%`, transform: 'translateX(-50%)' }}>
                <span className="text-[9px] tabular-nums whitespace-nowrap" style={{ color: 'var(--text-disabled)' }}>{pct}%</span>
              </div>
            ))}
          </div>
          {/* Ruler body with stop markers */}
          <div
            ref={rulerRef}
            className="relative flex-1 select-none overflow-hidden"
            style={{
              minHeight: 0,
              backgroundImage: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.05) 0px, rgba(255,255,255,0.05) 1px, transparent 1px, transparent 10%)',
              backgroundSize: '10% 100%',
            }}
            onPointerDown={(e) => {
              const target = e.target as HTMLElement;
              if (target === rulerRef.current || target === innerRulerRef.current) {
                setSelectedStop(null);
              }
            }}
          >
            {/* Inner padded area — tick marks + stops are absolute inside this */}
            <div
              ref={innerRulerRef}
              className="absolute inset-y-0"
              style={{ left: 12, right: 12 }}
            >
              {/* Tick lines (vertical guides) */}
              <div className="absolute top-0 left-0 right-0 bottom-0 pointer-events-none">
                {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(pct => (
                  <div key={pct} className="absolute top-0 bottom-0 w-px"
                    style={{ left: `${pct}%`, background: pct % 50 === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)' }} />
                ))}
              </div>

              {/* Stop markers */}
              {keyframe.stops.map((stop, i) => (
                <StopMarker
                  key={`stop-${i}`}
                  stop={stop}
                  index={i}
                  selected={selectedStop === i}
                  rulerRef={innerRulerRef}
                  onSelect={handleStopSelect}
                  onOffsetChange={handleOffsetChange}
                  onRemove={handleRemoveStop}
                />
              ))}

              {/* Cursor playhead */}
              <div
                className="absolute top-0 bottom-0 z-30 cursor-ew-resize"
                style={{ left: `${cursorPercent}%`, transform: 'translateX(-7px)', width: 14 }}
                onPointerDown={handleCursorDrag}
              >
                {/* Triangle head at top */}
                <div style={{
                  position: 'absolute', left: 2, top: 0,
                  width: 10, height: 10,
                  backgroundColor: 'var(--accent)',
                  clipPath: 'polygon(0 0, 100% 0, 50% 100%)',
                }} />
                {/* Vertical line */}
                <div style={{
                  position: 'absolute', left: 6, top: 0, bottom: 0, width: 2,
                  backgroundColor: 'var(--accent)',
                  opacity: 0.8,
                }} />
              </div>
            </div>

            {/* Selected stop label */}
            {selectedStop !== null && (
              <div className="absolute bottom-1 right-2 text-[9px] tabular-nums pointer-events-none" style={{ color: 'var(--text-disabled)' }}>
                {keyframe.stops[selectedStop]?.offset ?? '?'}% selected
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
