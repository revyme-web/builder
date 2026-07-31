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
import { isKnownProjectFormat } from './types';
import { trace } from '@/shared/debug-trace';

const API_URL = ((import.meta as ImportMeta & { env: Record<string, string> }).env?.VITE_API_URL ?? '').replace(/\/$/, '');

/** Resolve a relative API path against the configured backend base.
 *  Empty base → relative URL (dispatched by Next.js). Non-empty →
 *  absolute URL straight to the Hono backend. */
function url(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return API_URL ? `${API_URL}${p}` : p;
}

export class RevymeBackend implements ProjectBackend {
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
      if (!res.ok) {
        trace.error('backend:load-project', { id, status: res.status });
        return null;
      }
      const row = await res.json() as { id: string; name: string; json: string };
      let data: Partial<ProjectData> | null = null;
      try {
        data = row.json ? JSON.parse(row.json) as Partial<ProjectData> : null;
      } catch (err) {
        trace.error('backend:load-project-parse', { id, error: String(err) });
        return null;
      }
      if (!data || !isKnownProjectFormat(data.format)) {
        // Empty project (newly-created website) — return null so the
        // ProjectLoader seeds the empty starter.
        trace.action('backend:load-project', { id, result: 'no-snapshot', format: data?.format });
        return null;
      }
      trace.action('backend:load-project', { id, fileCount: Object.keys(data.files ?? {}).length });
      return data as ProjectData;
    } catch (err) {
      trace.error('backend:load-project', err);
      return null;
    }
  }

  async getWebsiteRole(id: string): Promise<'owner' | 'editor' | 'viewer'> {
    // The website GET endpoint returns the caller's effective role on
    // the site (`_role`). Falling back to 'viewer' is the conservative
    // choice on any error — the worst case is the user can't edit (a
    // toast surfaces the underlying problem) rather than letting writes
    // through without authorization.
    try {
      const res = await fetch(url(`/api/websites/${encodeURIComponent(id)}`), {
        credentials: 'include',
      });
      if (!res.ok) {
        trace.error('backend:get-website-role', { id, status: res.status });
        return 'viewer';
      }
      const row = (await res.json()) as { _role?: 'owner' | 'editor' | 'viewer' };
      return row._role ?? 'viewer';
    } catch (err) {
      trace.error('backend:get-website-role', err);
      return 'viewer';
    }
  }

  async getWebsiteClosedSource(id: string): Promise<boolean> {
    // Same website GET as getWebsiteRole — `closed_source` is stamped onto
    // remixed websites created from a closed-source template. Defaulting to
    // FALSE on error is deliberate: worst case the code panel shows (the
    // template author's protection degrades gracefully) rather than locking
    // a legitimate owner out of their own code.
    try {
      const res = await fetch(url(`/api/websites/${encodeURIComponent(id)}`), {
        credentials: 'include',
      });
      if (!res.ok) {
        trace.error('backend:get-website-closed-source', { id, status: res.status });
        return false;
      }
      const row = (await res.json()) as { closed_source?: boolean };
      return row.closed_source === true;
    } catch (err) {
      trace.error('backend:get-website-closed-source', err);
      return false;
    }
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
    // Same endpoint + same shape as getWebsiteRole, different field. We
    // could collapse both into a single getWebsiteDetails() call, but
    // the two callers fire at very different times (getWebsiteRole on
    // load, getWebsiteWorkspaceId on a menu click) and keeping them
    // independent avoids coupling the menu's click latency to the
    // critical-path role check on initial render. Returns null on any
    // error — caller treats null as "skip the ws param" so the
    // dashboard URL still opens (just without workspace pre-selection).
    try {
      const res = await fetch(url(`/api/websites/${encodeURIComponent(id)}`), {
        credentials: 'include',
      });
      if (!res.ok) {
        trace.error('backend:get-website-workspace-id', { id, status: res.status });
        return null;
      }
      // The website GET returns the raw Prisma row spread into the
      // response, so the field is snake_case `workspace_id` — NOT
      // `workspaceId`. (Reading the camelCase name was a latent bug:
      // it always resolved undefined → null, silently breaking the
      // workspace deep-link here and in the LeftHeader account menu.)
      const row = (await res.json()) as { workspace_id?: string | null };
      return typeof row.workspace_id === 'string' ? row.workspace_id : null;
    } catch (err) {
      trace.error('backend:get-website-workspace-id', err);
      return null;
    }
  }

  async saveProject(id: string, data: ProjectData): Promise<void> {
    // Hono backend (src/routes/websites.ts) Zod-validates `{ name?, json? }`.
    // Anything else in the body is silently dropped — and if neither is
    // present it throws "Nothing to update". Earlier this sent the
    // legacy Next.js shape `{ data, sourceWebsiteId }`, both of which
    // got dropped, hitting the 400. The full ProjectData is passed as
    // a JSON-encoded string in `json`.
    const res = await fetch(url(`/api/websites/${id}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ json: JSON.stringify(data) }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      trace.error('backend:save-project', { id, status: res.status, body: text });
      throw new Error(`Save failed: ${res.status} ${text}`);
    }
    trace.action('backend:save-project', { id, fileCount: Object.keys(data.files).length });
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
    trace.action('backend:rename-website', { id, name });
  }

  async getWebsiteName(id: string): Promise<string | null> {
    try {
      const res = await fetch(url(`/api/websites/${encodeURIComponent(id)}`), {
        credentials: 'include',
      });
      if (!res.ok) {
        trace.error('backend:get-website-name', { id, status: res.status });
        return null;
      }
      const row = (await res.json()) as { name?: string | null };
      return typeof row.name === 'string' ? row.name : null;
    } catch (err) {
      trace.error('backend:get-website-name', err);
      return null;
    }
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
