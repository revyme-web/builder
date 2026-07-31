// types.ts — Shared types for the backend adapter layer.

/** Current tag written by every save. */
export const PROJECT_FORMAT = 'revyme-v1' as const;

/**
 * Tags accepted on READ. `canvas-poc-v1` is the pre-rename tag: the stored
 * data was migrated in place, but keep reading it so any blob that predates
 * the migration — an old export, a hand-restored backup — still hydrates
 * instead of silently loading as an empty project.
 */
export type ProjectFormat = 'revyme-v1' | 'canvas-poc-v1';

export function isKnownProjectFormat(value: unknown): value is ProjectFormat {
  return value === 'revyme-v1' || value === 'canvas-poc-v1';
}

export interface ProjectData {
  format: ProjectFormat;
  files: Record<string, string>;  // ProjectFS snapshot: { filePath: fileContent }
  settings?: {
    fonts?: string[];
    pages?: string[];
    // Website metadata (synced from layout.tsx for cloud features like domain, publish)
    websiteName?: string;
    websiteDescription?: string;
    faviconUrl?: string;
    socialShareUrl?: string;
  };
}

/** A custom font in the workspace library (shared across the workspace's
 *  projects). Mirrors the backend manifest entry; `url` is the public CDN
 *  url of the font file. The font picker groups these by `family`. */
export interface WorkspaceFont {
  id: string;
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  ext: 'woff2' | 'woff' | 'otf' | 'ttf';
  fileName: string;
  size: number;
  url: string;
  uploadedAt: string;
  uploadedBy: string;
}

export interface RevymeUser {
  id: string;
  name: string;
  email: string;
  image?: string;
  /** Mirrors the server `role === 'admin'` (email allowlist). Surfaced so the
   *  editor can show admin-only affordances (e.g. the 3D-assets media tab).
   *  The server still gates /api/admin/* — this is purely UI state. */
  isAdmin?: boolean;
}

type WebsiteRole = 'owner' | 'editor' | 'viewer';

export interface ProjectBackend {
  /** Get the currently authenticated user. Returns null if not authenticated. */
  getUser(): Promise<RevymeUser | null>;

  /** Load a project by ID. Returns null if not found or wrong format. */
  loadProject(id: string): Promise<ProjectData | null>;

  /** Save the full project snapshot. */
  saveProject(id: string, data: ProjectData): Promise<void>;

  /** Update the website's canonical name (`websites.name`) — the value the
   *  dashboard tile shows. Called when the user renames the project from the
   *  in-editor chip so the editor and dashboard stay in sync. */
  renameWebsite(id: string, name: string): Promise<void>;

  /** The website's canonical name from the backend, or null if unavailable
   *  (standalone/local mode, or fetch failed). Used to seed the project chip
   *  on load so a rename done in the dashboard shows up in the editor. */
  getWebsiteName(id: string): Promise<string | null>;

  /** Upload an asset file. Returns the CDN/object URL. */
  uploadAsset(id: string, file: File): Promise<string>;

  /** Delete uploaded assets by their R2 object keys (bulk-capable — the
   *  Media panel's multi-select delete). Cloud-only: the standalone impl
   *  is a no-op (its object/data URLs have no server object to remove). */
  deleteAssets(id: string, keys: string[]): Promise<void>;

  /** Fetch a remote media asset's bytes via the server-side proxy
   *  (`/api/media/proxy`). A server-to-server fetch isn't subject to CORS, so
   *  the returned Blob can be drawn to a <canvas> and read back (frame
   *  extraction) — impossible via a direct cross-origin fetch of a CDN like
   *  Pixabay. `data:`/`blob:` URLs are read directly (already same-origin). */
  fetchMediaBytes(url: string): Promise<Blob>;

  /** The caller's effective role on this website. Cloud impl reads
   *  the merged workspace+per-site role from the backend; local impl
   *  always returns 'owner' (single-user localStorage projects). The
   *  editor calls this on load to flip into view-only mode when the
   *  user is a viewer (disables writes + dims interactive UI). */
  getWebsiteRole(id: string): Promise<WebsiteRole>;

  /** Whether this website's CODE is hidden — true only for websites remixed
   *  from a CLOSED-SOURCE template (stamped onto the `websites` row at remix
   *  time). The editor hides the code panel + code popup when true. Local
   *  impl always returns false. */
  getWebsiteClosedSource(id: string): Promise<boolean>;

  /** The workspace id that owns this website. Cloud impl reads
   *  `workspaceId` from the website GET response; local impl returns
   *  null (localStorage projects don't belong to any workspace). Used
   *  by the LeftHeader's "Your Account" menu item to build the
   *  workspace-scoped dashboard URL (`/dashboard?ws=<id>&view=…`). */
  getWebsiteWorkspaceId(id: string): Promise<string | null>;

  /** Prepaid AI-credit balance for the given workspace, or null when
   *  unavailable (standalone/local mode, or the caller can't read it).
   *  The AI chat bars surface this so the user sees their balance. */
  getCredits(workspaceId: string): Promise<number | null>;

  /** Custom fonts uploaded to the workspace library. Available to every
   *  project in the workspace; surfaced in the font picker under a
   *  "Workspace fonts" section. Local impl returns [] (no workspace). */
  listWorkspaceFonts(workspaceId: string): Promise<WorkspaceFont[]>;
}

/** Lightweight publish metadata for the Live dropdown — publish state,
 *  subdomain, and timestamps. Used by `LiveDropdown.tsx`. Mirror of the
 *  same shape in revyme-cloud's types.ts. */
export interface WebsiteMeta {
  isPublished: boolean;
  publishedAt: string | null;
  subdomain: string | null;
  customSubdomain?: string | null;
  customDomain?: string | null;
  /** Snapshot currently deployed live. NULL when the site has never been
   *  published. The LiveDropdown shows "Live from backup · <date>" when
   *  this points to a snapshot that isn't the latest row for the site. */
  liveSnapshotId?: string | null;
  liveSnapshotCreatedAt?: string | null;
  /** Most recent snapshot for the site. When `liveSnapshotId !==
   *  latestSnapshotId`, the live deploy is FROM a backup. */
  latestSnapshotId?: string | null;
  /** Site plan ('free' | 'lite' | 'pro' | 'studio') — surfaced so the
   *  Export dropdown can decide whether to offer Pro-tier export
   *  formats (Tailwind, etc.) or show the upgrade nudge instead. */
  plan?: string | null;
  /** Stripe subscription status. Used in tandem with `plan` — a paid
   *  plan with `status !== 'active'` (past_due, canceled) reverts to
   *  free-tier feature gating. */
  planStatus?: string | null;
}
