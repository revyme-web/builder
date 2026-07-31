// workspace-fonts-store.ts — custom fonts uploaded to the workspace library.
//
// The website being edited belongs to a workspace; custom fonts are a
// workspace-level library shared by every project in it (uploaded from the
// dashboard's Workspace → Fonts settings). The font picker surfaces them under
// a "Workspace fonts" section.
//
// Lazy: the list is fetched the first time something needs it (the picker
// opening), then cached for the session. Each font is registered with the
// FontFace API on load so the picker can render every entry in its own
// typeface. Cloud-only — stays empty in standalone / local-project mode.
//
// Module-level state + `useSyncExternalStore`, the same pattern as
// `credits-store` — readable from React and imperative code, and dodges the
// editor's `<Provider>` store.

import { useSyncExternalStore } from 'react';
import { trace } from '@/shared/debug-trace';
import { backend } from '@/backend';
import { getProjectId } from '@/backend/project-id';
import { loadCustomFont } from '@/shared/font-loader';
import { modifyProjectFile } from '@/code/project/modify-file';
import { addWorkspaceFontFacesToCss } from '@/code/project/preset-ops';
import { forceCanvasRender } from '@/canvas/node-ops';
import type { WorkspaceFont } from '@/backend/types';

let _fonts: WorkspaceFont[] = [];
let _loaded = false;
let _loading = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

/**
 * Fetch the workspace font library once, then cache. Resolves the owning
 * workspace from the current website, lists its fonts, and pre-registers each
 * face (so previews render). Safe to call repeatedly — it no-ops once loaded
 * or while a load is in flight. Failures leave the library empty (the picker
 * just omits the section).
 */
export async function ensureWorkspaceFonts(): Promise<void> {
  if (_loaded || _loading) return;
  _loading = true;
  try {
    const websiteId = getProjectId();
    if (!websiteId || websiteId === 'local') { _loaded = true; return; }

    const workspaceId = await backend.getWebsiteWorkspaceId(websiteId);
    if (!workspaceId) { _loaded = true; return; }

    const fonts = await backend.listWorkspaceFonts(workspaceId);
    _fonts = fonts;
    _loaded = true;
    trace.action('workspace-fonts:loaded', { count: fonts.length, workspaceId });

    // Register every face so the picker renders each in its own typeface.
    for (const f of fonts) {
      loadCustomFont({ family: f.family, url: f.url, weight: f.weight, style: f.style });
    }
    notify();
  } catch (err) {
    trace.error('workspace-fonts:load-failed', err);
    _loaded = true;
  } finally {
    _loading = false;
    notify();
  }
}

/** Imperative read of the cached library (empty until loaded). */
function getWorkspaceFonts(): WorkspaceFont[] {
  return _fonts;
}

/**
 * Make a workspace font usable in the CURRENT project: declare an @font-face
 * for every weight/style of the family in app/globals.css (pointing at the
 * hosted file), then force a canvas re-render so the iframe resolves it. The
 * @font-face lives in the project source, so it's visible in the code explorer
 * and ships with the published site. Called when the user applies a workspace
 * font from the picker. No-op when the family isn't in the library.
 */
export function applyWorkspaceFontToProject(family: string): void {
  const familyFonts = _fonts.filter(f => f.family === family);
  if (familyFonts.length === 0) return;

  const specs = familyFonts.map(f => ({
    family: f.family, url: f.url, weight: f.weight, style: f.style, ext: f.ext,
  }));

  // modifyProjectFile flushes any pending mutation (e.g. the fontFamily write
  // that just queued) before reading globals.css, so neither clobbers the other.
  const before = modifyProjectFile('app/globals.css', css => addWorkspaceFontFacesToCss(css, specs));
  trace.action('workspace-fonts:applied-to-project', { family, weights: specs.length, changed: before != null });
  forceCanvasRender();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** React hook — the workspace font library, reactive to load completion. */
export function useWorkspaceFonts(): WorkspaceFont[] {
  return useSyncExternalStore(subscribe, getWorkspaceFonts, getWorkspaceFonts);
}
