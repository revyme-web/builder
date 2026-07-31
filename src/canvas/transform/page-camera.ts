// page-camera.ts — Per-page camera (pan x/y + zoom) memory.
//
// standard UX: each PAGE remembers the exact pan/zoom you left it at, so
// switching away and back puts you right where you were. Masters (component /
// icon-set) are EXCLUDED here — their camera is owned by the
// component-navigation enter/exit flow + breadcrumb.
//
// CRITICAL ordering: the camera must be applied BEFORE the switch triggers the
// new page's render, so the content renders at the correct camera from its
// first frame. Doing it AFTER (reactively, on render-complete) shows the page
// at the OLD camera for a frame, then snaps — the "flash big then scales down"
// glitch. We hook into `switchActiveFile` (via `setSwitchCameraHandler`) which
// calls us right before `setActiveFile`, exactly like the breadcrumb's "back
// to page" applies `setTransform(stashed)` before its own switch.
//
// Storage is the in-memory `cameraStash` (Map<filePath,{x,y,scale}>), NOT page
// source or a ProjectFS file: history `computeDiffs` snapshots ALL files, so
// persisting camera would flood undo/autosave/publish with every pan. Session-
// scoped is exactly the "return to where I was" UX without that pollution.

import { transformManager } from './TransformManager';
import { cameraStash } from './camera-stash';
import { fitAllOnNextRender } from './CameraCommands';
import { isRegularPageFile } from '@/code/project/active-file-store';
import { trace } from '@/shared/debug-trace';

/** Remember the current camera for the page being left. */
export function savePageCamera(filePath: string): void {
  if (!filePath) return;
  cameraStash.save(filePath, transformManager.getTransform());
  trace.fn('page-camera.save', { filePath });
}

/**
 * Switch-camera hook (registered into `switchActiveFile`). Runs BEFORE the
 * new page renders:
 *   - Save the leaving page's camera (regular pages only).
 *   - Restore the entering page's saved camera SYNCHRONOUSLY — so its content
 *     renders at the right pan/zoom immediately (no flash). Old content (still
 *     shown for a beat) and new content are both at the SAME restored camera,
 *     so the swap is seamless.
 *   - First visit (no stash) → fit on the next render (hidden until it lands,
 *     via `fitAllOnNextRender`).
 * Master enter/exit (to/from a non-page) is left to component-navigation.
 */
export function applyPageCameraForSwitch(from: string, to: string): void {
  // Save the leaving page's camera ONLY on page→page switches. Do NOT save
  // when entering a master: `enterComponentFile` already stashed the page
  // camera (correctly, before its pre-zoom), and by the time switchActiveFile
  // calls us the camera has been moved to the master's view — re-saving here
  // would overwrite the page's stash with the master camera, so the
  // breadcrumb "back to page" would restore the wrong (fit) view.
  if (isRegularPageFile(from) && isRegularPageFile(to)) savePageCamera(from);
  if (!isRegularPageFile(to)) return; // entering a master — component-nav owns the camera
  const saved = cameraStash.get(to);
  if (saved) {
    transformManager.setTransform({ ...saved }); // apply NOW, before the render
    trace.fn('page-camera.restore', { to, saved });
  } else {
    fitAllOnNextRender(); // first visit / brand-new page — fit once it renders
    trace.fn('page-camera.fit', { to });
  }
}
