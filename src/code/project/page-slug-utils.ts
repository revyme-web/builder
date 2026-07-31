// page-slug-utils.ts — settings-URL page-slug form (`?settings=pages:<slug>`).
//
// Distinct from active-file-store's `filePathToSlug` (route slug — DROPS the
// trailing `page` segment): this form KEEPS it, encoding an exact file path
// (`app/about/page.client.tsx` ⇄ `about/page.client`). Used by the Settings
// overlay's URL param parser and the Pages/SEO section. Lives in core (not
// src/cloud/) because SettingsOverlay is core chrome and must not import
// from cloud modules.

/** Convert `app/about/page.client.tsx` → `about/page.client` (settings URL form). */
export function pageFilePathToSlug(filePath: string): string {
  return filePath.replace(/^app\//, '').replace(/\.tsx$/, '');
}

/** Convert `about/page.client` → `app/about/page.client.tsx`. */
export function pageSlugToFilePath(slug: string): string {
  return `app/${slug}.tsx`;
}
