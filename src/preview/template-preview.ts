// template-preview.ts — Shared helpers for previewing a Template.
//
// A Template is a route-group `LayoutClient.tsx` with NO page of its own, so it
// has no URL to preview — navigating to it directly 404s (`/LayoutClient.tsx`).
// We inject a synthetic placeholder page into each template's route group so the
// layout renders around a "page content" placeholder, mirroring the canvas.
//
// Pure module — NO project/FS/jotai imports — so both the parent editor
// (PreviewOverlay / ServerPreview) and the isolated preview-sandbox bundle can
// import it without pulling in heavy dependencies.

/** Group name when `path` is a template's layout file, else null.
 *  e.g. `app/(marketing)/LayoutClient.tsx` → `marketing`. */
export function templateGroupFromLayoutFile(path: string | null | undefined): string | null {
  const m = path?.match(/^app\/\(([^)]+)\)\/(?:LayoutClient|layout)\.tsx$/);
  return m ? m[1] : null;
}

/** The synthetic placeholder route used to preview a template. It lives INSIDE
 *  the template's route group so the group layout (LayoutClient) wraps it; the
 *  segment embeds the group name so multiple templates don't collide at the
 *  same URL (route groups are URL-invisible). */
export function templatePreviewRoute(group: string): { dir: string; url: string } {
  return { dir: `app/(${group})/__template_preview/${group}`, url: `/__template_preview/${group}` };
}

const PLACEHOLDER_PAGE = `export default function TemplatePreviewPlaceholder() {
  return (
    <div style={{
      flex: 1, minHeight: '50vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 8,
      color: '#8a8f98', fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Placeholder</div>
      <div style={{ fontSize: 13, opacity: 0.7 }}>Your page content will appear here.</div>
    </div>
  );
}
`;

/** Placeholder page files to inject for every template found in `filePaths`.
 *  Emits BOTH halves of the page pair: `page.tsx` (the real Next.js preview
 *  server routes against this) and `page.client.tsx` (the in-browser sandbox
 *  router routes against the client half — see preview-sandbox/router.ts). */
export function templatePreviewPages(filePaths: Iterable<string>): Array<{ file: string; content: string }> {
  const groups = new Set<string>();
  for (const fp of filePaths) {
    const m = fp.match(/^app\/\(([^)]+)\)\/LayoutClient\.tsx$/);
    if (m) groups.add(m[1]);
  }
  const out: Array<{ file: string; content: string }> = [];
  for (const group of groups) {
    const { dir } = templatePreviewRoute(group);
    out.push({ file: `${dir}/page.tsx`, content: PLACEHOLDER_PAGE });
    out.push({ file: `${dir}/page.client.tsx`, content: PLACEHOLDER_PAGE });
  }
  return out;
}
