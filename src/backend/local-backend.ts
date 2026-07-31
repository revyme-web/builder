// local-backend.ts — Standalone (no backend) implementation using localStorage.
// Used when VITE_REVYME_CLOUD is not set.

import type { ProjectBackend, ProjectData, RevymeUser, WorkspaceFont } from './types';
import { isKnownProjectFormat } from './types';
import { trace } from '@/shared/debug-trace';

const STORAGE_PREFIX = 'revyme-project-';

export class LocalBackend implements ProjectBackend {
  async getUser(): Promise<RevymeUser | null> {
    return { id: 'local', name: 'Local User', email: 'local@dev' };
  }

  async loadProject(id: string): Promise<ProjectData | null> {
    const key = STORAGE_PREFIX + id;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const data = JSON.parse(raw) as ProjectData;
      if (!isKnownProjectFormat(data.format)) return null;
      trace.action('backend:load-project', { id, source: 'localStorage', fileCount: Object.keys(data.files).length });
      return data;
    } catch (err) {
      trace.error('local-backend:load-error', { id, error: String(err) });
      return null;
    }
  }

  async saveProject(id: string, data: ProjectData): Promise<void> {
    const key = STORAGE_PREFIX + id;
    localStorage.setItem(key, JSON.stringify(data));
    trace.action('backend:save-project', { id, source: 'localStorage', fileCount: Object.keys(data.files).length });
  }

  async renameWebsite(id: string, name: string): Promise<void> {
    // No cloud row to update — the project chip persists the name itself via
    // project-store's localStorage. Nothing else to do here.
    trace.action('backend:rename-website', { id, name, source: 'local' });
  }

  async getWebsiteName(_id: string): Promise<string | null> {
    // Local projects have no canonical backend name — the chip's localStorage
    // value is the source of truth, so don't override it on load.
    return null;
  }

  async uploadAsset(_id: string, file: File): Promise<string> {
    // Standalone (no-cloud) mode: read the file as a base64 data URL
    // so the bytes get embedded directly in whatever code path stores
    // it. `URL.createObjectURL` was simpler but produced a `blob:`
    // URL that's scoped to the current page session — closing or
    // reloading the editor invalidated every uploaded image, which
    // surfaced as 404 image placeholders in the SEO metadata form
    // and anywhere else uploads were saved (Fill tool, etc.). Data
    // URLs are bigger but survive across sessions and serialize
    // cleanly into the project JSON. Cloud mode (revyme-backend)
    // uses the real CDN endpoint and is unaffected by this change.
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
    trace.action('backend:upload-asset', { source: 'dataURL', name: file.name, bytes: file.size });
    return url;
  }

  async deleteAssets(_id: string, keys: string[]): Promise<void> {
    // Standalone uploads are data: URLs embedded in the project — there is
    // no server object to delete. The Media panel hides its delete UI in
    // this mode; keep the interface satisfied as a traced no-op.
    trace.action('backend:delete-assets', { source: 'local-noop', count: keys.length });
  }

  async fetchMediaBytes(remoteUrl: string): Promise<Blob> {
    // No server-side proxy in standalone mode — best-effort direct fetch.
    // Works for data:/blob: URLs and CORS-enabled sources; cross-origin CDNs
    // (e.g. Pixabay) will reject, which is expected without the cloud backend.
    const res = await fetch(remoteUrl);
    if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
    trace.action('backend:fetch-media-bytes', { source: 'direct' });
    return res.blob();
  }

  async getWebsiteRole(_id: string): Promise<'owner' | 'editor' | 'viewer'> {
    // localStorage projects are single-user — there are no other roles
    // to be. Always owner.
    return 'owner';
  }

  async getWebsiteClosedSource(_id: string): Promise<boolean> {
    // localStorage projects are never template remixes — code always visible.
    return false;
  }

  async getWebsiteWorkspaceId(_id: string): Promise<string | null> {
    // localStorage projects don't belong to any workspace — there's no
    // cloud dashboard to route to. Callers (LeftHeader's "Your Account"
    // menu item) treat null as "skip the workspace param" and fall back
    // to a bare dashboard URL.
    return null;
  }

  async getCredits(_workspaceId: string): Promise<number | null> {
    // No credits in local mode — AI runs aren't metered against a
    // workspace pool. The AI bars hide the indicator when this is null.
    return null;
  }

  async listWorkspaceFonts(_workspaceId: string): Promise<WorkspaceFont[]> {
    // localStorage projects have no workspace — no custom font library.
    return [];
  }
}
