// viewport-store.ts — Viewport/responsive system.
// Uses CSS container queries (@container) for responsive styles.
// Canvas renders the content inside a container at the active viewport width.
// Viewports are freely positioned on the canvas (x, y stored here).

import { atom } from 'jotai';
import type { ViewportConfig } from '@/shared/types';
import { activeFilePathAtom, activeCodeAtom, isComponentFilePath, isIconSetFilePath } from '../project/active-file-store';
import { projectVersionAtom, projectFS } from '../project/project-fs';
import { parseCanvasConfig, updateCanvasConfigInCode } from '../project/canvas-config';
import { parseVariantConfig } from '../variants/variant-config';
import { VIEWPORT_GAP, DEFAULT_VIEWPORT_WIDTH } from '@/shared/constants';
import { trace } from '@/shared/debug-trace';
import { notifyExternalActiveFileWrite } from '../mutation/external-write-registry';

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
      trace.fn('viewport-store:readConfigs', { count: config.viewports.length, source: '@canvas', widths: config.viewports.map(v => v.width) });
      return computeDefaultPositions(config.viewports);
    }
    trace.fn('viewport-store:readConfigs', { count: DEFAULT_VIEWPORTS.length, source: 'defaults', widths: DEFAULT_VIEWPORTS.map(v => v.width) });
    return DEFAULT_VIEWPORTS;
  },
  (get, set, update: ViewportConfig[] | ((prev: ViewportConfig[]) => ViewportConfig[])) => {
    // Compose on FRESH ProjectFS content, not the activeCodeAtom cache. During
    // a gesture, `modifyProjectFile` transactions DEFER the version bump
    // (Round-2 perf rule), so activeCodeAtom's cached value predates them —
    // the resize commit's config write was composing on pre-band-rewrite code
    // and silently REVERTING the just-renamed @media bands (trace 2026-08-06:
    // band write 43207 → config write 43200 = pre-rewrite size + 1; the
    // resized viewport "lost all its responsive overrides"). This staleness
    // existed all along — the old microtask-adopt bug just made the BAND
    // write win the race instead, which is how stray bands accumulated.
    const code = projectFS.readFile(get(activeFilePathAtom)) ?? get(activeCodeAtom);
    const config = parseCanvasConfig(code) || {
      viewports: [...DEFAULT_VIEWPORTS],
      positions: { ...DEFAULT_POSITIONS },
    };
    const current = config.viewports.length ? computeDefaultPositions(config.viewports) : [...DEFAULT_VIEWPORTS];
    const next = typeof update === 'function' ? update(current) : update;
    config.viewports = next;
    trace.action('viewport-store:writeConfigs', { count: next.length });
    const newCode = updateCanvasConfigInCode(code, config);
    set(activeCodeAtom, newCode);
    adoptCanvasConfigWriteIntoGestureStash(newCode);
  },
);

/** GESTURE WRITE COHERENCE for @canvas config writes. These setters write
 *  straight through activeCodeAtom → ProjectFS; during a gesture (viewport
 *  RESIZE commit runs inside one) the deferred-drag-flush stash still holds
 *  the PRE-write code, and its gesture-end apply clobbered this write ~50ms
 *  later — the resized tile flashed the other breakpoint's styles on mouseup
 *  and the @canvas width silently REVERTED to its old value (trace: write
 *  45400 → stale re-write 45388, "oldWidth: 375" again on the next resize,
 *  2026-08-06). Adopt the write into the stash — SYNCHRONOUSLY, in the same
 *  task as the write. The first version used a dynamic import (mutation-queue
 *  transitively imports this store) whose .then microtask ran AFTER the whole
 *  mouseup handler — gesture-end cleanup had already cleared the drag flag,
 *  the adopt no-opped, and the drag-end fan-out re-flushed the pre-config
 *  stash over the width write: mobile reverted 636→375 on the next file
 *  switch while the band RULES kept 636 (the "resize lost after entering the
 *  template and back" report, 2026-08-06). The registry is dependency-free,
 *  so this import can be static. */
function adoptCanvasConfigWriteIntoGestureStash(newCode: string): void {
  notifyExternalActiveFileWrite(newCode);
}

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
    // FRESH ProjectFS read — same gesture-staleness fix as the configs setter.
    const code = projectFS.readFile(get(activeFilePathAtom)) ?? get(activeCodeAtom);
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
    const newCode = updateCanvasConfigInCode(code, config);
    set(activeCodeAtom, newCode);
    // Same gesture coherence as the configs setter above (tile reposition
    // commits also run inside a gesture window).
    adoptCanvasConfigWriteIntoGestureStash(newCode);
  },
);

// Which viewport the user is currently interacting with (clicked in)
// This determines whether style updates go to inline styles or @container rules.
//
// RAW — read through `interactingViewportIdAtom` below, which clamps it to a
// viewport that still exists.
const interactingViewportIdRawAtom = atom<string>('desktop');

// Viewport widths — writable so viewport root resize can update breakpoints.
// When changed, the generator reads these for @container breakpoint ranges.
//
// FILE-SCOPED (root-cause fix 2026-08-06): this was a GLOBAL primitive atom
// keyed by vpId ('mobile'…) — the SAME ids every file uses — and
// visibleViewportsAtom overlays it onto the ACTIVE file's config. Resizing the
// page's mobile to 898 then entering the Body template showed the TEMPLATE's
// mobile tile at 898 (the page's width leaked in), and returning showed the
// PAGE at the template's stale defaults (375) even though the page FILE held
// 898 the whole time — "my resize reverts when I visit the template". A React
// effect in Canvas.tsx reconciled widths←configs after the fact, racing every
// file switch (and the template-enter path bypasses switchActiveFile
// entirely). Scoping the override to the file it was WRITTEN FOR makes the
// leak structurally impossible — there is no switch-time re-seed to forget:
// reading from a different file falls straight through to that file's
// @canvas config (or defaults).
// The override is ALSO keyed to the project version at write time: every
// width write is immediately followed by a durable @canvas config write in
// the same handler (resize commit step 4, SizeTool commit), which bumps the
// version — from then on the CONFIG is the truth and the override is spent.
// This kills the undo case too: undo restores the file (bump) and a dangling
// pre-undo override must not paint the undone width back over it.
const viewportWidthsOverrideAtom = atom<{ file: string; version: number; widths: Record<string, number> } | null>(null);

export const viewportWidthsAtom = atom(
  (get) => {
    const file = get(activeFilePathAtom);
    const override = get(viewportWidthsOverrideAtom);
    if (override && override.file === file && override.version === get(projectVersionAtom)) {
      return override.widths;
    }
    const configs = get(viewportsConfigAtom);
    return Object.fromEntries(configs.map(v => [v.id, v.width]));
  },
  (get, set, update: Record<string, number> | ((prev: Record<string, number>) => Record<string, number>)) => {
    const prev = get(viewportWidthsAtom);
    const widths = typeof update === 'function' ? update(prev) : update;
    set(viewportWidthsOverrideAtom, {
      file: get(activeFilePathAtom),
      version: get(projectVersionAtom),
      widths,
    });
  },
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

/**
 * The interacting viewport, CLAMPED to one that is actually on canvas.
 *
 * The raw value is a plain id set on click, and nothing revoked it when the
 * viewport it names went away. Undo a "duplicate variant" and the file is back
 * to one variant while this still said `variant-1`: the selection overlay went
 * on asking for that tile's rect, got a stale CACHED entry for a tile that no
 * longer renders, and painted a selection box over empty canvas (reported
 * 2026-08-24 — the box stayed while the Layers panel correctly showed the
 * surviving variant).
 *
 * Worse than the ghost box: `activeComponentVariantAtom` and
 * `isComponentVariantViewportAtom` derive the WRITE TARGET from this id, so the
 * next style edit would have been routed into a variant object that no longer
 * exists.
 *
 * Clamping on READ rather than reconciling on change is deliberate — there is
 * no ordering to get wrong and nothing to forget to call. Every path that can
 * remove a viewport (undo, redo, delete-variant, file switch, a template's
 * viewport set) is covered by construction. Same reasoning as the file-scoped
 * width override above.
 */
export const interactingViewportIdAtom = atom(
  (get): string => {
    const raw = get(interactingViewportIdRawAtom);
    const visible = get(visibleViewportsAtom);
    // No viewports parsed yet (boot, mid-rebuild) — keep the raw value rather
    // than inventing a fallback that a later render would have to undo.
    if (visible.length === 0) return raw;
    if (visible.some((v) => v.id === raw)) return raw;
    const fallback = (visible.find((v) => v.isPrimary) ?? visible[0]).id;
    trace.fn('viewport-store:interacting-vp-gone', { raw, fallback });
    return fallback;
  },
  (_get, set, next: string) => { set(interactingViewportIdRawAtom, next); },
);
