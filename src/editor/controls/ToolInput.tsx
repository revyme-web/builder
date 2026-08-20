// ToolInput.tsx — Numeric/text input with chevron drag and arrow key nudging.
// Does NOT include label — use ToolRow for label + input layout.
// Exact input styling from old builder's ToolInput.tsx.

import { useState, useRef, useCallback, useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { canvasInteractingAtom } from '@/code/stores/store';
import { trace } from '@/shared/debug-trace';
import { useIsViewer } from '@/code/stores/viewer-mode-store';

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** OPTIONAL live update — fires every frame during a CHEVRON DRAG (and the
   *  hold-repeat). Wire to a cheap DOM-only patch; the final value commits via
   *  `onCommit` on release. When omitted, chevron drags fall back to per-frame
   *  `onChange` (legacy behaviour — every existing caller is unaffected). */
  onChangeLive?: (value: string) => void;
  /** OPTIONAL commit — fires ONCE when a chevron drag/hold ends. Pairs with
   *  `onChangeLive`. No-op when omitted. */
  onCommit?: (value: string) => void;
  /** Step for arrow keys and chevron drag (default 1) */
  step?: number;
  /** If true, treat as plain text (no numeric scrubbing) */
  text?: boolean;
  /** Small label shown on right side when not hovering (e.g. "px", "°"). Hidden on hover when chevrons appear. */
  chevronLabel?: string;
  className?: string;
  /** If true, input is greyed out and non-interactive */
  disabled?: boolean;
  /** Placeholder text shown when the input is empty. */
  placeholder?: string;
  /** Clamp floor for numeric scrubbing (chevron drag/hold, arrow keys). The
   *  drag REF is clamped too, so dragging past the floor sticks there instead
   *  of accumulating an invisible negative distance that must be dragged back.
   *  (Live find 2026-07-14: the Radius control scrubbed to -60.) */
  min?: number;
  /** Clamp ceiling for numeric scrubbing — same semantics as `min`. */
  max?: number;
}

/** Parse "300px" → { num: 300, unit: "px" } */
function parseNumeric(v: string): { num: number; unit: string } | null {
  const match = v.match(/^(-?[\d.]+)(px|%|em|rem|vh|vw|deg|fr|)?$/);
  if (!match) return null;
  return { num: parseFloat(match[1]), unit: match[2] || '' };
}

export default function ToolInput({ value, onChange, onChangeLive, onCommit, step = 1, text, chevronLabel, className, disabled, placeholder, min, max }: Props) {
  // Viewers see every ToolInput in the read-only disabled state. The
  // parent <fieldset disabled> already blocks the native input, but the
  // ToolInput wrapper's dimmed look keys off this flag — without it the
  // control reads as enabled (just unresponsive).
  const isViewer = useIsViewer();
  const effectiveDisabled = disabled || isViewer;
  const [localValue, setLocalValue] = useState(value);
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const setCanvasInteracting = useSetAtom(canvasInteractingAtom);

  // Chevron drag refs
  const isDraggingRef = useRef(false);
  const currentValueRef = useRef(0);
  const lastYRef = useRef(0);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // While a chevron drag/hold is active the field must DISPLAY the dragged
  // `localValue`, not the `value` prop — with a live (DOM-only) patch the prop
  // is frozen until the commit on release, so without this the number would
  // sit stale during the whole drag and snap on mouseup. State drives the
  // render; the ref guards the prop-sync effect from clobbering localValue.
  const [chevronDragging, setChevronDragging] = useState(false);
  const chevronDraggingRef = useRef(false);
  // After a chevron drag with a live (DOM-only) scrub, the COMMIT is async (code write → reparse → re-render,
  // ~0.1s). Hold the scrubbed `localValue` on screen through that gap — else on mouseup the field snaps back to
  // the stale `value` prop for a frame, then jumps to the committed value (the user-reported 255→280 flash).
  // Cleared the moment `value` catches up (the effect below) — so it ONLY bridges the post-drag commit window.
  const [holdLocal, setHoldLocal] = useState(false);

  // Prop→state sync BURST DETECTOR. This effect can only loop if the `value`
  // prop genuinely oscillates between different strings on every render —
  // a parent-side feeder bug. When that happens, React's update-depth limit
  // used to kill the WHOLE app (user crash 2026-07-30, ToolInput mount
  // storm). >60 syncs in a second while unfocused is pathological (committed
  // values change per code-write, not per frame): stop syncing for the rest
  // of that window (breaks the feedback loop, app stays alive; next window
  // resumes) and trace the oscillating values so the culprit control is
  // identifiable from the dump.
  const syncBurstRef = useRef({ windowStart: 0, count: 0, tripped: false, lastValues: [] as string[] });
  useEffect(() => {
    if (!isFocused && !isDraggingRef.current && !chevronDraggingRef.current) {
      const b = syncBurstRef.current;
      const now = performance.now();
      if (now - b.windowStart > 1000) { b.windowStart = now; b.count = 0; b.tripped = false; b.lastValues = []; }
      b.count++;
      if (b.lastValues.length < 6) b.lastValues.push(value);
      if (b.count > 60) {
        if (!b.tripped) {
          b.tripped = true;
          trace.error('tool-input:prop-sync-loop', {
            count: b.count, values: b.lastValues, placeholder: placeholder ?? '', text: !!text,
          });
        }
        return;
      }
      setLocalValue(value); setHoldLocal(false);
    }
  }, [value, isFocused]);

  const parsed = parseNumeric(value);
  const isNumeric = parsed !== null && !text;
  const unit = parsed?.unit || '';

  const clampNum = useCallback((num: number): number => {
    let n = num;
    if (min !== undefined && n < min) n = min;
    if (max !== undefined && n > max) n = max;
    return n;
  }, [min, max]);

  const applyValue = useCallback((num: number, live = false) => {
    const rounded = Math.round(clampNum(num) * 100) / 100;
    const newVal = `${rounded}${unit}`;
    setLocalValue(newVal);
    // Chevron drags pass live=true → DOM-only patch (commit on mouseup).
    // Everything else (arrow keys, single click without a live path) commits.
    if (live && onChangeLive) onChangeLive(newVal);
    else onChange(newVal);
  }, [onChange, onChangeLive, unit, clampNum]);

  const commit = useCallback((val: string) => {
    const trimmed = val.trim();
    if (trimmed === value) return;
    if (!text && unit && /^-?[\d.]+$/.test(trimmed)) {
      trace.action('tool-input:commit', { from: value, to: trimmed + unit });
      onChange(trimmed + unit);
    } else {
      trace.action('tool-input:commit', { from: value, to: trimmed });
      onChange(trimmed);
    }
  }, [value, onChange, unit, text]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { commit(localValue); inputRef.current?.blur(); }
    else if (e.key === 'Escape') { setLocalValue(value); inputRef.current?.blur(); }
    else if (isNumeric && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
      applyValue(parsed!.num + delta);
    }
  };

  // ─── Chevron hold + drag ──────────────────────────────────────────
  const startChevronDrag = useCallback((direction: 'up' | 'down', e: React.MouseEvent) => {
    if (!isNumeric || !parsed) return;
    e.preventDefault();
    e.stopPropagation();

    currentValueRef.current = parsed.num;
    lastYRef.current = e.clientY;
    isDraggingRef.current = false;
    chevronDraggingRef.current = true;
    setChevronDragging(true);
    setCanvasInteracting(true);

    // Single increment (LIVE — committed on mouseup so a single click still
    // persists via onCommit). The REF is clamped at every mutation so a drag
    // past the floor/ceiling sticks there — no invisible overshoot to unwind.
    const delta = direction === 'up' ? step : -step;
    currentValueRef.current = clampNum(currentValueRef.current + delta);
    applyValue(currentValueRef.current, true);

    // Hold-to-repeat after 200ms
    holdTimerRef.current = setTimeout(() => {
      intervalRef.current = setInterval(() => {
        if (!isDraggingRef.current) {
          currentValueRef.current = clampNum(currentValueRef.current + delta);
          applyValue(currentValueRef.current, true);
        }
      }, 50);
    }, 200);

    const handleMouseMove = (me: MouseEvent) => {
      me.preventDefault();
      const deltaY = me.clientY - lastYRef.current;
      if (Math.abs(deltaY) > 0) {
        isDraggingRef.current = true;
        currentValueRef.current = clampNum(currentValueRef.current - deltaY * step);
        applyValue(currentValueRef.current, true);
        lastYRef.current = me.clientY;
      }
    };

    const handleMouseUp = () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      if (intervalRef.current) clearInterval(intervalRef.current);
      isDraggingRef.current = false;
      chevronDraggingRef.current = false;
      setChevronDragging(false);
      setCanvasInteracting(false);
      document.removeEventListener('mousemove', handleMouseMove, true);
      document.removeEventListener('mouseup', handleMouseUp, true);
      document.body.style.cursor = '';
      // Commit the final value to code once (the drag/hold only live-patched). Hold the scrubbed display until
      // the async commit lands (value prop catches up) so the field doesn't flash the stale value first.
      // Batched with setChevronDragging(false) above (same handler) → no intermediate "show value" render.
      if (onCommit) { setHoldLocal(true); onCommit(`${Math.round(currentValueRef.current * 100) / 100}${unit}`); }
    };

    // CAPTURE phase: the drag-move + drag-END (mouseup) listeners must fire even
    // when an ANCESTOR stops these events from bubbling to `document`. The
    // ConnectionTypeModal does exactly that (`onMouseUp stopPropagation` to isolate
    // itself from the canvas), which left the chevron hold-repeat STUCK — the
    // mouseup never reached this listener so it never cleared the interval and the
    // value scrubbed with the mouse forever. Capture runs before any bubbling
    // stopPropagation, so the drag/hold always ends cleanly in any modal.
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('mouseup', handleMouseUp, true);
    document.body.style.cursor = 'ns-resize';
  }, [isNumeric, parsed, step, applyValue, clampNum, setCanvasInteracting, onCommit, unit]);

  const isAutoOrFill = value === 'auto' || value === 'fill';

  return (
    <div className={`relative group w-full ${effectiveDisabled ? 'opacity-40 pointer-events-none' : ''} ${className || ''}`}>
      <input
        ref={inputRef}
        type="text"
        value={isFocused || chevronDragging || holdLocal ? localValue : value}
        onChange={(e) => setLocalValue(e.target.value)}
        onFocus={(e) => {
          setIsFocused(true);
          setLocalValue(value);
          // Auto-select the entire current value on focus so the user
          // can immediately type to overwrite. Without this they'd need
          // to triple-click or Ctrl+A first — every property edit would
          // require an extra gesture. Defer with rAF so the selection
          // applies AFTER React's controlled-value sync (the
          // `value={isFocused ? localValue : value}` swap on this same
          // tick can otherwise reset the selection range).
          const el = e.currentTarget;
          requestAnimationFrame(() => el.select());
        }}
        onMouseUp={(e) => {
          // Browsers reset the selection on mouseup if the user clicked
          // (rather than tabbed) into the field. Re-select after the
          // browser's default handler runs but ONLY when no actual range
          // is being set by the user (clicked, didn't drag-select).
          const el = e.currentTarget;
          if (el.selectionStart === el.selectionEnd) {
            requestAnimationFrame(() => el.select());
          }
        }}
        onBlur={() => { setIsFocused(false); commit(localValue); }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={`w-full h-[var(--control-height)] px-[var(--control-pad-x)] text-xs bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] ${isAutoOrFill ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'} cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] focus:[--cut-border-color:var(--border-focus)] focus:outline-none transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
      />
      {/* Chevron label — shown when not hovering/focused, hidden when chevrons appear */}
      {chevronLabel && isNumeric && (
        <div className={`absolute right-2.5 inset-y-0 flex items-center pointer-events-none ${isFocused ? 'hidden' : 'group-hover:hidden'}`}>
          <span className="text-[9px] text-[var(--text-secondary)] font-medium">{chevronLabel}</span>
        </div>
      )}
      {/* Chevrons — visible on hover or focus */}
      {isNumeric && (
        // inset-y-[3px], not inset-y-0: shrinking the stack pulls the two
        // chevrons ~3px closer together, keeping the down chevron clear of
        // the field's bottom-right cut.
        <div className={`absolute right-1 inset-y-[3px] w-3 ${isFocused ? 'flex' : 'hidden group-hover:flex'} flex-col`}>
          <button
            tabIndex={-1}
            type="button"
            onMouseDown={(e) => startChevronDrag('up', e)}
            className="flex-1 flex items-center justify-center cursor-pointer group/chevron"
          >
            <svg className="w-2.5 h-2.5 text-[var(--text-secondary)] group-hover/chevron:text-[var(--text-primary)] transition-all group-hover/chevron:-translate-y-px" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          <button
            tabIndex={-1}
            type="button"
            onMouseDown={(e) => startChevronDrag('down', e)}
            className="flex-1 flex items-center justify-center cursor-pointer group/chevron"
          >
            <svg className="w-2.5 h-2.5 text-[var(--text-secondary)] group-hover/chevron:text-[var(--text-primary)] transition-all group-hover/chevron:translate-y-px" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
