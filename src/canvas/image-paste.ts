// image-paste.ts — Detect image data on the system clipboard and turn
// it into a canvas image node.
//
// Triggered from the Ctrl+V keyboard handler and the global `paste`
// event listener in `shortcuts.ts` when the clipboard carries an
// `image/*` file (screenshot, copied image from the browser, Figma
// frame, etc.). The image is uploaded through the same
// `backend.uploadAsset` flow the Media tab uses — so it lands in
// the user's media library + counts toward storage quota — and
// then dropped onto the canvas via the regular paste engine.
//
// Routing the image through `engineExecutePaste` with an
// `overrideClipboard` means the image inherits ALL the normal
// paste rules:
//   - Selected frame → image lands inside as a child
//   - Selected node in a frame → image becomes a sibling
//   - Canvas node selected → image lands next to it on canvas
//   - Nothing selected → image lands at the visible canvas centre
// Same target resolution, positioning, and replica routing as a
// regular copy+paste of an image node.

import { toast } from 'sonner';
import { getDefaultStore } from 'jotai';
import { backend } from '@/backend';
import { getProjectId } from '@/backend/project-id';
import { flushNow } from '@/code/mutation/mutation-queue';
import { executePaste as engineExecutePaste } from '@/code/features/paste-engine';
import type { ClipboardData } from '@/code/features/paste-engine';
import { transformManager } from './transform';
import { getInteractingViewport, getActiveFilePath } from './node-ops';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { generateNodeId } from '@/shared/id-utils';
import { selectedIdsAtom, nodesAtom } from '@/code/stores/store';
import { getBlobImageDimensions, fitFrameBox } from './image-dims';
import { trace } from '@/shared/debug-trace';

/** Read the system clipboard for an image file. Returns null if no
 *  image is present, the clipboard API is unavailable, or the read
 *  fails (e.g. user denied permission). Uses the modern
 *  `navigator.clipboard.read()` API which is the only way to get
 *  binary blob data out of the OS clipboard from a non-paste
 *  event context (i.e. the Ctrl+V keyboard handler, which fires
 *  before the native `paste` event). */
async function readClipboardImage(): Promise<Blob | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.read) {
    return null;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        if (type.startsWith('image/')) {
          const blob = await item.getType(type);
          return blob;
        }
      }
    }
  } catch (err) {
    // Permission denied, no image in clipboard, or unsupported
    // mime — all fine, just signal "no image" to the caller.
    trace.action('image-paste:clipboard-read-failed', { error: String(err) });
  }
  return null;
}

/** True when a DataTransfer (from a `paste` ClipboardEvent) carries
 *  an image file. Used by the synchronous paste-event path; the
 *  Ctrl+V keyboard path uses `readClipboardImage()` instead because
 *  it doesn't have access to a DataTransfer. */
export function hasClipboardImageInDataTransfer(clipboardData: DataTransfer | null): boolean {
  if (!clipboardData) return false;
  for (const item of clipboardData.items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return true;
  }
  return false;
}

/** Pull the first image File from a paste-event DataTransfer. */
function extractImageFile(clipboardData: DataTransfer | null): File | null {
  if (!clipboardData) return null;
  for (const item of clipboardData.items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

/** Upload the file + insert via the paste engine. Shared by both
 *  the Ctrl+V (Blob) and paste-event (File) entry points. */
async function uploadAndInsert(file: File | Blob, fallbackName = 'image.png'): Promise<string | null> {
  const projectId = getProjectId();
  // `uploadAsset` accepts a File. Most Blob sources (clipboard
  // images) are already Files; wrap raw Blobs so the backend gets
  // a sensible filename.
  const fileLike: File = file instanceof File
    ? file
    : new File([file], fallbackName, { type: file.type || 'image/png' });

  trace.action('image-paste:upload-start', {
    name: fileLike.name, size: fileLike.size, type: fileLike.type,
  });

  let url: string;
  try {
    url = await backend.uploadAsset(projectId, fileLike);
  } catch (err) {
    trace.error('image-paste:upload-failed', { error: String(err) });
    toast.error(err instanceof Error ? err.message : 'Image upload failed');
    return null;
  }

  trace.action('image-paste:upload-success', { url });

  // Size the node to the image's own aspect ratio (same box math as an
  // OS file drop — see `image-dims.ts`). Read from the in-memory bytes
  // so this costs no extra network round-trip. A fixed box would make
  // `object-fit: cover` crop anything that isn't exactly that ratio;
  // a square 350x350 cutout used to lose its top and bottom.
  const dims = await getBlobImageDimensions(fileLike);
  const { width, height } = fitFrameBox(dims);
  trace.action('image-paste:sized', { natural: dims, width, height });

  // Build a synthetic ClipboardData for the paste engine. The engine
  // then runs its full rule pipeline (selection → target → position
  // → styles) exactly as if the user had copied this image from the
  // canvas and pasted it. `isCanvasNode: true` lets the engine pick
  // the canvas-paste rules when nothing is selected; the rule for
  // "paste canvas node into selected frame" handles the selected
  // case automatically (re-routes parent + strips absolute styles).
  const nodeId = generateNodeId('img');
  const clipboard: ClipboardData = {
    version: 1,
    timestamp: Date.now(),
    nodes: [
      {
        id: nodeId,
        type: 'img',
        parentId: null,
        children: [],
        order: 0,
        // No placeholder fill. A grey backgroundColor is invisible behind
        // an opaque photo but shows through every transparent pixel of a
        // PNG/WebP cutout (product shots, logos, icons) — which reads to
        // the user as "the paste lost my transparency". Same rule the
        // media-gallery drop follows (see MediaGalleryPanel.tsx).
        styles: {
          position: 'absolute',
          width: `${width}px`,
          height: `${height}px`,
          display: 'block',
          maxWidth: 'none',
          objectFit: 'cover',
        },
        attrs: { src: url, alt: '' },
        name: 'Image',
        isCanvasNode: true,
      },
    ],
  };

  // Gather call-site context — mirrors `executePaste()` in
  // `code/features/paste-engine/execute-from-ui.ts`. Same store reads, same DOM
  // measurements, same replica-context queries so the image goes
  // through the IDENTICAL paste path as a normal node paste.
  const store = getDefaultStore();
  const selectedIds = store.get(selectedIdsAtom);
  const nodes = store.get(nodesAtom);
  const viewportEl = document.querySelector<HTMLElement>('[data-canvas-viewport]');
  const rect = viewportEl?.getBoundingClientRect();
  const { vpId: interactingVpId } = getInteractingViewport();
  const activeFilePath = getActiveFilePath();

  const result = engineExecutePaste({
    selectedIds,
    nodes,
    transform: transformManager.getTransform(),
    containerWidth: rect?.width,
    containerHeight: rect?.height,
    interactingVpId,
    viewportWidths: getViewportWidths(),
    activeFilePath,
    overrideClipboard: clipboard,
  });

  if (result.success && result.createdIds.length > 0) {
    flushNow();
    store.set(selectedIdsAtom, [result.createdIds[0]]);
    trace.action('image-paste:inserted', { id: result.createdIds[0], url });
  } else {
    trace.error('image-paste:engine-failed', { message: result.message });
    toast.error(result.message || 'Failed to insert image');
  }

  return url;
}

/** Handle a paste-event ClipboardEvent — extracts the first image
 *  File from the DataTransfer and routes it through the paste engine.
 *  Errors surface via `toast.error` and `trace`; never throws. */
export async function handleClipboardImagePasteFromEvent(
  clipboardData: DataTransfer | null,
): Promise<string | null> {
  const file = extractImageFile(clipboardData);
  if (!file) return null;
  return uploadAndInsert(file, file.name || 'image.png');
}

/** Handle a Ctrl+V keypress — async-reads the clipboard for an image
 *  Blob via `navigator.clipboard.read()`. Returns null if no image is
 *  found (so the keyboard handler can fall through to the normal
 *  text-clipboard logic). */
export async function handleClipboardImagePasteFromKeyboard(): Promise<string | null> {
  const blob = await readClipboardImage();
  if (!blob) return null;
  return uploadAndInsert(blob);
}
