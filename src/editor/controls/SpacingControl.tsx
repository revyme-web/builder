// SpacingControl.tsx — Reusable global/individual 4-value control.
// Used by StylesTool for Padding, Margin, Radius sections.
// Pattern: global input + uniform/individual toggle + 4 segmented inputs when expanded.
// Per-side unit awareness: each side shows its unit (px/%) as a clickable toggle.

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
  /** OPTIONAL live (per-frame) twin of `onChangeAll` — fires during a CHEVRON
   *  DRAG on the global input. Wire to a DOM-only patch (`onChangeMultipleLive`)
   *  so dragging the chevron stays at 60fps; the source write commits once on
   *  release via `onChangeAll`. When omitted, chevron drags fall back to
   *  per-frame `onChangeAll` (legacy behaviour — existing callers unaffected). */
  onChangeAllLive?: (value: string) => void;
  /** Reference size in px for px↔% conversion. For padding/margin: parent width. For radius: element size. */
  referenceSize?: number;
  /** Allow NEGATIVE values (margin only). Padding + radius can't be negative in
   *  CSS, so they leave this off and the lower bound stays 0. Margin passes true
   *  (negative margins are valid + needed for overlap/pull-up layouts). */
  allowNegative?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type SpacingUnit = 'px' | '%' | 'rem';

const UNIT_CYCLE: SpacingUnit[] = ['px', '%', 'rem'];
function nextUnit(u: SpacingUnit): SpacingUnit {
  const idx = UNIT_CYCLE.indexOf(u);
  return UNIT_CYCLE[(idx + 1) % UNIT_CYCLE.length];
}

/** Parse "60px" → { num: 60, unit: 'px' }, "5%" → { num: 5, unit: '%' }, "1.5rem" → { num: 1.5, unit: 'rem' } */
function parseValue(v: string): { num: number; unit: SpacingUnit } {
  if (!v || v === '0') return { num: 0, unit: 'px' };
  if (v.endsWith('rem')) return { num: parseFloat(v) || 0, unit: 'rem' };
  if (v.endsWith('%')) return { num: parseFloat(v) || 0, unit: '%' };
  return { num: parseInt(v) || 0, unit: 'px' };
}

/** Parse just the number */
function parseNum(v: string): number {
  return parseFloat(v) || 0;
}

/** Clamp a spacing number to its unit's valid range. The lower bound is 0
 *  (padding/radius can't be negative in CSS) UNLESS `allowNegative` — margins
 *  can be negative (needed for overlap / pull-up layouts), bounded at -max. */
export function clampSpacingValue(num: number, unit: SpacingUnit, allowNegative: boolean): number {
  const max = unit === '%' ? 100 : unit === 'rem' ? 99 : 999;
  return Math.max(allowNegative ? -max : 0, Math.min(max, num));
}

function allEqual(values: [string, string, string, string]): boolean {
  const n = parseNum(values[0]);
  return values.every(v => parseNum(v) === n);
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function SpacingControl({ values, labels, onChange, onChangeAll, onChangeAllLive, referenceSize, allowNegative = false }: SpacingControlProps) {
  const [showIndividual, setShowIndividual] = useState(() => !allEqual(values));
  const userToggledRef = useRef(false); // tracks if user explicitly toggled individual mode
  const [localValues, setLocalValues] = useState(values.map(v => String(parseNum(v))));
  const [units, setUnits] = useState<SpacingUnit[]>(() => values.map(v => parseValue(v).unit));
  const focusedRef = useRef<number | null>(null);

  // Sync from props (skip while user is editing)
  useEffect(() => {
    if (focusedRef.current === null) {
      setLocalValues(values.map(v => String(parseNum(v))));
      setUnits(values.map(v => parseValue(v).unit));
      // Only auto-toggle if user hasn't explicitly set the mode
      if (!userToggledRef.current) {
        setShowIndividual(!allEqual(values));
      }
    }
  }, [values]);

  // Global input value — show just the number (no unit)
  const globalValue = String(parseNum(values[0]));
  // Global unit — derived from first side's unit
  const globalUnit = units[0];

  const handleGlobalChange = useCallback((val: string) => {
    // Clamp typed AND scrubbed commits — padding/radius can't be negative
    // (the ToolInput `min` handles the scrub display; this guards typed text).
    const num = clampSpacingValue(parseFloat(val) || 0, globalUnit, allowNegative);
    const unit = globalUnit;
    const formatted = `${num}${unit}`;
    trace.action('spacing-control:global-change', { value: formatted });
    onChangeAll(formatted);
  }, [onChangeAll, globalUnit, allowNegative]);

  // Live (per-frame) twin for the global input's chevron drag. Same formatting
  // as handleGlobalChange but routes to the DOM-only patch — no source write
  // per frame. The commit lands once on release (ToolInput.onCommit →
  // handleGlobalChange). The global input carries no unit suffix, so the
  // ToolInput hands us a bare number; re-append the current unit here.
  const handleGlobalChangeLive = useCallback((val: string) => {
    if (!onChangeAllLive) return;
    const num = clampSpacingValue(parseFloat(val) || 0, globalUnit, allowNegative);
    onChangeAllLive(`${num}${globalUnit}`);
  }, [onChangeAllLive, globalUnit, allowNegative]);

  // Convert a numeric value between units. rem uses 16px base.
  const convertValue = useCallback((num: number, from: SpacingUnit, to: SpacingUnit): number => {
    if (from === to) return num;
    // First convert to px
    let px = num;
    if (from === '%' && referenceSize) px = (num / 100) * referenceSize;
    else if (from === 'rem') px = num * 16;
    // Then convert from px to target
    if (to === 'px') return Math.round(px);
    if (to === '%' && referenceSize) return Math.round((px / referenceSize) * 100);
    if (to === 'rem') return Math.round((px / 16) * 100) / 100; // 2 decimal places
    return Math.round(px);
  }, [referenceSize]);

  const toggleGlobalUnit = useCallback(() => {
    const currentUnit = units[0];
    const newUnit = nextUnit(currentUnit);

    // Apply to all sides
    const newUnits = units.map(() => newUnit);
    const newLocals = localValues.map((v) => {
      const num = parseFloat(v) || 0;
      return String(convertValue(num, currentUnit, newUnit));
    });

    setUnits(newUnits);
    setLocalValues(newLocals);
    // If all values are the same, use shorthand via onChangeAll
    const allSame = newLocals.every(v => v === newLocals[0]);
    if (allSame && !showIndividual) {
      onChangeAll(`${newLocals[0]}${newUnit}`);
    } else {
      for (let i = 0; i < 4; i++) {
        onChange(i, `${newLocals[i]}${newUnit}`);
      }
    }
    trace.action('spacing-control:global-unit-toggle', { from: currentUnit, to: newUnit });
  }, [units, localValues, onChange, onChangeAll, referenceSize, showIndividual]);

  // ─── Segmented input handlers ───────────────────────────────────
  const handleSegmentChange = useCallback((index: number, rawValue: string) => {
    if (rawValue === '' || rawValue === '-' || /^-?\d*\.?\d*$/.test(rawValue)) {
      setLocalValues(prev => { const n = [...prev]; n[index] = rawValue; return n; });
    }
  }, []);

  const commitSegment = useCallback((index: number) => {
    const num = parseFloat(localValues[index]) || 0;
    const unit = units[index];
    const clamped = clampSpacingValue(num, unit, allowNegative);
    setLocalValues(prev => { const n = [...prev]; n[index] = String(clamped); return n; });
    trace.action('spacing-control:side-change', { index, label: labels[index], value: clamped, unit });
    onChange(index, `${clamped}${unit}`);
    focusedRef.current = null;
  }, [localValues, units, onChange, labels, allowNegative]);

  const handleSegmentKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    if (e.key === 'Enter') { commitSegment(index); (e.target as HTMLInputElement).blur(); }
    else if (e.key === 'Escape') {
      setLocalValues(prev => { const n = [...prev]; n[index] = String(parseNum(values[index])); return n; });
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const unit = units[index];
      const step = e.shiftKey ? 10 : 1;
      const delta = (e.key === 'ArrowUp' ? 1 : -1) * step;
      const newVal = clampSpacingValue((parseFloat(localValues[index]) || 0) + delta, unit, allowNegative);
      setLocalValues(prev => { const n = [...prev]; n[index] = String(newVal); return n; });
      onChange(index, `${newVal}${unit}`);
    }
  }, [commitSegment, localValues, units, values, onChange, allowNegative]);

  const toggleUnit = useCallback((index: number) => {
    const currentUnit = units[index];
    const newUnit = nextUnit(currentUnit);
    const currentNum = parseFloat(localValues[index]) || 0;
    const convertedNum = convertValue(currentNum, currentUnit, newUnit);

    setUnits(prev => { const n = [...prev]; n[index] = newUnit; return n; });
    setLocalValues(prev => { const n = [...prev]; n[index] = String(convertedNum); return n; });
    trace.action('spacing-control:unit-toggle', { index, from: currentUnit, to: newUnit, convertedNum });
    onChange(index, `${convertedNum}${newUnit}`);
  }, [units, localValues, onChange, convertValue]);

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

        {/* Toggle group: uniform shows px/% text, individual shows uniform icon */}
        <div className="flex items-center border border-[var(--control-border)] rounded-md overflow-hidden shrink-0">
          {/* Left button: when uniform → shows unit (px/%), click toggles unit.
              When individual → shows uniform icon, click switches to uniform. */}
          <button
            tabIndex={-1}
            onClick={() => {
              if (showIndividual) {
                // Switch back to uniform — consolidate longhands into shorthand
                setShowIndividual(false);
                userToggledRef.current = true;
                const num = parseFloat(localValues[0]) || 0;
                const unit = units[0];
                onChangeAll(`${num}${unit}`);
              } else {
                toggleGlobalUnit();
              }
            }}
            className={`flex items-center justify-center h-7 w-7 transition-colors cursor-pointer ${
              !showIndividual
                ? 'bg-[var(--button-secondary-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:brightness-125'
                : 'bg-[var(--choice-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
            title={showIndividual ? 'Uniform' : `Switch to ${nextUnit(globalUnit)}`}
          >
            {showIndividual
              ? <UniformIcon className="w-3 h-3" />
              : <span className="text-[10px] font-medium">{globalUnit}</span>
            }
          </button>
          {/* Right button: individual sides */}
          <button
            tabIndex={-1}
            onClick={() => { setShowIndividual(true); userToggledRef.current = true; }}
            className={`flex items-center justify-center h-7 w-7 transition-colors ${
              showIndividual
                ? 'bg-[var(--button-secondary-bg)] text-[var(--text-primary)]'
                : 'bg-[var(--choice-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
            title="Individual sides"
          >
            <IndividualIcon className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Row 2: Individual segmented inputs (when expanded) */}
      {showIndividual && (
        <div className="mt-3">
          <div className="flex w-full rounded overflow-hidden">
            {localValues.map((val, i) => {
              const isFirst = i === 0;
              const isLast = i === 3;
              const unit = units[i];
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
                    <button
                      tabIndex={-1}
                      onClick={() => toggleUnit(i)}
                      className={`text-[9px] cursor-pointer transition-colors border-none bg-transparent leading-none p-0 ${
                        unit === '%' ? 'text-[var(--accent-text)]' : unit === 'rem' ? 'text-emerald-400' : 'text-[var(--text-disabled)]'
                      } hover:text-[var(--text-primary)]`}
                      title={`Switch to ${nextUnit(unit)}`}
                    >
                      {unit}
                    </button>
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
