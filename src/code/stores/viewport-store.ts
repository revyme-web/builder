// viewport-store.ts — Viewport/responsive system.
// Uses CSS container queries (@container) for responsive styles.
// Canvas renders the content inside a container at the active viewport width.
// Viewports are freely positioned on the canvas (x, y stored here).

import { atom } from 'jotai';
import type { ViewportConfig } from '@/shared/types';
import { activeFilePathAtom, activeCodeAtom, isComponentFilePath, isIconSetFilePath } from '../project/active-file-store';
import { parseCanvasConfig, updateCanvasConfigInCode } from '../project/canvas-config';
import { parseVariantConfig } from '../variants/variant-config';
import { VIEWPORT_GAP, DEFAULT_VIEWPORT_WIDTH } from '@/shared/constants';
import { trace } from '@/shared/debug-trace';

// Compute default positions: side-by-side with gap
function computeDefaultPositions(configs: Omit<ViewportConfig, 'x' | 'y'>[]): ViewportConfig[] {
  let currentX = 0;
  return configs.map(c => {
    const vp = { ...c, x: currentX, y: 0 };
    currentX += c.width + VIEWPORT_GAP;
    return vp;
  });
}

/** Default viewport configs — used as initial value. */
export const DEFAULT_VIEWPORTS: ViewportConfig[] = computeDefaultPositions([
  { id: 'desktop', label: 'Desktop', width: DEFAULT_VIEWPORT_WIDTH, isPrimary: true, order: 0 },
  { id: 'tablet', label: 'Tablet', width: 768, isPrimary: false, order: 1 },
  { id: 'mobile', label: 'Mobile', width: 375, isPrimary: false, order: 2 },
]);


// ─── Dynamic viewport config (from @canvas block) ──────────────────────────

const DEFAULT_POSITIONS: Record<string, { x: number; y: number }> = Object.fromEntries(
  DEFAULT_VIEWPORTS.map(v => [v.id, { x: v.x, y: v.y }])
);

/** Viewport configs — read from @canvas block in the active file's code. */
export const viewportsConfigAtom = atom(
  (get) => {
    const code = get(activeCodeAtom);
    const config = parseCanvasConfig(code);
    if (config?.viewports?.length) {
      // Recompute x/y positions from the stored config (computeDefaultPositions adds x/y)
      trace.fn('viewport-store:readConfigs', { count: config.viewports.length, source: '@canvas' });
      return computeDefaultPositions(config.viewports);
    }
    trace.fn('viewport-store:readConfigs', { count: DEFAULT_VIEWPORTS.length, source: 'defaults' });
    return DEFAULT_VIEWPORTS;
  },
  (get, set, update: ViewportConfig[] | ((prev: ViewportConfig[]) => ViewportConfig[])) => {
    const code = get(activeCodeAtom);
    const config = parseCanvasConfig(code) || {
      viewports: [...DEFAULT_VIEWPORTS],
      positions: { ...DEFAULT_POSITIONS },
    };
    const current = config.viewports.length ? computeDefaultPositions(config.viewports) : [...DEFAULT_VIEWPORTS];
    const next = typeof update === 'function' ? update(current) : update;
    config.viewports = next;
    trace.action('viewport-store:writeConfigs', { count: next.length });
    set(activeCodeAtom, updateCanvasConfigInCode(code, config));
  },
);

/** Viewport positions — read from @canvas block. */
export const viewportPositionsAtom = atom(
  (get) => {
    const code = get(activeCodeAtom);
    const config = parseCanvasConfig(code);
    if (config?.positions && Object.keys(config.positions).length > 0) {
      trace.fn('viewport-store:readPositions', { keys: Object.keys(config.positions), source: '@canvas' });
      return config.positions;
    }
    trace.fn('viewport-store:readPositions', { keys: Object.keys(DEFAULT_POSITIONS), source: 'defaults' });
    return DEFAULT_POSITIONS;
  },
  (get, set, update: Record<string, { x: number; y: number }> | ((prev: Record<string, { x: number; y: number }>) => Record<string, { x: number; y: number }>)) => {
    const code = get(activeCodeAtom);
    const config = parseCanvasConfig(code) || {
      viewports: [...DEFAULT_VIEWPORTS],
      positions: { ...DEFAULT_POSITIONS },
    };
    const current = config.positions && Object.keys(config.positions).length > 0
      ? config.positions
      : { ...DEFAULT_POSITIONS };
    const next = typeof update === 'function' ? update(current) : update;
    config.positions = next;
    trace.action('viewport-store:writePositions', { keys: Object.keys(next) });
    set(activeCodeAtom, updateCanvasConfigInCode(code, config));
  },
);

// Which viewport the user is currently interacting with (clicked in)
// This determines whether style updates go to inline styles or @container rules
export const interactingViewportIdAtom = atom<string>('desktop');

// Viewport widths — writable so viewport root resize can update breakpoints.
// Starts from DEFAULT_VIEWPORTS. When changed, the generator reads these for @container breakpoint ranges.
export const viewportWidthsAtom = atom<Record<string, number>>(
  Object.fromEntries(DEFAULT_VIEWPORTS.map(v => [v.id, v.width]))
);

/** Get the current viewport widths (reads from atom store imperatively). */
let _viewportWidths: Record<string, number> = Object.fromEntries(DEFAULT_VIEWPORTS.map(v => [v.id, v.width]));
export function getViewportWidths(): Record<string, number> { return _viewportWidths; }
export function syncViewportWidths(widths: Record<string, number>): void { _viewportWidths = widths; }

/** Get all non-primary viewport widths sorted descending (for @container breakpoint computation). */
export function getSortedBreakpointWidths(): number[] {
  return Object.values(_viewportWidths).sort((a, b) => b - a);
}

// Derived: is the user interacting with a non-primary (replica) viewport?
//
// Note: this atom answers "is this a non-primary PAGE viewport" (e.g. tablet
// or mobile). Component-file variants are tracked separately — variants are
// not page replicas, and writing per-variant overrides goes through a
// different code path (motion variant style overrides + ternary expressions
// for instance prop overrides). See `isComponentVariantViewportAtom` below.
export const isReplicaViewportAtom = atom((get) => {
  const vpId = get(interactingViewportIdAtom);
  const filePath = get(activeFilePathAtom);
  // In component files, the viewport list represents variants, not page
  // replicas. Don't treat non-default variants as replicas — that would
  // cascade into the page-replica `data-responsive` write path which is
  // keyed by viewport WIDTH (variants have no width).
  if (isComponentFilePath(filePath)) return false;
  const configs = get(viewportsConfigAtom);
  const vp = configs.find(v => v.id === vpId);
  return vp ? !vp.isPrimary : false;
});

// Derived: is the user on a non-default variant viewport in a component file?
// True only when the active file is a component AND the interacting viewport
// id maps to a non-primary variant (e.g. 'variant-1'). Used by tools that
// need to route style/prop writes to per-variant overrides.
export const isComponentVariantViewportAtom = atom((get) => {
  const filePath = get(activeFilePathAtom);
  if (!isComponentFilePath(filePath)) return false;
  const vpId = get(interactingViewportIdAtom);
  // The visibleViewportsAtom maps variant 'default' → id 'desktop' and other
  // variants → their literal name. So 'desktop' (== default variant) is the
  // primary; any other id is a non-default variant viewport.
  return vpId !== 'desktop';
});

// Derived: when on a component file, the active variant name (e.g. 'default'
// or 'variant-1'). Returns null on page files. The variant name is what the
// generator writes into framer-motion variant objects + ternary branches.
export const activeComponentVariantAtom = atom<string | null>((get) => {
  const filePath = get(activeFilePathAtom);
  if (!isComponentFilePath(filePath)) return null;
  const vpId = get(interactingViewportIdAtom);
  return vpId === 'desktop' ? 'default' : vpId;
});

// Derived: get the interacting viewport's max-width (for @container rules)
export const interactingViewportWidthAtom = atom((get) => {
  const vpId = get(interactingViewportIdAtom);
  const widths = get(viewportWidthsAtom);
  return widths[vpId] ?? DEFAULT_VIEWPORT_WIDTH;
});

// All viewports to show on canvas — switches between page viewports and component variants
export const visibleViewportsAtom = atom<ViewportConfig[]>((get) => {
  const filePath = get(activeFilePathAtom);
  if (isComponentFilePath(filePath)) {
    const code = get(activeCodeAtom);
    const variants = parseVariantConfig(code);
    return variants.map((v, i) => ({
      id: v.name === 'default' ? 'desktop' : v.name,
      label: v.label || v.name,
      width: 0,
      isPrimary: v.isPrimary ?? i === 0,
      order: i,
      x: v.x,
      y: v.y,
    }));
  }
  // Icon-set master files render as a single canvas — each
  // vector lives inside the master root as an absolute-positioned
  // element. No replica viewports because there's no concept of breakpoints
  // for a vector set.
  if (isIconSetFilePath(filePath)) {
    return [{
      id: 'desktop',
      label: 'Master',
      width: 0,
      isPrimary: true,
      order: 0,
      x: 0,
      y: 0,
    }];
  }
  // Merge writable widths into dynamic configs
  const configs = get(viewportsConfigAtom);
  const widths = get(viewportWidthsAtom);
  return configs.map(v => ({ ...v, width: widths[v.id] ?? v.width }));
});
