// viewport-size-ops.ts — Helpers for committing viewport-size changes that
// mirror onto the page's root <div> inline style.
//
// Both the resize-handle drag (SelectionOverlay) and the SizeTool's Height
// input write a viewport's height to the @canvas block AND mirror that
// height onto the root JSX style for primary viewports. The mirror has a
// subtle race with the mutation queue: setViewportsConfig writes ProjectFS
// directly via the activeCodeAtom setter, but the mutation queue keeps its
// own cached `currentCode` (mutation-queue.ts:376) that's only refreshed via
// explicit `syncQueueCode(code)` calls. Without this sync, the upcoming
// updateNodeStyles flush applies its JSX transform to the stale cached code
// and the writeback wipes the @canvas height update.

import { syncQueueCode } from '@/code/mutation/mutation-queue';
import { projectFS } from '@/code/project/project-fs';
import { updateNodeStyles } from './node-ops';
import { trace } from '@/shared/debug-trace';

/**
 * Mirror a primary viewport's height onto the root `<div>`'s inline style.
 *
 * Call this AFTER `setViewportsConfig` has committed the new height to the
 * @canvas block. It pulls the freshly-written code into the queue's cache,
 * then queues a style mutation on `root`. Pass `0`/empty to clear the
 * inline height (auto mode).
 *
 * Skip the call entirely for non-primary viewports — the inline style is
 * shared across all viewports, and replicas keep their height in the
 * @canvas block alone.
 */
export function mirrorPrimaryViewportHeightToRoot(args: {
  activeFilePath: string;
  contentEl: HTMLElement;
  /** New height in CSS px. `0` (or any value <= 0) clears the inline
   *  height — same contract as updateNodeStyles' empty-string-removes-property. */
  height: number;
}): void {
  const { activeFilePath, contentEl, height } = args;
  const freshCode = projectFS.readFile(activeFilePath);
  if (freshCode) syncQueueCode(freshCode);
  updateNodeStyles({
    id: 'root',
    styles: { height: height > 0 ? `${height}px` : '' },
    contentEl,
  });
  trace.action('viewport-size-ops:mirror-primary-height', {
    activeFilePath, height,
  });
}
