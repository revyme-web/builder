/** Dependency-free seam between active-file writers that cannot import the
 *  mutation queue (viewport-store — the queue transitively imports it) and the
 *  queue's deferred-drag-flush stash.
 *
 *  WHY IT MUST BE SYNCHRONOUS: a mid-gesture ProjectFS write must be adopted
 *  into the stash BEFORE the gesture-end fan-out captures its code. The
 *  previous dynamic-import adopt (`import('mutation-queue').then(...)`) ran as
 *  a MICROTASK — after the whole mouseup handler, by which point gesture-end
 *  cleanup had cleared the drag flag, the refresh no-opped on its guard, and
 *  the drag-end fan-out re-flushed the PRE-write stash right over the write
 *  (trace 2026-08-06: viewport resize committed bands 42798 then @canvas
 *  config 42797; fan-out re-wrote 42798 → the mobile width silently reverted
 *  636→375 on the next file switch while the band rules kept 636 — the
 *  "resize lost after entering the template and back" report).
 *
 *  mutation-queue registers its refresh at module load; writers call
 *  notifyExternalActiveFileWrite inline in the same task as their write. */

let refreshFn: ((code: string) => void) | null = null;

export function registerExternalWriteRefresh(fn: (code: string) => void): void {
  refreshFn = fn;
}

/** Forward an active-file write to the mutation queue's external-write
 *  refresh, synchronously. No-op until the queue module has loaded (it loads
 *  with the canvas, long before any gesture can produce a write). */
export function notifyExternalActiveFileWrite(code: string): void {
  refreshFn?.(code);
}

/** Test probe — lets a test assert mutation-queue actually registered. */
export function isExternalWriteRefreshRegistered(): boolean {
  return refreshFn !== null;
}
