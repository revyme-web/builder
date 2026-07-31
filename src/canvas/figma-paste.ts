// figma-paste.ts — receive an "Import to Revyme" Figma-plugin clipboard.
//
// The Figma plugin copies a hidden HTML flavor to the system clipboard:
//   <span data-revyme-import='{"version":"5.0","source":"figma-plugin",…}'>
// (text/plain is a single space so nothing pastes as text by accident).
//
// On Ctrl+V we read the text/html clipboard flavor, detect that marker,
// convert the payload into paste-engine ClipboardData (code/import/figma —
// where all the dialect rules live) and hand it to the SAME engine used by
// internal copy/paste via `overrideClipboard`. Target resolution, id
// re-allocation, placement, replica routing and undo are all inherited.
//
// Image fills arrive as data URLs; each is uploaded through the same
// backend.uploadAsset flow the Media tab uses, and the node's src is swapped
// for the hosted URL before conversion. Upload failures fall back to the
// data URL so the paste never loses content.

import { getDefaultStore } from 'jotai';
import { backend } from '@/backend';
import { getProjectId } from '@/backend/project-id';
import { flushNow } from '@/code/mutation/mutation-queue';
import { executePaste as engineExecutePaste } from '@/code/features/paste-engine';
import { convertFigmaPayload } from '@/code/import/figma/convert';
import type { FigmaPayload } from '@/code/import/figma/payload-types';
import { extractFigmaPayloadFromHtml } from '@/code/import/figma/clipboard-html';
import { sniffImageMime, extForMime } from '@/code/import/figma/image-mime';
import { transformManager } from './transform';
import { getInteractingViewport, getActiveFilePath } from './node-ops';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { selectedIdsAtom, nodesAtom } from '@/code/stores/store';
import { loadGoogleFont, } from '@/shared/font-loader';
import { ensureGoogleFontImport } from '@/code/project/preset-ops';
import { toast } from 'sonner';
import { trace } from '@/shared/debug-trace';

/** Read the clipboard's text/html flavor and extract the plugin payload.
 *  Returns null when the clipboard isn't a Figma import. Chrome SANITIZES
 *  html on clipboard.read() (re-quoted attributes, entity-encoded values),
 *  so extraction is DOM-based — see code/import/figma/clipboard-html. */
export async function readFigmaClipboard(): Promise<FigmaPayload | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.read) return null;
  let items: ClipboardItems;
  try {
    items = await navigator.clipboard.read();
  } catch (err) {
    trace.error('figma-paste:clipboard-read-failed', { error: String(err) });
    return null; // permission denied / empty — not a figma paste
  }
  for (const item of items) {
    if (!item.types.includes('text/html')) continue;
    try {
      const html = await (await item.getType('text/html')).text();
      trace.action('figma-paste:html-flavor-read', {
        htmlLength: html.length, hasMarker: html.includes('data-revyme-import'),
      });
      const parsed = extractFigmaPayloadFromHtml(html);
      if (parsed) {
        trace.action('figma-paste:payload-detected', {
          nodes: parsed.nodes.length, roots: parsed.rootNodeIds.length,
        });
        return parsed;
      }
      return null;
    } catch (err) {
      trace.error('figma-paste:html-parse-failed', { error: String(err) });
      return null;
    }
  }
  return null;
}

/** data URL (base64 OR utf8 svg) → File for backend.uploadAsset.
 *  The declared MIME is only a HINT: Figma ships a photo's ORIGINAL bytes
 *  (usually JPEG) while older plugin versions labeled everything image/png.
 *  The backend magic-byte-verifies every upload and 400s on a mismatch, so
 *  the File's type/extension come from sniffing the actual bytes. */
function dataUrlToFile(dataUrl: string, baseName: string): File | null {
  const b64 = dataUrl.match(/^data:([^;,]+);base64,(.*)$/);
  if (b64) {
    try {
      const bin = atob(b64[2]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const declared = b64[1];
      const mime = sniffImageMime(bytes) ?? declared;
      if (mime !== declared) {
        trace.action('figma-paste:mime-corrected', { baseName, declared, sniffed: mime });
      }
      return new File([bytes], `${baseName}.${extForMime(mime)}`, { type: mime });
    } catch {
      return null;
    }
  }
  const utf8 = dataUrl.match(/^data:image\/svg\+xml[^,]*,(.*)$/);
  if (utf8) {
    try {
      return new File([decodeURIComponent(utf8[1])], `${baseName}.svg`, { type: 'image/svg+xml' });
    } catch {
      return null;
    }
  }
  return null;
}

/** Post-convert sweep: EVERY `url(data:…)` in the converted styles —
 *  payload image fills AND converter-generated svg fallbacks — is uploaded
 *  to the project's asset storage and swapped for the hosted URL. Inline
 *  data URLs must never reach the source code: they bloat the page file by
 *  megabytes and every parse/save pays for them. Dedupes identical URLs;
 *  upload failures keep the data URL so no content is ever lost. */
async function uploadClipboardAssets(clipboard: { nodes: Array<{ id: string; styles: Record<string, string> }> }): Promise<void> {
  const projectId = getProjectId();
  const uploaded = new Map<string, string>();
  let ok = 0;
  let failed = 0;
  for (const node of clipboard.nodes) {
    const bgi = node.styles?.backgroundImage;
    const m = bgi?.match(/^url\((data:.+)\)$/); // GREEDY — svg data URLs contain nested url(#grad) parens
    if (!m) continue;
    const dataUrl = m[1];
    let hosted = uploaded.get(dataUrl);
    if (!hosted) {
      const file = dataUrlToFile(dataUrl, `figma-${node.id}`);
      if (!file) continue;
      try {
        hosted = await backend.uploadAsset(projectId, file);
        uploaded.set(dataUrl, hosted);
        ok++;
      } catch (err) {
        failed++;
        trace.error('figma-paste:asset-upload-failed', { id: node.id, error: String(err) });
        continue;
      }
    }
    node.styles.backgroundImage = `url(${hosted})`;
  }
  trace.action('figma-paste:assets-uploaded', { ok, failed });
  if (failed > 0) toast.error(`${failed} image${failed === 1 ? '' : 's'} couldn't upload — kept inline`);
}

/** Full receive flow: upload assets → convert → paste via the engine. */
export async function handleFigmaPaste(payload: FigmaPayload): Promise<boolean> {
  const store = getDefaultStore();
  toast.info('Importing from Figma…');

  const clipboard = convertFigmaPayload(payload);
  await uploadClipboardAssets(clipboard);

  // Load every font family the design references RIGHT NOW — the project-
  // wide font sweep only runs on page switches, so without this a paste's
  // fonts stay unloaded (Google families render as the browser's serif
  // default: wrong metrics, wrong wraps). fontFamily is a STACK
  // ("Aeonik, Inter, sans-serif") and loadGoogleFont takes ONE family, so
  // split and load each non-generic entry — that pulls in the metric-twin
  // alias when the primary is a premium font Google doesn't have.
  const GENERIC_FAMILIES = new Set(['sans-serif', 'serif', 'monospace', 'system-ui', 'cursive', 'fantasy']);
  const families = new Set<string>();
  for (const n of clipboard.nodes) {
    const stack = n.styles?.fontFamily;
    if (!stack) continue;
    for (const part of String(stack).split(',')) {
      const fam = part.trim().replace(/^['"]|['"]$/g, '');
      if (fam && !GENERIC_FAMILIES.has(fam.toLowerCase())) families.add(fam);
    }
  }
  for (const fam of families) {
    void loadGoogleFont(fam);
    try { ensureGoogleFontImport(fam); } catch { /* viewer mode / no tokens file */ }
  }
  trace.action('figma-paste:fonts-requested', { families: [...families] });

  const viewportEl = document.querySelector('[data-canvas-viewport]') as HTMLElement | null;
  const rect = viewportEl?.getBoundingClientRect();
  const { vpId: interactingVpId } = getInteractingViewport();

  const result = engineExecutePaste({
    selectedIds: store.get(selectedIdsAtom),
    nodes: store.get(nodesAtom),
    transform: transformManager.getTransform(),
    containerWidth: rect?.width,
    containerHeight: rect?.height,
    interactingVpId,
    viewportWidths: getViewportWidths(),
    activeFilePath: getActiveFilePath(),
    overrideClipboard: clipboard,
  });

  trace.action('figma-paste:done', {
    success: result.success, created: result.createdIds.length,
  });

  if (result.success) {
    flushNow();
    if (result.createdIds.length > 0) store.set(selectedIdsAtom, [result.createdIds[0]]);
    toast.success(`Imported ${result.createdIds.length} layer${result.createdIds.length === 1 ? '' : 's'} from Figma`);
  } else {
    toast.error(result.message || 'Figma import failed');
  }
  return result.success;
}
