// grid-config.ts — standard grid configuration model.
//
// The old `grid-helpers.ts` exposed `TrackList` + per-track parsing
// which let the user configure each fr/px column individually.
// Designers don't think that way — they think "I want 3 columns" and
// "each cell is at least 53px wide". This module collapses the grid
// state into a single structured config that drives both the simplified
// main panel UI and an Advanced popup, then serializes back to CSS.
//
// CSS output combinations:
//   Cols Fixed N + Width Min:    repeat(N, minmax(Wpx, 1fr))
//   Cols Fixed N + Width Fixed:  repeat(N, Wpx)
//   Cols Auto    + Width Min:    repeat(auto-fill, minmax(Wpx, 1fr))
//   Cols Auto    + Width Fixed:  repeat(auto-fill, Wpx)
//   Height Fixed:                grid-template-rows: repeat(M, Hpx); grid-auto-rows: Hpx
//   Height Fill Container:       repeat(M, minmax(0, 1fr)); grid-auto-rows: minmax(0, 1fr)
//   Height Fit Content:          (no template-rows / auto-rows); height: min-content
//   Masonry:                     repeat(N, 1fr); height: min-content (renderer wraps children)

type GridColumnsMode = 'auto' | 'fixed';
type GridWidthMode = 'min' | 'fixed';
type GridHeightMode = 'fixed' | 'fill' | 'fit';
export type GridAlign = 'start' | 'center' | 'end';

export interface GridConfig {
  /** Masonry layout (true → variable-height items pack vertically per column,
   *  no row tracks). When on, `rowsCount`/`heightMode` are ignored. */
  masonry: boolean;
  /** Number of explicit columns (used when `columnsMode === 'fixed'`).
   *  In `auto` mode the count is implicit (browser fills as many as fit). */
  columnsCount: number;
  /** Number of explicit rows. Ignored when `heightMode === 'fit'` or masonry. */
  rowsCount: number;
  /** Column gap in px (CSS `column-gap`). */
  gapX: number;
  /** Row gap in px (CSS `row-gap`). */
  gapY: number;
  // ── Advanced popup state ─────────────────────────────────────────────
  /** `auto` → `repeat(auto-fill, …)` track def; `fixed` → `repeat(N, …)`. */
  columnsMode: GridColumnsMode;
  /** Cell minimum width in px (the `Wpx` in `minmax(Wpx, 1fr)`). */
  width: number;
  /** `min` → `minmax(Wpx, 1fr)` (cell can grow with available space);
   *  `fixed` → `Wpx` (cell is exactly W). */
  widthMode: GridWidthMode;
  /** Cell height in px (used when `heightMode === 'fixed'`). */
  height: number;
  /** `fixed` → `Hpx`; `fill` → `minmax(0, 1fr)`; `fit` → no track sizing. */
  heightMode: GridHeightMode;
  /** Maps to CSS `justify-content` on the grid parent. */
  align: GridAlign;
}

const DEFAULT_WIDTH = 53;
const DEFAULT_HEIGHT = 200;
const DEFAULT_GAP = 0;

export function defaultGridConfig(): GridConfig {
  return {
    masonry: false,
    columnsCount: 2,
    rowsCount: 2,
    gapX: DEFAULT_GAP,
    gapY: DEFAULT_GAP,
    columnsMode: 'fixed',
    width: DEFAULT_WIDTH,
    widthMode: 'min',
    height: DEFAULT_HEIGHT,
    heightMode: 'fill',
    align: 'center',
  };
}

/** Parse a `repeat(...)` `grid-template-columns` value back into the
 *  structured columns config. Recognizes the four patterns we generate;
 *  unknown patterns fall back to default fixed N=count. */
function parseColumnsTemplate(value: string, fallbackCount: number): {
  mode: GridColumnsMode; count: number; width: number; widthMode: GridWidthMode;
} {
  const def = { mode: 'fixed' as const, count: fallbackCount, width: DEFAULT_WIDTH, widthMode: 'min' as const };
  if (!value) return def;

  // `repeat(auto-fill, minmax(53px, 1fr))`
  let m = value.match(/^repeat\(\s*auto-fill\s*,\s*minmax\(\s*(\d+(?:\.\d+)?)px\s*,\s*1fr\s*\)\s*\)$/);
  if (m) return { mode: 'auto', count: fallbackCount, width: parseFloat(m[1]) || DEFAULT_WIDTH, widthMode: 'min' };

  // `repeat(auto-fill, 53px)`
  m = value.match(/^repeat\(\s*auto-fill\s*,\s*(\d+(?:\.\d+)?)px\s*\)$/);
  if (m) return { mode: 'auto', count: fallbackCount, width: parseFloat(m[1]) || DEFAULT_WIDTH, widthMode: 'fixed' };

  // `repeat(N, minmax(0, 1fr))` / `repeat(N, minmax(0px, 1fr))` — fixed count,
  // NO px floor (the overflow-safe form emitted for a fixed-count 'min' width).
  // width carries the panel default since the floor is intentionally absent.
  m = value.match(/^repeat\(\s*(\d+)\s*,\s*minmax\(\s*0(?:px)?\s*,\s*1fr\s*\)\s*\)$/);
  if (m) return { mode: 'fixed', count: parseInt(m[1], 10), width: DEFAULT_WIDTH, widthMode: 'min' };

  // `repeat(N, minmax(53px, 1fr))`
  m = value.match(/^repeat\(\s*(\d+)\s*,\s*minmax\(\s*(\d+(?:\.\d+)?)px\s*,\s*1fr\s*\)\s*\)$/);
  if (m) return { mode: 'fixed', count: parseInt(m[1], 10), width: parseFloat(m[2]) || DEFAULT_WIDTH, widthMode: 'min' };

  // `repeat(N, 53px)`
  m = value.match(/^repeat\(\s*(\d+)\s*,\s*(\d+(?:\.\d+)?)px\s*\)$/);
  if (m) return { mode: 'fixed', count: parseInt(m[1], 10), width: parseFloat(m[2]) || DEFAULT_WIDTH, widthMode: 'fixed' };

  // `repeat(N, 1fr)` — simple uniform (treat as fixed N + min width default)
  m = value.match(/^repeat\(\s*(\d+)\s*,\s*1fr\s*\)$/);
  if (m) return { mode: 'fixed', count: parseInt(m[1], 10), width: DEFAULT_WIDTH, widthMode: 'min' };

  // Fallback: count the comma-separated tracks as the column count.
  const trackCount = value.split(/\s+/).filter(Boolean).length;
  return { ...def, count: trackCount > 0 ? trackCount : fallbackCount };
}

/** Parse a `grid-template-rows` value back to height mode + count. */
function parseRowsTemplate(value: string, fallbackCount: number): {
  mode: GridHeightMode; count: number; height: number;
} {
  const def = { mode: 'fit' as const, count: fallbackCount, height: DEFAULT_HEIGHT };
  if (!value) return def;

  // `repeat(N, Hpx)` → fixed
  let m = value.match(/^repeat\(\s*(\d+)\s*,\s*(\d+(?:\.\d+)?)px\s*\)$/);
  if (m) return { mode: 'fixed', count: parseInt(m[1], 10), height: parseFloat(m[2]) || DEFAULT_HEIGHT };

  // `repeat(N, minmax(0px, 1fr))` → fill
  m = value.match(/^repeat\(\s*(\d+)\s*,\s*minmax\(\s*0(?:px)?\s*,\s*1fr\s*\)\s*\)$/);
  if (m) return { mode: 'fill', count: parseInt(m[1], 10), height: DEFAULT_HEIGHT };

  // `repeat(N, 1fr)` → treat as fill
  m = value.match(/^repeat\(\s*(\d+)\s*,\s*1fr\s*\)$/);
  if (m) return { mode: 'fill', count: parseInt(m[1], 10), height: DEFAULT_HEIGHT };

  return def;
}

/** Read structured config from a grid parent's inline style record. */
export function parseGridConfig(styles: Record<string, string>): GridConfig {
  const base = defaultGridConfig();

  // Gap → split into X (column-gap) and Y (row-gap).
  // `gap: 34px 49px` parses to two values; `gap: 16px` parses to one
  // (both axes equal). React inlines this as `gap`, not split.
  const gapRaw = styles.gap || styles.columnGap || '';
  const colGapRaw = styles.columnGap || '';
  const rowGapRaw = styles.rowGap || '';
  let gapX = base.gapX;
  let gapY = base.gapY;
  if (rowGapRaw && colGapRaw) {
    gapY = parseFloat(rowGapRaw) || 0;
    gapX = parseFloat(colGapRaw) || 0;
  } else if (gapRaw) {
    const parts = gapRaw.trim().split(/\s+/);
    if (parts.length >= 2) {
      gapY = parseFloat(parts[0]) || 0;
      gapX = parseFloat(parts[1]) || 0;
    } else {
      gapX = gapY = parseFloat(parts[0]) || 0;
    }
  }

  // Masonry detection: marked via `grid-template-rows: masonry` (a real
  // CSS Grid Level 3 keyword — Firefox honors it natively; other
  // browsers ignore it, which is fine: we use this string as a marker
  // that the renderer can later read to wrap children in N column
  // flex stacks for cross-browser masonry. Can't use a CSS custom
  // property (`--grid-masonry`) because dash-prefixed keys aren't
  // valid bare identifiers in JSX object literals — the generator
  // would emit them unquoted and break parse.
  const masonry = styles.gridTemplateRows === 'masonry';

  const cols = parseColumnsTemplate(styles.gridTemplateColumns || '', base.columnsCount);
  const rows = parseRowsTemplate(styles.gridTemplateRows || '', base.rowsCount);
  // `grid-auto-rows: Hpx` reinforces height mode for newly-flowed rows.
  // Use it as a tiebreaker when grid-template-rows is missing.
  let heightMode: GridHeightMode = rows.mode;
  let height = rows.height;
  if (!styles.gridTemplateRows) {
    const ar = styles.gridAutoRows || '';
    if (ar.match(/minmax\(\s*0(?:px)?\s*,\s*1fr\s*\)/)) heightMode = 'fill';
    else {
      const arPx = ar.match(/^(\d+(?:\.\d+)?)px$/);
      if (arPx) { heightMode = 'fixed'; height = parseFloat(arPx[1]) || DEFAULT_HEIGHT; }
    }
  }

  const align = (styles.justifyContent === 'start' || styles.justifyContent === 'end')
    ? styles.justifyContent
    : 'center';

  return {
    masonry,
    columnsCount: cols.count,
    rowsCount: rows.count,
    gapX,
    gapY,
    columnsMode: cols.mode,
    width: cols.width,
    widthMode: cols.widthMode,
    height,
    heightMode,
    align,
  };
}

/** Implicit row count of an auto-flowing grid (fit-content rows): the number
 *  of rows the browser actually creates for `childCount` items across
 *  `columnsCount` columns. What the Rows field should DISPLAY in fit mode —
 *  the config's `rowsCount` there is just a parse default the browser never
 *  reads (the panel showed "2" over a visibly 3-row grid, 2026-08-11). */
export function implicitRowCount(childCount: number, columnsCount: number): number {
  return Math.max(1, Math.ceil(Math.max(0, childCount) / Math.max(1, columnsCount)));
}

/**
 * Apply a ROWS-COUNT change so it actually takes effect — the rows twin of the
 * columns handler's auto→fixed flip (2026-08-11).
 *
 * In `fit` height mode the serializer emits NO row template (rows are
 * implicit), so a rows change was silently ignored: the stepper updated state
 * that `formatGridConfig` never wrote ("Rows +/- does nothing" — verified in
 * the trace: every press emitted `gridTemplateRows: ""`). Touching the count
 * means the user wants EXPLICIT row tracks, so fit promotes to:
 *   - `fill` when the container's own height is definite (px/%/vh/vw) — rows
 *     share that height, visible immediately;
 *   - `fixed` otherwise — `fill` against an indefinite height collapses every
 *     row to ~0 (the exact trap the flex→grid defaults below document), so an
 *     auto-height container gets px rows at the config's current row height.
 * Non-fit modes just take the new count.
 */
export function withRowsCount(
  c: GridConfig,
  count: number,
  /** The container's own `height` style value (SizeTool-owned). */
  containerHeight: string | undefined,
): GridConfig {
  const rowsCount = Math.max(1, Math.min(20, count));
  if (c.heightMode !== 'fit') return { ...c, rowsCount };
  const definite = !!containerHeight && /^\d+(\.\d+)?(px|%|vh|vw)$/.test(containerHeight.trim());
  return { ...c, rowsCount, heightMode: definite ? 'fill' : 'fixed' };
}

/** Build the inline-style record from a structured config. Empty string
 *  values mean "remove this property" per the empty-string-removes rule. */
export function formatGridConfig(c: GridConfig): Record<string, string> {
  const out: Record<string, string> = { display: 'grid' };

  // ── Gap ────────────────────────────────────────────────────────────
  // CSS shorthand: `gap: rowGap columnGap`. We always emit the longhand
  // when X and Y differ (clearer), shorthand when equal (smaller).
  if (c.gapX === c.gapY) {
    out.gap = c.gapX === 0 ? '' : `${c.gapX}px`;
    out.rowGap = '';
    out.columnGap = '';
  } else {
    out.gap = '';
    out.rowGap = `${c.gapY}px`;
    out.columnGap = `${c.gapX}px`;
  }

  // ── Masonry shortcut ───────────────────────────────────────────────
  // `grid-template-rows: masonry` is the marker. Firefox uses it natively
  // for true masonry; other browsers ignore it and fall back to regular
  // single-row grid (children stretch vertically). A future renderer
  // hook can read this value and wrap children in N flex columns for
  // cross-browser masonry visuals.
  //
  // We deliberately do NOT touch `height` here — parent height is the
  // SizeTool's concern. Earlier versions wrote `height: 'min-content'`
  // which silently overwrote the user's explicit height every time
  // they touched gap / columns / anything in the grid panel.
  if (c.masonry) {
    out.gridTemplateColumns = `repeat(${Math.max(1, c.columnsCount)}, 1fr)`;
    out.gridTemplateRows = 'masonry';
    out.gridAutoRows = '';
    out.justifyContent = '';
    return out;
  }

  // ── Columns ────────────────────────────────────────────────────────
  // Track sizing. A px "min width" floor — minmax(Wpx, 1fr) — only makes sense
  // in AUTO columns mode, where it's the auto-fill WRAP threshold (each column
  // ≥ Wpx; the browser drops to fewer columns rather than shrink below). For a
  // FIXED column count a px floor OVERFLOWS the container whenever its width <
  // count × Wpx — the items spill out and a centering parent shoves the whole
  // grid off-screen (the live "advisors grid offset" bug). So a fixed count in
  // 'min' mode fills with minmax(0, 1fr): equal columns, no floor, never
  // overflows. 'fixed' width mode keeps exact px columns (a deliberately
  // fixed-size grid the user opted into).
  let trackSize: string;
  if (c.widthMode === 'fixed') {
    trackSize = `${c.width}px`;
  } else if (c.columnsMode === 'auto') {
    trackSize = `minmax(${c.width}px, 1fr)`;
  } else {
    trackSize = 'minmax(0, 1fr)';
  }
  out.gridTemplateColumns = c.columnsMode === 'auto'
    ? `repeat(auto-fill, ${trackSize})`
    : `repeat(${Math.max(1, c.columnsCount)}, ${trackSize})`;

  // ── Rows + auto-rows ──────────────────────────────────────────────
  // Same rule as masonry: don't mutate parent `height` here. The user
  // controls that via SizeTool. We only set the per-track sizing
  // (gridTemplateRows / gridAutoRows) — those tell the browser HOW to
  // distribute the parent's existing height across rows.
  if (c.heightMode === 'fit') {
    out.gridTemplateRows = '';
    out.gridAutoRows = '';
  } else if (c.heightMode === 'fixed') {
    out.gridTemplateRows = `repeat(${Math.max(1, c.rowsCount)}, ${c.height}px)`;
    out.gridAutoRows = `${c.height}px`;
  } else {
    // fill
    out.gridTemplateRows = `repeat(${Math.max(1, c.rowsCount)}, minmax(0px, 1fr))`;
    out.gridAutoRows = 'minmax(0px, 1fr)';
  }

  // ── Align (justify-content) ───────────────────────────────────────
  out.justifyContent = c.align === 'center' ? '' : c.align;

  return out;
}

// ─── Flex → Grid conversion defaults ────────────────────────────────────────
// The crux of the "everything collapses when I switch to grid" bug lives here,
// extracted as pure helpers so the behaviour is unit-pinned (the call site is a
// React useCallback in LayoutTool).

/**
 * Parent track defaults when a container is switched from flex to grid:
 * 2 COLUMNS (reads unmistakably as a grid the moment you toggle) and
 * FIT-CONTENT rows (empty `gridTemplateRows`) so each row hugs its children's
 * natural height. The old `repeat(2, 1fr)` ROWS default collapsed children: in
 * an auto-height container a 1fr row sizes to its child's MIN-content, and a
 * child whose height resolves against that indefinite track (height:100%, or an
 * inner flex:1 fill) shrinks to ~0. Fill rows stay one click away in the panel
 * (Height → Fill Container).
 */
export function flexToGridParentStyles(): Record<string, string> {
  // minmax(0, 1fr) — NOT plain `1fr` (= minmax(auto, 1fr), whose `auto` min is
  // the item's content min-size and can blow the grid past its container) and
  // NOT a px floor (overflows a fixed count) — so the grid can never overflow.
  return { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gridTemplateRows: '' };
}

/**
 * Per-child style patch applied to each in-flow child on flex → grid. Fill the
 * column horizontally (`width: 100%` — overrides a component master's fixed
 * artboard width so the card spans its track), but NEVER force `height: 100%`:
 * a grid item with a percentage height collapses against a content-sized / 1fr
 * row in an auto-height container, and it overrides a card's definite master
 * height (killing any inner flex:1 fill). The grid item's default
 * `align-self: stretch` already fills the row when the row is definite. A STALE
 * injected fill-height (`height: '100%'`, from a pre-fix grid or a re-toggle) is
 * cleared so it can't keep collapsing.
 */
export function gridChildFillStyles(childStyles?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { width: '100%' };
  if (childStyles?.height === '100%') out.height = '';
  return out;
}
