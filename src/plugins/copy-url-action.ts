// plugins/copy-url-action.ts — right-click "Copy URL" on a local
// Tier 2 plugin. Bundles the plugin source to a self-contained HTML
// blob, uploads it to `/api/plugins/draft` along with the raw TSX,
// receives back a public draft URL, and copies it to the clipboard.
//
// The URL serves two audiences:
//   1. Friends — paste into their cmd+K palette to install the plugin
//      directly into their project (Phase 4 install flow handles this).
//   2. The author — paste into the revyme-cloud creator dashboard's
//      "Submit Plugin" form to pre-fill bundle_url + source_url +
//      metadata so the plugin can be officially published without
//      re-uploading.
//
// Visibility model: drafts created here are ALWAYS uploaded with the
// source TSX (open). The author can choose closed-source when they
// formally publish via the creator dashboard — that's the right place
// for the decision since publishing is the public release act.

import { toast } from 'sonner';
import { readPluginSource, pluginPathToInternalName } from '@/editor/plugin-editor/plugin-files';
import { bundlePluginToBlobUrl } from '@/editor/plugin-editor/plugin-bundler';
import { trace } from '@/shared/debug-trace';

/**
 * Fetch the bundled HTML for a local plugin in portable form. The
 * `portable: true` flag tells the bundler to embed the SDK as a data
 * URL instead of a blob URL — required so the HTML works when loaded
 * cross-origin (from R2, in someone else's Revyme, etc.). The
 * non-portable variant would leak a `blob:http://localhost:NNNN/...`
 * URL that only resolves in the originating tab.
 */
async function bundleToHtml(filePath: string, pluginName: string): Promise<string> {
  const source = readPluginSource(filePath);
  if (!source) throw new Error('Plugin source missing');
  const blobUrl = bundlePluginToBlobUrl(source, {
    pluginId: `local.${pluginName.toLowerCase()}`,
    pluginName,
    portable: true,
  });
  try {
    const res = await fetch(blobUrl);
    if (!res.ok) throw new Error(`Bundle fetch failed: ${res.status}`);
    return await res.text();
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/**
 * Copy the plugin's draft URL to the clipboard. Shows a toast on
 * success / failure. Uploads both the bundle and the TSX source so
 * the URL works for both consumer install (bundle) AND author
 * publish-form pre-fill (source).
 */
export async function copyLocalPluginUrl(filePath: string): Promise<void> {
  const pluginName = pluginPathToInternalName(filePath);
  const loading = toast.loading(`Preparing ${pluginName}...`);
  try {
    const source = readPluginSource(filePath);
    if (!source) {
      toast.dismiss(loading);
      toast.error('Plugin source not found');
      return;
    }
    const bundle = await bundleToHtml(filePath, pluginName);

    // Uploads to R2 under a content-addressable hash. No DB row gets
    // created here — the creator-dashboard "Submit Plugin" flow is
    // what creates a `creator_components` row, after the user adds
    // marketplace metadata (thumbnail, byline, etc.). Re-copying the
    // same plugin produces the same URL (content-hash dedup).
    const res = await fetch('/api/plugins/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        name: pluginName,
        bundle,
        source,
      }),
    });
    toast.dismiss(loading);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 401) {
        toast.error('Sign in to share plugins');
        return;
      }
      toast.error(`Upload failed (${res.status}): ${text.slice(0, 120)}`);
      return;
    }

    const data = (await res.json()) as { url: string; hash: string };
    await navigator.clipboard.writeText(data.url);
    trace.action('copy-url:success', { filePath, hash: data.hash });
    toast.success('Copied URL to clipboard');
  } catch (err) {
    toast.dismiss(loading);
    trace.error('copy-url:failed', { filePath, error: String(err) });
    toast.error(`Couldn't copy URL: ${(err as Error).message}`);
  }
}
