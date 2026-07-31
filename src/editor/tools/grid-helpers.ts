// grid-helpers.ts — Pure helper functions for CSS grid template parsing/formatting.

// ─── Individual Track ───────────────────────────────────────────────────────

export type TrackUnit = 'fr' | 'px' | 'auto' | 'min-content' | 'max-content';

export interface Track {
  value: number;
  unit: TrackUnit;
}

/** Parse a single track value like '2fr', '200px', 'auto', 'min-content' */
export function parseTrack(raw: string): Track {
  const trimmed = raw.trim();
  if (trimmed === 'auto' || !trimmed) return { value: 0, unit: 'auto' };
  if (trimmed === 'min-content') return { value: 0, unit: 'min-content' };
  if (trimmed === 'max-content') return { value: 0, unit: 'max-content' };

  const frMatch = trimmed.match(/^(\d+(?:\.\d+)?)fr$/);
  if (frMatch) return { value: parseFloat(frMatch[1]), unit: 'fr' };

  const pxMatch = trimmed.match(/^(\d+(?:\.\d+)?)px$/);
  if (pxMatch) return { value: parseFloat(pxMatch[1]), unit: 'px' };

  // Fallback: treat as fr with value 1
  return { value: 1, unit: 'fr' };
}

/** Format a single track back to CSS */
export function formatTrack(track: Track): string {
  if (track.unit === 'auto') return 'auto';
  if (track.unit === 'min-content') return 'min-content';
  if (track.unit === 'max-content') return 'max-content';
  return `${track.value || 1}${track.unit}`;
}

// ─── Track List (columns/rows) ──────────────────────────────────────────────

export interface TrackList {
  tracks: Track[];
  /** Whether this is repeat(auto-fill, ...) */
  autoFill: boolean;
  /** For auto-fill: the track template (e.g. minmax(200px, 1fr)) */
  autoFillTemplate: string;
  /** Original raw CSS for values we can't fully parse (minmax, etc.) */
  raw: string;
  /** True if all tracks are the same and we use repeat() */
  isUniform: boolean;
}

/** Parse gridTemplateColumns/Rows into a list of individual tracks */
export function parseTrackList(value: string): TrackList {
  if (!value) return { tracks: [{ value: 1, unit: 'fr' }], autoFill: false, autoFillTemplate: '', raw: '', isUniform: true };

  // repeat(auto-fill, ...)
  const autoFillMatch = value.match(/^repeat\(\s*auto-fill\s*,\s*(.+)\s*\)$/);
  if (autoFillMatch) {
    return { tracks: [], autoFill: true, autoFillTemplate: autoFillMatch[1].trim(), raw: value, isUniform: false };
  }

  // repeat(N, trackSize)
  const repeatMatch = value.match(/^repeat\(\s*(\d+)\s*,\s*(.+)\s*\)$/);
  if (repeatMatch) {
    const count = parseInt(repeatMatch[1], 10);
    const inner = repeatMatch[2].trim();
    const track = parseTrack(inner);
    const tracks = Array.from({ length: count }, () => ({ ...track }));
    return { tracks, autoFill: false, autoFillTemplate: '', raw: value, isUniform: true };
  }

  // Space-separated tracks: "2fr 1fr 1fr", "200px auto 1fr"
  const parts = splitGridTracks(value);
  const tracks = parts.map(parseTrack);
  const isUniform = tracks.length > 0 && tracks.every(t => t.value === tracks[0].value && t.unit === tracks[0].unit);
  return { tracks, autoFill: false, autoFillTemplate: '', raw: value, isUniform };
}

/** Format a TrackList back to CSS */
export function formatTrackList(list: TrackList): string {
  if (list.autoFill) {
    return `repeat(auto-fill, ${list.autoFillTemplate || 'minmax(200px, 1fr)'})`;
  }
  if (list.tracks.length === 0) return '';

  // If all tracks are the same, use repeat() for cleaner output
  if (list.isUniform && list.tracks.length > 0) {
    const t = list.tracks[0];
    return `repeat(${list.tracks.length}, ${formatTrack(t)})`;
  }

  // Mixed tracks: space-separated
  return list.tracks.map(formatTrack).join(' ');
}

// ─── Auto Track (gridAutoRows/gridAutoColumns) ──────────────────────────────

type AutoTrackMode = 'auto' | 'fixed' | 'minmax';

export interface AutoTrackConfig {
  mode: AutoTrackMode;
  fixedValue: string;
  minmaxMin: string;
  minmaxMax: string;
}

export function parseAutoTrack(value: string): AutoTrackConfig {
  if (!value || value === 'auto') return { mode: 'auto', fixedValue: '', minmaxMin: '', minmaxMax: '' };

  const pxMatch = value.match(/^(\d+(?:\.\d+)?)px$/);
  if (pxMatch) return { mode: 'fixed', fixedValue: pxMatch[1], minmaxMin: '', minmaxMax: '' };

  const mmMatch = value.match(/^minmax\(\s*(.+?)\s*,\s*(.+?)\s*\)$/);
  if (mmMatch) return { mode: 'minmax', fixedValue: '', minmaxMin: mmMatch[1], minmaxMax: mmMatch[2] };

  // Treat unknown as fixed with raw value
  return { mode: 'fixed', fixedValue: value.replace('px', ''), minmaxMin: '', minmaxMax: '' };
}

export function formatAutoTrack(config: AutoTrackConfig): string {
  switch (config.mode) {
    case 'auto': return '';
    case 'fixed': return `${config.fixedValue || '200'}px`;
    case 'minmax': return `minmax(${config.minmaxMin || '200px'}, ${config.minmaxMax || 'auto'})`;
    default: return '';
  }
}

// ─── Low-level helpers ──────────────────────────────────────────────────────

/** Split a grid template value into individual tracks, respecting parenthesized groups */
export function splitGridTracks(value: string): string[] {
  if (!value) return [];
  const tracks: string[] = [];
  let current = '';
  let parenDepth = 0;
  for (const ch of value) {
    if (ch === '(') parenDepth++;
    if (ch === ')') parenDepth--;
    if (ch === ' ' && parenDepth === 0 && current.trim()) {
      tracks.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) tracks.push(current.trim());
  return tracks;
}

// ─── Grid Placement (gridColumn / gridRow) ──────────────────────────────────

type PlacementMode = 'auto' | 'span' | 'explicit';

export interface GridPlacement {
  mode: PlacementMode;
  span: number;       // for 'span' mode: how many tracks to span
  start: number;      // for 'explicit' mode: start line (1-based)
  end: number;        // for 'explicit' mode: end line (1-based)
}

/** Parse gridColumn/gridRow value into structured placement */
export function parsePlacement(value: string): GridPlacement {
  if (!value) return { mode: 'auto', span: 1, start: 1, end: 2 };

  // "span 2"
  const spanMatch = value.match(/^span\s+(\d+)$/);
  if (spanMatch) return { mode: 'span', span: parseInt(spanMatch[1], 10), start: 1, end: 2 };

  // "2 / 4" or "1 / -1" or "1 / 3"
  const explicitMatch = value.match(/^(-?\d+)\s*\/\s*(-?\d+)$/);
  if (explicitMatch) {
    const start = parseInt(explicitMatch[1], 10);
    const end = parseInt(explicitMatch[2], 10);
    return { mode: 'explicit', span: Math.abs(end - start), start, end };
  }

  // "2 / span 2"
  const startSpanMatch = value.match(/^(\d+)\s*\/\s*span\s+(\d+)$/);
  if (startSpanMatch) {
    const start = parseInt(startSpanMatch[1], 10);
    const span = parseInt(startSpanMatch[2], 10);
    return { mode: 'explicit', span, start, end: start + span };
  }

  // Single number "2" — treat as start position
  const singleMatch = value.match(/^(\d+)$/);
  if (singleMatch) {
    const start = parseInt(singleMatch[1], 10);
    return { mode: 'explicit', span: 1, start, end: start + 1 };
  }

  return { mode: 'auto', span: 1, start: 1, end: 2 };
}

/** Format a GridPlacement back to CSS */
export function formatPlacement(p: GridPlacement): string {
  switch (p.mode) {
    case 'auto': return '';
    case 'span': return p.span <= 1 ? '' : `span ${p.span}`;
    case 'explicit': return `${p.start} / ${p.end}`;
    default: return '';
  }
}

// ─── Legacy span helpers (backward compat) ──────────────────────────────────

/** Parse `span N` from gridColumn/gridRow value */
export function parseSpan(value: string): number {
  const p = parsePlacement(value);
  return p.span;
}

/** Format span count to CSS value; span 1 = '' (remove property) */
export function formatSpan(count: number): string {
  const n = Math.max(1, count);
  return n === 1 ? '' : `span ${n}`;
}

// ─── Gap helpers ────────────────────────────────────────────────────────────

/** Parse gap value — handles single "20px" and dual "20px 16px" (row col) */
export function parseGap(value: string): { row: string; col: string; isSplit: boolean } {
  if (!value) return { row: '', col: '', isSplit: false };
  const parts = value.trim().split(/\s+/);
  if (parts.length >= 2) return { row: parts[0], col: parts[1], isSplit: true };
  return { row: parts[0], col: parts[0], isSplit: false };
}

/** Format gap — returns single value if equal, dual if different */
export function formatGap(row: string, col: string): string {
  if (!row && !col) return '';
  if (row === col) return row;
  return `${row} ${col}`;
}

/** Track unit options for dropdowns */
export const TRACK_UNIT_OPTIONS = [
  { value: 'fr', label: 'fr' },
  { value: 'px', label: 'px' },
  { value: 'auto', label: 'auto' },
  { value: 'min-content', label: 'min' },
  { value: 'max-content', label: 'max' },
];
