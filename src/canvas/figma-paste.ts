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
import { flushSaveNow } from '@/backend/autosave';
import { setTemplatePromptArmed } from '@/code/stores/fresh-site-store';
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
 *  upload failures keep the data URL so no content is ever lost.
 *
 *  `onProgress(done, total)` fires per settled upload (total = UNIQUE data
 *  URLs — the real network work) so the import toast can show "n/N" instead
 *  of going silent for the whole sweep. Uploads run through a small pool:
 *  a big import's images upload ~4× faster than the old one-at-a-time loop.
 *  Exported for unit tests. */
export async function uploadClipboardAssets(
  clipboard: { nodes: Array<{ id: string; styles: Record<string, string> }> },
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const projectId = getProjectId();
  // Group by unique data URL first — N references share one upload.
  const byUrl = new Map<string, { firstId: string; refs: Array<Record<string, string>> }>();
  for (const node of clipboard.nodes) {
    const bgi = node.styles?.backgroundImage;
    const m = bgi?.match(/^url\((data:.+)\)$/); // GREEDY — svg data URLs contain nested url(#grad) parens
    if (!m) continue;
    const group = byUrl.get(m[1]);
    if (group) group.refs.push(node.styles);
    else byUrl.set(m[1], { firstId: node.id, refs: [node.styles] });
  }
  const entries = [...byUrl.entries()];
  const total = entries.length;
  if (total === 0) return;
  onProgress?.(0, total);

  let done = 0;
  let ok = 0;
  let failed = 0;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= entries.length) return;
      const [dataUrl, group] = entries[i];
      const file = dataUrlToFile(dataUrl, `figma-${group.firstId}`);
      if (file) {
        try {
          const hosted = await backend.uploadAsset(projectId, file);
          for (const styles of group.refs) styles.backgroundImage = `url(${hosted})`;
          ok++;
        } catch (err) {
          failed++;
          trace.error('figma-paste:asset-upload-failed', { id: group.firstId, error: String(err) });
        }
      }
      done++;
      onProgress?.(done, total);
    }
  };
  const POOL = 4;
  await Promise.all(Array.from({ length: Math.min(POOL, entries.length) }, worker));

  trace.action('figma-paste:assets-uploaded', { ok, failed });
  if (failed > 0) toast.error(`${failed} image${failed === 1 ? '' : 's'} couldn't upload — kept inline`);
}

/** Task-boundary yield so the toast's React render can PAINT before the next
 *  synchronous chunk of work (convert / paste+flush) blocks the main thread. */
const nextTask = () => new Promise<void>((r) => setTimeout(r, 0));

/** Full receive flow: upload assets → convert → paste via the engine.
 *
 *  ONE persistent loading toast, updated in place through every phase. The
 *  old `toast.info` auto-dismissed after ~4s while a big import's image
 *  uploads were still running — a dead-silent gap users read as "it broke"
 *  (2026-08-07). The spinner lives until success/error replaces it, and the
 *  image phase shows real n/N synced to the upload sweep. */
export async function handleFigmaPaste(payload: FigmaPayload): Promise<boolean> {
  const store = getDefaultStore();
  const toastId = toast.loading('Importing from Figma…');
  try {
    return await runFigmaPaste(payload, store, toastId);
  } catch (err) {
    // Never strand the spinner — an unexpected throw resolves it to an error.
    trace.error('figma-paste:failed', { error: String(err) });
    toast.error('Figma import failed', { id: toastId });
    return false;
  }
}

async function runFigmaPaste(
  payload: FigmaPayload,
  store: ReturnType<typeof getDefaultStore>,
  toastId: string | number,
): Promise<boolean> {
  await nextTask(); // let the toast paint before the synchronous convert
  const clipboard = convertFigmaPayload(payload);
  await uploadClipboardAssets(clipboard, (done, total) => {
    toast.loading(`Importing images… ${done}/${total}`, { id: toastId });
  });
  toast.loading('Placing layers…', { id: toastId });
  await nextTask(); // paint the phase change before the synchronous paste+flush

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
    // Real content now exists — a still-armed fresh-site template prompt must
    // not keep HOLDING autosave (held = every save deferred AND the unload
    // beacon skipped: the import would live only in memory). No-op otherwise.
    setTemplatePromptArmed(false);
    // Persist NOW, not after the 2s debounce — the import is exactly when a
    // user is likely to navigate straight back to the dashboard, and a
    // multi-MB project existing only in memory is one hard nav from gone
    // ("went to dashboard, came back, blank canvas", 2026-08-07).
    // Fire-and-forget: the toast doesn't wait on the PUT.
    void flushSaveNow();
    if (result.createdIds.length > 0) store.set(selectedIdsAtom, [result.createdIds[0]]);
    toast.success(`Imported ${result.createdIds.length} layer${result.createdIds.length === 1 ? '' : 's'} from Figma`, { id: toastId });
  } else {
    toast.error(result.message || 'Figma import failed', { id: toastId });
  }
  return result.success;
}
