// src/ai/agent/tools/pages-more.ts
//
// Pages beyond create / switch (audit §11 gaps 1, 2): delete, rename (a new
// route), duplicate, per-page SEO metadata and site-wide metadata (favicon).
// Each write is the Pages panel's / the Settings panel's own — `deletePageFile`,
// `movePageFile`, the FileExplorer duplicate sequence, `updateMetadataInCode`
// on the page's server wrapper (`page.tsx`, the file Next.js reads metadata
// from) and on `app/layout.tsx` for the site.

import { z } from 'zod';
import { getDefaultStore } from 'jotai';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { flushTool, isBranchedRun, resolveToolFile, queueToolMutation, getToolNodes } from '@/ai/agent/workspace';
import { innerShapeJSX } from '@/canvas/creators/ShapeCreator';
import { decomposeSvgDropToShapes } from '@/canvas/drag/svg-drop-shapes';
import { generateNodeId } from '@/shared/id-utils';
import { seedFlowChild } from './flow-placement';
import { queueOrderWrites } from './semantic-structure';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import {
  deletePageFile, movePageFile, getPageSlug, getRouteGroup, getPageClientPath, getPageServerPath,
  isPageServerFile, isPageClientFile, activeFilePathAtom,
} from '@/code/project/active-file-store';
import { parseMetadataFromCode, parseSiteConfigFromCode, updateMetadataInCode, type SiteMetadata } from '@/code/generation/metadata-gen';
import { setWebsiteWatermark } from '@/backend/revyme-backend';
import { getProjectId } from '@/backend/project-id';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/** A page by route ("/about", "about") or path — the client half, which is
 *  what the editor opens. */
export function resolvePagePath(page: string): string | null {
  const p = page.trim();
  if (/\.tsx$/.test(p)) {
    const client = isPageServerFile(p) ? getPageClientPath(p) : p;
    return projectFS.exists(client) ? client : null;
  }
  const slug = p.replace(/^\//, '').replace(/\/$/, '');
  const want = slug === '' || slug === 'home' ? '/' : `/${slug}`;
  for (const path of projectFS.listFiles('app/')) {
    if (isPageClientFile(path) && getPageSlug(path) === want) return path;
  }
  return null;
}

const HOME_PATH = 'app/page.client.tsx';
const bump = (): void => { store.set(projectVersionAtom, (v) => v + 1); };

export const deletePageTool: AgentTool = {
  name: 'delete_page',
  description: 'Delete a page (both halves of its pair). Not the home page. ONLY when the user asked for it — other pages that link to it keep a dead link.',
  inputSchema: { page: z.string().describe('route ("/about") or path') },
  category: 'semantic',
  async execute(args, ctx) {
    const path = resolvePagePath(String(args.page));
    if (!path) return fail(`No page "${args.page}". list_pages shows them.`);
    if (path === HOME_PATH) return fail('The home page cannot be deleted.');
    if (isBranchedRun(ctx)) return fail('delete_page works on the active branch only — run unbranched.');
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const wasActive = store.get(activeFilePathAtom) === path;
    deletePageFile(path);
    if (wasActive) store.set(activeFilePathAtom, HOME_PATH);
    bump();
    trace.action('agent-tool:delete_page', { path });
    return ok({ deleted: path, ...(wasActive ? { active_file: HOME_PATH } : {}) });
  },
};

export const renamePageTool: AgentTool = {
  name: 'rename_page',
  description: 'Change a page\'s route: "About" → /about becomes /company. Moves both halves of the pair; comments follow. Links to the old route on other pages are NOT rewritten — say so if any exist. Not the home page.',
  inputSchema: { page: z.string().describe('route ("/about") or path'), new_name: z.string().describe('the new name; its slug becomes the route, e.g. "Company" → /company') },
  category: 'semantic',
  async execute(args, ctx) {
    const path = resolvePagePath(String(args.page));
    if (!path) return fail(`No page "${args.page}". list_pages shows them.`);
    if (path === HOME_PATH) return fail('The home page has no slug to rename.');
    const slug = String(args.new_name).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) return fail('new_name must contain letters or digits.');
    if (isBranchedRun(ctx)) return fail('rename_page works on the active branch only — run unbranched.');
    const group = getRouteGroup(path);
    const newPath = `${group ? `app/(${group})` : 'app'}/${slug}/page.client.tsx`;
    if (newPath === path) return ok({ path, route: getPageSlug(path), unchanged: true });
    if (projectFS.exists(newPath)) return fail(`A page already lives at ${getPageSlug(newPath)}.`);
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const wasActive = store.get(activeFilePathAtom) === path;
    movePageFile(path, newPath);
    if (wasActive) store.set(activeFilePathAtom, newPath);
    bump();
    // Other pages linking to the old route: reported, not rewritten.
    const oldRoute = getPageSlug(path);
    const linking = projectFS.listFiles('app/').filter((p) => p !== newPath && isPageClientFile(p) && new RegExp(`href=["']${oldRoute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(projectFS.readFile(p) ?? ''));
    trace.action('agent-tool:rename_page', { from: path, to: newPath });
    return ok({ path: newPath, route: getPageSlug(newPath), previous_route: oldRoute, ...(linking.length ? { pages_still_linking_to_old_route: linking } : {}) });
  },
};

export const duplicatePageTool: AgentTool = {
  name: 'duplicate_page',
  description: 'Copy a page to a new route (default "<route>-copy", or the name you give) — the Pages panel\'s Duplicate. The copy becomes the active file.',
  inputSchema: { page: z.string().describe('route ("/about") or path'), new_name: z.string().optional() },
  category: 'semantic',
  async execute(args, ctx) {
    const path = resolvePagePath(String(args.page));
    if (!path) return fail(`No page "${args.page}". list_pages shows them.`);
    if (isBranchedRun(ctx)) return fail('duplicate_page works on the active branch only — run unbranched.');
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const code = projectFS.readFile(path);
    if (!code) return fail(`${path} is empty.`);
    const group = getRouteGroup(path);
    const baseDir = group ? `app/(${group})` : 'app';
    const srcSlug = getPageSlug(path).replace(/^\//, '');
    let slug = args.new_name ? String(args.new_name).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') : (srcSlug ? `${srcSlug}-copy` : 'page-copy');
    let newPath = `${baseDir}/${slug}/page.client.tsx`;
    for (let n = 1; projectFS.exists(newPath); n++) { newPath = `${baseDir}/${slug}-${n}/page.client.tsx`; }
    projectFS.writeFile(newPath, code);
    projectFS.writeFile(getPageServerPath(newPath), `import PageClient from './page.client';\n\nexport const metadata = {};\n\nexport default function Page() {\n  return <PageClient />;\n}\n`);
    store.set(activeFilePathAtom, newPath);
    bump();
    trace.action('agent-tool:duplicate_page', { from: path, to: newPath });
    return ok({ path: newPath, route: getPageSlug(newPath), active_file: newPath });
  },
};

const META_SHAPE = {
  title: z.string().optional().describe('the <title> / tab name — for the site, its NAME'),
  description: z.string().optional().describe('meta description (search snippets) — ~150-160 characters'),
  og_title: z.string().optional().describe('title when shared on social (Open Graph)'),
  og_description: z.string().optional(),
  og_image: z.string().optional().describe('URL of the share image (1200×630)'),
};

/** The rest of the Settings → Pages SEO panel (PagesSeoSection.tsx): Twitter /
 *  X card, canonical URL, robots. Same metadata export, same shape. */
const PAGE_SEO_SHAPE = {
  twitter_card: z.enum(['summary', 'summary_large_image']).optional().describe('Twitter / X card type — summary_large_image shows the big image'),
  twitter_title: z.string().optional(),
  twitter_description: z.string().optional(),
  twitter_image: z.string().optional().describe('URL of the Twitter / X image (defaults to og_image when unset)'),
  canonical: z.string().optional().describe('canonical URL of this page ("https://example.com/about") — "" clears it'),
  index: z.boolean().optional().describe('false = noindex: keep this page out of search results (thank-you pages, drafts, duplicates)'),
  follow: z.boolean().optional().describe('false = nofollow: search engines should not follow this page\'s links'),
};

function toMeta(args: Record<string, unknown>): SiteMetadata {
  const m: SiteMetadata = {};
  if (args.title !== undefined) m.title = String(args.title);
  if (args.description !== undefined) m.description = String(args.description);
  const og: NonNullable<SiteMetadata['openGraph']> = {};
  if (args.og_title !== undefined) og.title = String(args.og_title);
  if (args.og_description !== undefined) og.description = String(args.og_description);
  if (args.og_image !== undefined) og.images = args.og_image ? [String(args.og_image)] : [];
  if (Object.keys(og).length) m.openGraph = og;
  const tw: Record<string, unknown> = {};
  if (args.twitter_card !== undefined) tw.card = String(args.twitter_card);
  if (args.twitter_title !== undefined) tw.title = String(args.twitter_title);
  if (args.twitter_description !== undefined) tw.description = String(args.twitter_description);
  if (args.twitter_image !== undefined) tw.image = String(args.twitter_image);
  if (Object.keys(tw).length) m.twitter = tw;
  if (args.canonical !== undefined) m.alternates = { canonical: String(args.canonical) };
  const robots: Record<string, unknown> = {};
  if (args.index !== undefined) robots.index = !!args.index;
  if (args.follow !== undefined) robots.follow = !!args.follow;
  if (Object.keys(robots).length) m.robots = robots;
  return m;
}

export const setPageMetadataTool: AgentTool = {
  name: 'set_page_metadata',
  description: 'Set a page\'s SEO — everything the Settings → Pages panel edits: title, description, social (Open Graph) title / description / image, Twitter / X card + title / description / image, canonical URL, robots (index / follow). Only what you pass changes. Omit `page` for the active page. Write REAL copy for the page (its own subject and keywords, a description of ~150-160 characters), never the site defaults repeated.',
  inputSchema: { page: z.string().optional().describe('route ("/about") or path; default: the active page'), ...META_SHAPE, ...PAGE_SEO_SHAPE },
  category: 'semantic',
  async execute(args, ctx) {
    const path = args.page ? resolvePagePath(String(args.page)) : resolveToolFile(ctx);
    if (!path || !isPageClientFile(path)) return fail(args.page ? `No page "${args.page}".` : 'The active file is not a page — pass `page`.');
    const meta = toMeta(args);
    if (Object.keys(meta).length === 0) return fail('Nothing to set — pass title, description, og_*, twitter_*, canonical, index or follow.');
    if (isBranchedRun(ctx)) return fail('Page metadata is written on the active branch only — run unbranched.');
    const server = getPageServerPath(path);
    if (!projectFS.exists(server)) return fail(`${path} has no server wrapper (${server}) to hold metadata.`);
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const wrote = modifyProjectFile(server, (code) => updateMetadataInCode(code, meta));
    if (wrote === null) return fail(`Could not write ${server}.`);
    bump();
    return ok({ page: getPageSlug(path), metadata: parseMetadataFromCode(projectFS.readFile(server) ?? '') });
  },
};

/**
 * `get_seo` — the site's settings and every page's SEO in one read, with what
 * is MISSING per page, so "do the SEO properly" starts from an audit rather
 * than a guess. The same sources the Settings panels read: the layout's
 * metadata + siteConfig, each page's server wrapper metadata.
 */
export function seoAudit(): {
  site: Record<string, unknown>;
  pages: { route: string; path: string; title?: string; description?: string; og_image?: string; twitter_card?: string; canonical?: string; index?: boolean; missing: string[] }[];
} {
  const layout = projectFS.readFile('app/layout.tsx') ?? '';
  const siteMeta = parseMetadataFromCode(layout);
  const config = parseSiteConfigFromCode(layout);
  const siteImage = (siteMeta.openGraph as { images?: string[] } | undefined)?.images?.[0];
  const site = {
    name: siteMeta.title ?? '',
    description: siteMeta.description ?? '',
    language: config.language ?? 'en',
    theme: config.theme ?? 'light',
    favicon: (siteMeta.icons as { icon?: string } | undefined)?.icon ?? '',
    social_image: siteImage ?? '',
    custom_code_head: config.customHead ?? '',
    custom_code_body: config.customBody ?? '',
  };
  const pages = projectFS.listFiles('app/').filter((p) => isPageClientFile(p)).sort().map((path) => {
    const server = getPageServerPath(path);
    const m = parseMetadataFromCode(projectFS.readFile(server) ?? '');
    const og = (m.openGraph ?? {}) as { images?: string[] };
    const tw = (m.twitter ?? {}) as { card?: string };
    const robots = (m.robots ?? {}) as { index?: boolean };
    const alt = (m.alternates ?? {}) as { canonical?: string };
    const title = typeof m.title === 'string' ? m.title : undefined;
    const description = typeof m.description === 'string' ? m.description : undefined;
    const missing: string[] = [];
    if (!title) missing.push('title');
    if (!description) missing.push('description');
    else if (description.length < 50 || description.length > 160) missing.push(`description length ${description.length} (aim 50-160)`);
    if (!og.images?.[0] && !siteImage) missing.push('social image (neither the page nor the site has one)');
    if (robots.index === false) missing.push('noindex — hidden from search (intended?)');
    return {
      route: getPageSlug(path), path, title, description, og_image: og.images?.[0], twitter_card: tw.card,
      canonical: alt.canonical, index: robots.index, missing,
    };
  });
  const byTitle = new Map<string, string[]>();
  for (const pg of pages) if (pg.title) byTitle.set(pg.title, [...(byTitle.get(pg.title) ?? []), pg.route]);
  for (const pg of pages) if (pg.title && (byTitle.get(pg.title)?.length ?? 0) > 1) pg.missing.push(`duplicate title (also on ${byTitle.get(pg.title)!.filter((r) => r !== pg.route).join(', ')})`);
  const siteMissing: string[] = [];
  if (!site.name) siteMissing.push('name');
  if (!site.description) siteMissing.push('description');
  if (!site.favicon) siteMissing.push('favicon');
  if (!site.social_image) siteMissing.push('social image');
  return { site: { ...site, missing: siteMissing }, pages };
}

export const getSeoTool: AgentTool = {
  name: 'get_seo',
  description: 'Read the site settings (name, description, language, favicon, social image, theme, custom code) and EVERY page\'s SEO (title, description, social image, Twitter card, canonical, robots) with what is missing per page — duplicate titles, descriptions outside 50-160 characters, no share image, noindex. Call it before setting SEO, then fix with set_site_metadata / set_page_metadata.',
  inputSchema: {},
  category: 'read',
  async execute() {
    return ok(seoAudit());
  },
};

export const setSiteMetadataTool: AgentTool = {
  name: 'set_site_metadata',
  description:
    'Set the WEBSITE settings — everything Settings → Website edits: name (title), description, default language, favicon URL, default social image, default theme, custom code at the end of <head> / end of <body>, and the "Made in Revyme" badge. Pages without their own SEO inherit the name, description and social image. ' +
    'Custom code is raw HTML that ships on EVERY page (analytics, a verification <meta>, a chat widget) — only what the user asked for, never a script of your own. Upload images first (upload_image / revyme_upload_image) and pass the returned URL.',
  inputSchema: {
    ...META_SHAPE,
    favicon: z.string().optional().describe('URL of the favicon (.ico / .png / .svg, 32×32 or 64×64)'),
    language: z.string().optional().describe('default language code of the site, e.g. "en", "fr" (the <html lang>)'),
    theme: z.enum(['light', 'dark', 'system']).optional().describe('default colour theme visitors get'),
    custom_code_head: z.string().optional().describe('raw HTML placed at the END of <head> on every page; "" clears it'),
    custom_code_body: z.string().optional().describe('raw HTML placed at the END of <body> on every page; "" clears it'),
    made_in_revyme_badge: z.boolean().optional().describe('show (true) or hide (false) the small "Made in Revyme" badge on the published site'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const meta = toMeta(args);
    if (args.favicon !== undefined) meta.icons = { icon: String(args.favicon) };
    // The site-config half — the SAME mutation the Settings panel queues.
    const config: Record<string, string> = {};
    if (args.language !== undefined) config.language = String(args.language);
    if (args.theme !== undefined) config.theme = String(args.theme);
    if (args.custom_code_head !== undefined) config.customHead = String(args.custom_code_head);
    if (args.custom_code_body !== undefined) config.customBody = String(args.custom_code_body);
    const badge = typeof args.made_in_revyme_badge === 'boolean' ? args.made_in_revyme_badge : undefined;
    if (Object.keys(meta).length === 0 && Object.keys(config).length === 0 && badge === undefined) return fail('Nothing to set.');
    if (isBranchedRun(ctx)) return fail('Site settings are written on the active branch only — run unbranched.');
    ctx.ensureCheckpoint();
    flushTool(ctx);
    if (Object.keys(meta).length > 0) {
      if (!projectFS.exists('app/layout.tsx')) return fail('The project has no app/layout.tsx.');
      const wrote = modifyProjectFile('app/layout.tsx', (code) => updateMetadataInCode(code, meta));
      if (wrote === null) return fail('Could not write app/layout.tsx.');
    }
    if (Object.keys(config).length > 0) {
      queueToolMutation(ctx, { type: 'updateSiteConfig', config });
      flushTool(ctx);
    }
    // The badge lives on the WEBSITE row (the live Worker reads it), not in
    // the code — the Settings toggle's own backend call.
    let badgeNote: string | undefined;
    if (badge !== undefined) {
      if (!CLOUD_ENABLED) badgeNote = 'The badge is a Revyme cloud setting — not available on this install.';
      else {
        try { await setWebsiteWatermark(getProjectId(), !badge); }
        catch (e) { return fail(`The other settings were saved, but the badge could not be changed: ${(e as Error).message}`); }
      }
    }
    bump();
    const layout = projectFS.readFile('app/layout.tsx') ?? '';
    return ok({
      metadata: parseMetadataFromCode(layout),
      settings: parseSiteConfigFromCode(layout),
      ...(badge !== undefined && !badgeNote ? { made_in_revyme_badge: badge } : {}),
      ...(badgeNote ? { note: badgeNote } : {}),
    });
  },
};

// ─── add_shape ───────────────────────────────────────────────────────────────

const SHAPES = ['rectangle', 'ellipse', 'triangle', 'line', 'path'] as const;
type AddNodeChild = { id: string; type: string; name?: string; styles: Record<string, string>; attrs?: Record<string, string>; children?: AddNodeChild[] };
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|var\(--[\w-]+\)|none|transparent|[a-z]+)$/;

export const addShapeTool: AgentTool = {
  name: 'add_shape',
  description:
    'Draw an SVG SHAPE — the Shape tool: rectangle | ellipse | triangle | line, or a custom "path" from an SVG `d` string (ONE subpath — a divider wave, a blob, an arrow). The shape is a stretchable <svg> wrapper (viewBox + preserveAspectRatio none) the Shape and Stroke panels edit: fill, stroke, stroke_width. ' +
    'Sized in px (width / height); placed like any layer (parent_id, index). For icons prefer the icon tools; for decorative backgrounds prefer list_built_in_components.',
  inputSchema: {
    parent_id: z.string(),
    shape: z.enum(SHAPES),
    width: z.number().int().min(1),
    height: z.number().int().min(1),
    fill: z.string().optional().describe('default #3b82f6; "none" for an outline'),
    stroke: z.string().optional(),
    stroke_width: z.number().optional(),
    d: z.string().optional().describe('SVG path data for shape "path" (coordinates in the width × height box)'),
    name: z.string().optional(),
    index: z.number().optional(),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const parentId = String(args.parent_id);
    const nodes = getToolNodes(ctx);
    const parent = nodes.get(parentId);
    if (!parent) return fail(`No node "${parentId}" in the active file.`);
    if (/^[A-Z]/.test(parent.type)) return fail(`"${parentId}" is a component instance — draw inside its master or beside it.`);
    const shape = args.shape as (typeof SHAPES)[number];
    const w = Math.round(Number(args.width)), h = Math.round(Number(args.height));
    const fill = (args.fill as string | undefined) ?? (shape === 'line' ? 'none' : '#3b82f6');
    const stroke = (args.stroke as string | undefined) ?? (shape === 'line' ? '#3b82f6' : '#000000');
    for (const c of [fill, stroke]) if (!COLOR_RE.test(c)) return fail(`"${c}" is not a colour (hex, rgb(), var(--token) or none).`);
    const strokeWidth = typeof args.stroke_width === 'number' ? args.stroke_width : shape === 'line' ? 2 : 0;
    let inner: string;
    if (shape === 'path') {
      const d = String(args.d ?? '').trim();
      if (!d) return fail('shape "path" needs d (SVG path data).');
      if (!/^[Mm]/.test(d)) return fail('d must start with a moveto (M x,y …).');
      if ((d.match(/[Mm]/g) ?? []).length > 1) return fail('One subpath per shape (a single M…): the Shape editor edits one outline. Split it into several shapes.');
      inner = `<path d="${d.replace(/"/g, "'")}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" />`;
    } else {
      inner = innerShapeJSX(shape === 'rectangle' ? 'shape-rect' : shape === 'ellipse' ? 'shape-ellipse' : shape === 'triangle' ? 'shape-triangle' : 'shape-path', w, h)
        .replace(/fill="[^"]*"/, `fill="${fill}"`)
        .replace(/stroke="[^"]*"/, `stroke="${stroke}"`)
        .replace(/stroke-?[wW]idth="[^"]*"/, `stroke-width="${strokeWidth}"`);
    }
    const id = generateNodeId(shape);
    const name = (args.name as string | undefined) ?? shape[0].toUpperCase() + shape.slice(1);
    // The builder's shape GRAMMAR (svg-drop-shapes / Figma import): a 1:1
    // viewBox wrapper holding ONE `<path data-id="<id>-g0">` — primitives
    // become path data, so the Shape editor shows vertices and Fill / Stroke
    // bind per shape. Flat inner markup renders but is not shape-editable.
    const dec = decomposeSvgDropToShapes(`<svg viewBox="0 0 ${w} ${h}">${inner}</svg>`, id, name, w, h);
    if (!dec || dec.children.length === 0) return fail(`Could not turn that ${shape} into an editable shape — check the path data.`);
    const toDef = (d: { tag: string; id?: string; name?: string; styles: Record<string, string>; attrs?: Record<string, string>; children?: unknown[] }): AddNodeChild => ({ id: d.id ?? generateNodeId('shape'), type: d.tag, name: d.name, styles: d.styles, attrs: d.attrs, children: (d.children as typeof d[] | undefined)?.map(toDef) });
    const placed = seedFlowChild({ position: 'relative', width: `${dec.box.w}px`, height: `${dec.box.h}px`, overflow: 'visible' }, parent, nodes, args.index as number | undefined);
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'addNode', parentId, index: args.index as number | undefined, node: { id, type: 'svg', name, styles: placed.styles, attrs: dec.attrs, children: dec.children.map(toDef) } });
    queueOrderWrites(ctx, placed.siblings);
    flushTool(ctx);
    trace.action('agent-tool:add_shape', { id, shape, parentId });
    return ok({ node_id: id, shape, width: dec.box.w, height: dec.box.h, geometry_id: dec.children[0]?.id ?? null, fill, stroke: strokeWidth ? stroke : null });
  },
};

export const PAGES_MORE_TOOLS: AgentTool[] = [getSeoTool, deletePageTool, renamePageTool, duplicatePageTool, setPageMetadataTool, setSiteMetadataTool, addShapeTool];
