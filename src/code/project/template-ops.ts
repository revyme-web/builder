// template-ops.ts — Templates as a first-class entity (standard).
//
// A "template" is a Next.js route group whose folder contains its own
// `LayoutClient.tsx` (and `layout.tsx` re-exporting it). Pages opt-in by
// living inside that route group's folder, exactly like Next's nested
// layouts but driven by an explicit picker UI instead of folder
// conventions.
//
// The mechanics are entirely existing primitives:
//   - `createRouteGroup(name)` builds the `app/(name)/{layout,LayoutClient}.tsx` pair
//   - `movePageFile(old, new)` is how a page's template assignment changes
//   - `getLayoutForPage(filePath)` already walks parents to find a layout
//
// What this module adds is the SEMANTIC layer: which route groups count
// as templates (those with a LayoutClient — organizational route groups
// that have only pages don't), and the page→template lookup/mutation API.
//
// Pages with NO template land at `app/<slug>/page.tsx` and resolve to
// `app/layout.tsx` only — which (post Phase-1 strip) is a bare
// `<html><body>{children}</body></html>` shell. So "no template" really
// means "no chrome", matching the reference's behaviour.

import { projectFS } from './project-fs';
import {
  createRouteGroup as createRouteGroupRaw,
  getRouteGroup,
  movePageFile,
} from './active-file-store';
import { trace } from '@/shared/debug-trace';

export interface Template {
  /** Route-group name without parens (e.g. `marketing`). */
  name: string;
  /** `app/(name)/LayoutClient.tsx` — the file the user actually edits. */
  clientPath: string;
  /** `app/(name)/layout.tsx` — server shell that re-exports LayoutClient. */
  layoutPath: string;
}

// ─── Read API ───────────────────────────────────────────────────────────────

/**
 * List every template in the project. A template is a route group whose
 * folder has a `LayoutClient.tsx`. Route groups without one are treated as
 * pure organisational folders and excluded.
 */
export function listTemplates(): Template[] {
  const seen = new Set<string>();
  const templates: Template[] = [];
  for (const file of projectFS.listFiles('app/')) {
    const group = getRouteGroup(file);
    if (!group || seen.has(group)) continue;
    const clientPath = `app/(${group})/LayoutClient.tsx`;
    if (!projectFS.exists(clientPath)) continue;
    seen.add(group);
    templates.push({
      name: group,
      clientPath,
      layoutPath: `app/(${group})/layout.tsx`,
    });
  }
  templates.sort((a, b) => a.name.localeCompare(b.name));
  return templates;
}

/**
 * Read the template a page is currently assigned to.
 * Returns the route-group name, or null when the page lives outside any
 * group (= no template, renders against the bare root shell).
 *
 * Note: returns the group name even for organisational route groups (those
 * without a LayoutClient). Callers that need to distinguish should
 * cross-check via `listTemplates()` or `templateExists(name)`.
 */
export function getPageTemplate(pageFilePath: string): string | null {
  return getRouteGroup(pageFilePath);
}

/** True when a route group with a LayoutClient.tsx exists for this name. */
export function templateExists(name: string): boolean {
  return projectFS.exists(`app/(${name})/LayoutClient.tsx`);
}

// ─── Path manipulation ──────────────────────────────────────────────────────

/**
 * Compute the destination page path when moving a page in or out of a
 * template's route group. Pure — no FS writes.
 *
 *   pagePathForTemplate('app/about/page.tsx', 'marketing')
 *     → 'app/(marketing)/about/page.tsx'
 *
 *   pagePathForTemplate('app/(marketing)/about/page.tsx', null)
 *     → 'app/about/page.tsx'
 *
 *   pagePathForTemplate('app/(blog)/post/page.tsx', 'marketing')
 *     → 'app/(marketing)/post/page.tsx'   // strips old group, inserts new
 *
 * Home page lives at `app/page.tsx` or `app/(group)/page.tsx` — the same
 * rule applies, the slug part is just empty.
 */
export function pagePathForTemplate(pageFilePath: string, templateName: string | null): string {
  // Strip current route group if any: `app/(g)/x/page.tsx` → `app/x/page.tsx`.
  const stripped = pageFilePath.replace(/^app\/\([^)]+\)\//, 'app/');
  if (!templateName) return stripped;
  // Insert new group after `app/`. The substring after `app/` is the slug
  // path (could be `page.tsx` for the home of the group).
  const after = stripped.slice('app/'.length);
  return `app/(${templateName})/${after}`;
}

// ─── Write API ──────────────────────────────────────────────────────────────

/**
 * Move a page in or out of a template's route group. Returns the new path
 * (or the old one if no move was needed / the move was blocked).
 *
 * Blocked when the destination already exists — the caller can surface a
 * conflict toast. We deliberately don't auto-rename to avoid clobbering an
 * unrelated page.
 *
 * Triggers `projectFS.moveFile` which notifies subscribers; downstream
 * atoms (page tree, active file path) re-derive on the next read.
 */
export function assignTemplate(pageFilePath: string, templateName: string | null): string {
  const newPath = pagePathForTemplate(pageFilePath, templateName);
  if (newPath === pageFilePath) {
    trace.fn('template-ops:assign-noop', { pageFilePath, templateName });
    return pageFilePath;
  }
  if (projectFS.exists(newPath)) {
    trace.error('template-ops:assign-conflict', { from: pageFilePath, to: newPath });
    return pageFilePath;
  }
  trace.action('template-ops:assign', { from: pageFilePath, to: newPath, templateName });
  movePageFile(pageFilePath, newPath);
  return newPath;
}

/**
 * Create a new template. Wraps `createRouteGroup(name, withLayout=true)`
 * but rejects names that already exist or aren't safe folder identifiers.
 * Returns the template's clientPath (the file the user edits).
 */
export function createTemplate(name: string): string | null {
  const clean = sanitizeTemplateName(name);
  if (!clean) {
    trace.error('template-ops:create-invalid-name', { name });
    return null;
  }
  if (templateExists(clean)) {
    trace.error('template-ops:create-exists', { name: clean });
    return null;
  }
  createRouteGroupRaw(clean, true);
  trace.action('template-ops:create', { name: clean });
  return `app/(${clean})/LayoutClient.tsx`;
}

/**
 * Create the template `name` (if it doesn't exist yet) and move every page in
 * `pageFilePaths` into its route group, so the template's chrome applies to
 * them — Next.js resolves a layout by folder nesting, and route groups are
 * URL-invisible so the pages' routes don't change. This is the "make a
 * template from shared header/footer and apply it across the site" operation;
 * the MCP `create_template` bridge action is a thin wrapper around it.
 *
 * - Pages already inside this template are skipped (idempotent — re-running
 *   with the same args performs zero moves).
 * - A move blocked by a destination clash (assignTemplate's conflict guard) is
 *   omitted from `moved`; it never clobbers an existing page.
 *
 * Returns the LayoutClient path (the template file the caller then authors with
 * the shared chrome) + the moves actually performed. Throws on an invalid name.
 */
export function applyTemplate(
  name: string,
  pageFilePaths: string[],
): { layoutClient: string; moved: { from: string; to: string }[] } {
  const clean = sanitizeTemplateName(name);
  if (!clean) {
    throw new Error(`Invalid template name "${name}" — use letters, digits, dash or underscore (e.g. "site").`);
  }
  if (!templateExists(clean)) createRouteGroupRaw(clean, true);
  const layoutClient = `app/(${clean})/LayoutClient.tsx`;

  const moved: { from: string; to: string }[] = [];
  for (const from of pageFilePaths) {
    if (getRouteGroup(from) === clean) continue; // already inside this template
    const to = assignTemplate(from, clean);
    if (to !== from) moved.push({ from, to });
  }
  trace.action('template-ops:apply', { name: clean, layoutClient, movedCount: moved.length });
  return { layoutClient, moved };
}

/**
 * Rename a template. Moves the route-group folder by rewriting every file
 * path under it — there's no `renameDir` on ProjectFS, so we list+move
 * one file at a time.
 *
 * Blocked when the destination name already exists.
 */
export function renameTemplate(oldName: string, newName: string): boolean {
  const clean = sanitizeTemplateName(newName);
  if (!clean) {
    trace.error('template-ops:rename-invalid-name', { oldName, newName });
    return false;
  }
  if (clean === oldName) return true;
  if (templateExists(clean)) {
    trace.error('template-ops:rename-conflict', { oldName, newName: clean });
    return false;
  }
  const oldDir = `app/(${oldName})/`;
  const newDir = `app/(${clean})/`;
  const files = projectFS.listFiles(oldDir);
  for (const file of files) {
    const dest = newDir + file.slice(oldDir.length);
    projectFS.moveFile(file, dest);
  }
  trace.action('template-ops:rename', { oldName, newName: clean, fileCount: files.length });
  return true;
}

/**
 * Delete a template. Pages inside the group are first moved out to
 * `app/<slug>/page.tsx` (= unassigned), then the group's layout files
 * are removed. So deleting a template never deletes user pages.
 */
export function deleteTemplate(name: string): void {
  const dir = `app/(${name})/`;
  const filesInGroup = projectFS.listFiles(dir);

  // Move pages out first so they survive the delete.
  for (const file of filesInGroup) {
    if (!file.endsWith('page.tsx')) continue;
    const dest = file.replace(`/(${name})/`, '/');
    if (!projectFS.exists(dest)) {
      projectFS.moveFile(file, dest);
    } else {
      // Conflict: a page with the same slug already exists outside the
      // group. Drop the templated copy — it would overwrite real work.
      // The caller can re-assign it manually if needed.
      projectFS.deleteFile(file);
      trace.error('template-ops:delete-page-conflict', { from: file, to: dest });
    }
  }

  // Remove anything left in the group folder (the layout files).
  for (const file of projectFS.listFiles(dir)) {
    projectFS.deleteFile(file);
  }
  trace.action('template-ops:delete', { name });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Strip whitespace + reject characters that aren't valid in a route-group
 * folder name. Letters, digits, dash, underscore — plain enough that the
 * resulting `(name)` reads cleanly in a file tree.
 */
function sanitizeTemplateName(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return '';
  return trimmed;
}
