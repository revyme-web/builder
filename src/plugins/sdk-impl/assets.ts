// plugins/sdk-impl/assets.ts — assets.* namespace.
//
// Drops images and SVGs onto the active page. `uploadImage` ships a
// data-URL fallback (no real upload) — when the cloud backend lands,
// this swaps to R2 upload returning a hosted URL. Plugin authors see
// no API change.

import { getDefaultStore } from 'jotai';
import { nodesAtom } from '@/code/stores/store';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { sanitizeSvgMarkupForJsx } from '@/shared/svg-sanitize';
import { normalizeSvgGeometryToBox } from '@/shared/icon-viewbox';
import { decomposeSvgDropToShapes } from '@/canvas/drag/svg-drop-shapes';
import { modifyProjectFile } from '@/code/project/modify-file';
import { addNodeInCode, type AddNodeDef } from '@/code/generation/generator-crud';
import { backend } from '@/backend';
import { getProjectId } from '@/backend/project-id';
import type { ImageAsset } from '@revyme/plugin-sdk';
import type { RpcHandler } from '../plugin-types';
import { makeNodeId } from './_id-gen';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

function findRootId(): string | null {
  for (const [id, node] of store.get(nodesAtom)) {
    if (!node.parentId) return id;
  }
  return null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Convert a Blob to a real File object (so it round-trips through
 * `backend.uploadAsset`'s File-typed signature). The MediaGallery
 * uses real File inputs from `<input type="file">`, so when a plugin
 * passes a Blob without a name we synthesize one. Mime type is
 * preserved because R2 keys off it for content-type metadata.
 */
function blobToFile(blob: Blob | File, fallbackName: string): File {
  if (blob instanceof File) return blob;
  const ext = (blob.type.split('/')[1] ?? 'bin').split('+')[0];
  return new File([blob], `${fallbackName}.${ext}`, { type: blob.type });
}

/**
 * Upload via the same backend the MediaGallery panel uses. R2 in cloud
 * mode (returns a hosted URL); local-mode falls back to a session-only
 * object URL (see `local-backend.ts`). Images AND videos route through
 * the same endpoint — the backend stores them under different prefixes
 * keyed by mime type, so plugin authors don't need separate methods.
 *
 * On error (offline, 5xx, etc) we fall back to a base64 data URL so
 * plugins keep working in dev / disconnected contexts. The plugin
 * sees a successful resolve either way; trace logs distinguish.
 */
async function uploadViaBackend(blob: Blob | File, fallbackName: string): Promise<string> {
  const file = blobToFile(blob, fallbackName);
  try {
    const projectId = getProjectId();
    const url = await backend.uploadAsset(projectId, file);
    trace.action('plugin:assets.upload:backend', { name: file.name, type: file.type, size: file.size });
    return url;
  } catch (err) {
    // Backend unavailable (offline, missing project id) — fall back
    // to a data URL so the plugin still gets a usable asset reference.
    // Cost: bigger source files when the URL ends up serialized into
    // a code component. Worth it for offline dev.
    trace.error('plugin:assets.upload:backend-failed', { name: file.name, error: String(err) });
    return blobToDataUrl(blob);
  }
}

export const assetsHandlers: Record<string, RpcHandler> = {
  'assets.addImage': async (params): Promise<string> => {
    const p = params as { asset?: ImageAsset };
    if (!p?.asset || typeof p.asset.url !== 'string') {
      throw new Error('assets.addImage: asset.url required');
    }
    const rootId = findRootId();
    if (!rootId) throw new Error('assets.addImage: active page has no root');
    const id = makeNodeId('img');
    const w = p.asset.width ? `${p.asset.width}px` : '200px';
    const h = p.asset.height ? `${p.asset.height}px` : '200px';
    const def: AddNodeDef = {
      id,
      type: 'img',
      styles: { position: 'absolute', left: '0px', top: '0px', width: w, height: h },
      attrs: { src: p.asset.url, alt: p.asset.name ?? '' },
      name: p.asset.name ?? 'Image',
    };
    modifyProjectFile(store.get(activeFilePathAtom), (code) => addNodeInCode(code, rootId, def));
    return id;
  },

  'assets.addSvg': async (params): Promise<string> => {
    const p = params as { svgString?: unknown; opts?: { name?: string } };
    if (typeof p?.svgString !== 'string') throw new Error('assets.addSvg: svgString required');
    const rootId = findRootId();
    if (!rootId) throw new Error('assets.addSvg: active page has no root');
    const id = makeNodeId('svg');
    // Strip everything through the opening <svg …> tag (covers an XML
    // prologue / leading comments) and the closing shell — the generator
    // emits its own <svg data-id="..."> wrapper. Already-bare children
    // (paths/circles) pass through. Then SANITIZE for JSX: real-world
    // exports carry XML comments / `<style>{…}` blocks / namespaced attrs
    // that are valid XML but unparseable as JSX — the written page then
    // fails to parse (live find 2026-07-28, svgl.app wordmarks).
    const inner = sanitizeSvgMarkupForJsx(
      p.svgString.replace(/^[\s\S]*?<svg[^>]*>/i, '').replace(/<\/svg>[\s\S]*$/i, ''),
    );
    // Size from the SOURCE aspect and honor the shape dialect: the editor's
    // svg system assumes viewBox === `0 0 W H` (px). The old hardcoded
    // `0 0 100 100` squashed any non-square/foreign-space source (a 116×48
    // wordmark rendered letterboxed, then mangled on first resize).
    const srcViewBox = p.svgString.match(/viewBox="([^"]+)"/)?.[1];
    const vbParts = (srcViewBox ?? '').trim().split(/[\s,]+/).map(Number);
    const aspect = vbParts.length === 4 && vbParts[3] > 0 ? vbParts[2] / vbParts[3] : 1;
    const boxW = 100;
    const boxH = Math.max(1, Math.round(boxW / (aspect > 0 ? aspect : 1)));
    const name = p.opts?.name ?? 'SVG';
    // Best outcome: decompose into the native shape GRAMMAR (Figma-import
    // parity — per-shape nested svgs + real path children, double-click
    // editable with vertices). Fallbacks: flat 1:1 rescale, then source
    // viewBox verbatim.
    const decomposed = srcViewBox
      ? decomposeSvgDropToShapes(`<svg viewBox="${srcViewBox}">${inner}</svg>`, id, name, boxW, boxH)
      : null;
    const toDef = (d: import('@/shared/types').NewNodeDescriptor): AddNodeDef => ({
      id: d.id ?? makeNodeId('shape'), type: d.tag, styles: d.styles ?? {}, attrs: d.attrs,
      name: d.name, textContent: d.textContent, children: d.children?.map(toDef),
    });
    const oneToOne = decomposed ? null : normalizeSvgGeometryToBox(srcViewBox, inner, boxW, boxH);
    const def: AddNodeDef = {
      id,
      type: 'svg',
      styles: {
        position: 'absolute', left: '0px', top: '0px',
        width: `${boxW}px`, height: `${boxH}px`,
        ...(decomposed ? { overflow: 'visible' } : {}),
      },
      attrs: decomposed
        ? decomposed.attrs
        : { viewBox: oneToOne?.viewBox ?? srcViewBox ?? `0 0 ${boxW} ${boxH}` },
      name,
      textContent: decomposed ? undefined : (oneToOne?.inner ?? inner),
      children: decomposed ? decomposed.children.map(toDef) : undefined,
    };
    modifyProjectFile(store.get(activeFilePathAtom), (code) => addNodeInCode(code, rootId, def));
    return id;
  },

  /**
   * Upload an image to R2 (or a session-local object URL in standalone
   * mode) via the same `backend.uploadAsset` the MediaGallery panel
   * uses. Returns an `ImageAsset` whose `url` is the hosted asset URL
   * — the plugin can pass it straight to `assets.addImage` or use it
   * as an `<img src>` value baked into a generated component.
   */
  'assets.uploadImage': async (params): Promise<ImageAsset> => {
    const p = params as { file?: Blob | File };
    if (!p?.file || !(p.file instanceof Blob)) {
      throw new Error('assets.uploadImage: file (Blob) required');
    }
    const url = await uploadViaBackend(p.file, 'image');
    return {
      url,
      name: p.file instanceof File ? p.file.name : undefined,
    };
  },

  /**
   * Download an image's bytes THROUGH the backend media proxy and hand the
   * plugin a Blob (structured-clone-safe over postMessage). This is the ONLY
   * CORS-safe way for a plugin to read pixels from an arbitrary URL — the
   * user's own storage (assets.revyme.app / R2) and most CDNs send NO
   * Access-Control-Allow-Origin, so `<img crossorigin>` taints the canvas and
   * `toBlob`/`getImageData` throw. The proxied Blob is same-origin, so it can
   * be drawn to a canvas and read back freely (flip, recolor, sample, etc.).
   */
  'assets.fetchImage': async (params): Promise<Blob> => {
    const p = params as { url?: unknown };
    if (typeof p?.url !== 'string' || !p.url) throw new Error('assets.fetchImage: url required');
    return backend.fetchMediaBytes(p.url);
  },

  /**
   * Bulk upload. Each file uploads serially through `backend.uploadAsset`
   * — parallel uploads would saturate the connection and the cloud
   * backend's per-request rate limit. Plugin authors processing very
   * large batches should chunk + show progress in their own UI.
   */
  'assets.uploadImages': async (params): Promise<ImageAsset[]> => {
    const p = params as { files?: (Blob | File)[] };
    if (!Array.isArray(p?.files)) throw new Error('assets.uploadImages: files[] required');
    const out: ImageAsset[] = [];
    for (const f of p.files) {
      if (!(f instanceof Blob)) continue;
      out.push({
        url: await uploadViaBackend(f, 'image'),
        name: f instanceof File ? f.name : undefined,
      });
    }
    return out;
  },

  /**
   * Generic file upload — same backend, returns FileAsset shape with
   * content-type. Use this for video, audio, PDFs, etc. — anything
   * that's not a still image. The backend routes by mime-type:
   * `video/*` → R2 video prefix, others → R2 storage prefix.
   */
  'assets.uploadFile': async (params) => {
    const p = params as { file?: Blob | File };
    if (!p?.file || !(p.file instanceof Blob)) {
      throw new Error('assets.uploadFile: file (Blob) required');
    }
    const url = await uploadViaBackend(p.file, 'file');
    return {
      url,
      name: p.file instanceof File ? p.file.name : 'file',
      contentType: p.file.type || 'application/octet-stream',
    };
  },

  'assets.uploadFiles': async (params) => {
    const p = params as { files?: (Blob | File)[] };
    if (!Array.isArray(p?.files)) throw new Error('assets.uploadFiles: files[] required');
    const out: { url: string; name: string; contentType: string }[] = [];
    for (const f of p.files) {
      if (!(f instanceof Blob)) continue;
      out.push({
        url: await uploadViaBackend(f, 'file'),
        name: f instanceof File ? f.name : 'file',
        contentType: f.type || 'application/octet-stream',
      });
    }
    return out;
  },

  /**
   * Replace the current selection's image src. Routes through
   * canvas.setAttributes since `<img>` src is just an attribute —
   * but the public SDK currently only accepts `styles` for
   * setAttributes (Pass 2). Workaround: write an inline-style
   * `--asset-url` token that themed components can read. When
   * setAttributes opens up to attrs in a later pass, this swaps.
   *
   * For now, throw clearly — this method is typed but not yet
   * usable end-to-end.
   */
  'assets.setImage': async () => {
    throw new Error(
      'NOT_IMPLEMENTED:assets.setImage (depends on canvas.setAttributes accepting non-style attrs, Pass 2)',
    );
  },

  /**
   * Open the editor's native video picker (the same Pixabay / Upload / URL
   * modal the Fill tool uses) and return the chosen clip AS BYTES. The URL is
   * fetched through the backend media proxy so cross-origin CDN clips (Pixabay
   * sends no CORS header) become decodable in the browser — the plugin can draw
   * the returned Blob to a <canvas> and read frames back. Resolves `null` when
   * the user closes the picker without choosing.
   *
   * Mirrors the `ui.showContextMenu` shape: dispatch an event carrying a
   * resolver, a globally-mounted host (`PluginVideoPickerHost`) renders the
   * modal and calls back. If no host is mounted, resolves null after a beat so
   * the plugin never hangs.
   */
  'assets.pickVideo': async (): Promise<{ url: string; blob: Blob } | null> => {
    const pickedUrl = await new Promise<string | null>((resolve) => {
      let settled = false;
      const done = (u: string | null) => { if (!settled) { settled = true; resolve(u); } };
      window.dispatchEvent(new CustomEvent('revyme:plugin-pick-video', { detail: { resolve: done } }));
      // Absent-host guard: if no host is mounted the modal never opens, so a
      // long fallback keeps a broken mount from hanging the plugin forever.
      setTimeout(() => done(null), 5 * 60_000);
    });
    if (!pickedUrl) return null;
    trace.action('plugin:assets.pickVideo', { picked: true });
    const blob = await backend.fetchMediaBytes(pickedUrl);
    return { url: pickedUrl, blob };
  },
};
