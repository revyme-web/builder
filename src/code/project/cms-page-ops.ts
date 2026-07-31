// cms-page-ops.ts — Create CMS-backed page files (Index + Detail).
//
// Both flavours emit a SERVER + CLIENT pair — the same shape `createPageFile`
// produces for hand-made pages — so every page-pair helper (PageSelector,
// delete/move, layout resolution, duplicate-detection) resolves them. The
// server `page.tsx` is a thin wrapper that owns the `metadata` export and
// re-exports the canvas-editable client body (`page.client.tsx`).
//
//   1. **Index** — `app/{slug}/page.{tsx,client.tsx}`. A normal page pair
//      hosting a `.map()` repeater over the whole collection. Renders an
//      aggregate list (e.g. "all Articles").
//
//   2. **Detail** — `app/{slug}/[slug]/page.{tsx,client.tsx}`. Next.js
//      dynamic route. The client body is a TEMPLATE rendered ONCE, with
//      bindings to `item.field` — Next.js fills the `[slug]` segment and
//      the page's `useParams()` + `.find()` resolves to the matching item
//      at runtime. The client file carries a
//      `/** @cmsPage { collection, kind: 'detail' } */` annotation so the
//      editor knows to enable detail-page UI (preview-slug navigator etc.).
//
// Both client files use the same canvas-config block so viewport positions
// stay consistent with hand-created pages.

import { projectFS } from './project-fs';
import { uniqueRouteSlug, slugToFilePath } from './active-file-store';
import { getCollectionSchema } from './cms-ops';
import type { CollectionSchema, FieldDefinition } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

// ─── Field selection ────────────────────────────────────────────────────────

/**
 * Pick the first text-shaped field from a schema for the default heading
 * binding. Falls back to `_slug` (always present on every item) when the
 * schema has no text fields.
 */
function firstTextField(schema: CollectionSchema | null): string {
  if (!schema) return '_slug';
  const text = schema.fields.find(f =>
    f.type === 'text' || f.type === 'textarea' || f.type === 'richtext' || f.type === 'slug',
  );
  return text?.id ?? '_slug';
}

/**
 * Pick the first body-shaped field — anything text-y that isn't the heading.
 * Falls back to a placeholder field name; the page renders an empty string
 * if the field isn't present at runtime.
 */
function firstBodyField(schema: CollectionSchema | null, headingField: string): string | null {
  if (!schema) return null;
  const text = schema.fields.find(f =>
    (f.type === 'text' || f.type === 'textarea' || f.type === 'richtext') && f.id !== headingField,
  );
  return text?.id ?? null;
}

// ─── Field → JSX renderers ─────────────────────────────────────────────────
// Each scope (`detail` / `card`) gets its own size + style profile so the
// generated page looks balanced without the user having to retouch every
// field. Card variants are smaller and tighter — they live inside a flex
// list. Detail variants are article-sized — they live inside a centered
// 720px reading column.

type RenderScope = 'detail' | 'card';

/**
 * A safe JS accessor for a field id: `item.foo` when the id is a valid
 * identifier, `item['foo-bar']` otherwise. New field ids are always
 * camelCase identifiers, but older collections may carry hyphenated ids
 * (e.g. `cover-image`) where `item.cover-image` is a syntax error.
 */
function itemAccess(itemVar: string, fieldId: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(fieldId)
    ? `${itemVar}.${fieldId}`
    : `${itemVar}[${JSON.stringify(fieldId)}]`;
}

/**
 * Generate JSX for a single field bound to `item.fieldId`. Returns null when
 * the field type is unsupported in the chosen scope (e.g. references) — the
 * caller skips it. Indentation is meant to be inserted under a flex parent
 * with a 4-space indent already applied to the line.
 */
function renderFieldJsx(
  field: FieldDefinition,
  itemVar: string,
  scope: RenderScope,
  isHeading: boolean,
  isBody: boolean,
): string | null {
  const id = `field-${field.id}`;
  const access = itemAccess(itemVar, field.id);

  switch (field.type) {
    case 'image':
    case 'file': {
      // Image is the primary visual anchor for the row — render at the top.
      // Width 100% lets it scale with the layout column; objectFit:cover
      // keeps consistent aspect across mismatched source images.
      const height = scope === 'detail' ? '400px' : '180px';
      const radius = scope === 'detail' ? '12px' : '8px';
      return `      <img data-id="${id}" data-name="${field.name}" src={${access}} alt="" style={{
        width: '100%', height: '${height}',
        objectFit: 'cover', borderRadius: '${radius}',
        display: 'block'
      }} />`;
    }
    case 'text':
    case 'slug': {
      // Heading vs sub-text: distinct sizes so the visual hierarchy reads.
      // Detail-page heading is the page title; card heading is a title row.
      const fontSize = isHeading
        ? (scope === 'detail' ? '48px' : '20px')
        : (scope === 'detail' ? '16px' : '14px');
      const weight = isHeading ? '700' : '500';
      const color = isHeading ? '#0f172a' : '#475569';
      return `      <p data-id="${id}" data-name="${field.name}" style={{
        position: 'relative',
        fontSize: '${fontSize}', fontWeight: '${weight}', color: '${color}',
        fontFamily: 'Inter, sans-serif',
        margin: 0
      }}>{${access}}</p>`;
    }
    case 'textarea':
    case 'richtext': {
      // Body copy: comfortable reading column width on detail pages, no
      // explicit width on cards (flex parent constrains it).
      const fontSize = scope === 'detail' ? '16px' : '14px';
      const lineHeight = isBody ? '1.7' : '1.5';
      const maxWidth = scope === 'detail' ? `, maxWidth: '720px'` : '';
      return `      <p data-id="${id}" data-name="${field.name}" style={{
        position: 'relative',
        fontSize: '${fontSize}', color: '#475569', lineHeight: '${lineHeight}',
        fontFamily: 'Inter, sans-serif',
        margin: 0${maxWidth}
      }}>{${access}}</p>`;
    }
    case 'number':
    case 'date': {
      return `      <p data-id="${id}" data-name="${field.name}" style={{
        position: 'relative',
        fontSize: '14px', color: '#64748b',
        fontFamily: 'Inter, sans-serif',
        margin: 0
      }}>{${access}}</p>`;
    }
    case 'boolean': {
      // Boolean → string label; the user can edit the renderer afterwards.
      // Skip on cards to avoid clutter.
      if (scope === 'card') return null;
      return `      <p data-id="${id}" data-name="${field.name}" style={{
        position: 'relative',
        fontSize: '12px', color: '#64748b',
        fontFamily: 'Inter, sans-serif',
        margin: 0
      }}>{${access} ? '${field.name}: Yes' : '${field.name}: No'}</p>`;
    }
    case 'enum': {
      // Render as a small pill — distinguishes category/status fields from
      // body text without the user having to restyle.
      return `      <span data-id="${id}" data-name="${field.name}" style={{
        position: 'relative',
        fontSize: '11px', fontWeight: '600', color: '#3b82f6',
        backgroundColor: '#eff6ff',
        padding: '4px 10px', borderRadius: '999px',
        fontFamily: 'Inter, sans-serif',
        alignSelf: 'flex-start',
        textTransform: 'uppercase', letterSpacing: '0.04em'
      }}>{${access}}</span>`;
    }
    case 'tags': {
      // Comma-joined display — primitive but valid for any string[]; user can
      // refactor into a .map() pill list afterwards.
      return `      <p data-id="${id}" data-name="${field.name}" style={{
        position: 'relative',
        fontSize: '12px', color: '#64748b',
        fontFamily: 'Inter, sans-serif',
        margin: 0
      }}>{Array.isArray(${access}) ? ${access}.join(', ') : ''}</p>`;
    }
    case 'link':
    case 'url': {
      // Render as visible link so the user can see the binding worked. They
      // can swap the label text afterwards via .map() / static.
      return `      <a data-id="${id}" data-name="${field.name}" href={${access}} style={{
        position: 'relative',
        fontSize: '14px', color: '#3b82f6',
        fontFamily: 'Inter, sans-serif',
        textDecoration: 'none',
        margin: 0
      }}>{${field.name === 'LinkedIn' || field.name === 'Twitter' || field.name === 'GitHub' ? `'${field.name}'` : access}}</a>`;
    }
    case 'color': {
      // Color is a swatch, not display copy. Render a small chip.
      return `      <div data-id="${id}" data-name="${field.name}" style={{
        position: 'relative',
        width: '24px', height: '24px',
        borderRadius: '6px',
        backgroundColor: ${access},
        border: '1px solid #e2e8f0'
      }} />`;
    }
    // reference / multi-reference are intentionally omitted — they need a
    // join + nested map which is too much to scaffold; the user can add
    // them via the CMS binding menu after the page exists.
    default:
      return null;
  }
}

/**
 * Generate JSX for ALL fields in a schema, in declaration order.
 * `headingFieldId` and `bodyFieldId` flag which text fields receive the
 * upgraded title/body styling (vs being rendered as plain rows).
 */
function renderAllFields(
  schema: CollectionSchema | null,
  itemVar: string,
  scope: RenderScope,
  headingFieldId: string,
  bodyFieldId: string | null,
): string {
  if (!schema) return '';
  const blocks: string[] = [];
  // Image fields first — visual anchor at the top.
  // Then heading. Then everything else in schema order.
  const ordered = [...schema.fields].sort((a, b) => {
    const aImage = a.type === 'image' || a.type === 'file';
    const bImage = b.type === 'image' || b.type === 'file';
    if (aImage && !bImage) return -1;
    if (!aImage && bImage) return 1;
    if (a.id === headingFieldId && b.id !== headingFieldId) return -1;
    if (b.id === headingFieldId && a.id !== headingFieldId) return 1;
    return 0;
  });
  for (const field of ordered) {
    const isHeading = field.id === headingFieldId;
    const isBody = field.id === bodyFieldId;
    const jsx = renderFieldJsx(field, itemVar, scope, isHeading, isBody);
    // Every in-flow child needs a sequential quoted `order` + no-shrink flex
    // (FLEX_CHILD_MISSING_ORDER / FLEX_CHILD_SHRINKS) — the builder's own
    // scaffolds must pass its own oracle gate on a no-op resubmit.
    if (jsx) blocks.push(jsx.replace('style={{', `style={{
        order: '${blocks.length}', flex: '0 0 auto',`));
  }
  return blocks.join('\n');
}

// ─── Canvas config block (shared) ──────────────────────────────────────────

const CANVAS_CONFIG_BLOCK = `/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 },
    { "id": "tablet", "label": "Tablet", "width": 768, "isPrimary": false, "order": 1 },
    { "id": "mobile", "label": "Mobile", "width": 375, "isPrimary": false, "order": 2 }
  ],
  "positions": {
    "desktop": { "x": 0, "y": 0 },
    "tablet": { "x": 1600, "y": 0 },
    "mobile": { "x": 2528, "y": 0 }
  }
} */`;

// ─── Server wrapper (shared) ────────────────────────────────────────────────
// The thin server `page.tsx` half of the page pair: owns the `metadata`
// export and re-exports the canvas-editable client body. `./page.client`
// resolves to the sibling `page.client.tsx` for both index and detail dirs.
const SERVER_WRAPPER = `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`;

// ─── Index page ─────────────────────────────────────────────────────────────

/**
 * Build the import binding's local variable name for a collection. CMS
 * slugs are kebab-case ([a-z0-9-]); a JS identifier can't contain '-' or
 * start with a digit, so we camelCase the hyphen-separated parts and
 * prefix any digit-leading result.
 *   "blog-posts"   → "blogPosts"
 *   "team"         → "team"
 *   "collection-2" → "collection2"  (the old [a-z]-only rule left the
 *                                    dash in — `import collection-2` is a
 *                                    syntax error that broke the page)
 *   "2023-recap"   → "cms2023Recap" (identifiers can't start with a digit)
 */
function collectionVarName(slug: string): string {
  const camel = slug.replace(/-+([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return /^[0-9]/.test(camel) ? `cms${camel}` : camel;
}

/**
 * Create a CMS Index page PAIR — server `app/{slug}/page.tsx` + client
 * `app/{slug}/page.client.tsx`. The client body is a pre-bound `.map()`
 * over the collection that the user can immediately customise (add
 * filters, change layout, bind more fields).
 *
 * Each card is a Next.js `<Link>` to `/{slug}/{item._slug}` — the detail
 * page's dynamic route — so clicking a card client-side-navigates to that
 * item (and the route auto-prefetches when the card enters the viewport).
 * The link resolves the right item purely from `.map()` scope
 * (`item._slug`); no per-item wiring needed. (If no detail page exists
 * yet the link 404s until one is created.)
 *
 * Returns the CLIENT path (the canvas-editable half) so the caller can
 * route the editor to it — same contract as `createPageFile`.
 */
export function createCmsIndexPageFile(slug: string): string {
  const schema = getCollectionSchema(slug);
  const headingField = firstTextField(schema);
  const bodyField = firstBodyField(schema, headingField);
  const varName = collectionVarName(slug);
  // Route folder must NOT collide with an existing page (e.g. a `/blog` index
  // already living in a route group like `app/(Body)/blog/`). `slug` stays the
  // COLLECTION (data import + card links → its canonical detail route); only
  // the new index page's FOLDER gets bumped to `blog-2` when taken.
  const routeSlug = uniqueRouteSlug(slug);
  const serverPath = `app/${routeSlug}/page.tsx`;
  const clientPath = `app/${routeSlug}/page.client.tsx`;
  const pageName = schema?.name ?? slug;

  // Card body — every schema field rendered with type-aware JSX. Image
  // fields get an <img>, text gets a <p>, enums get a pill, etc. Rendering
  // ALL fields up-front means the card looks complete the moment the page
  // is created; the user can delete what they don't want instead of having
  // to manually bind every column.
  const cardFieldsJsx = renderAllFields(schema, 'item', 'card', headingField, bodyField);

  const code = `'use client';

${CANVAS_CONFIG_BLOCK}

import React from 'react';
import Link from 'next/link';
import ${varName} from '@/cms/${slug}.json';

export default function Page() {
  return (
    <div data-id="root" data-name="${pageName}" style={{
      position: 'relative', width: '100%',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center',
      gap: '32px', padding: '60px',
      backgroundColor: '#ffffff'
    }}>
      <div data-id="page-container" style={{
        position: 'relative', width: '100%', maxWidth: '960px',
        display: 'flex', flexDirection: 'column',
        gap: '32px',
        order: '0', flex: '0 0 auto'
      }}>
      <p data-id="page-heading" style={{
        position: 'relative',
        order: '0', flex: '0 0 auto',
        fontSize: '40px', fontWeight: '700', color: '#0f172a',
        fontFamily: 'Inter, sans-serif',
        margin: 0
      }}>
        ${pageName}
      </p>
      <div data-id="card-list" style={{
        position: 'relative',
        order: '1', flex: '0 0 auto',
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '20px'
      }}>
      {${varName}.map((item, idx) => (
        <Link data-id="card" data-name="Card" key={idx} data-cms-nav="row" href={\`/${slug}/\${item?._slug ?? ''}\`} style={{
          position: 'relative',
          display: 'flex', flexDirection: 'column', gap: '12px',
          padding: '20px',
          backgroundColor: '#f8fafc', borderRadius: '12px',
          border: '1px solid #e2e8f0',
          textDecoration: 'none', color: 'inherit'
        }}>
${cardFieldsJsx}
        </Link>
      ))}
      </div>
      </div>
    </div>
  );
}`;

  projectFS.writeFile(serverPath, SERVER_WRAPPER);
  projectFS.writeFile(clientPath, code);
  trace.action('cms-page-ops:create-index', { serverPath, clientPath, slug, headingField, bodyField, fieldCount: schema?.fields.length });
  return clientPath;
}

// ─── Detail page ────────────────────────────────────────────────────────────

/**
 * Create a CMS Detail page PAIR — server `app/{slug}/[slug]/page.tsx` +
 * client `app/{slug}/[slug]/page.client.tsx`.
 *
 * The client body is a TEMPLATE rendered once. At runtime, Next.js fills
 * the dynamic `[slug]` segment, the page's `useParams()` resolves the
 * active item, and the bindings (`item.title`, `item.body`, …) substitute
 * that one item's values.
 *
 * The root carries `key={params.slug}`. Two detail URLs (/projects/a → /projects/b) resolve to the
 * SAME component, so React reconciles it in place instead of remounting: `initial` never re-applies
 * and every `whileInView` with `once:true` stays latched, so a next/prev link swaps the content with
 * NO entrance animation while a header link (a different route segment, hence a real remount) plays
 * normally (live find 2026-07-30). Keying the root makes a slug change a new subtree. Deliberately
 * scoped to the page's own root — keying higher (root layout / LayoutClient) would remount the
 * header, resetting its variant state mid-transition, and remount PageTransitions, orphaning the
 * `finishRef` resolver so the view transition never completes.
 *
 * The `/** @cmsPage { collection, kind: 'detail' } *​/` annotation lives in
 * the CLIENT file — that is the file the editor activates and parses, so
 * the panel can surface the preview-slug navigator and the binding
 * resolver can pick values from the currently-previewed item.
 *
 * Returns the CLIENT path so the caller can route the editor to it.
 */
export function createCmsDetailPageFile(slug: string): string {
  // ONE detail page per collection. If one already exists — in a route group,
  // co-located under an index folder, or a bumped folder — return it instead
  // of scaffolding a second route nothing links to. The Pages menu greys the
  // entry out; this guards the AI `create_pages` mirror + direct callers.
  const existing = findCmsPageFile(slug, 'detail');
  if (existing) {
    trace.action('cms-page-ops:create-detail-exists', { slug, existing });
    return existing;
  }
  const schema = getCollectionSchema(slug);
  const headingField = firstTextField(schema);
  const bodyField = firstBodyField(schema, headingField);
  const varName = collectionVarName(slug);
  // Where the detail page lives. The dynamic route is `[slug]/page.{tsx,
  // client.tsx}` so the URL is /{collection}/{item-slug}. Two cases:
  //  1. The collection already has a BASE page (e.g. an `/advisors` index,
  //     possibly inside a route group like `app/(Body)/advisors/`). CO-LOCATE
  //     the detail in that SAME folder → `app/(Body)/advisors/[slug]/`. The
  //     detail then NESTS under the index in the Pages tree AND inherits the
  //     same route-group template (matches the Next.js index+detail model).
  //  2. No base page → a bare folder, route-group-aware deduped so the detail
  //     route can't collide.
  // Either way the @cmsPage `collection` below stays the real collection — it
  // binds to the data, not the folder.
  const baseFile = slugToFilePath(slug);
  const baseDir = projectFS.exists(baseFile) ? baseFile.replace(/\/page\.(client\.)?tsx$/, '') : '';
  let serverPath: string;
  let clientPath: string;
  if (baseDir && !projectFS.exists(`${baseDir}/[slug]/page.client.tsx`)) {
    serverPath = `${baseDir}/[slug]/page.tsx`;
    clientPath = `${baseDir}/[slug]/page.client.tsx`;
  } else {
    const routeSlug = uniqueRouteSlug(slug, '/[slug]');
    serverPath = `app/${routeSlug}/[slug]/page.tsx`;
    clientPath = `app/${routeSlug}/[slug]/page.client.tsx`;
  }
  const pageName = schema?.name ? `${schema.name} Detail` : `${slug} Detail`;

  // Detail-scope JSX for every field — image at top, heading next, then
  // remaining fields in schema order. Centered 720px column gives a
  // readable article layout out of the box.
  //
  // The emitted find-by-slug line falls back to the first item so the page
  // still renders during navigation transitions or on a stale link. That
  // rationale lives HERE, not as a comment in the emitted code — generated
  // code carries no prose comments (the oracle's NO_COMMENTS rule; quotes in
  // comments corrupt the fast-path generators' string tracking, and the old
  // emitted comment literally contained "doesn't").
  const fieldsJsx = renderAllFields(schema, 'item', 'detail', headingField, bodyField);

  const code = `'use client';

${CANVAS_CONFIG_BLOCK}

/** @cmsPage {
  "collection": "${slug}",
  "kind": "detail"
} */

import React from 'react';
import { useParams } from 'next/navigation';
import ${varName} from '@/cms/${slug}.json';

export default function Page() {
  const params = useParams();
  const item = ${varName}.find((i) => i._slug === params?.slug) ?? ${varName}[0];
  return (
    <div data-id="root" key={String(params?.slug ?? '')} data-name="${pageName}" style={{
      position: 'relative', width: '100%',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center',
      padding: '80px 40px',
      backgroundColor: '#ffffff'
    }}>
      <div data-id="article-container" style={{
        position: 'relative',
        width: '100%', maxWidth: '720px',
        display: 'flex', flexDirection: 'column',
        gap: '24px',
        order: '0', flex: '0 0 auto'
      }}>
${fieldsJsx}
      </div>
    </div>
  );
}`;

  projectFS.writeFile(serverPath, SERVER_WRAPPER);
  projectFS.writeFile(clientPath, code);
  trace.action('cms-page-ops:create-detail', { serverPath, clientPath, slug, headingField, bodyField, fieldCount: schema?.fields.length });
  return clientPath;
}

// ─── @cmsPage annotation parsing ────────────────────────────────────────────
// Lives in cms-page-meta.ts (leaf) so cms-ops can parse the annotation
// without importing this module back (cms-ops ↔ cms-page-ops cycle);
// re-exported here for existing callers.

import { parseCmsPageMeta, type CmsPageMeta } from './cms-page-meta';
export { parseCmsPageMeta, type CmsPageMeta };

/**
 * Locate the EXISTING index/detail page of a collection, wherever it lives.
 *
 * The naive `projectFS.exists('app/<slug>/[slug]/page.client.tsx')` probe is
 * the bug behind "New CMS Page still offers Detail Page although
 * /collection-1/[slug] exists" (user report 2026-07-28) — applying a Template
 * moves pages into a route group, so the real file sits at
 * `app/(Body)/collection-1/[slug]/page.client.tsx`, invisible to the bare path.
 *
 * Resolution order:
 *  1. `@cmsPage { collection, kind }` annotation scan — authoritative. Survives
 *     route groups, a detail co-located under an index folder, AND a bumped
 *     route folder (`blog-2/[slug]` when `/blog` was taken) — the annotation
 *     names the collection regardless of where the folder ended up.
 *  2. Route probe via `slugToFilePath` (route-group aware) — index pages
 *     created before the annotation existed carry none.
 *
 * Returns the client-file path, or null when the page doesn't exist.
 */
export function findCmsPageFile(collection: string, kind: 'index' | 'detail'): string | null {
  for (const f of projectFS.listFiles('app/')) {
    if (!f.endsWith('page.client.tsx')) continue;
    const code = projectFS.readFile(f);
    if (!code || !code.includes('@cmsPage')) continue;
    const meta = parseCmsPageMeta(code);
    if (meta && meta.collection === collection && meta.kind === kind) {
      trace.fn('cms-page-ops:findCmsPageFile', { collection, kind, file: f, via: 'annotation' });
      return f;
    }
  }
  const probe = slugToFilePath(kind === 'detail' ? `${collection}/[slug]` : collection);
  if (projectFS.exists(probe)) {
    trace.fn('cms-page-ops:findCmsPageFile', { collection, kind, file: probe, via: 'route' });
    return probe;
  }
  return null;
}

// ─── Display helpers (shared by the slug breadcrumb + component breadcrumb) ──

/** Human-readable label for a CMS record WITHOUT needing the schema: the first
 *  non-underscore string field, falling back to its `_slug`. Used for the
 *  previewed-item label in the slug breadcrumb. */
export function cmsItemDisplayLabel(
  item: Record<string, any> | undefined | null,
  fallbackSlug?: string | null,
): string {
  if (!item) return fallbackSlug ?? '';
  const textKey = Object.keys(item).find(
    (k) => !k.startsWith('_') && typeof item[k] === 'string' && (item[k] as string).trim(),
  );
  return (textKey ? item[textKey] : item._slug) || item._slug || (fallbackSlug ?? '');
}

/** "blog-posts" / "blog_posts" → "Blog Posts" — collection slug to a title. */
export function prettyCollectionName(slug: string): string {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
