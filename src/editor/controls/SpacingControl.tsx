// SpacingControl.tsx — Reusable global/individual 4-value control.
// Used by StylesTool for Padding, Margin, Radius sections.
// Pattern: global input + uniform/individual toggle + 4 segmented inputs when expanded.
//
// AXIS MODE (padding + margin — callers that pass `onChangeSides`): the
// corners button steps uniform → X / Y (left+right, top+bottom) → all four,
// and back to X / Y; the uniform button collapses to one value. Its icon
// shows two corners for X / Y and four for per-side (user request
// 2026-10-16). Radius has no axes, so it keeps the two-state toggle.
//
// PX-ONLY (2026-08-12, user decision): the per-side %/rem unit cycle was
// removed — spacing is a pixel concept for this audience (reference parity:
// the reference tools' padding/margin/radius controls have no unit picker),
// % padding resolves against the parent's WIDTH even for top/bottom (a
// footgun, not a feature), and multi-unit spacing bred a whole class of
// shorthand-mix/codegen bugs. Every commit writes `<n>px`. LEGACY values in
// other units still DISPLAY honestly (numeric part + a static unit label);
// the first edit converts that side to px. The oracle enforces the same
// rule for AI-written files (SPACING_UNIT_NOT_PX).

import { useState, useCallback, useEffect, useRef } from 'react';
import ToolInput from './ToolInput';
import { trace } from '@/shared/debug-trace';

// ─── Icons (exact SVGs from old builder) ────────────────────────────────────

function UniformIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="2 2 20 20" className={className}>
      <rect width="16.5" height="16.5" x="3.75" y="3.75" fill="none" stroke="currentColor"
        strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" rx="4" />
    </svg>
  );
}

/** Two of IndividualIcon's four corners (top-left + bottom-right) — the X / Y
 *  step. Same artwork family (Phosphor corners-out, via Iconify), so the two
 *  glyphs read as one control. */
function AxisIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 256 256" className={className}>
      <path fill="currentColor"
        d="M88 40H48a8 8 0 0 0-8 8v40a8 8 0 0 0 13.66 5.66l40-40A8 8 0 0 0 88 40m123.06 120.61a8 8 0 0 0-8.72 1.73l-40 40A8 8 0 0 0 168 216h40a8 8 0 0 0 8-8v-40a8 8 0 0 0-4.94-7.39" />
    </svg>
  );
}

function IndividualIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 256 256" className={className}>
      <path fill="currentColor"
        d="M93.66 202.34A8 8 0 0 1 88 216H48a8 8 0 0 1-8-8v-40a8 8 0 0 1 13.66-5.66ZM88 40H48a8 8 0 0 0-8 8v40a8 8 0 0 0 13.66 5.66l40-40A8 8 0 0 0 88 40m123.06 120.61a8 8 0 0 0-8.72 1.73l-40 40A8 8 0 0 0 168 216h40a8 8 0 0 0 8-8v-40a8 8 0 0 0-4.94-7.39M208 40h-40a8 8 0 0 0-5.66 13.66l40 40A8 8 0 0 0 216 88V48a8 8 0 0 0-8-8" />
    </svg>
  );
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface SpacingControlProps {
  /** 4 CSS values, e.g. ['10px', '20px', '10px', '20px'] or ['0', '0', '0', '0'] */
  values: [string, string, string, string];
  /** Labels under each segmented input, e.g. ['T', 'R', 'B', 'L'] or ['TL', 'TR', 'BR', 'BL'] */
  labels: [string, string, string, string];
  /** Called when a single side changes. index 0-3 maps to the labels. */
  onChange: (index: number, value: string) => void;
  /** Called when the global input changes (applies to all 4). */
  onChangeAll: (value: string) => void;
  /** All four sides at once — the X / Y inputs write two sides per edit, and
   *  per-side `onChange` rebuilds from the CURRENT values, so two calls would
   *  drop the first. Passing this ENABLES the X / Y step (padding, margin). */
  onChangeSides?: (values: [string, string, string, string]) => void;
  /** OPTIONAL live (per-frame) twin of `onChangeAll` — fires during a CHEVRON
   *  DRAG on the global input. Wire to a DOM-only patch (`onChangeMultipleLive`)
   *  so dragging the chevron stays at 60fps; the source write commits once on
   *  release via `onChangeAll`. When omitted, chevron drags fall back to
   *  per-frame `onChangeAll` (legacy behaviour — existing callers unaffected). */
  onChangeAllLive?: (value: string) => void;
  /** Allow NEGATIVE values (margin only). Padding + radius can't be negative in
   *  CSS, so they leave this off and the lower bound stays 0. Margin passes true
   *  (negative margins are valid + needed for overlap/pull-up layouts). */
  allowNegative?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** DISPLAY-only unit of a legacy value: '5%' → '%', '1.5rem' → 'rem', else
 *  'px'. Purely informational — every write is px. */
function displayUnit(v: string): string {
  if (!v || v === '0') return 'px';
  if (v.endsWith('rem')) return 'rem';
  if (v.endsWith('em')) return 'em';
  if (v.endsWith('%')) return '%';
  return 'px';
}

/** Parse just the number */
function parseNum(v: string): number {
  return parseFloat(v) || 0;
}

/** Clamp a spacing number. The lower bound is 0 (padding/radius can't be
 *  negative in CSS) UNLESS `allowNegative` — margins can be negative (needed
 *  for overlap / pull-up layouts), bounded at -999. */
export function clampSpacingValue(num: number, allowNegative: boolean): number {
  return Math.max(allowNegative ? -999 : 0, Math.min(999, num));
}

function allEqual(values: [string, string, string, string]): boolean {
  const n = parseNum(values[0]);
  return values.every(v => parseNum(v) === n);
}

export type SpacingMode = 'uniform' | 'axis' | 'individual';

/** The mode a set of values reads as: one value, matched pairs (top = bottom,
 *  left = right — only when the X / Y step exists), or four sides. */
export function detectSpacingMode(values: [string, string, string, string], axes: boolean): SpacingMode {
  if (allEqual(values)) return 'uniform';
  if (axes && parseNum(values[0]) === parseNum(values[2]) && parseNum(values[1]) === parseNum(values[3])) return 'axis';
  return 'individual';
}

/** What the corners button switches to: uniform → X / Y → four sides → X / Y. */
export function nextSpacingMode(mode: SpacingMode, axes: boolean): SpacingMode {
  if (!axes) return 'individual';
  return mode === 'axis' ? 'individual' : 'axis';
}

/** The four sides after an X / Y edit: X = right + left, Y = top + bottom. */
export function applyAxisValue(
  values: [string, string, string, string], axis: 'x' | 'y', value: string,
): [string, string, string, string] {
  const next = [...values] as [string, string, string, string];
  if (axis === 'y') { next[0] = value; next[2] = value; } else { next[1] = value; next[3] = value; }
  return next;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function SpacingControl({ values, labels, onChange, onChangeAll, onChangeSides, onChangeAllLive, allowNegative = false }: SpacingControlProps) {
  const axes = !!onChangeSides;
  const [mode, setMode] = useState<SpacingMode>(() => detectSpacingMode(values, axes));
  const showIndividual = mode !== 'uniform';
  const userToggledRef = useRef(false); // tracks if user explicitly toggled individual mode
  const [localValues, setLocalValues] = useState(values.map(v => String(parseNum(v))));
  const focusedRef = useRef<number | null>(null);
  // The X / Y input being typed in — a pair that differs shows "Mixed" only
  // while it is NOT being edited.
  const [editingAxis, setEditingAxis] = useState<'x' | 'y' | null>(null);

  // Sync from props (skip while user is editing)
  useEffect(() => {
    if (focusedRef.current === null) {
      setLocalValues(values.map(v => String(parseNum(v))));
      // Only auto-toggle if user hasn't explicitly set the mode
      if (!userToggledRef.current) {
        setMode(detectSpacingMode(values, axes));
      }
    }
  }, [values, axes]);

  // Global input value — show just the number (no unit)
  const globalValue = String(parseNum(values[0]));

  const handleGlobalChange = useCallback((val: string) => {
    // Clamp typed AND scrubbed commits — padding/radius can't be negative
    // (the ToolInput `min` handles the scrub display; this guards typed text).
    const num = clampSpacingValue(parseFloat(val) || 0, allowNegative);
    const formatted = `${num}px`;
    trace.action('spacing-control:global-change', { value: formatted });
    onChangeAll(formatted);
  }, [onChangeAll, allowNegative]);

  // Live (per-frame) twin for the global input's chevron drag. Same formatting
  // as handleGlobalChange but routes to the DOM-only patch — no source write
  // per frame. The commit lands once on release (ToolInput.onCommit →
  // handleGlobalChange).
  const handleGlobalChangeLive = useCallback((val: string) => {
    if (!onChangeAllLive) return;
    const num = clampSpacingValue(parseFloat(val) || 0, allowNegative);
    onChangeAllLive(`${num}px`);
  }, [onChangeAllLive, allowNegative]);

  // ─── Segmented input handlers ───────────────────────────────────
  const handleSegmentChange = useCallback((index: number, rawValue: string) => {
    if (rawValue === '' || rawValue === '-' || /^-?\d*\.?\d*$/.test(rawValue)) {
      setLocalValues(prev => { const n = [...prev]; n[index] = rawValue; return n; });
    }
  }, []);

  const commitSegment = useCallback((index: number) => {
    const num = parseFloat(localValues[index]) || 0;
    const clamped = clampSpacingValue(num, allowNegative);
    setLocalValues(prev => { const n = [...prev]; n[index] = String(clamped); return n; });
    trace.action('spacing-control:side-change', { index, label: labels[index], value: clamped });
    onChange(index, `${clamped}px`);
    focusedRef.current = null;
  }, [localValues, onChange, labels, allowNegative]);

  // ─── X / Y inputs (axis mode) ───────────────────────────────────
  // Y edits localValues[0] (top) and X localValues[1] (right); a commit writes
  // the PAIR through onChangeSides, the other axis untouched.
  const axisIndex = (axis: 'x' | 'y') => (axis === 'y' ? 0 : 1);
  const commitAxisValue = useCallback((axis: 'x' | 'y', num: number) => {
    if (!onChangeSides) return;
    const clamped = clampSpacingValue(num, allowNegative);
    setLocalValues(prev => {
      const n = [...prev];
      if (axis === 'y') { n[0] = String(clamped); n[2] = String(clamped); }
      else { n[1] = String(clamped); n[3] = String(clamped); }
      return n;
    });
    trace.action('spacing-control:axis-change', { axis, value: clamped });
    onChangeSides(applyAxisValue(values, axis, `${clamped}px`));
  }, [onChangeSides, values, allowNegative]);

  const commitAxis = useCallback((axis: 'x' | 'y') => {
    const raw = localValues[axisIndex(axis)];
    focusedRef.current = null;
    setEditingAxis(null);
    // Left a "Mixed" pair without typing — nothing to write.
    if (raw === '') return;
    commitAxisValue(axis, parseFloat(raw) || 0);
  }, [localValues, commitAxisValue]);

  const handleAxisKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>, axis: 'x' | 'y') => {
    const i = axisIndex(axis);
    if (e.key === 'Enter') { commitAxis(axis); (e.target as HTMLInputElement).blur(); }
    else if (e.key === 'Escape') {
      setLocalValues(prev => { const n = [...prev]; n[i] = String(parseNum(values[i])); return n; });
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      commitAxisValue(axis, (parseFloat(localValues[i]) || 0) + (e.key === 'ArrowUp' ? 1 : -1) * step);
    }
  }, [commitAxis, commitAxisValue, localValues, values]);

  const handleSegmentKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    if (e.key === 'Enter') { commitSegment(index); (e.target as HTMLInputElement).blur(); }
    else if (e.key === 'Escape') {
      setLocalValues(prev => { const n = [...prev]; n[index] = String(parseNum(values[index])); return n; });
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const delta = (e.key === 'ArrowUp' ? 1 : -1) * step;
      const newVal = clampSpacingValue((parseFloat(localValues[index]) || 0) + delta, allowNegative);
      setLocalValues(prev => { const n = [...prev]; n[index] = String(newVal); return n; });
      onChange(index, `${newVal}px`);
    }
  }, [commitSegment, localValues, values, onChange, allowNegative]);

  return (
    <div className="w-full">
      {/* Row 1: Global input + toggle */}
      <div className="flex items-center w-full gap-2">
        {/* Global input */}
        <ToolInput
          value={globalValue}
          onChange={handleGlobalChange}
          onChangeLive={onChangeAllLive ? handleGlobalChangeLive : undefined}
          onCommit={onChangeAllLive ? handleGlobalChange : undefined}
          min={allowNegative ? undefined : 0}
          className="flex-1"
        />

        {/* Toggle group: uniform shows the static px badge, individual shows uniform icon */}
        <div className="flex items-center border border-[var(--control-border)] cut-corners cut-border [--cut-border-color:var(--control-border)] overflow-hidden shrink-0">
          {/* Left button: when individual → shows uniform icon, click switches
              back to uniform (consolidates the longhands into shorthand).
              When uniform → a STATIC px badge; spacing is px-only, so there
              is no unit to cycle. */}
          <button
            tabIndex={-1}
            onClick={() => {
              if (!showIndividual) return;
              // Switch back to uniform — consolidate longhands into shorthand
              setMode('uniform');
              userToggledRef.current = true;
              const num = parseFloat(localValues[0]) || 0;
              onChangeAll(`${num}px`);
            }}
            className={`flex items-center justify-center h-7 w-7 transition-colors ${
              !showIndividual
                ? 'bg-[var(--button-secondary-bg)] text-[var(--text-disabled)] cursor-default'
                : 'bg-[var(--choice-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer'
            }`}
            title={showIndividual ? 'Uniform' : 'px'}
          >
            {showIndividual
              ? <UniformIcon className="w-3 h-3" />
              : <span className="text-[10px] font-medium">px</span>
            }
          </button>
          {/* Right button: X / Y ⇄ individual sides (only individual when the
              caller has no axes, e.g. radius). Two corners = X / Y, four =
              per-side. */}
          <button
            tabIndex={-1}
            data-spacing-mode={mode}
            onClick={() => {
              const next = nextSpacingMode(mode, axes);
              trace.action('spacing-control:mode', { from: mode, to: next });
              setMode(next);
              userToggledRef.current = true;
            }}
            className={`flex items-center justify-center h-7 w-7 transition-colors ${
              showIndividual
                ? 'bg-[var(--button-secondary-bg)] text-[var(--text-primary)]'
                : 'bg-[var(--choice-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
            title={!axes ? 'Individual sides' : mode === 'axis' ? 'Individual sides' : 'Horizontal & vertical'}
          >
            {axes && mode !== 'individual'
              ? <AxisIcon className="w-3 h-3" />
              : <IndividualIcon className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Row 2 (axis mode): X = left + right, Y = top + bottom */}
      {mode === 'axis' && (
        <div className="mt-3">
          <div className="flex w-full rounded overflow-hidden">
            {(['x', 'y'] as const).map((axis, k) => {
              const i = axisIndex(axis);
              const pair = axis === 'y' ? [values[0], values[2]] : [values[1], values[3]];
              const mixed = parseNum(pair[0]) !== parseNum(pair[1]) && editingAxis !== axis;
              const unit = displayUnit(pair[0]);
              return (
                <div key={axis} className="flex-1 flex flex-col relative">
                  <input
                    type="text"
                    data-spacing-axis={axis}
                    value={mixed ? '' : localValues[i]}
                    onChange={e => handleSegmentChange(i, e.target.value)}
                    onKeyDown={e => handleAxisKeyDown(e, axis)}
                    onBlur={() => commitAxis(axis)}
                    onFocus={e => {
                      focusedRef.current = i;
                      setEditingAxis(axis);
                      if (mixed) setLocalValues(prev => { const n = [...prev]; n[i] = ''; return n; });
                      e.target.select();
                    }}
                    placeholder={mixed ? 'Mixed' : '0'}
                    className={`w-full h-7 px-1.5 text-xs text-center bg-[var(--grid-line)] text-[var(--text-primary)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] focus:outline-none focus:z-10 transition-colors ${k === 0 ? 'rounded-l-lg' : '-ml-[1px] rounded-r-lg'}`}
                  />
                  <div className="flex justify-center items-center mt-0.5" style={{ gap: '2px' }}>
                    <span className="text-[9px] text-[var(--text-secondary)]">{axis.toUpperCase()}</span>
                    <span className={`text-[9px] leading-none ${unit === 'px' ? 'text-[var(--text-disabled)]' : 'text-[var(--accent-text)]'}`}>
                      {unit}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Row 2: Individual segmented inputs (when expanded) */}
      {mode === 'individual' && (
        <div className="mt-3">
          <div className="flex w-full rounded overflow-hidden">
            {localValues.map((val, i) => {
              const isFirst = i === 0;
              const isLast = i === 3;
              // Legacy values in other units display their unit as a STATIC
              // label so the user sees the truth; the first edit writes px.
              const unit = displayUnit(values[i]);
              return (
                <div key={i} className="flex-1 flex flex-col relative">
                  <input
                    type="text"
                    value={val}
                    onChange={e => handleSegmentChange(i, e.target.value)}
                    onKeyDown={e => handleSegmentKeyDown(e, i)}
                    onBlur={() => commitSegment(i)}
                    onFocus={e => { focusedRef.current = i; e.target.select(); }}
                    placeholder="0"
                    className={`w-full h-7 px-1.5 text-xs text-center bg-[var(--grid-line)] text-[var(--text-primary)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] focus:outline-none focus:z-10 transition-colors ${isFirst ? 'rounded-l-lg' : '-ml-[1px]'} ${isLast ? 'rounded-r-lg' : ''}`}
                  />
                  <div className="flex justify-center items-center mt-0.5" style={{ gap: '2px' }}>
                    <span className="text-[9px] text-[var(--text-secondary)]">{labels[i]}</span>
                    <span className={`text-[9px] leading-none ${unit === 'px' ? 'text-[var(--text-disabled)]' : 'text-[var(--accent-text)]'}`}>
                      {unit}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
