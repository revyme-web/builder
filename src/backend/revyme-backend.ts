// revyme-backend.ts — Revyme cloud implementation.
// Calls the Hono API. By default (no `VITE_API_URL` set) requests are
// relative — they go through the Next.js dispatcher at `localhost:3001`
// which rewrites `/api/*` upstream to the backend. Set `VITE_API_URL`
// (e.g. `http://localhost:8090`) to talk to the backend directly,
// which bypasses the dispatcher entirely. That's the recommended dev
// setup when Chrome HSTS keeps trying to upgrade `localhost:3001` to
// HTTPS and trips ALPN.
//
// Credentials ride along on the session cookie either way.

import type { ProjectBackend, ProjectData, RevymeUser, WorkspaceFont } from './types';
import { disableGzipBodies, encodeSaveBody, noteServerEncodings } from './save-encoding';
import { isKnownProjectFormat, SaveConflictError } from './types';
import { getBaseRevision, isRevisionInSync, noteSaved, setLoadedRevision } from './save-revision';
import { trace } from '@/shared/debug-trace';

const API_URL = ((import.meta as ImportMeta & { env: Record<string, string> }).env?.VITE_API_URL ?? '').replace(/\/$/, '');

/** Resolve a relative API path against the configured backend base.
 *  Empty base → relative URL (dispatched by Next.js). Non-empty →
 *  absolute URL straight to the Hono backend. */
function url(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return API_URL ? `${API_URL}${p}` : p;
}

/** The website row as the role / name / flag getters read it — never the
 *  project blob. */
interface WebsiteRow {
  _role?: 'owner' | 'editor' | 'viewer';
  name?: string | null;
  closed_source?: boolean;
  workspace_id?: string | null;
  revision?: number;
}

/** How long one row fetch answers every getter that asks for it. Boot asks
 *  four of them at once (role, name, closed-source, then workspace). */
const WEBSITE_ROW_TTL_MS = 3000;

export class RevymeBackend implements ProjectBackend {
  private websiteRows = new Map<string, { at: number; row: Promise<{ ok: true; row: WebsiteRow } | { ok: false; status?: number; error?: unknown }> }>();

  /**
   * The website row WITHOUT its `json` blob. `GET /api/websites/:id` returns
   * the whole project (13 MB for a big site), and boot used to fetch it once
   * per getter — seven times per page load. `/meta` is the same row minus the
   * blob; a backend that predates it answers 404 and we fall back to the full
   * GET. Concurrent callers share one request.
   */
  private fetchWebsiteRow(id: string): Promise<{ ok: true; row: WebsiteRow } | { ok: false; status?: number; error?: unknown }> {
    const cached = this.websiteRows.get(id);
    if (cached && Date.now() - cached.at < WEBSITE_ROW_TTL_MS) return cached.row;
    const row = (async () => {
      try {
        const enc = encodeURIComponent(id);
        let res = await fetch(url(`/api/websites/${enc}/meta`), { credentials: 'include' });
        if (res.status === 404) {
          res = await fetch(url(`/api/websites/${enc}`), { credentials: 'include' });
        }
        noteServerEncodings(res);
        if (!res.ok) return { ok: false as const, status: res.status };
        return { ok: true as const, row: (await res.json()) as WebsiteRow };
      } catch (error) {
        return { ok: false as const, error };
      }
    })();
    this.websiteRows.set(id, { at: Date.now(), row });
    return row;
  }

  async getUser(): Promise<RevymeUser | null> {
    try {
      const res = await fetch(url('/api/auth/session'), { credentials: 'include' });
      if (!res.ok) return null;
      const session = await res.json();
      if (!session?.user) return null;
      const { id, name, email, image, isAdmin } = session.user;
      trace.action('backend:get-user', { id, email, isAdmin: !!isAdmin });
      return { id, name, email, image, isAdmin: !!isAdmin };
    } catch (err) {
      trace.error('revyme-backend:get-user-error', { error: String(err) });
      return null;
    }
  }

  async loadProject(id: string): Promise<ProjectData | null> {
    // Hono returns the websites row directly with `json` as a JSON-encoded
    // string of the ProjectData snapshot. Earlier this code expected the
    // legacy Next.js shape `{ website: { data } }` and got null for every
    // load against the Hono backend.
    try {
      const res = await fetch(url(`/api/websites/${id}`), { credentials: 'include' });
      noteServerEncodings(res);
      if (!res.ok) {
        trace.error('backend:load-project', { id, status: res.status });
        return null;
      }
      const row = await res.json() as { id: string; name: string; json: string; revision?: number };
      // The save base: every later save names it, and the backend refuses a
      // save based on an older revision (a stale tab) — see save-revision.ts.
      setLoadedRevision(row.revision);
      let data: Partial<ProjectData> | null = null;
      try {
        data = row.json ? JSON.parse(row.json) as Partial<ProjectData> : null;
      } catch (err) {
        trace.error('backend:load-project-parse', { id, error: String(err) });
        return null;
      }
      // A row that HAS files is a real project — never discard it over an
      // unrecognised format tag. Returning null makes ProjectLoader seed an
      // empty starter, and the next autosave writes that emptiness back over
      // the user's work. The tag is a version hint, not an admission gate:
      // only a genuinely fileless row (newly-created website) is "no
      // snapshot". An unknown tag is logged loudly and loaded anyway.
      const fileCount = data?.files ? Object.keys(data.files).length : 0;
      if (!data || fileCount === 0) {
        trace.action('backend:load-project', { id, result: 'no-snapshot', format: data?.format });
        return null;
      }
      if (!isKnownProjectFormat(data.format)) {
        trace.error('backend:load-project-unknown-format', { id, format: data.format, fileCount });
      }
      trace.action('backend:load-project', { id, fileCount });
      return data as ProjectData;
    } catch (err) {
      trace.error('backend:load-project', err);
      return null;
    }
  }

  async getWebsiteRole(id: string): Promise<'owner' | 'editor' | 'viewer'> {
    // The website row carries the caller's effective role on the site
    // (`_role`). Falling back to 'viewer' is the conservative choice on any
    // error — the worst case is the user can't edit (a toast surfaces the
    // underlying problem) rather than letting writes through without
    // authorization.
    const r = await this.fetchWebsiteRow(id);
    if (!r.ok) {
      trace.error('backend:get-website-role', { id, status: r.status, error: r.error ? String(r.error) : undefined });
      return 'viewer';
    }
    return r.row._role ?? 'viewer';
  }

  async getWebsiteClosedSource(id: string): Promise<boolean> {
    // `closed_source` is stamped onto remixed websites created from a
    // closed-source template. Defaulting to FALSE on error is deliberate:
    // worst case the code panel shows (the template author's protection
    // degrades gracefully) rather than locking a legitimate owner out of
    // their own code.
    const r = await this.fetchWebsiteRow(id);
    if (!r.ok) {
      trace.error('backend:get-website-closed-source', { id, status: r.status, error: r.error ? String(r.error) : undefined });
      return false;
    }
    return r.row.closed_source === true;
  }

  async getCredits(workspaceId: string): Promise<number | null> {
    // Workspace prepaid AI-credit balance — see backend routes/credits.ts.
    // Null on any error: the AI bars simply hide the indicator.
    try {
      const res = await fetch(
        url(`/api/credits?workspaceId=${encodeURIComponent(workspaceId)}`),
        { credentials: 'include' },
      );
      if (!res.ok) {
        trace.error('backend:get-credits', { workspaceId, status: res.status });
        return null;
      }
      const row = (await res.json()) as { balance?: number };
      return typeof row.balance === 'number' ? row.balance : null;
    } catch (err) {
      trace.error('backend:get-credits', err);
      return null;
    }
  }

  async listWorkspaceFonts(workspaceId: string): Promise<WorkspaceFont[]> {
    // Workspace custom-font library — see backend routes/workspaces.ts
    // (GET /:id/fonts). Empty array on any error so the picker just omits
    // the "Workspace fonts" section rather than breaking.
    try {
      const res = await fetch(
        url(`/api/workspaces/${encodeURIComponent(workspaceId)}/fonts`),
        { credentials: 'include' },
      );
      if (!res.ok) {
        trace.error('backend:list-workspace-fonts', { workspaceId, status: res.status });
        return [];
      }
      const body = (await res.json()) as { fonts?: WorkspaceFont[] };
      return Array.isArray(body.fonts) ? body.fonts : [];
    } catch (err) {
      trace.error('backend:list-workspace-fonts', err);
      return [];
    }
  }

  async getWebsiteWorkspaceId(id: string): Promise<string | null> {
    // Null on any error — the caller treats null as "skip the ws param" so
    // the dashboard URL still opens (just without workspace pre-selection).
    // The row is the raw Prisma shape, so the field is snake_case
    // `workspace_id` — NOT `workspaceId` (reading the camelCase name always
    // resolved undefined, silently breaking the workspace deep-link here and
    // in the LeftHeader account menu).
    const r = await this.fetchWebsiteRow(id);
    if (!r.ok) {
      trace.error('backend:get-website-workspace-id', { id, status: r.status, error: r.error ? String(r.error) : undefined });
      return null;
    }
    return typeof r.row.workspace_id === 'string' ? r.row.workspace_id : null;
  }

  async saveProject(id: string, data: ProjectData): Promise<void> {
    // Hono backend (src/routes/websites.ts) Zod-validates `{ name?, json?,
    // baseRevision?, inSync? }` — the full ProjectData rides as a
    // JSON-encoded string in `json`. `baseRevision` is the row revision this
    // tab's copy is based on: a save based on an older one is refused with
    // 409 rather than overwriting newer work (save-revision.ts). A backend
    // that predates revisions strips the extra keys and saves as before.
    const baseRevision = getBaseRevision();
    const body: Record<string, unknown> = { json: JSON.stringify(data) };
    if (baseRevision !== null) {
      body.baseRevision = baseRevision;
      body.inSync = isRevisionInSync();
    }
    // Gzipped once the API has said it reads gzip (save-encoding.ts); a
    // compressed save it refuses is resent plain, and compression stays off.
    const payload = JSON.stringify(body);
    const put = async (allowGzip: boolean) => {
      const encoded = await encodeSaveBody(payload, allowGzip);
      const r = await fetch(url(`/api/websites/${id}`), {
        method: 'PUT',
        headers: encoded.headers,
        credentials: 'include',
        body: encoded.body,
      });
      return { r, gzip: encoded.gzip };
    };
    const first = await put(true);
    let res = first.r;
    if (first.gzip && (res.status === 400 || res.status === 415)) {
      trace.error('backend:save-gzip-refused', { id, status: res.status });
      disableGzipBodies();
      res = (await put(false)).r;
    }
    noteServerEncodings(res);
    if (res.status === 409) {
      const payload = await res.json().catch(() => null) as { error?: { details?: { revision?: number } } } | null;
      const serverRevision = payload?.error?.details?.revision;
      trace.error('backend:save-project-conflict', { id, baseRevision, serverRevision });
      throw new SaveConflictError(typeof serverRevision === 'number' ? serverRevision : null);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      trace.error('backend:save-project', { id, status: res.status, body: text });
      // The API's `{ error: { message } }` is written for a person ("This
      // project is 16.4 MB — too large to save…"); show that, not raw JSON.
      let message = text;
      try { message = (JSON.parse(text) as { error?: { message?: string } })?.error?.message ?? text; } catch { /* not JSON */ }
      throw new Error(`Save failed: ${res.status} ${message}`);
    }
    const saved = await res.json().catch(() => null) as { revision?: number } | null;
    noteSaved(saved?.revision);
    trace.action('backend:save-project', { id, fileCount: Object.keys(data.files).length, revision: saved?.revision });
  }

  async renameWebsite(id: string, name: string): Promise<void> {
    // Partial PUT — sends only `name` so the stored `json` snapshot is left
    // untouched (Prisma `update` only writes provided fields). This is what
    // keeps the dashboard tile's name in sync with the editor chip.
    const res = await fetch(url(`/api/websites/${encodeURIComponent(id)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      trace.error('backend:rename-website', { id, name, status: res.status, body: text });
      throw new Error(`Rename failed: ${res.status} ${text}`);
    }
    this.websiteRows.delete(id);
    trace.action('backend:rename-website', { id, name });
  }

  async getWebsiteName(id: string): Promise<string | null> {
    const r = await this.fetchWebsiteRow(id);
    if (!r.ok) {
      trace.error('backend:get-website-name', { id, status: r.status, error: r.error ? String(r.error) : undefined });
      return null;
    }
    return typeof r.row.name === 'string' ? r.row.name : null;
  }

  async fetchMediaBytes(remoteUrl: string): Promise<Blob> {
    // data:/blob: URLs are same-origin readable — fetch directly, skip the proxy.
    if (/^(data|blob):/i.test(remoteUrl)) {
      const res = await fetch(remoteUrl);
      return res.blob();
    }
    // Everything else goes through the server-side proxy so cross-origin CDN
    // bytes (Pixabay etc.) become readable/decodable in the browser.
    const res = await fetch(url(`/api/media/proxy?url=${encodeURIComponent(remoteUrl)}`), {
      credentials: 'include',
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      trace.error('backend:fetch-media-bytes', { status: res.status, msg: msg.slice(0, 160) });
      throw new Error(`Media proxy failed (${res.status})`);
    }
    trace.action('backend:fetch-media-bytes', { ok: true });
    return res.blob();
  }

  async uploadAsset(id: string, file: File): Promise<string> {
    const form = new FormData();
    form.append('file', file);
    form.append('type', 'image');
    form.append('source', 'uploaded');
    form.append('websiteId', id);

    const res = await fetch(url('/api/upload'), { method: 'POST', body: form, credentials: 'include' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      trace.error('backend:upload-asset', { id, status: res.status, body: text });
      // Surface backend error messages (especially 402 storage-cap rejections)
      // so the UI can show something useful instead of "Upload failed: 402 …".
      let message = `Upload failed: ${res.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed?.error?.message) message = parsed.error.message;
      } catch {
        // not JSON, keep the default
      }
      throw new Error(message);
    }
    const json = await res.json();
    trace.action('backend:upload-asset', { id, url: json.url });
    return json.url as string;
  }

  async deleteAssets(id: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const res = await fetch(url('/api/upload'), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ websiteId: id, keys }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      trace.error('backend:delete-assets', { id, count: keys.length, status: res.status, body: text });
      let message = `Delete failed: ${res.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed?.error?.message) message = parsed.error.message;
      } catch { /* not JSON, keep the default */ }
      throw new Error(message);
    }
    trace.action('backend:delete-assets', { id, count: keys.length });
  }
}

// ─── Per-site collaborators ───────────────────────────────────────────────
//
// Cloud-only feature. The CollaboratorsModal renders a "Sign in to share"
// placeholder in standalone mode, so these helpers throw rather than
// silently no-op — making upstream calls surface real errors during dev.

/** One row in the editor's CollaboratorsModal list. Mirrors
 *  `revyme-cloud/src/backend/types.ts` so the wire shape matches. */
export interface Collaborator {
  /** Real user id when source !== 'pending'. Pending rows synthesise
   *  `invite:<inviteId>` — opaque to the UI, used only as a React key. */
  user_id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  role: 'owner' | 'editor' | 'viewer';
  color: string;
  source: 'owner' | 'workspace' | 'collaborator' | 'pending';
  collaborator_id?: string;
  /** Set on `source === 'pending'`. Target for revoke (DELETE
   *  /api/workspaces/:wsId/invites/:inviteId). */
  invite_id?: string;
  pending?: boolean;
}

export async function listCollaborators(websiteId: string): Promise<Collaborator[]> {
  const res = await fetch(url(`/api/websites/${encodeURIComponent(websiteId)}/collaborators`), {
    credentials: 'include',
  });
  if (!res.ok) {
    trace.error('backend:list-collaborators', { websiteId, status: res.status });
    return [];
  }
  const data = await res.json();
  return data.collaborators ?? [];
}

/** Structured details the backend may attach to a 402 PAYMENT_REQUIRED
 *  when the workspace has no free editor seat. The modal uses these to
 *  render a "Buy seat" CTA pointing at the right workspace (instead of
 *  parsing the message string for the workspace id). */
export interface SeatLimitDetails {
  reason: 'SEAT_LIMIT';
  workspaceId: string | null;
  currentCount: number;
  limit: number;
}

export type CollabActionResult =
  | { ok: true }
  | { ok: false; error: string; code?: string; seatLimit?: SeatLimitDetails };

/** Extract `{ code, message, details }` from a backend error response body.
 *  All routes use the AppError serializer in backend/src/lib/errors.ts, so
 *  the shape is stable: `{ error: { code, message, details? } }`. */
function parseBackendError(
  text: string,
): { code?: string; message?: string; details?: unknown } {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error ?? {};
  } catch {
    return {};
  }
}

function asSeatLimit(details: unknown): SeatLimitDetails | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const d = details as Record<string, unknown>;
  if (d.reason !== 'SEAT_LIMIT') return undefined;
  return {
    reason: 'SEAT_LIMIT',
    workspaceId: typeof d.workspaceId === 'string' ? d.workspaceId : null,
    currentCount: typeof d.currentCount === 'number' ? d.currentCount : 0,
    limit: typeof d.limit === 'number' ? d.limit : 0,
  };
}

export async function inviteCollaborator(
  websiteId: string,
  email: string,
  role: 'editor' | 'viewer' = 'editor',
): Promise<CollabActionResult> {
  const res = await fetch(url(`/api/websites/${encodeURIComponent(websiteId)}/collaborators`), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    trace.error('backend:invite-collaborator', { websiteId, status: res.status, body: text });
    const parsed = parseBackendError(text);
    return {
      ok: false,
      error: parsed.message ?? 'Failed to invite',
      code: parsed.code,
      seatLimit: asSeatLimit(parsed.details),
    };
  }
  trace.action('backend:invite-collaborator', { websiteId, email, role });
  return { ok: true };
}

export async function updateCollaborator(
  websiteId: string,
  userId: string,
  patch: { role?: 'editor' | 'viewer'; color?: string },
): Promise<CollabActionResult> {
  const res = await fetch(url(`/api/websites/${encodeURIComponent(websiteId)}/collaborators`), {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, ...patch }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    trace.error('backend:update-collaborator', { websiteId, status: res.status, body: text });
    const parsed = parseBackendError(text);
    return {
      ok: false,
      error: parsed.message ?? 'Failed to update',
      code: parsed.code,
      seatLimit: asSeatLimit(parsed.details),
    };
  }
  return { ok: true };
}

export async function removeCollaborator(
  websiteId: string,
  userId: string,
): Promise<{ ok: boolean; error?: string }> {
  const qs = `?user_id=${encodeURIComponent(userId)}`;
  const res = await fetch(
    url(`/api/websites/${encodeURIComponent(websiteId)}/collaborators${qs}`),
    { method: 'DELETE', credentials: 'include' },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    trace.error('backend:remove-collaborator', { websiteId, status: res.status, body: text });
    let message = 'Failed to remove';
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error?.message) message = parsed.error.message;
    } catch {
      // not JSON
    }
    return { ok: false, error: message };
  }
  trace.action('backend:remove-collaborator', { websiteId, userId });
  return { ok: true };
}

/**
 * Upload a Preview-overlay thumbnail (JPEG data URL) for a website. The
 * backend stores it in R2 and writes `websites.preview_image`. Replaces the
 * puppeteer screenshot-service — the preview iframe already holds a real
 * render, so we snapshot that client-side instead.
 *
 * Best-effort: callers (usePreviewThumbnail) swallow failures — a missing or
 * stale dashboard thumbnail is cosmetic.
 */
export async function uploadPreviewThumbnail(websiteId: string, dataUrl: string): Promise<string> {
  const res = await fetch(url(`/api/websites/${websiteId}/preview-image`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ dataUrl }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    trace.error('backend:upload-preview-thumbnail', { websiteId, status: res.status, body: text });
    throw new Error(`Preview thumbnail upload failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as { url: string };
  trace.action('backend:upload-preview-thumbnail', { websiteId, url: json.url });
  return json.url;
}

// ─── Template flow (free functions — RevymeBackend interface stays
//     focused on project CRUD; these stand alone) ────────────────────

export interface TemplateShareResult {
  hash: string;
  /** User-facing remix link — `<host>/r/<hash>`. Shareable directly
   *  with friends OR pasteable into the dashboard's Templates submit
   *  form (both flows accept the same URL). */
  share_url: string;
  /** API URL — kept for callers that hit the JSON metadata endpoint
   *  directly (dashboard prefill). */
  api_url: string;
  snapshot_url: string;
  /** Idempotent draft `creator_components` row id. Lets the dashboard
   *  edit-flow find the existing draft by hash on resubmit. */
  draft_id: string;
}

/**
 * Upload the current project snapshot as the canonical draft of a
 * future template submission. Backend deep-copies any user-owned
 * media URLs into the platform bucket, persists the rewritten
 * snapshot, and returns the share URL the dashboard form needs to
 * prefill from.
 *
 * No DB row is created — the share lives in R2 only until the user
 * goes through the dashboard submission flow and approval pipeline.
 */
export async function shareAsTemplate(args: {
  name: string;
  description?: string;
  files: Record<string, string>;
  /** ID of the website this share originates from. Backend looks it
   *  up to discover whether the project was itself a remix — if so,
   *  the new draft row inherits the `parent_template_id` chain and
   *  the original creator's `user_id` is propagated forever. Without
   *  this, lineage is lost after the first re-share. */
  source_website_id?: string;
}): Promise<TemplateShareResult> {
  const res = await fetch(url('/api/templates/share'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    trace.error('template:share-failed', { status: res.status, body: text });
    throw new Error(`Share failed: ${res.status}`);
  }
  const json = (await res.json()) as TemplateShareResult;
  trace.action('template:share', { hash: json.hash });
  return json;
}

/**
 * Move a website into a workspace.
 *
 * The remix flow creates the copy in the user's PERSONAL workspace immediately
 * (the backend's `resolveRemixWorkspace` defaults there when none is given) so
 * the builder can open the real, editable site at once. The workspace question
 * is then asked INSIDE the builder and answered by this call — no second page
 * load, and no read-only preview standing in for the site.
 *
 * Sending the workspace it is already in is a no-op server-side, so the picker
 * can always send its selection.
 */
/**
 * Create a fresh empty website row (`POST /websites`) and return its id.
 * The backend stamps `user_id` ownership, so the builder opens the new site
 * with full edit rights.
 *
 * `workspaceId` is the requested target — pass the CURRENT website's
 * workspace so the new project lands next to the one being edited. The
 * backend validates it (owner/admin/editor member may create there; anyone
 * else falls back to their PERSONAL workspace). `null` = personal
 * explicitly; omit the argument entirely for the dashboard's
 * cookie-resolved default.
 *
 * File → New project MUST go through this: opening `/builder/<random-uuid>`
 * without a backend row leaves the ACL with no membership to resolve, and
 * the builder boots in view-only mode ("you don't have edit access",
 * 2026-08-11) with every save rejected.
 */
export async function createWebsite(name?: string, workspaceId?: string | null): Promise<string> {
  const res = await fetch(url('/api/websites'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: name ?? 'Untitled',
      ...(workspaceId !== undefined ? { workspace_id: workspaceId } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    trace.error('website:create-failed', { status: res.status, body: text });
    throw new Error('Could not create a new project.');
  }
  const created = (await res.json()) as { id: string };
  trace.action('website:created', { websiteId: created.id });
  return created.id;
}

/** "Made in Revyme" badge opt-out — available on every plan. The backend
 *  flips `websites.hide_watermark` AND rewrites the site's PLANS_KV entry,
 *  so a published site (with a post-2026-08-19 worker) updates live without
 *  a republish. */
export async function setWebsiteWatermark(websiteId: string, hideWatermark: boolean): Promise<void> {
  const res = await fetch(url(`/api/websites/${encodeURIComponent(websiteId)}/watermark`), {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hideWatermark }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    trace.error('website:set-watermark-failed', { websiteId, hideWatermark, status: res.status, body: text });
    throw new Error('Could not update the badge setting.');
  }
  trace.action('website:set-watermark', { websiteId, hideWatermark });
}

export async function setWebsiteWorkspace(
  websiteId: string,
  workspaceId: string,
): Promise<void> {
  const res = await fetch(url(`/api/websites/${encodeURIComponent(websiteId)}/workspace`), {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    trace.error('website:set-workspace-failed', { websiteId, workspaceId, status: res.status, body: text });
    let msg = 'Could not move this site to that workspace.';
    try { msg = (JSON.parse(text) as { error?: string }).error || msg; } catch { /* keep default */ }
    throw new Error(msg);
  }
  trace.action('website:set-workspace', { websiteId, workspaceId });
}

/**
 * Remix an approved template — backend creates a new `websites` row
 * owned by the current user, deep-copies template media into the new
 * user's storage path, and returns the new website id. The caller
 * routes to `/builder/<id>` to land on the freshly-cloned project.
 *
 * The new website has `is_remix=true` + `remix_template_id=<id>`
 * stamped permanently for revenue-share queries.
 */
export async function remixTemplate(
  templateId: string,
  workspaceId?: string,
): Promise<{ website_id: string; template_id: string }> {
  const res = await fetch(url(`/api/templates/remix/${encodeURIComponent(templateId)}`), {
    method: 'POST',
    credentials: 'include',
    headers: workspaceId ? { 'Content-Type': 'application/json' } : undefined,
    body: workspaceId ? JSON.stringify({ workspaceId }) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    trace.error('template:remix-failed', { templateId, workspaceId, status: res.status, body: text });
    // Surface the backend's message (e.g. "This is a paid template —
    // purchase it to remix.") instead of a bare status code.
    let msg = `Remix failed: ${res.status}`;
    try {
      const j = JSON.parse(text) as { error?: { message?: string } };
      if (j?.error?.message) msg = j.error.message;
    } catch { /* non-JSON body */ }
    throw new Error(msg);
  }
  const json = (await res.json()) as { website_id: string; template_id: string };
  trace.action('template:remix', json);
  return json;
}

export interface AttachableWorkspace {
  id: string;
  name: string;
  logo: string | null;
  is_personal: boolean;
  role: string;
}

/**
 * Workspaces the current user can attach a remixed website to — owner /
 * admin / editor members only (viewers + per-site guests excluded). The
 * remix workspace picker forces a choice from this list so the new site
 * always lands in a workspace the user's dashboard shows.
 */
export async function listAttachableWorkspaces(): Promise<AttachableWorkspace[]> {
  const res = await fetch(url('/api/workspaces/attachable'), { credentials: 'include' });
  if (!res.ok) {
    trace.error('workspaces:list-attachable-failed', { status: res.status });
    throw new Error(`Failed to load workspaces: ${res.status}`);
  }
  const json = (await res.json()) as { workspaces: AttachableWorkspace[] };
  trace.action('workspaces:list-attachable', { count: json.workspaces?.length ?? 0 });
  return json.workspaces ?? [];
}

/**
 * Remix from a "Create Remix Link" share hash — for the pre-marketplace
 * direct-share flow. Same end result as `remixTemplate(id)` but routes
 * through the share-hash endpoint so authors can hand out remixable
 * links before they're submitted to the marketplace.
 */
export async function remixTemplateShare(
  hash: string,
  workspaceId?: string,
): Promise<{ website_id: string; template_id: string }> {
  const res = await fetch(url(`/api/templates/share/${encodeURIComponent(hash)}/remix`), {
    method: 'POST',
    credentials: 'include',
    headers: workspaceId ? { 'Content-Type': 'application/json' } : undefined,
    body: workspaceId ? JSON.stringify({ workspaceId }) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    trace.error('template:remix-share-failed', { hash, workspaceId, status: res.status, body: text });
    throw new Error(`Remix failed: ${res.status}`);
  }
  const json = (await res.json()) as { website_id: string; template_id: string };
  trace.action('template:remix-share', json);
  return json;
}

/** Marketplace listing row, as returned by the public
 *  `GET /api/templates/approved` endpoint (subset we consume). */
export interface ApprovedTemplate {
  id: string;
  slug: string | null;
  name: string;
  byline: string | null;
  description: string | null;
  category: string | null;
  pricing_type: string;
  price_cents: number | null;
  closed_source: boolean;
  thumbnail_url: string | null;
  preview_url: string | null;
  author: string | null;
  avatar: string | null;
  /** Marketplace detail-page view count — the popularity signal the
   *  fresh-site template prompt ranks by. Always sent by `/approved`. */
  views: number;
  /** Websites ever created from this template (counted from
   *  `websites.remix_template_id`, so it is retroactively complete). */
  remix_count: number;
}

/** The marketplace's canonical free/paid predicate — there is no boolean
 *  column; "paid" means `pricing_type === 'paid'` AND a positive price.
 *  Mirrors `assertPaidTemplateAccess` in the backend and the landing
 *  page's price filter. */
export function isFreeTemplate(t: Pick<ApprovedTemplate, 'pricing_type' | 'price_cents'>): boolean {
  return !(t.pricing_type === 'paid' && (t.price_cents ?? 0) > 0);
}

/**
 * All approved marketplace templates — for the fresh-website "start from
 * a template" prompt. The `/approved` endpoint is public and unfiltered;
 * the caller splits free/paid with `isFreeTemplate` (same client-side
 * split the landing page's marketplace browser does).
 */
export async function listApprovedTemplates(): Promise<ApprovedTemplate[]> {
  const res = await fetch(url('/api/templates/approved'));
  if (!res.ok) {
    trace.error('template:list-approved-failed', { status: res.status });
    throw new Error(`Failed to load templates: ${res.status}`);
  }
  const json = (await res.json()) as { templates: ApprovedTemplate[] };
  trace.action('template:list-approved', { total: json.templates?.length ?? 0 });
  return json.templates ?? [];
}

/**
 * Apply an approved template INTO an existing EMPTY website — the
 * backend deep-copies media and rewrites this website's row in place
 * (stamping `is_remix` + `remix_template_id`), so the builder URL stays
 * `/builder/<websiteId>`. Rejected once the site has any content.
 */
export async function remixTemplateIntoWebsite(
  templateId: string,
  websiteId: string,
): Promise<{ website_id: string; template_id: string }> {
  const res = await fetch(url(`/api/templates/remix/${encodeURIComponent(templateId)}`), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intoWebsiteId: websiteId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    trace.error('template:remix-into-failed', { templateId, websiteId, status: res.status, body: text });
    // Surface the backend's message (paid gate / "already has content")
    // instead of a bare status code — same policy as remixTemplate.
    let msg = `Remix failed: ${res.status}`;
    try {
      const j = JSON.parse(text) as { error?: { message?: string } };
      if (j?.error?.message) msg = j.error.message;
    } catch { /* non-JSON body */ }
    throw new Error(msg);
  }
  const json = (await res.json()) as { website_id: string; template_id: string };
  trace.action('template:remix-into', json);
  return json;
}
