// LayoutTool.tsx — Flex/grid layout controls ported from old builder design.
// Uses icon-based direction toggle, direction-aware align/justify labels,
// human-readable wrap toggle, and grid column/row +/- controls.
// Also exports GridChildControls for grid child span/alignment controls.

import { useCallback, useState, useRef } from 'react';
import { ToolSection, ToolSegmentedControl, ToolDivider, ToolPlusMinus, ToolInput, ToolSelect, ToolSlider, StyleField, ControlLabel, ControlActionRow, ColorSwatch } from '../controls';
import { PaddingControl } from './StylesTool/atoms';
import ColorInput from '../controls/ColorInput';
import { LegacyVariableBoundPill } from '../controls/VariableBoundPill';
import ToolPopup from '../ui/ToolPopup';
import { useControl } from '../controls/ControlProvider';
import { getAlignOptions, getJustifyOptions } from '../controls/css-property-options';
import { LocalePillOrLegacy } from '../controls/LocaleBoundPill';
import { updateNodeStyles, getContentRoot, findNodeSize, findNodeRect } from '@/canvas/node-ops';
import { injectFlexLayoutOnFrame, resolveLayoutInjectionTargets, rebaseChildrenForDirectionFlip } from './layout-injection';
import { flushNow } from '@/code/mutation/mutation-queue';
import { transformManager } from '@/canvas/transform';
import { useAtomValue } from 'jotai';
import { getNodesSnapshot, selectedIdsAtom, nodesAtom, selectedNodeAtom } from '@/code/stores/store';
import { interactingViewportIdAtom, getViewportWidths } from '@/code/stores/viewport-store';
import { activeFilePathAtom, isComponentFilePath } from '@/code/project/active-file-store';
import { containerOverridesAtom } from '@/code/stores/container-query-store';
import { isPrimaryViewport } from '@/canvas/node-ops';
import { presetTokensAtom } from '@/code/stores/preset-store';
import { isFitSize } from '@/shared/constants';
import { trace } from '@/shared/debug-trace';
import { parseVarRef } from '@/shared/css-utils';
import { parseAutoTrack, formatAutoTrack,
  type TrackList, type Track, type TrackUnit,
  TRACK_UNIT_OPTIONS,
} from './grid-helpers';
import {
  parseGridConfig, formatGridConfig,
  flexToGridParentStyles, gridChildFillStyles,
  implicitRowCount, withRowsCount,
  type GridConfig, type GridAlign,
} from './grid-config';

// Re-export grid helpers for consumers that imported from LayoutTool

interface Props {
  styles: Record<string, string>;
  nodeId: string;
  onUpdate: (key: string, value: string) => void;
  onUpdateMultiple: (styles: Record<string, string>) => void;
  /** When true, only Block (columns) layout is available (text elements can't be flex/grid) */
  /** Template root: a Template is ALWAYS a flex column — its layout can't be
   *  changed or removed (design-tool parity). Renders a simplified panel:
   *  Align (cross-axis) + Gap + Padding only — no Type/Direction/Wrap/Justify
   *  and no +/- remove. */
  templateRoot?: boolean;
}

// ─── GridChildControls ──────────────────────────────────────────────────────

// Grid uses start/end (not flex-start/flex-end)
const GRID_SELF_ALIGN_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'start', label: 'Start' },
  { value: 'center', label: 'Center' },
  { value: 'end', label: 'End' },
  { value: 'stretch', label: 'Stretch' },
];

// ─── GridSpanSelect — single-axis Span dropdown ─────────────────────────────
// Matches the reference's Grid Child UX: one dropdown per axis with values
// `Span 1` ... `Span 12` + `Span All`. No explicit start/end fields — for
// 95% of real-world layouts spanning N cells from the auto-placed start is
// what designers actually want, and the auto-flow rest figures itself out.

const SPAN_OPTIONS = [
  { value: '1', label: 'Span 1' },
  { value: '2', label: 'Span 2' },
  { value: '3', label: 'Span 3' },
  { value: '4', label: 'Span 4' },
  { value: '5', label: 'Span 5' },
  { value: '6', label: 'Span 6' },
  { value: '7', label: 'Span 7' },
  { value: '8', label: 'Span 8' },
  { value: '9', label: 'Span 9' },
  { value: '10', label: 'Span 10' },
  { value: '11', label: 'Span 11' },
  { value: '12', label: 'Span 12' },
  { value: 'all', label: 'Span All' },
];

/** Encode a Span dropdown value to a CSS `grid-column`/`grid-row` value.
 *  - `'1'`   → `''` (single-cell auto-placed; remove the property)
 *  - `'all'` → `'1 / -1'` (full track length — common CSS idiom)
 *  - `'N'`   → `'span N'` (span N tracks from auto-placed start) */
function formatSpanValue(value: string): string {
  if (value === 'all') return '1 / -1';
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 1) return '';
  return `span ${n}`;
}

/** Decode an existing `grid-column`/`grid-row` CSS value back to a Span
 *  dropdown value. Anything we don't recognize (e.g. user-authored
 *  `2 / 4` mid-grid spans) falls through to `'1'` so the dropdown shows
 *  the safest default — we don't try to second-guess hand-written CSS. */
function parseSpanValue(css: string): string {
  if (!css) return '1';
  if (css.trim() === '1 / -1') return 'all';
  const m = css.match(/^span\s+(\d+)$/);
  if (m) return m[1];
  // Pattern `N / M` where M - N gives the span — surface it as Span (M-N)
  // when it starts at line 1 so a converted Position drag still reads
  // sensibly. Other start lines stay as Span 1 (CSS preserved verbatim
  // via the inline style; only the dropdown display is approximated).
  const explicit = css.match(/^(-?\d+)\s*\/\s*(-?\d+)$/);
  if (explicit) {
    const start = parseInt(explicit[1], 10);
    const end = parseInt(explicit[2], 10);
    if (start === 1 && end > 1) return String(end - 1);
  }
  return '1';
}

function GridSpanSelect({ label, value, onChange }: {
  label: string;
  value: string;       // dropdown value ('1' | '2' | ... | 'all')
  onChange: (cssValue: string) => void;
}) {
  return (
    <div className="flex items-center justify-between w-full">
      {/* Mirror `ControlLabel`'s `pl-[18px] -ml-[18px]` chevron gutter
          so the right-column width lines up with the StyleField rows
          (Align Self / Justify Self / Order) below this control. */}
      <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">{label}</span>
      <div className="w-full">
        <ToolSelect
          value={value}
          onChange={v => onChange(formatSpanValue(v))}
          options={SPAN_OPTIONS}
        />
      </div>
    </div>
  );
}

/**
 * Grid child controls: standard "Span N / Span N" per axis + self-
 * alignment. The previous Auto / Span / Position triple-mode was
 * confusing — designers think in "how many cells across" not in CSS
 * line numbers. This collapses to one dropdown per axis (1..12 + All).
 */
export function GridChildControls() {
  const { styles, updateStyle } = useControl();

  const colValue = parseSpanValue(styles.gridColumn || '');
  const rowValue = parseSpanValue(styles.gridRow || '');

  const updateCol = useCallback((css: string) => {
    trace.action('grid-child:col-span', { css });
    updateStyle('gridColumn', css);
  }, [updateStyle]);

  const updateRow = useCallback((css: string) => {
    trace.action('grid-child:row-span', { css });
    updateStyle('gridRow', css);
  }, [updateStyle]);

  return (
    <ToolSection title="Grid Child" collapsible>
      <div className="flex flex-col gap-2">
        {/* Column span */}
        <GridSpanSelect label="Columns" value={colValue} onChange={updateCol} />

        {/* Row span */}
        <GridSpanSelect label="Rows" value={rowValue} onChange={updateRow} />

        {/* Justify Self (Align Self lives in the Dimensions/SizeTool section
            since it applies to both flex AND grid children — keeping it there
            avoids two controls writing the same property in different panels) */}
        <StyleField property="justifySelf" label="Justify Self" defaultValue="auto"
          options={GRID_SELF_ALIGN_OPTIONS} />
      </div>
    </ToolSection>
  );
}

// FlexChildControls removed — flex child sizing (grow/shrink/basis/alignSelf) now lives in SizeTool

// ─── GridLayoutControls — standard grid parent UI ──────────────────────
//
// Main panel (Type / Masonry / Columns / Rows / Gap XY / Padding /
// Advanced) drives the structured `GridConfig`, which serializes to CSS
// via `grid-config.ts`. The Advanced popup hangs off the same config
// and exposes Columns mode, Width, Height, Align.

function GridLayoutControls({
  styles, onUpdateMultiple,
}: {
  styles: Record<string, string>;
  onUpdateMultiple: (styles: Record<string, string>) => void;
}) {
  // Parse current styles into the structured config every render. Since
  // each control writes back via formatGridConfig the round-trip is
  // stable — no drift between displayed values and source code.
  const config = parseGridConfig(styles);

  const apply = useCallback((next: GridConfig) => {
    onUpdateMultiple(formatGridConfig(next));
  }, [onUpdateMultiple]);

  // Child count of the selected grid — what the Rows field DISPLAYS in
  // fit-content mode, where the browser derives rows implicitly and the
  // config's rowsCount is just a parse default (it showed "2" over a
  // visibly 3-row grid, 2026-08-11).
  const gcNodes = useAtomValue(nodesAtom);
  const gcSelectedId = useAtomValue(selectedNodeAtom);
  const gridChildCount = gcSelectedId ? (gcNodes.get(gcSelectedId)?.children.length ?? 0) : 0;
  // The HARD FLOOR for the rows count: fewer template rows than the content
  // needs is not a real state — the overflow children land in IMPLICIT rows
  // that gridAutoRows sizes identically to the template rows, so "Rows: 2"
  // over 15 items × 5 columns renders pixel-identical to 3 ("stepping down
  // does nothing", 2026-08-11). The minus stops at the floor instead of
  // silently no-oping; fewer rows = more columns or fewer children.
  const rowsMin = config.masonry ? 1 : implicitRowCount(gridChildCount, config.columnsCount);
  const displayRows = config.heightMode === 'fit' && !config.masonry
    ? rowsMin
    : Math.max(rowsMin, config.rowsCount);

  // Number-input helper for Columns / Rows counts: floors at 1.
  // Changing columns count when `columnsMode === 'auto'` would be a
  // no-op — auto-fill derives count from container width and ignores
  // our count field on serialization. Flip to Fixed automatically so
  // the user's count actually takes effect. Rows have the SAME trap in
  // `fit` height mode (no row template is emitted at all) — a rows
  // change promotes the height mode via withRowsCount so the count
  // actually produces tracks (2026-08-11).
  const onCountChange = (key: 'columnsCount' | 'rowsCount') => (v: string) => {
    const n = Math.max(1, Math.min(20, parseInt(v) || 1));
    if (key === 'columnsCount') {
      apply({ ...config, columnsCount: n, columnsMode: 'fixed' });
    } else {
      apply(withRowsCount(config, Math.max(rowsMin, n), styles.height));
    }
  };
  // Same flips for the ± stepper.
  const onCountStep = (key: 'columnsCount' | 'rowsCount') => (v: number) => {
    const n = Math.max(1, Math.min(20, v));
    if (key === 'columnsCount') {
      apply({ ...config, columnsCount: n, columnsMode: 'fixed' });
    } else {
      apply(withRowsCount(config, Math.max(rowsMin, n), styles.height));
    }
  };

  return (
    <>
      {/* ── Masonry Yes/No (hidden when truly N/A — kept always-visible
           for parity with the reference; defaults No on new grids). ── */}
      <div className="flex items-center justify-between w-full">
        <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">Masonry</span>
        <div className="w-full">
          <ToolSegmentedControl
            value={config.masonry ? 'yes' : 'no'}
            onChange={v => apply({ ...config, masonry: v === 'yes' })}
            options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]}
            size="sm"
          />
        </div>
      </div>

      {/* ── Columns count + ± stepper ── */}
      <div className="flex items-center justify-between w-full">
        <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">Columns</span>
        <div className="flex items-center gap-1 w-full">
          <ToolInput
            value={String(config.columnsCount)}
            onChange={onCountChange('columnsCount')}
            step={1}
          />
          <ToolPlusMinus
            value={config.columnsCount}
            onChange={onCountStep('columnsCount')}
            min={1} max={20} step={1}
          />
        </div>
      </div>

      {/* ── Rows count + ± stepper — hidden in Masonry (rows are implicit) ── */}
      {!config.masonry && (
        <div className="flex items-center justify-between w-full">
          <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">Rows</span>
          <div className="flex items-center gap-1 w-full">
            <ToolInput
              value={String(displayRows)}
              onChange={onCountChange('rowsCount')}
              step={1}
            />
            <ToolPlusMinus
              value={displayRows}
              onChange={onCountStep('rowsCount')}
              min={rowsMin} max={20} step={1}
            />
          </div>
        </div>
      )}

      {/* ── Gap X / Y — two inputs in one row, labeled at the chevron. ── */}
      <div className="flex items-center justify-between w-full">
        <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">Gap</span>
        <div className="flex items-center gap-1 w-full">
          <ToolInput
            value={String(config.gapX)}
            onChange={v => apply({ ...config, gapX: Math.max(0, parseInt(v) || 0) })}
            step={1}
            chevronLabel="X"
          />
          <ToolInput
            value={String(config.gapY)}
            onChange={v => apply({ ...config, gapY: Math.max(0, parseInt(v) || 0) })}
            step={1}
            chevronLabel="Y"
          />
        </div>
      </div>

      {/* ── Advanced controls — inlined directly under Gap so users
           don't have to open a popup to reach common settings. Hidden
           in Masonry mode because those settings don't apply (all
           cells = 1fr, no explicit row tracks). ── */}
      {!config.masonry && (
        <>
          {/* Sub-Columns: Auto / Fixed */}
          <div className="flex items-center justify-between w-full">
            <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">Cols Mode</span>
            <div className="w-full">
              <ToolSegmentedControl
                value={config.columnsMode}
                onChange={v => apply({ ...config, columnsMode: v as 'auto' | 'fixed' })}
                options={[{ value: 'auto', label: 'Auto' }, { value: 'fixed', label: 'Fixed' }]}
                size="sm"
              />
            </div>
          </div>

          {/* Width: number + Min/Fixed dropdown */}
          <div className="flex items-center justify-between w-full">
            <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">Width</span>
            <div className="flex items-center gap-1 w-full">
              <ToolInput
                value={String(config.width)}
                onChange={v => apply({ ...config, width: Math.max(0, parseInt(v) || 0) })}
                step={10}
              />
              <ToolSelect
                value={config.widthMode}
                onChange={v => apply({ ...config, widthMode: v as 'min' | 'fixed' })}
                options={[{ value: 'min', label: 'Min' }, { value: 'fixed', label: 'Fixed' }]}
              />
            </div>
          </div>

          {/* Height: number (only when Fixed) + mode dropdown. Two layouts
              so the dropdown ALWAYS takes the full right-column width
              when alone — a placeholder `flex-1` div would compete for
              space and shrink the select. */}
          <div className="flex items-center justify-between w-full">
            <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">Height</span>
            {config.heightMode === 'fixed' ? (
              <div className="flex items-center gap-1 w-full">
                <ToolInput
                  value={String(config.height)}
                  onChange={v => apply({ ...config, height: Math.max(0, parseInt(v) || 0) })}
                  step={10}
                />
                <ToolSelect
                  value={config.heightMode}
                  onChange={v => apply({ ...config, heightMode: v as 'fixed' | 'fill' | 'fit' })}
                  options={[
                    { value: 'fixed', label: 'Fixed' },
                    { value: 'fill', label: 'Fill Container' },
                    { value: 'fit', label: 'Fit Content' },
                  ]}
                />
              </div>
            ) : (
              <div className="w-full">
                <ToolSelect
                  value={config.heightMode}
                  onChange={v => apply({ ...config, heightMode: v as 'fixed' | 'fill' | 'fit' })}
                  options={[
                    { value: 'fixed', label: 'Fixed' },
                    { value: 'fill', label: 'Fill Container' },
                    { value: 'fit', label: 'Fit Content' },
                  ]}
                />
              </div>
            )}
          </div>

          {/* Align: 3-button start/center/end (writes justify-content) */}
          <div className="flex items-center justify-between w-full">
            <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">Align</span>
            <div className="w-full">
              <ToolSegmentedControl
                value={config.align}
                onChange={v => apply({ ...config, align: v as GridAlign })}
                options={[
                  { value: 'start', label: '◧' },
                  { value: 'center', label: '◫' },
                  { value: 'end', label: '◨' },
                ]}
                size="sm"
              />
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ─── Auto Flow options ──────────────────────────────────────────────────────

const AUTO_FLOW_OPTIONS = [
  { value: 'row', label: 'Row' },
  { value: 'column', label: 'Col' },
  { value: 'dense', label: 'Dense' },
];

const GRID_ALIGN_OPTIONS = [
  { value: 'start', label: 'Start' },
  { value: 'center', label: 'Center' },
  { value: 'end', label: 'End' },
  { value: 'stretch', label: 'Stretch' },
];

const FLEX_CONTENT_OPTIONS = [
  { value: 'flex-start', label: 'Start' },
  { value: 'center', label: 'Center' },
  { value: 'flex-end', label: 'End' },
  { value: 'stretch', label: 'Stretch' },
  { value: 'space-between', label: 'Space Between' },
  { value: 'space-around', label: 'Space Around' },
  { value: 'space-evenly', label: 'Space Evenly' },
];

const GRID_CONTENT_OPTIONS = [
  { value: 'start', label: 'Start' },
  { value: 'center', label: 'Center' },
  { value: 'end', label: 'End' },
  { value: 'stretch', label: 'Stretch' },
  { value: 'space-between', label: 'Space Between' },
  { value: 'space-around', label: 'Space Around' },
  { value: 'space-evenly', label: 'Space Evenly' },
];

const AUTO_TRACK_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'fixed', label: 'Fixed (px)' },
  { value: 'minmax', label: 'Min-Max' },
];

// ─── Grid mode detection ────────────────────────────────────────────────────

type GridMode = 'fixed' | 'columns-auto' | 'auto-fill';

/** Detect grid configuration mode from current styles */
function detectGridMode(styles: Record<string, string>): GridMode {
  const cols = styles.gridTemplateColumns || '';
  const rows = styles.gridTemplateRows || '';
  const autoRows = styles.gridAutoRows || '';

  // Auto-fill: repeat(auto-fill, ...) on columns
  if (cols.includes('auto-fill')) return 'auto-fill';

  // Fixed grid: has explicit rows defined
  if (rows) return 'fixed';

  // Columns only: columns defined, rows auto-generated
  return 'columns-auto';
}

const GRID_MODE_OPTIONS = [
  { value: 'columns-auto', label: 'Columns' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'auto-fill', label: 'Auto Fill' },
];

// ─── Grid Presets ───────────────────────────────────────────────────────────

interface GridPreset {
  id: string;
  label: string;
  /** SVG viewBox blocks: [x, y, w, h] in a 24x24 grid */
  blocks: [number, number, number, number][];
  /** Parent styles to apply */
  parent: Record<string, string>;
  /** Per-child styles: index → styles. Children beyond this list get cleared. */
  children: Record<string, string>[];
}

const GRID_PRESETS: GridPreset[] = [
  {
    id: 'equal-2x2', label: '2×2 Equal',
    blocks: [[0,0,11,11],[13,0,11,11],[0,13,11,11],[13,13,11,11]],
    parent: { gridTemplateColumns: 'repeat(2, 1fr)', gridTemplateRows: 'repeat(2, 1fr)', gap: '16px' },
    children: [{}, {}, {}, {}],
  },
  {
    id: 'equal-3col', label: '3 Columns',
    blocks: [[0,0,7,24],[9,0,7,24],[17,0,7,24]],
    parent: { gridTemplateColumns: 'repeat(3, 1fr)', gridTemplateRows: '', gap: '16px', gridAutoRows: 'minmax(200px, auto)' },
    children: [{}, {}, {}],
  },
  {
    id: 'bento', label: 'Bento',
    blocks: [[0,0,14,14],[15,0,9,6],[15,8,9,6],[0,15,7,9],[8,15,7,9],[16,15,8,9]],
    parent: { gridTemplateColumns: 'repeat(4, 1fr)', gridTemplateRows: '', gap: '12px', gridAutoRows: '200px' },
    children: [
      { gridColumn: 'span 2', gridRow: 'span 2' },
      {}, {},
      {}, {}, {},
    ],
  },
  {
    id: 'sidebar', label: 'Sidebar',
    blocks: [[0,0,7,24],[9,0,15,24]],
    parent: { gridTemplateColumns: '280px 1fr', gridTemplateRows: '', gap: '24px' },
    children: [{}, {}],
  },
  {
    id: 'masonry', label: 'Masonry',
    blocks: [[0,0,7,14],[9,0,7,10],[17,0,7,18],[0,16,7,8],[9,12,7,12],[17,20,7,4]],
    parent: { gridTemplateColumns: 'repeat(3, 1fr)', gridTemplateRows: '', gap: '12px', gridAutoRows: 'minmax(100px, auto)' },
    children: [
      { gridRow: 'span 2' }, {}, { gridRow: 'span 2' },
      {}, { gridRow: 'span 2' }, {},
    ],
  },
  {
    id: 'dashboard', label: 'Dashboard',
    blocks: [[0,0,15,14],[16,0,8,6],[16,8,8,6],[0,16,8,8],[9,16,15,8]],
    parent: { gridTemplateColumns: '2fr 1fr 1fr', gridTemplateRows: 'repeat(2, 250px)', gap: '16px' },
    children: [
      { gridColumn: 'span 1', gridRow: 'span 2' },
      {}, {},
      {},
      { gridColumn: 'span 2' },
    ],
  },
  {
    id: 'holy-grail', label: 'Holy Grail',
    blocks: [[0,0,24,4],[0,6,6,14],[8,6,16,14],[0,22,24,2]],
    parent: { gridTemplateColumns: '200px 1fr', gridTemplateRows: 'auto 1fr auto', gap: '16px' },
    children: [
      { gridColumn: '1 / -1' },
      {}, {},
      { gridColumn: '1 / -1' },
    ],
  },
];

/** Small SVG preview of a grid preset */
function PresetIcon({ preset, onClick, size = 36 }: { preset: GridPreset; onClick: () => void; size?: number }) {
  return (
    <button
      onClick={onClick}
      title={preset.label}
      className="hover:bg-[var(--bg-hover)] cut-corners"
      style={{
        width: size + 10, height: size + 10,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: '1px solid var(--border-light)', borderRadius: 'var(--radius-md)',
        background: 'var(--control-bg)',
      }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24">
        {preset.blocks.map((b, i) => (
          <rect key={i} x={b[0]} y={b[1]} width={b[2]} height={b[3]} rx={1.5} fill="var(--accent)" opacity={0.7} />
        ))}
      </svg>
    </button>
  );
}

// ─── GridTrackControl — per-track column/row editing ────────────────────────

function GridTrackControl({ label, property, list, onChange }: {
  label: string;
  property: string;
  list: TrackList;
  onChange: (list: TrackList) => void;
}) {
  const addTrack = () => {
    const lastTrack = list.tracks[list.tracks.length - 1] || { value: 1, unit: 'fr' as TrackUnit };
    onChange({ ...list, tracks: [...list.tracks, { ...lastTrack }], isUniform: false });
  };

  const removeTrack = () => {
    if (list.tracks.length <= 1) return;
    const tracks = list.tracks.slice(0, -1);
    const isUniform = tracks.every(t => t.value === tracks[0].value && t.unit === tracks[0].unit);
    onChange({ ...list, tracks, isUniform });
  };

  const updateSingleTrack = (index: number, track: Track) => {
    const tracks = list.tracks.map((t, i) => i === index ? track : t);
    const isUniform = tracks.every(t => t.value === tracks[0].value && t.unit === tracks[0].unit);
    onChange({ ...list, tracks, isUniform });
  };

  // Auto-fill mode — parse minmax(Npx, unit) into structured controls
  if (list.autoFill) {
    const tpl = list.autoFillTemplate || 'minmax(200px, 1fr)';
    const mmMatch = tpl.match(/^minmax\(\s*(\d+)px\s*,\s*(.+?)\s*\)$/);
    const afMin = mmMatch ? mmMatch[1] : '200';
    const afMax = mmMatch ? mmMatch[2] : '1fr';

    const updateAutoFill = (min: string, max: string) => {
      onChange({ ...list, autoFillTemplate: `minmax(${min}px, ${max})` });
    };

    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between w-full">
          <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">Min</span>
          <div className="w-full">
            <ToolInput value={afMin} onChange={v => updateAutoFill(v, afMax)} step={10} chevronLabel="px" />
          </div>
        </div>
        <div className="flex items-center justify-between w-full">
          <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">Max</span>
          <div className="w-full">
            <ToolSelect value={afMax} onChange={v => updateAutoFill(afMin, v)} options={[
              { value: '1fr', label: '1fr' },
              { value: 'auto', label: 'auto' },
              { value: 'max-content', label: 'max-content' },
            ]} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Count row with +/- */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label={label} property={property} />
        <div className="flex items-center gap-1 w-full">
          <ToolInput value={String(list.tracks.length)} onChange={v => {
            const n = Math.max(1, parseInt(v) || 1);
            const current = list.tracks;
            if (n > current.length) {
              const last = current[current.length - 1] || { value: 1, unit: 'fr' as TrackUnit };
              const tracks = [...current, ...Array.from({ length: n - current.length }, () => ({ ...last }))];
              onChange({ ...list, tracks, isUniform: tracks.every(t => t.value === tracks[0].value && t.unit === tracks[0].unit) });
            } else {
              const tracks = current.slice(0, n);
              onChange({ ...list, tracks, isUniform: tracks.every(t => t.value === tracks[0].value && t.unit === tracks[0].unit) });
            }
          }} step={1} />
          <ToolPlusMinus value={list.tracks.length} onChange={v => {
            if (v > list.tracks.length) addTrack();
            else removeTrack();
          }} min={1} step={1} />
        </div>
      </div>

      {/* Per-track rows: value + unit dropdown. Label uses the same
          `pl-[18px] -ml-[18px]` chevron gutter as ControlLabel so the
          right-column flex sizing matches the parent track-count row
          above — without it the right-column inputs end up a few px
          wider than the parent's (visible mismatch on Columns/Rows). */}
      {list.tracks.map((track, i) => (
        <div key={i} className="flex items-center justify-between w-full">
          <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">{i + 1}</span>
          <div className="flex items-center gap-1 w-full">
            {track.unit !== 'auto' && track.unit !== 'min-content' && track.unit !== 'max-content' ? (
              <ToolInput value={String(track.value || 1)} onChange={v => updateSingleTrack(i, { ...track, value: parseFloat(v) || 1 })} step={track.unit === 'fr' ? 1 : 10} />
            ) : (
              <div className="flex-1" />
            )}
            <ToolSelect
              value={track.unit}
              onChange={v => {
                const unit = v as TrackUnit;
                const value = unit === 'auto' || unit === 'min-content' || unit === 'max-content' ? 0
                  : unit === 'fr' ? (track.value || 1)
                  : unit === 'px' ? (track.value || 200)
                  : track.value;
                updateSingleTrack(i, { value, unit });
              }}
              options={TRACK_UNIT_OPTIONS}
            />
          </div>
        </div>
      ))}

    </div>
  );
}

// ─── GridAutoTrackControl — Auto Rows/Cols with cascading sub-controls ──────

function GridAutoTrackControl({ label, property, config, onUpdate }: {
  label: string;
  property: string;
  config: ReturnType<typeof parseAutoTrack>;
  onUpdate: (key: string, value: string) => void;
}) {
  const update = (newConfig: typeof config) => {
    const css = formatAutoTrack(newConfig);
    trace.action('layout:grid-auto-track', { property, config: newConfig, css });
    onUpdate(property, css);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between w-full">
        <ControlLabel label={label} property={property} />
        <div className="w-full">
          <ToolSelect
            value={config.mode}
            onChange={v => update({ ...config, mode: v as any, fixedValue: v === 'fixed' ? '200' : config.fixedValue, minmaxMin: v === 'minmax' ? '200px' : config.minmaxMin, minmaxMax: v === 'minmax' ? 'auto' : config.minmaxMax })}
            options={AUTO_TRACK_OPTIONS}
          />
        </div>
      </div>

      {config.mode === 'fixed' && (
        <div className="flex items-center justify-between w-full">
          <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">Height</span>
          <div className="w-full">
            <ToolInput
              value={config.fixedValue || '200'}
              onChange={v => update({ ...config, fixedValue: v })}
              step={10}
              chevronLabel="px"
            />
          </div>
        </div>
      )}
      {config.mode === 'minmax' && (
        <>
          <div className="flex items-center justify-between w-full">
            <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">Min</span>
            <div className="w-full">
              <ToolInput
                value={String(parseInt(config.minmaxMin) || 200)}
                onChange={v => update({ ...config, minmaxMin: `${v}px` })}
                step={10}
                chevronLabel="px"
              />
            </div>
          </div>
          <div className="flex items-center justify-between w-full">
            <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">Max</span>
            <div className="w-full">
              <ToolSelect
                value={config.minmaxMax || 'auto'}
                onChange={v => update({ ...config, minmaxMax: v })}
                options={[
                  { value: 'auto', label: 'auto' },
                  { value: '1fr', label: '1fr' },
                  { value: 'max-content', label: 'max-content' },
                ]}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────

/**
 * Which layout mode (if any) the Layout panel should surface for a node.
 *
 * Detects from the actual layout PROPS, not just `display` — a hidden node
 * (`display: 'none'`) with flex/grid props still has an authored layout;
 * Hide and Layout are independent concerns (reference parity: Visible
 * YES/NO doesn't blank the Stack/Grid configuration). Grid takes precedence
 * when both prop families coexist, matching the Type toggle's
 * `hasGrid ? 'grid' : 'flex'`.
 *
 * TEXT leaf elements never mount this tool at all (gated in
 * PropertiesPanel) — layouts are a frame concept. The text multi-column
 * "Block" mode that used to live here was removed (2026-08-12): CSS
 * multicol can't coexist with the text tool's Adjust control (`display:
 * flex` disables multicol on the same element), behaves erratically with
 * auto width / fixed height (overflow spawns columns HORIZONTALLY past the
 * box, per spec), and designers wanting a magazine spread use two text
 * frames in a flex row instead. Legacy `columnCount` in user source still
 * parses and renders — it just has no control, and here it never counts as
 * a layout.
 */
export function detectLayoutFlags(
  styles: Record<string, string>,
): { hasFlex: boolean; hasGrid: boolean; hasLayout: boolean } {
  const display = styles.display || '';
  const hasFlexDisplay = display === 'flex' || display === 'inline-flex';
  const hasGridDisplay = display === 'grid' || display === 'inline-grid';
  const hasFlexProps = !!styles.flexDirection
    || !!styles.alignItems
    || !!styles.justifyContent
    || !!styles.flexWrap
    || (styles.gap !== undefined && styles.gap !== '');
  const hasGridProps = !!styles.gridTemplateColumns
    || !!styles.gridTemplateRows
    || !!styles.gridAutoFlow
    || !!styles.gridAutoColumns
    || !!styles.gridAutoRows;
  const hasFlex = hasFlexDisplay || (!hasGridProps && hasFlexProps);
  const hasGrid = hasGridDisplay || hasGridProps;
  return { hasFlex, hasGrid, hasLayout: hasFlex || hasGrid };
}

export default function LayoutTool({ styles, nodeId, onUpdate, onUpdateMultiple, templateRoot }: Props) {
  // useControl gives us the variable-binding helpers (`getValueSource`,
  // `removeVariable`) the Direction + Wrap rows need to surface the
  // purple variable pill — these rows are rendered as custom segmented
  // controls (not via StyleField), so they don't get the binding-pill
  // path automatically. Reading from the same ControlProvider the rest
  // of the panel already sits inside keeps the source of truth single.
  const { getValueSource, removeVariable, updateStyleLive, updateStyle } = useControl();
  const interactingVpId = useAtomValue(interactingViewportIdAtom);
  // Multi-select targets for `handleToggleLayout` — the frame branch injects
  // per-node (container props + child reflow) instead of fanning out via
  // ControlProvider, so it needs the full selection itself.
  const selectedIds = useAtomValue(selectedIdsAtom);
  const isReplica = !isPrimaryViewport(interactingVpId);
  // On a COMPONENT/TEMPLATE master, updateNodeStyles diverts `display: ''` into
  // the visibility (unhide) routing instead of removing the layout — so the
  // grid/flex display never clears and the Layout panel keeps showing the layout
  // (the "Grid minus does nothing" bug). An explicit `display: 'block'` is a real
  // layout change that FALLS THROUGH to the normal style write (same trick the
  // replica path already uses).
  const activeFile = useAtomValue(activeFilePathAtom);
  // Children's EFFECTIVE sizing for the tile being edited (direction-flip re-base).
  const containerOverrides = useAtomValue(containerOverridesAtom);
  const isComponentFile = isComponentFilePath(activeFile);
  const { hasFlex, hasGrid, hasLayout } = detectLayoutFlags(styles);

  const handleToggleLayout = useCallback(() => {
    const contentEl = getContentRoot();
    if (!contentEl) return;
    const nodes = getNodesSnapshot();
    const node = nodes.get(nodeId);
    if (!node) return;
    const scale = transformManager.getTransform().scale;
    // Read rects from the ACTIVE interacting vp's iframe — NOT a
    // hardcoded 'desktop'. The desktop iframe's rect for a child can
    // diverge wildly from the active vp's: e.g. a text wrapped in
    // `useResponsiveText` renders the zero-width-space primary on
    // desktop (rect ≈ 0×19) but the real override on the source vp
    // (rect = real width). Reading desktop rects and writing them to
    // a non-desktop @container would land the child at desktop's
    // (centered-zero-width) position, then the real-text-width
    // rendering on the active vp would extend off to the side — the
    // visible "jump" the user reported. Using `interactingVpId`
    // matches what the user SEES at the moment they click remove-
    // layout.
    const vpId = interactingVpId;

    if (hasLayout) {
      // ── Remove layout: children become absolute, preserving visual positions ──
      // Step 1: Capture parent's computed size BEFORE removing layout.
      // Only inject explicit px when width/height is `auto` (or missing) — those
      // values would collapse to 0 once flex/grid stops stretching the children.
      // Explicit values (px, %, em, vw, …) are LEFT ALONE so we don't gratuitously
      // change `width: 100%` to a fixed pixel size. findNodeSize returns SCREEN
      // pixels (post-zoom), so divide by scale to get CSS pixels.
      const parentDims: Record<string, string> = {};
      const parentSize = findNodeSize(nodeId, vpId);
      const wRaw = (styles.width ?? '').trim();
      const hRaw = (styles.height ?? '').trim();
      // Includes min-content (Fit): a content-hugging parent collapses to 0 once
      // its children go absolute, so lock it to current px like auto/empty.
      const isAutoLike = (v: string) => v === '' || isFitSize(v);
      if (isAutoLike(wRaw)) {
        parentDims.width = `${Math.round(parentSize.width / scale)}px`;
      }
      if (isAutoLike(hRaw)) {
        parentDims.height = `${Math.round(parentSize.height / scale)}px`;
      }

      // Step 2: Capture all children's visual positions BEFORE changing parent display
      // Use bridge rects to compute child positions relative to parent
      const parentRect = findNodeRect(nodeId, vpId);
      const childData: { id: string; styles: Record<string, string> }[] = [];
      for (const childId of node.children) {
        const childNode = nodes.get(childId);
        if (!childNode) continue;
        const childRect = findNodeRect(childId, vpId);
        if (!childRect || !parentRect) continue;

        // Compute child position relative to parent (like convertChildToAbsolute)
        const left = (childRect.left - parentRect.left) / scale;
        const top = (childRect.top - parentRect.top) / scale;
        const childStyles: Record<string, string> = {
          position: 'absolute',
          left: `${Math.round(left)}px`,
          top: `${Math.round(top)}px`,
        };
        // Resolve dimensions: only convert auto/empty to explicit px, since
        // those would collapse once flex/grid stops stretching. Explicit values
        // (%, px, em, vw, …) are left alone — they resolve correctly even on
        // a now-absolute child, and "stay-same" is the user's expectation.
        const childNodeStyles = childNode.styles;
        const cwRaw = (childNodeStyles.width ?? '').trim();
        const chRaw = (childNodeStyles.height ?? '').trim();
        const isAutoLikeChild = (v: string) => v === '' || isFitSize(v);
        // flex shorthand / flex-grow can also stretch children even when width
        // looks "auto" — same fate, capture computed px.
        const stretchedByFlex =
          (childNodeStyles.flex && parseFloat(childNodeStyles.flex) > 0) ||
          (childNodeStyles.flexGrow && parseFloat(childNodeStyles.flexGrow) > 0);
        // Width/height resolution gated on a real measurement. A zero rect
        // (childRect.width === 0 or .height === 0) means the bridge polled
        // an element that hadn't rendered yet (e.g. text wrapped in
        // `useResponsiveText` on a replica that hasn't resolved, or an
        // element with empty content). Writing `0px` would FREEZE the
        // element at zero size — the user's text node would never grow
        // back to its natural width even after the hook resolves. Skip
        // the write and let the element natural-size instead. The user
        // can resize after if they want explicit dimensions.
        const wRectPx = Math.round(childRect.width / scale);
        const hRectPx = Math.round(childRect.height / scale);
        if ((isAutoLikeChild(cwRaw) || stretchedByFlex) && wRectPx > 0) {
          childStyles.width = `${wRectPx}px`;
        }
        if ((isAutoLikeChild(chRaw) || stretchedByFlex) && hRectPx > 0) {
          childStyles.height = `${hRectPx}px`;
        }
        // Clear flex shorthand
        if (childNodeStyles.flex) childStyles.flex = '';
        if (childNodeStyles.flexGrow) childStyles.flexGrow = '';
        if (childNodeStyles.flexShrink) childStyles.flexShrink = '';
        if (childNodeStyles.flexBasis) childStyles.flexBasis = '';
        if (childNodeStyles.alignSelf) childStyles.alignSelf = '';

        childData.push({ id: childId, styles: childStyles });
      }

      // Steps 3–5 order is LOAD-BEARING (mirror of injectFlexLayoutOnFrame's
      // parent-first rule): the child/parent writes below carry property
      // REMOVALS, and updateNodeStyles' style-override-removal path
      // synchronously flushes + force-renders the code AS QUEUED SO FAR.
      // Clearing the parent's flex before the children got their absolute
      // positions shipped an intermediate frame with relative children in a
      // non-flex parent — the children visibly stacked at the parent's 0,0
      // before jumping to their spots (user report 2026-08-05, same glitch
      // class as add-layout). So: lock dims (additive, no flush) → children
      // absolute (they pin to their captured spots; the still-flex parent is
      // invisible once they leave the flow) → clear parent layout LAST.

      // Step 3: Lock auto-like parent dims to px FIRST — purely additive.
      // Must precede the children going absolute, or an auto-sized parent
      // collapses to 0 in the intermediate frame once its flow empties.
      if (Object.keys(parentDims).length > 0) {
        updateNodeStyles({ id: nodeId, styles: { ...parentDims }, contentEl });
      }

      // Step 4: Apply captured positions to children + clear grid child props
      for (const { id, styles: childStyles } of childData) {
        updateNodeStyles({
          id,
          styles: {
            ...childStyles,
            gridColumn: '', gridRow: '', alignSelf: '', justifySelf: '', order: '',
            flexGrow: '', flexShrink: '', flexBasis: '', flex: '',
          },
          contentEl,
        });
      }

      // Step 5: Remove layout from parent — every child is absolute now, so
      // the removal-triggered flush/render ships the final state.
      // On a REPLICA viewport, writing `display: ''` removes the property
      // from the @container rule — but the BASE inline style still has
      // `display: 'flex'`, so the merged effective on this replica falls
      // back to flex and the Layout panel keeps showing "Layout (Flex)"
      // even though the user just clicked "remove". Override explicitly
      // with `display: 'block'` so the replica actually has no layout.
      // On primary, `''` is fine — removing the inline property defaults
      // the element back to its natural block display.
      const removedDisplay = (isReplica || isComponentFile) ? 'block' : '';
      updateNodeStyles({
        id: nodeId,
        styles: {
          display: removedDisplay, flexDirection: '', alignItems: '', justifyContent: '',
          flexWrap: '', alignContent: '', gap: '', rowGap: '', gridTemplateColumns: '', gridTemplateRows: '',
          gridAutoRows: '', gridAutoColumns: '', gridAutoFlow: '',
          justifyItems: '',
          columnCount: '', columnGap: '',
          columnRule: '', columnRuleStyle: '', columnRuleWidth: '', columnRuleColor: '',
          columnWidth: '',
        },
        contentEl,
      });

      trace.action('layout:remove', { nodeId, childCount: childData.length, parentDims });
    } else {
      // ── Frame container: inject flex column + reflow children to flow.
      // Shared with SizeTool's `auto` width/height path so both entry
      // points produce identical results.
      //
      // EVERY selected frame, not just the primary — `injectFlexLayoutOnFrame`
      // reflows a frame's children itself and so does NOT fan out through
      // `ControlProvider` (see `resolveLayoutInjectionTargets`).
      const targets = resolveLayoutInjectionTargets(nodeId, selectedIds, nodes);
      for (const id of targets) injectFlexLayoutOnFrame(id, nodes, vpId);
      trace.action('layout:add-flex', { nodeId, targets, multi: targets.length > 1 });
    }

    // Force the queue to flush synchronously so the panel re-renders with
    // the new layout state in this same frame. Without flushNow, the
    // mutation goes through requestIdleCallback (see processQueue's
    // doFlush) and on a busy main thread (e.g. while the iframe is
    // re-flowing text into 2 columns) idle can take seconds to fire — that
    // was the source of the multi-second "+/- on text Layout" lag the
    // user reported. Toggle is a single user click; instant feedback wins
    // over the scheduling smoothness idle was buying.
    flushNow();
  }, [hasLayout, nodeId, onUpdateMultiple, styles, selectedIds, interactingVpId]);

  // Type switch is Flex ↔ Grid only.
  const handleTypeChange = useCallback((type: string) => {
    const currentType = hasGrid ? 'grid' : 'flex';
    if (type === currentType) return;
    trace.action('layout:type-change', { nodeId, from: currentType, to: type });

    const clearFlex = { flexDirection: '', flexWrap: '', alignContent: '' };
    const clearGrid = {
      gridTemplateColumns: '', gridTemplateRows: '',
      gridAutoRows: '', gridAutoColumns: '', gridAutoFlow: '',
      justifyItems: '', rowGap: '', columnGap: '',
    };

    // Per-child cleanups so leftover props from the OLD layout type
    // don't pollute the source. Going to flex → drop every grid-child
    // prop (gridColumn / gridRow / gridArea / justifySelf). Going to
    // grid → drop every flex-child prop (flex / flexGrow / flexShrink
    // / flexBasis / order). `alignSelf` is shared between flex and
    // grid so we leave it alone.
    const clearGridChildProps: Record<string, string> = {
      gridColumn: '', gridRow: '', gridArea: '', justifySelf: '',
    };
    const clearFlexChildProps: Record<string, string> = {
      flex: '', flexGrow: '', flexShrink: '', flexBasis: '', order: '',
    };

    const nodes = getNodesSnapshot();
    const node = nodes.get(nodeId);
    const contentEl = getContentRoot();
    // `extra` may be a flat style object applied to every in-flow child, OR a
    // per-child function (grid needs per-child logic — e.g. only clear a stale
    // fill-height where one actually exists).
    const cleanChildren = (
      extra: Record<string, string> | ((child: { styles?: Record<string, string> }) => Record<string, string>),
      childPropsToClear: Record<string, string>,
    ) => {
      if (!node?.children?.length || !contentEl) return;
      let addedKeys: string[] = [];
      for (const childId of node.children) {
        const childNode = nodes.get(childId);
        if (!childNode) continue;
        const pos = childNode.styles?.position;
        if (pos === 'absolute' || pos === 'fixed') continue;
        const extraStyles = typeof extra === 'function' ? extra(childNode) : extra;
        addedKeys = Object.keys(extraStyles);
        // A FLOW child (relative/static) must not carry position OFFSETS — they
        // shift it off its flex line / grid cell (the "grid offset" bug). For a
        // NORMAL child, clear them. For a component INSTANCE, the offset may be
        // baked into the MASTER root (it merges onto every instance via
        // expandComponent), so clearing the instance's own left/top wouldn't
        // remove it — write explicit `0px` to OVERRIDE the master (identity for
        // a clean master, neutralizes a mispositioned one).
        const isInstanceChild = !!childNode.componentFile || !!childNode.isComponentInstance;
        const offsetReset = isInstanceChild
          ? { left: '0px', top: '0px', right: '', bottom: '' }
          : { left: '', top: '', right: '', bottom: '' };
        updateNodeStyles({
          id: childId,
          styles: { ...childPropsToClear, ...offsetReset, ...extraStyles },
          contentEl,
        });
      }
      trace.action('layout:type-change:children-cleaned', {
        nodeId, childCount: node.children.length,
        cleared: Object.keys(childPropsToClear), added: addedKeys,
      });
    };

    // When the element is currently HIDDEN (display:'none'), we must
    // NOT overwrite the display value — the user's Visible:No setting
    // is independent of the Layout type config (matches the reference's
    // separation). Write only the type-specific props; the source ends
    // up with the new layout's props sitting alongside display:'none'.
    // On a later unhide, `updateNodeStyles`'s auto-restore detects
    // grid/flex props and substitutes the matching display value.
    const isHidden = styles.display === 'none';

    if (type === 'flex') {
      const flexStyles = {
        flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        ...clearGrid,
      };
      onUpdateMultiple(isHidden ? flexStyles : { display: 'flex', ...flexStyles });
      // Strip leftover grid-child props from every in-flow child.
      cleanChildren({}, clearGridChildProps);
    } else if (type === 'grid') {
      // Default to a 2-COLUMN grid with FIT-CONTENT rows (no explicit
      // gridTemplateRows). Two columns reads unmistakably as "this is a grid"
      // the moment the user toggles, while fit-content rows let each row hug
      // its children's natural height — so a card / component instance keeps
      // the height it had in flex.
      //
      // The old default `repeat(2, 1fr)` ROWS caused the "everything collapses
      // when I switch to grid" bug: in an auto-height container a 1fr row sizes
      // to its child's MIN-content, and a child whose own height resolves
      // against that indefinite track (height:100%, or an inner flex:1 fill)
      // collapses to ~0. Fill rows are one click away in the panel (Height →
      // Fill Container) for anyone who wants them.
      // Both halves key off whether THIS container has a height to divide: with
      // a definite one the rows become 1fr and each child's leftover flex
      // height is cleared so `align-self: stretch` fills the cell; with an auto
      // height the rows stay fit-content and child heights are untouched (a 1fr
      // row in an auto-height container collapses — see grid-config.ts).
      const gridStyles = { ...flexToGridParentStyles(styles.height), ...clearFlex };
      onUpdateMultiple(isHidden ? gridStyles : { display: 'grid', ...gridStyles });
      cleanChildren((child) => gridChildFillStyles(child.styles, styles.height), clearFlexChildProps);
    }
  }, [hasGrid, nodeId, onUpdateMultiple, styles.display, styles.height]);

  // Grid track parsing / preset handlers retained for the preset apply
  // below (still wired into the old Presets popup which has been
  // removed from the main UI — kept as dead code in case we restore it).
  const handlePresetApply = useCallback((preset: GridPreset) => {
    const contentEl = getContentRoot();
    if (!contentEl) return;
    const node = getNodesSnapshot().get(nodeId);
    if (!node) return;

    trace.action('layout:grid-preset', { nodeId, preset: preset.id });

    // 1. Apply parent styles
    onUpdateMultiple(preset.parent);

    // 2. Apply child styles (clear previous spans, then set preset spans)
    // Use NodeMap children instead of DOM iteration
    const children = node.children;

    for (let i = 0; i < children.length; i++) {
      const presetChild = preset.children[i] || {};
      updateNodeStyles({
        id: children[i],
        styles: {
          gridColumn: '', gridRow: '',  // clear previous spans
          width: '100%', height: '100%', // fill grid cell
          position: 'relative',
          ...presetChild,
        },
        contentEl,
      });
    }
  }, [nodeId, onUpdateMultiple]);

  // Declared BEFORE handleDirectionChange — it's in that callback's dep array,
  // and a dep array is evaluated during render, so a later `const` would be in
  // its TDZ and throw.
  const flexDirection = styles.flexDirection === 'column' ? 'column' : 'row';

  // ─── Direction change handler ────────────────────────────────
  const handleDirectionChange = useCallback((value: string) => {
    trace.action('layout:direction-change', { nodeId, value, from: flexDirection });
    onUpdate('flexDirection', value);
    // Flipping the axis rotates which dimension the children's `flex` governs —
    // re-base them in the SAME scope so their Fill keeps its dimension and any
    // explicit size on the new main axis actually applies (a row-authored
    // `flex: 1 0 0px` otherwise outranks `height` under a column flip).
    if (nodeId) {
      rebaseChildrenForDirectionFlip({
        nodeId,
        fromDirection: flexDirection,
        toDirection: value,
        vpId: interactingVpId,
        nodes: getNodesSnapshot(),
        overrides: containerOverrides,
        vpWidths: getViewportWidths(),
        activeFilePath: activeFile,
      });
    }
  }, [nodeId, onUpdate, flexDirection, interactingVpId, containerOverrides, activeFile]);

  // ─── Wrap change handler ─────────────────────────────────────
  const handleWrapChange = useCallback((value: string) => {
    trace.action('layout:wrap-change', { nodeId, value });
    onUpdate('flexWrap', value);
  }, [nodeId, onUpdate]);


  // +/- action button for the section title row
  const toggleAction = (
    <button
      onClick={handleToggleLayout}
      className="flex items-center justify-end pl-[80px] -ml-[80px] cursor-pointer group text-[var(--text-primary)]"
      title={hasLayout ? 'Remove Layout' : 'Add Layout'}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-opacity group-hover:opacity-80">
        {hasLayout ? (
          <line x1="5" y1="12" x2="19" y2="12" />
        ) : (
          <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>
        )}
      </svg>
    </button>
  );

  // ── Template root: a Template is ALWAYS a flex column; its layout can't be
  // changed or removed (design-tool parity). Show only Align (cross-axis) + Gap +
  // Padding — no Type/Direction/Wrap/Justify and no +/- remove action. ──
  if (templateRoot) {
    return (
      <>
        <ToolSection title="Layout" collapsible>
          <div className="flex flex-col gap-2">
            {/* Align — a flex COLUMN's cross axis is horizontal: left / center
                / right. Writes `alignItems`. */}
            <div className="flex items-center justify-between w-full">
              <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">Align</span>
              <ToolSegmentedControl
                value={styles.alignItems || 'flex-start'}
                onChange={(v) => { onUpdate('alignItems', v); flushNow(); }}
                options={[
                  { value: 'flex-start', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="4" width="2" height="16" rx="1" /><rect x="7" y="6" width="11" height="4" rx="1" /><rect x="7" y="14" width="7" height="4" rx="1" /></svg> },
                  { value: 'center', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="11" y="3" width="2" height="18" rx="1" /><rect x="6.5" y="6" width="11" height="4" rx="1" /><rect x="8.5" y="14" width="7" height="4" rx="1" /></svg> },
                  { value: 'flex-end', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="19" y="4" width="2" height="16" rx="1" /><rect x="6" y="6" width="11" height="4" rx="1" /><rect x="10" y="14" width="7" height="4" rx="1" /></svg> },
                ]}
                size="sm"
              />
            </div>
            {/* Gap */}
            <StyleField property="gap" label="Gap" />
            {/* Padding (T/R/B/L with the global ↔ individual toggle) */}
            <PaddingControl />
          </div>
        </ToolSection>
        <ToolDivider />
      </>
    );
  }

  return (
    <>
      <ToolSection title="Layout" collapsible hasContent={hasLayout} action={toggleAction}>
        {!hasLayout && (
          <span className="text-[11px] text-[var(--text-disabled)]">Click + to add layout</span>
        )}
        {hasLayout && (
          <div className="flex flex-col gap-2">
            {/* Type selector — Flex vs Grid. */}
            {(
              <div className="flex items-center justify-between w-full">
                {/* Mimic ControlLabel's `pl-[18px] -ml-[18px]` gutter so
                    the value column gets the same 18 px of width as
                    Direction / Wrap rows below — without it, Type's
                    plain span anchored the label flush at the parent's
                    left edge and the segmented control rendered ~6 px
                    narrower than its siblings. No chevron / menu here
                    because Type is a per-tool concept (Flex vs Grid),
                    not a CSS property the variable / preset system can
                    bind. */}
                <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">Type</span>
                <ToolSegmentedControl
                  value={hasGrid ? 'grid' : 'flex'}
                  onChange={handleTypeChange}
                  options={[
                    { value: 'flex', label: 'Flex' },
                    { value: 'grid', label: 'Grid' },
                  ]}
                  size="sm"
                />
              </div>
            )}

            {hasGrid ? (
              <>
                <GridLayoutControls styles={styles} onUpdateMultiple={onUpdateMultiple} />
                {/* Padding — same as the flex branch: a grid container has an
                    inner content box, so Padding lives in Layout (design-tool parity). */}
                <PaddingControl />
              </>
            ) : (
              <>
                {/* Flex: Direction — 2 arrow icon options.
                    Detect variable binding manually (the row doesn't go
                    through StyleField, so the binding-pill path needs
                    its own gate). When `flexDirection` is bound to a
                    variable, render the same purple `T <varName> ×`
                    pill StyleField uses so the user sees the binding. */}
                {(() => {
                  const dirSource = getValueSource('flexDirection');
                  const dirBound = dirSource.source === 'prop' && dirSource.ref;
                  return (
                    <div className="flex items-center justify-between w-full">
                      <ControlLabel label="Direction" property="flexDirection" />
                      {dirBound ? (
                        // Shared pill: body click → open the Variable modal, × → unbind. Direction is an
                        // enum (row/column) → the Option glyph.
                        <LegacyVariableBoundPill
                          property="flexDirection"
                          propertyLabel="Direction"
                          variableRef={dirSource.ref!}
                          currentValue={styles.flexDirection || 'row'}
                          removeVariable={removeVariable}
                          iconKey="option"
                        />
                      ) : (
                        <LocalePillOrLegacy property="flexDirection" label="Direction" nodeId={nodeId ?? null} baseValue={styles.flexDirection || 'row'} onChangeBase={(v) => updateStyle('flexDirection', v)}>
                        <ToolSegmentedControl
                          value={flexDirection}
                          onChange={handleDirectionChange}
                          options={[
                            { value: 'row', icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg> },
                            { value: 'column', icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" /></svg> },
                          ]}
                          size="sm"
                        />
                        </LocalePillOrLegacy>
                      )}
                    </div>
                  );
                })()}

                {/* Flex: Align — direction-aware labels */}
                <StyleField property="alignItems" label="Align" defaultValue="stretch"
                  options={getAlignOptions(styles.flexDirection)} />

                {/* Flex: Justify — direction-aware labels */}
                <StyleField property="justifyContent" label="Justify" defaultValue="flex-start"
                  options={getJustifyOptions(styles.flexDirection)} />

                {/* Flex: Wrap — human labels No/Yes.
                    Variable-binding gate matches Direction above. The
                    chevron menu's "Create Variable" entry is enabled
                    (was previously suppressed with `hideCreateVariable`
                    — there's no good reason flexWrap can't be bound to
                    a boolean variable now that we surface the pill). */}
                {(() => {
                  const wrapSource = getValueSource('flexWrap');
                  const wrapBound = wrapSource.source === 'prop' && wrapSource.ref;
                  return (
                    <div className="flex items-center justify-between w-full">
                      <ControlLabel label="Wrap" property="flexWrap" />
                      {wrapBound ? (
                        // Shared pill: body click → open the Variable modal, × → unbind. (Previously a
                        // bespoke button whose WHOLE body removed the binding — so you could never open
                        // the modal.) flexWrap variables are always Toggles → the boolean glyph.
                        <LegacyVariableBoundPill
                          property="flexWrap"
                          propertyLabel="Wrap"
                          variableRef={wrapSource.ref!}
                          currentValue={styles.flexWrap || 'nowrap'}
                          removeVariable={removeVariable}
                          iconKey="boolean"
                        />
                      ) : (
                        <LocalePillOrLegacy property="flexWrap" label="Wrap" nodeId={nodeId ?? null} baseValue={styles.flexWrap || 'nowrap'} onChangeBase={(v) => updateStyle('flexWrap', v)}>
                        <ToolSegmentedControl
                          value={styles.flexWrap === 'wrap' ? 'wrap' : 'nowrap'}
                          onChange={handleWrapChange}
                          options={[
                            { value: 'nowrap', label: 'No' },
                            { value: 'wrap', label: 'Yes' },
                          ]}
                          size="sm"
                        />
                        </LocalePillOrLegacy>
                      )}
                    </div>
                  );
                })()}

                {/* Flex: Align Content — only when wrap is enabled */}
                {styles.flexWrap === 'wrap' && (
                  <StyleField property="alignContent" label="Align Content" defaultValue="stretch"
                    options={FLEX_CONTENT_OPTIONS} />
                )}

                {/* Flex: Gap */}
                <StyleField property="gap" label="Gap" />
                {/* Padding — belongs to the layout (design-tool parity): only an
                    element WITH a flex/grid layout has an inner content box to
                    inset, so Padding lives here right after Gap, not in the
                    Styles tool. */}
                <PaddingControl />
              </>
            )}
          </div>
        )}
      </ToolSection>
      <ToolDivider />
    </>
  );
}
