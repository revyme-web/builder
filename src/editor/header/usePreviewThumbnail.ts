// usePreviewThumbnail.ts — Parent-side orchestration for the dashboard
// thumbnail. When the Preview overlay opens and the project changed since the
// last capture, asks the :5175 preview iframe to snapshot itself, receives
// the JPEG data URL, and uploads it to the backend (which stores it in R2 and
// writes websites.preview_image). Replaces the puppeteer screenshot-service.
//
// All best-effort: a missing or stale thumbnail is purely cosmetic — this
// never blocks or errors the preview UX.

import { useEffect, useRef } from 'react';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { getProjectId } from '@/backend/project-id';
import { uploadPreviewThumbnail } from '@/backend/revyme-backend';
import { trace } from '@/shared/debug-trace';

/**
 * Decide whether to (re)capture the thumbnail. Two gates:
 *   - `isHomePage` — `preview_image` is ONE thumbnail per website, so only the
 *     home page may set it; previewing a sub-page or a component master must
 *     never overwrite it.
 *   - version changed — only re-capture when the project actually changed
 *     since the last successful capture, so repeated preview-opens don't spam
 *     uploads. A version moving *backwards* (undo) still counts as a change.
 *
 * Pure — unit tested in usePreviewThumbnail.test.ts.
 */
export function shouldCaptureThumbnail(args: {
  isHomePage: boolean;
  lastCapturedVersion: number | null;
  currentVersion: number;
}): boolean {
  if (!args.isHomePage) return false;
  return args.lastCapturedVersion !== args.currentVersion;
}

interface Options {
  open: boolean;
  iframeReady: boolean;
  /** True only when the previewed file is the site's home page (`app/page.tsx`). */
  isHomePage: boolean;
  projectVersion: number;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  /** postMessage targetOrigin — PreviewOverlay uses '*' (see its comment). */
  postMessageTarget: string;
}

/**
 * Wires capture-on-preview-open. Mount once in PreviewOverlay.
 *
 * Flow:
 *   open + iframeReady, project changed since last capture
 *     → postMessage `preview:capture-thumbnail` to the iframe
 *   iframe defers (fonts.ready + idle), snapshots, posts `preview:thumbnail`
 *     → upload the data URL to the backend
 *
 * Captures once per open/ready cycle — not on every edit-while-open — so a
 * long editing session with the preview open doesn't re-capture on each keystroke.
 */
export function usePreviewThumbnail({
  open,
  iframeReady,
  isHomePage,
  projectVersion,
  iframeRef,
  postMessageTarget,
}: Options): void {
  const lastCapturedVersionRef = useRef<number | null>(null);

  // 1. Receive the captured data URL from the iframe → upload it.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MessageEvent) => {
      if (e.data?.type !== 'preview:thumbnail') return;
      const dataUrl = e.data.dataUrl;
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
        trace.error('preview-thumbnail:bad-payload', { kind: typeof dataUrl });
        return;
      }
      const websiteId = getProjectId();
      if (!websiteId) {
        trace.error('preview-thumbnail:no-website-id', {});
        return;
      }
      if (!CLOUD_ENABLED) return; // preview_image is a cloud websites-row column
      trace.action('preview-thumbnail:received', { websiteId, chars: dataUrl.length });
      uploadPreviewThumbnail(websiteId, dataUrl)
        .then((url) => trace.action('preview-thumbnail:uploaded', { websiteId, url }))
        .catch((err) =>
          trace.error('preview-thumbnail:upload-failed', { websiteId, error: String(err) }),
        );
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [open]);

  // 2. When the iframe is ready, the previewed page is the home page, and the
  //    project changed since the last capture, ask the iframe to snapshot
  //    itself. The iframe defers the actual capture so the preview render is
  //    never slowed. Re-runs if the user navigates to the home page while the
  //    preview is open; the version-debounce keeps it from re-capturing on
  //    every edit. `projectVersion` is read but intentionally not a dep — we
  //    don't re-capture on every edit-while-open.
  useEffect(() => {
    if (!open || !iframeReady) return;
    if (!shouldCaptureThumbnail({
      isHomePage,
      lastCapturedVersion: lastCapturedVersionRef.current,
      currentVersion: projectVersion,
    })) return;
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    lastCapturedVersionRef.current = projectVersion;
    iframe.contentWindow.postMessage({ type: 'preview:capture-thumbnail' }, postMessageTarget);
    trace.action('preview-thumbnail:requested', { projectVersion });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, iframeReady, isHomePage]);
}
