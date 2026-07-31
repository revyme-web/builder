// ruler-guides-store.ts — Atoms + ops for ruler guides.
//
// Source of truth = the active file's `/** @rulerGuides [...] */`
// annotation block (parsed in `ruler-guides-config.ts`). The atoms
// below are read-only derivations of that source — we never store
// guides in atom state separately, so the same guides round-trip
// across reloads + per-file scoping (each page / component / icon-set
// master gets its own list) comes for free.
//
// Writes go through the operations object: each op calls
// `modifyProjectFile` to update the annotation in place. Drag updates
// use a `skipHistory` flag so the source isn't rewritten 60 times per
// second during a guide drag — only the final position commits.

import { atom, getDefaultStore } from 'jotai';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { projectVersionAtom, projectFS } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import { parseRulerGuides, updateRulerGuidesInCode, type RulerGuide } from '@/code/project/ruler-guides-config';
import type { RulerGuideSnapLine } from '@/canvas/drag/handlers/snap-handler';
import { trace } from '@/shared/debug-trace';

export type { RulerGuide };

/** Sync read of the active file's ruler guides, projected into the
 *  shape `calculateSnap` consumes (axis = 'x' for vertical / 'y' for
 *  horizontal). Drag/resize handlers call this every frame from the
 *  RAF loop, where reading via `useAtomValue` would force a hook
 *  context. The atom subscription path (`activeRulerGuidesAtom`) stays
 *  the source of truth — this helper just snapshots its current value. */
export function getActiveRulerGuideSnapLines(): RulerGuideSnapLine[] {
  const guides = getDefaultStore().get(activeRulerGuidesAtom);
  if (guides.length === 0) return [];
  return guides.map((g) => ({
    id: g.id,
    axis: g.type === 'vertical' ? 'x' : 'y',
    position: g.position,
  }));
}

// ─── Read atoms ────────────────────────────────────────────────────────────

/** Live ruler-guides for whichever file is currently active. Re-derives
 *  on activeFilePath or projectVersion change — same dependency shape
 *  as `activeCodeAtom` so guide writes (which bump projectVersion via
 *  `modifyProjectFile`) propagate without manual sync. */
export const activeRulerGuidesAtom = atom<RulerGuide[]>((get) => {
  get(projectVersionAtom);
  const filePath = get(activeFilePathAtom);
  const code = projectFS.readFile(filePath);
  if (!code) return [];
  return parseRulerGuides(code);
});

/** Currently selected guide id (visual highlight + delete target).
 *  Session-only — intentionally not persisted; selection always starts
 *  empty when reloading. */
export const selectedGuideIdAtom = atom<string | null>(null);

/** Live drag preview during create-from-ruler. Holds the cursor's
 *  current screen-space position so `CanvasRulers` can render a 1-px
 *  preview line that follows the cursor before the drop commits. */
export const draggingGuidePreviewAtom = atom<
  | { type: 'horizontal' | 'vertical'; screenPosition: number }
  | null
>(null);

/** Set of ruler-guide IDs that are currently being snapped against
 *  (i.e., the dragged/resized element's edge is locked onto them).
 *  `RulerGuides.tsx` hides matching guide lines while their id is in
 *  this set so the pink snap line is visible without the cyan ruler
 *  guide overlapping it. Cleared by `Canvas.tsx`'s wrapper around
 *  `setSnapGuides` whenever the snap-guide list changes. */
export const snappedRulerGuideIdsAtom = atom<Set<string>>(new Set<string>());

// ─── Write ops ─────────────────────────────────────────────────────────────

/** Shape of the in-progress drag of an EXISTING guide. Stored in a
 *  module-level ref (not atom) so the mousemove handler can read/write
 *  without React renders 60 times per second. */
let activeDrag: { guideId: string; type: 'horizontal' | 'vertical' } | null = null;

const generateGuideId = () =>
  `guide-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const rulerGuideOps = {
  /** Add a guide at `position` to the active file. Returns the new id. */
  addGuide(filePath: string, type: 'horizontal' | 'vertical', position: number): string {
    const id = generateGuideId();
    modifyProjectFile(filePath, (code) => {
      const existing = parseRulerGuides(code);
      const next = [...existing, { id, type, position }];
      return updateRulerGuidesInCode(code, next);
    });
    trace.action('ruler-guide:add', { filePath, id, type, position });
    return id;
  },

  /** Remove a guide by id from the active file. */
  removeGuide(filePath: string, guideId: string): void {
    modifyProjectFile(filePath, (code) => {
      const existing = parseRulerGuides(code);
      const next = existing.filter((g) => g.id !== guideId);
      return updateRulerGuidesInCode(code, next);
    });
    trace.action('ruler-guide:remove', { filePath, guideId });
  },

  /** Update a guide's position. `skipHistory: true` means we're mid-
   *  drag and don't want every frame to land in the undo stack — the
   *  drop handler should call `commitGuidePosition` to add the final
   *  position as a single history entry. */
  updateGuidePosition(filePath: string, guideId: string, position: number, _skipHistory = false): void {
    modifyProjectFile(filePath, (code) => {
      const existing = parseRulerGuides(code);
      const next = existing.map((g) => g.id === guideId ? { ...g, position } : g);
      return updateRulerGuidesInCode(code, next);
    });
    // History batching is handled by the mutation queue's debounce so
    // we don't need to gate writes on `skipHistory` ourselves; the flag
    // is kept for API parity with the builder repo's signature.
  },

  /** Set the selected guide id. Pass `null` to deselect. */
  selectGuide(_filePath: string, guideId: string | null, store: { set: (a: any, v: any) => void }): void {
    store.set(selectedGuideIdAtom, guideId);
  },

  /** Track the in-flight drag of an existing guide (for the
   *  mousemove/up listeners in `RulerGuides`). */
  beginDragExisting(guideId: string, type: 'horizontal' | 'vertical'): void {
    activeDrag = { guideId, type };
  },
  getActiveDrag(): typeof activeDrag {
    return activeDrag;
  },
  endDragExisting(): void {
    activeDrag = null;
  },
};
